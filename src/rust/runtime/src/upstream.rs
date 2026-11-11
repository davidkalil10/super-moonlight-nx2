//! Where control-v1 requests go: the PC helper's authenticated channel, or Sunshine itself.

extern crate alloc;

use alloc::boxed::Box;

use moonlight_nx2_app::{
    direct::{Dial, DirectLink},
    link::{Link, LinkError},
};
use moonlight_nx2_core::control::Frame;
use moonlight_nx2_io::{control, secure::SecureSocket, socket::Socket};
use moonlight_nx2_ui::store::Files;

use crate::control_link::{Closed, Control};

pub type Dialer<S> = Box<dyn Dial<Socket = S>>;

pub enum Upstream<S: Socket + 'static> {
    Helper(Control<SecureSocket<S>>),
    Direct(Box<DirectLink<Dialer<S>>>),
}

impl<S: Socket + 'static> Upstream<S> {
    pub fn direct(&self) -> bool {
        matches!(self, Self::Direct(_))
    }

    pub fn pump(&mut self, files: &mut impl Files, now_ms: u64) -> Result<(), control::Error> {
        match self {
            Self::Helper(control) => control.pump(now_ms),
            Self::Direct(link) => {
                link.pump(files, now_ms);
                Ok(())
            }
        }
    }

    pub fn rejected(&self) -> bool {
        match self {
            Self::Helper(control) => control.rejected(),
            Self::Direct(_) => false,
        }
    }

    pub fn stats(&self) -> Option<control::Stats> {
        match self {
            Self::Helper(control) => control.stats(),
            Self::Direct(_) => None,
        }
    }

    pub fn close(&mut self) -> Option<Closed> {
        match self {
            Self::Helper(control) => control.close(),
            Self::Direct(link) => {
                link.close();
                Some(Closed {
                    error: None,
                    stats: control::Stats::default(),
                    retained: false,
                })
            }
        }
    }
}

impl<S: Socket + 'static> Link for Upstream<S> {
    fn ready(&self) -> bool {
        match self {
            Self::Helper(control) => control.ready(),
            Self::Direct(link) => link.ready(),
        }
    }

    fn failed(&self) -> bool {
        match self {
            Self::Helper(control) => control.failed(),
            Self::Direct(link) => link.failed(),
        }
    }

    fn request(&mut self, payload: &[u8]) -> Result<u32, LinkError> {
        match self {
            Self::Helper(control) => control.request(payload),
            Self::Direct(link) => link.request(payload),
        }
    }

    fn peek(&self) -> Option<Frame<'_>> {
        match self {
            Self::Helper(control) => control.peek(),
            Self::Direct(link) => link.peek(),
        }
    }

    fn consume(&mut self) -> Result<(), LinkError> {
        match self {
            Self::Helper(control) => control.consume(),
            Self::Direct(link) => link.consume(),
        }
    }
}
