/// One nonblocking TCP connection. The SDK implementation belongs to the runtime crate;
/// channels only drive these calls and never retry a call whose result was an error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IoError {
    WouldBlock,
    Interrupted,
    Refused(i32),
    Disconnected(i32),
    Failed,
}

impl IoError {
    pub fn is_retry(self) -> bool {
        matches!(self, Self::WouldBlock | Self::Interrupted)
    }
}

pub trait Socket {
    /// `Ok(true)` once the connection is established, `Ok(false)` while it is in progress.
    fn poll_connect(&mut self) -> Result<bool, IoError>;
    /// Bytes accepted, never more than `bytes.len()`.
    fn send(&mut self, bytes: &[u8]) -> Result<usize, IoError>;
    /// Bytes read, never more than `bytes.len()`; `Ok(0)` is end of stream.
    fn recv(&mut self, bytes: &mut [u8]) -> Result<usize, IoError>;
    fn close(&mut self) -> Result<(), IoError>;
}

pub(crate) fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { core::ptr::write_volatile(byte, 0) };
    }
}
