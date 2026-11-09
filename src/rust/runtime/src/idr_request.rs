//! Forwards the video path's IDR requests to the host as `idr` control requests, one at a time.

use moonlight_nx2_app::link::{Link, LinkError};
use moonlight_nx2_core::control::Kind;

const REPLY_TIMEOUT_MS: u64 = 10_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reply {
    Queued,
    Coalesced,
    Refused,
}

#[derive(Default)]
pub struct Requester {
    waiting: Option<(u32, u64)>,
}

impl Requester {
    pub fn reset(&mut self) {
        self.waiting = None;
    }

    pub fn waiting_id(&self) -> Option<u32> {
        self.waiting.map(|(id, _)| id)
    }

    pub fn expired(&self, now_ms: u64) -> bool {
        self.waiting.is_some_and(|(_, deadline)| now_ms >= deadline)
    }

    pub fn request<L: Link>(&mut self, link: &mut L, wanted: bool, now_ms: u64) -> bool {
        if !wanted || self.waiting.is_some() || !link.ready() {
            return false;
        }
        match link.request(br#"{"op":"idr"}"#) {
            Ok(id) => {
                self.waiting = Some((id, now_ms.saturating_add(REPLY_TIMEOUT_MS)));
                true
            }
            Err(_) => false,
        }
    }

    pub fn poll<L: Link>(&mut self, link: &mut L) -> Option<Result<Reply, LinkError>> {
        let id = self.waiting_id()?;
        let frame = link.peek()?;
        if frame.header.request_id != id {
            return None;
        }
        let reply = match frame.header.kind {
            Kind::Event if contains(frame.payload, br#""queued":true"#) => Reply::Queued,
            Kind::Event => Reply::Coalesced,
            _ => Reply::Refused,
        };
        self.waiting = None;
        Some(link.consume().map(|()| reply))
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlight_nx2_core::control::{Frame, Header};

    #[derive(Default)]
    struct Fake {
        requests: Vec<Vec<u8>>,
        frame: Option<(Kind, u32, Vec<u8>)>,
        busy: bool,
    }

    impl Link for Fake {
        fn ready(&self) -> bool {
            true
        }
        fn failed(&self) -> bool {
            false
        }
        fn request(&mut self, payload: &[u8]) -> Result<u32, LinkError> {
            if self.busy {
                return Err(LinkError::Again);
            }
            self.requests.push(payload.to_vec());
            Ok(self.requests.len() as u32)
        }
        fn peek(&self) -> Option<Frame<'_>> {
            let (kind, id, payload) = self.frame.as_ref()?;
            Some(Frame {
                header: Header::new(*kind, *id, payload.len()).ok()?,
                payload,
            })
        }
        fn consume(&mut self) -> Result<(), LinkError> {
            self.frame = None;
            Ok(())
        }
    }

    #[test]
    fn one_request_at_a_time_and_its_reply_is_consumed() {
        let mut link = Fake::default();
        let mut idr = Requester::default();
        assert!(!idr.request(&mut link, false, 0));
        assert!(idr.request(&mut link, true, 0));
        assert_eq!(link.requests, [br#"{"op":"idr"}"#.to_vec()]);
        assert!(!idr.request(&mut link, true, 1));
        link.frame = Some((Kind::Event, 9, b"{}".to_vec()));
        assert_eq!(idr.poll(&mut link), None);
        link.frame = Some((
            Kind::Event,
            1,
            br#"{"event":"result","op":"idr","ok":true,"value":{"queued":true}}"#.to_vec(),
        ));
        assert_eq!(idr.poll(&mut link), Some(Ok(Reply::Queued)));
        assert!(link.frame.is_none());
        assert_eq!(idr.waiting_id(), None);
    }

    #[test]
    fn coalesced_refused_busy_and_timeout() {
        let mut link = Fake::default();
        let mut idr = Requester::default();
        idr.request(&mut link, true, 0);
        link.frame = Some((
            Kind::Event,
            1,
            br#"{"event":"result","op":"idr","ok":true,"value":{"queued":false}}"#.to_vec(),
        ));
        assert_eq!(idr.poll(&mut link), Some(Ok(Reply::Coalesced)));
        idr.request(&mut link, true, 0);
        link.frame = Some((Kind::Error, 2, br#"{"code":"invalid_state"}"#.to_vec()));
        assert_eq!(idr.poll(&mut link), Some(Ok(Reply::Refused)));
        link.busy = true;
        assert!(!idr.request(&mut link, true, 0));
        link.busy = false;
        assert!(idr.request(&mut link, true, 100));
        assert!(!idr.expired(100 + REPLY_TIMEOUT_MS - 1));
        assert!(idr.expired(100 + REPLY_TIMEOUT_MS));
    }
}
