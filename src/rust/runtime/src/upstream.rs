//! Where control-v1 requests go: Sunshine itself, through the console's direct link.

extern crate alloc;

use alloc::boxed::Box;

use moonlight_nx2_app::{
    direct::{Dial, DirectLink},
    direct_stream::Live,
    link::{Link, LinkError},
};
use moonlight_nx2_core::control::Frame;
use moonlight_nx2_io::socket::Socket;
use moonlight_nx2_ui::store::Files;

pub type Dialer<S> = Box<dyn Dial<Socket = S>>;

pub struct Upstream<S: Socket + 'static>(Box<DirectLink<Dialer<S>>>);

impl<S: Socket + 'static> Upstream<S> {
    pub fn new(link: DirectLink<Dialer<S>>) -> Self {
        Self(Box::new(link))
    }

    pub fn pump(&mut self, files: &mut impl Files, now_ms: u64) {
        if let Some(live) = self.0.live() {
            let mouse = crate::hid::pointer::mouse();
            live.pointer(mouse.as_ref(), crate::hid::pointer::keyboard().as_ref());
        }
        self.0.pump(files, now_ms);
    }

    /// The stream whose control channel is up: its negotiated media settings and the
    /// input session the media path feeds each record to with `Live::record`.
    pub fn live(&mut self) -> Option<&mut Live> {
        self.0.live()
    }

    /// Whether this console holds a pinned certificate for the PC.
    pub fn paired(&self) -> bool {
        self.0.paired()
    }

    pub fn close(&mut self) {
        self.0.close();
    }
}

impl<S: Socket + 'static> Link for Upstream<S> {
    fn ready(&self) -> bool {
        self.0.ready()
    }

    fn failed(&self) -> bool {
        self.0.failed()
    }

    fn request(&mut self, payload: &[u8]) -> Result<u32, LinkError> {
        self.0.request(payload)
    }

    fn peek(&self) -> Option<Frame<'_>> {
        self.0.peek()
    }

    fn consume(&mut self) -> Result<(), LinkError> {
        self.0.consume()
    }
}
