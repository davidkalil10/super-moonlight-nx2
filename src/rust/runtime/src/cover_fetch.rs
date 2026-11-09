extern crate alloc;

use alloc::{format, vec::Vec};
use moonlight_nx2_app::{
    covers::{Cover, Error},
    link::{Link, LinkError},
};
use moonlight_nx2_core::control::{Frame, Kind};

struct Pending {
    app: u32,
    cover: Cover,
    request: Option<u32>,
    deadline: u64,
    restarted: bool,
}

#[derive(Default)]
pub struct Fetcher {
    pending: Option<Pending>,
    attempted: Vec<u32>,
    disabled: bool,
    fatal: bool,
}

impl Fetcher {
    pub fn reset(&mut self) {
        *self = Self::default();
    }
    pub fn busy(&self) -> bool {
        self.pending.is_some()
    }
    pub fn waiting_id(&self) -> Option<u32> {
        self.pending.as_ref()?.request
    }
    pub fn expired(&self, now_ms: u64) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|pending| pending.request.is_some() && now_ms >= pending.deadline)
    }
    pub fn failed(&self) -> bool {
        self.fatal
    }
    pub fn attempted(&self, app: u32) -> bool {
        self.disabled || self.attempted.contains(&app)
    }
    pub fn mark_attempted(&mut self, app: u32) {
        if !self.attempted.contains(&app) {
            self.attempted.push(app);
        }
    }

    pub fn begin(&mut self, app: u32) {
        if !self.busy() && !self.attempted(app) {
            self.pending = Cover::new(app).map(|cover| Pending {
                app,
                cover,
                request: None,
                deadline: 0,
                restarted: false,
            });
        }
    }

    pub fn request<L: Link>(&mut self, link: &mut L, host: &str, now_ms: u64) {
        let Some(pending) = self.pending.as_mut() else {
            return;
        };
        if pending.request.is_some() || !moonlight_nx2_ui::model::is_address(host) {
            return;
        }
        let request = format!(
            "{{\"op\":\"cover\",\"host\":\"{host}\",\"app\":{},\"offset\":{}}}",
            pending.app,
            pending.cover.offset()
        );
        if let Ok(id) = link.request(request.as_bytes()) {
            pending.request = Some(id);
            pending.deadline = now_ms.saturating_add(30_000);
        }
    }

    pub fn poll<L: Link>(&mut self, link: &mut L) -> Option<(u32, Vec<u8>)> {
        let pending = self.pending.as_mut()?;
        let id = pending.request?;
        let Some(frame) = link.peek() else {
            return None;
        };
        if frame.header.request_id != id {
            return None;
        }
        let result = if matches!(frame.header.kind, Kind::Event | Kind::Error) {
            pending.cover.accept(frame.payload)
        } else {
            Err(Error::Malformed)
        };
        if link.consume().is_err() {
            self.pending = None;
            self.fatal = true;
            return None;
        }
        let pending = self.pending.as_mut().unwrap();
        pending.request = None;
        let app = pending.app;
        match result {
            Ok(true) => {
                let pending = self.pending.take().unwrap();
                pending.cover.into_bytes().map(|bytes| (app, bytes))
            }
            Ok(false) => None,
            Err(Error::Unsupported) => {
                self.disabled = true;
                self.pending = None;
                None
            }
            Err(Error::Backend) if pending.cover.offset() > 0 && !pending.restarted => {
                pending.cover = Cover::new(app).unwrap();
                pending.restarted = true;
                None
            }
            Err(_) => {
                self.mark_attempted(app);
                self.pending = None;
                None
            }
        }
    }
}

/// Holds ordinary requests while a cover response is outstanding and leaves that response
/// for the fetcher on the next frame.
pub struct Guard<'a, L> {
    pub link: &'a mut L,
    pub waiting: Option<u32>,
}
impl<L: Link> Link for Guard<'_, L> {
    fn ready(&self) -> bool {
        self.link.ready()
    }
    fn failed(&self) -> bool {
        self.link.failed()
    }
    fn request(&mut self, payload: &[u8]) -> Result<u32, LinkError> {
        if self.waiting.is_some() {
            Err(LinkError::Again)
        } else {
            self.link.request(payload)
        }
    }
    fn peek(&self) -> Option<Frame<'_>> {
        self.link
            .peek()
            .filter(|frame| Some(frame.header.request_id) != self.waiting)
    }
    fn consume(&mut self) -> Result<(), LinkError> {
        self.link.consume()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlight_nx2_core::control::Header;

    #[derive(Default)]
    struct Fake {
        requests: Vec<Vec<u8>>,
        frame: Option<(Kind, u32, Vec<u8>)>,
    }
    impl Link for Fake {
        fn ready(&self) -> bool {
            true
        }
        fn failed(&self) -> bool {
            false
        }
        fn request(&mut self, payload: &[u8]) -> Result<u32, LinkError> {
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
    fn chunk_requests_serialize_and_unsupported_stops_session() {
        let mut link = Fake::default();
        let mut fetch = Fetcher::default();
        fetch.begin(7);
        fetch.request(&mut link, "192.168.1.2", 0);
        assert_eq!(fetch.waiting_id(), Some(1));
        let mut guard = Guard {
            link: &mut link,
            waiting: fetch.waiting_id(),
        };
        assert_eq!(guard.request(b"{}"), Err(LinkError::Again));
        guard.link.frame = Some((Kind::Event, 1, br#"{"event":"result","op":"cover","ok":true,"value":{"app":7,"mime":"image/png","total":4,"offset":0,"data":"AQID"}}"#.to_vec()));
        assert!(guard.peek().is_none());
        assert!(fetch.poll(&mut link).is_none());
        fetch.request(&mut link, "192.168.1.2", 1);
        assert!(
            core::str::from_utf8(&link.requests[1])
                .unwrap()
                .contains("\"offset\":3")
        );
        link.frame = Some((Kind::Event, 2, br#"{"event":"result","op":"cover","ok":true,"value":{"app":7,"mime":"image/png","total":4,"offset":3,"data":"BA=="}}"#.to_vec()));
        assert_eq!(fetch.poll(&mut link), Some((7, vec![1, 2, 3, 4])));
        fetch.begin(8);
        fetch.request(&mut link, "192.168.1.2", 2);
        link.frame = Some((
            Kind::Error,
            3,
            br#"{"code":"unsupported","message":"unsupported"}"#.to_vec(),
        ));
        assert!(fetch.poll(&mut link).is_none());
        assert!(fetch.attempted(9));
    }

    #[test]
    fn backend_change_restarts_a_partial_cover_only_once() {
        let mut link = Fake::default();
        let mut fetch = Fetcher::default();
        fetch.begin(7);
        fetch.request(&mut link, "192.168.1.2", 0);
        link.frame = Some((Kind::Event, 1, br#"{"event":"result","op":"cover","ok":true,"value":{"app":7,"mime":"image/png","total":4,"offset":0,"data":"AQID"}}"#.to_vec()));
        assert!(fetch.poll(&mut link).is_none());
        fetch.request(&mut link, "192.168.1.2", 1);
        link.frame = Some((
            Kind::Error,
            2,
            br#"{"code":"backend_failed","message":"changed"}"#.to_vec(),
        ));
        assert!(fetch.poll(&mut link).is_none());
        fetch.request(&mut link, "192.168.1.2", 2);
        assert!(
            core::str::from_utf8(&link.requests[2])
                .unwrap()
                .contains("\"offset\":0")
        );
        link.frame = Some((Kind::Event, 3, br#"{"event":"result","op":"cover","ok":true,"value":{"app":7,"mime":"image/png","total":4,"offset":0,"data":"AQID"}}"#.to_vec()));
        assert!(fetch.poll(&mut link).is_none());
        fetch.request(&mut link, "192.168.1.2", 3);
        link.frame = Some((
            Kind::Error,
            4,
            br#"{"code":"backend_failed","message":"changed"}"#.to_vec(),
        ));
        assert!(fetch.poll(&mut link).is_none());
        assert!(!fetch.busy());
        assert!(fetch.attempted(7));
    }
}
