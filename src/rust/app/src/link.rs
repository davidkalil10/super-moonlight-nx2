//! The control connection as the service sees it. `io::control::Channel` implements it; tests
//! use scripted links. The runtime owns opening, pumping and closing the connection.

use moonlight_nx2_core::control::Frame;
use moonlight_nx2_io::control::{Channel, Error, State};
use moonlight_nx2_io::socket::Socket;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LinkError {
    /// Nothing was queued; retry on a later poll.
    Again,
    /// The connection failed for good.
    Closed,
}

pub trait Link {
    /// Authenticated and able to take requests.
    fn ready(&self) -> bool;
    /// The connection ended or failed; complete frames may still be readable.
    fn failed(&self) -> bool;
    /// Queues one request payload and returns its request ID; never resent.
    fn request(&mut self, payload: &[u8]) -> Result<u32, LinkError>;
    /// The ready frame, borrowed until `consume`.
    fn peek(&self) -> Option<Frame<'_>>;
    fn consume(&mut self) -> Result<(), LinkError>;
}

impl<S: Socket> Link for Channel<'_, S> {
    fn ready(&self) -> bool {
        self.state() == State::Ready && self.failure().is_none()
    }

    fn failed(&self) -> bool {
        self.state() == State::Closed || self.failure().is_some()
    }

    fn request(&mut self, payload: &[u8]) -> Result<u32, LinkError> {
        match Channel::request(self, payload) {
            Ok(id) => Ok(id),
            Err(Error::Again) => Err(LinkError::Again),
            Err(_) => Err(LinkError::Closed),
        }
    }

    fn peek(&self) -> Option<Frame<'_>> {
        Channel::peek(self)
    }

    fn consume(&mut self) -> Result<(), LinkError> {
        match Channel::consume(self) {
            Ok(()) => Ok(()),
            Err(Error::Again) => Err(LinkError::Again),
            Err(_) => Err(LinkError::Closed),
        }
    }
}
