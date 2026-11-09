use core::fmt::{self, Write};
use moonlight_nx2_core::media::Header;
use moonlight_nx2_io::socket::{IoError, Socket};
use moonlight_nx2_io::udp::{self, Datagram, Receiver};

pub const SESSION_BYTES: usize = 512;
pub const MAX_PAYLOAD: usize = 4096;
pub const UNIT_BYTES: usize = MAX_PAYLOAD * udp::UNIT_SLOTS;
pub const FEEDBACK_BYTES: usize = 8192;
pub const DEADLINE_US: u64 = 20_000_000;
pub const HOLD_US: u64 = 100_000;
pub const LENGTHS: [usize; 3] = [256, 1361, 4096];
pub const SEQUENCES: [u32; 3] = [u32::MAX - 2, 7, u32::MAX];
pub const TIMESTAMPS: [u64; 3] = [0, 0x1_0000_0011, 9_007_199_254_740_991];

pub struct Session {
    pub address: [u8; 4],
    pub feedback_port: u16,
    pub udp_port: u16,
    pub feedback_token: [u8; 64],
    pub udp_token: [u8; 64],
    pub run_id: [u8; 32],
}

fn hex(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { core::ptr::write_volatile(byte, 0) };
    }
}

impl Session {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() >= SESSION_BYTES {
            return None;
        }
        let mut session = Self {
            address: [0; 4],
            feedback_port: 0,
            udp_port: 0,
            feedback_token: [0; 64],
            udp_token: [0; 64],
            run_id: [0; 32],
        };
        let text = core::str::from_utf8(bytes).ok()?;
        let mut seen = 0u8;
        for line in text.lines() {
            let (key, value) = line.split_once('=')?;
            let bit = match key {
                "profile" if value == "baseline-v1" => 1,
                "address" => {
                    let mut parts = value.split('.');
                    for byte in &mut session.address {
                        let part = parts.next()?;
                        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                            return None;
                        }
                        *byte = part.parse().ok()?;
                    }
                    if parts.next().is_some() || matches!(session.address[0], 0 | 224..=255) {
                        return None;
                    }
                    2
                }
                "feedback_port" | "udp_port" => {
                    if value.is_empty()
                        || value.len() > 5
                        || !value.bytes().all(|byte| byte.is_ascii_digit())
                    {
                        return None;
                    }
                    let port: u16 = value.parse().ok()?;
                    if port == 0 {
                        return None;
                    }
                    if key == "feedback_port" {
                        session.feedback_port = port;
                        4
                    } else {
                        session.udp_port = port;
                        8
                    }
                }
                "feedback_token" | "udp_token" if value.len() == 64 && hex(value.as_bytes()) => {
                    if key == "feedback_token" {
                        session.feedback_token.copy_from_slice(value.as_bytes());
                        16
                    } else {
                        session.udp_token.copy_from_slice(value.as_bytes());
                        32
                    }
                }
                "run_id" if value.len() == 32 && hex(value.as_bytes()) => {
                    session.run_id.copy_from_slice(value.as_bytes());
                    64
                }
                _ => return None,
            };
            if seen & bit != 0 {
                return None;
            }
            seen |= bit;
        }
        (seen == 127 && session.feedback_token != session.udp_token).then_some(session)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        wipe(&mut self.feedback_token);
        wipe(&mut self.udp_token);
    }
}

pub trait Env {
    type Socket: Socket;
    type Datagram: Datagram;
    fn now_us(&mut self) -> u64;
    fn connect_feedback(&mut self, address: [u8; 4], port: u16) -> Result<Self::Socket, IoError>;
    fn connect_datagram(&mut self, address: [u8; 4], port: u16) -> Result<Self::Datagram, IoError>;
    fn running(&mut self) -> bool {
        true
    }
    fn idle(&mut self);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Failure {
    Clock,
    Timeout,
    Cancelled,
    FeedbackOpen(IoError),
    DatagramOpen(IoError),
    Receiver(udp::Error),
    Header,
    Payload,
    ExtraUnit,
    Counters,
    Close,
}

pub struct Report {
    pub run_id: [u8; 32],
    pub failure: Option<Failure>,
    pub units: usize,
    pub bytes: usize,
    pub held_checks: usize,
    pub end: bool,
    pub drained: bool,
    pub close: udp::CloseError,
    pub stats: udp::Stats,
    pub elapsed_us: u64,
}

impl Report {
    fn new(run_id: [u8; 32]) -> Self {
        Self {
            run_id,
            failure: None,
            units: 0,
            bytes: 0,
            held_checks: 0,
            end: false,
            drained: false,
            close: udp::CloseError::default(),
            stats: udp::Stats::default(),
            elapsed_us: 0,
        }
    }

    pub fn passed(&self) -> bool {
        self.failure.is_none()
            && self.units == LENGTHS.len()
            && self.bytes == LENGTHS.iter().sum()
            && self.held_checks > 1
            && self.end
            && self.drained
            && self.close == udp::CloseError::default()
    }

    pub fn write(&self, out: &mut impl Write) -> fmt::Result {
        writeln!(
            out,
            "udp_diag.run_id={}",
            core::str::from_utf8(&self.run_id).unwrap_or("invalid")
        )?;
        writeln!(
            out,
            "udp_diag.units={} bytes={} held_checks={}",
            self.units, self.bytes, self.held_checks
        )?;
        writeln!(
            out,
            "udp_diag.end={} drained={} elapsed_us={}",
            self.end, self.drained, self.elapsed_us
        )?;
        writeln!(
            out,
            "udp_diag.close_feedback={:?} close_datagram={:?}",
            self.close.feedback, self.close.datagram
        )?;
        writeln!(
            out,
            "udp_diag.received={} copies={} repaired={} nacks={} duplicates={} reorders={}",
            self.stats.received,
            self.stats.copies,
            self.stats.repaired,
            self.stats.nacks,
            self.stats.duplicates,
            self.stats.reorders
        )?;
        writeln!(
            out,
            "udp_diag.late={} skipped={} invalid={} zero={} acked={} feedback_bytes={}",
            self.stats.late_drops,
            self.stats.skipped,
            self.stats.invalid,
            self.stats.zero_datagrams,
            self.stats.acknowledged,
            self.stats.feedback_bytes
        )?;
        writeln!(out, "udp_diag.failure={:?}", self.failure)?;
        writeln!(
            out,
            "udp_diag.result={}",
            if self.passed() { "PASS" } else { "FAIL" }
        )
    }
}

pub fn pattern(frame: usize, index: usize) -> u8 {
    (index
        .wrapping_mul(73)
        .wrapping_add(19)
        .wrapping_add(frame * 17)) as u8
}

pub fn run<E: Env>(
    env: &mut E,
    session: Session,
    units: &mut [u8],
    feedback_memory: &mut [u8],
) -> Report {
    let start = env.now_us();
    let mut report = Report::new(session.run_id);
    let feedback = match env.connect_feedback(session.address, session.feedback_port) {
        Ok(socket) => socket,
        Err(error) => {
            report.failure = Some(Failure::FeedbackOpen(error));
            return report;
        }
    };
    let datagram = match env.connect_datagram(session.address, session.udp_port) {
        Ok(socket) => socket,
        Err(error) => {
            let mut feedback = feedback;
            report.close.feedback = feedback.close().err();
            report.failure = Some(Failure::DatagramOpen(error));
            return report;
        }
    };
    let config = udp::Config {
        feedback_token: session.feedback_token,
        udp_token: session.udp_token,
        max_payload: MAX_PAYLOAD,
        deadline_us: 500_000,
        spread_us: 83_334,
        pace_bytes_per_ms: 12_500,
        hello_ms: 8000,
        connect_timeout_us: 5_000_000,
        datagram_budget: 64,
    };
    let mut receiver = match Receiver::open(
        config,
        udp::Memory {
            units,
            feedback: feedback_memory,
        },
        feedback,
        datagram,
        start,
    ) {
        Ok(receiver) => receiver,
        Err((error, mut feedback, mut datagram)) => {
            report.failure = Some(Failure::Receiver(error));
            report.close.feedback = feedback.close().err();
            report.close.datagram = datagram.close().err();
            return report;
        }
    };
    let mut held_at = None;
    let mut previous = start;
    loop {
        let now = env.now_us();
        if now < previous {
            report.failure = Some(Failure::Clock);
            break;
        }
        previous = now;
        report.elapsed_us = now - start;
        if report.elapsed_us >= DEADLINE_US {
            report.failure = Some(Failure::Timeout);
            break;
        }
        if !env.running() {
            report.failure = Some(Failure::Cancelled);
            break;
        }
        match receiver.pump(now) {
            Ok(()) | Err(udp::Error::Ended) => {}
            Err(error) => {
                report.failure = Some(Failure::Receiver(error));
                break;
            }
        }
        if let Some(unit) = receiver.peek() {
            let frame = report.units;
            if frame >= LENGTHS.len() {
                report.failure = Some(Failure::ExtraUnit);
                break;
            }
            let header = Header {
                payload_bytes: LENGTHS[frame] as u32,
                sequence: SEQUENCES[frame],
                pts_us: TIMESTAMPS[frame],
            };
            if unit.transport_frame != frame as u32
                || unit.header != header
                || unit.keyframe != (frame != 1)
            {
                report.failure = Some(Failure::Header);
                break;
            }
            if unit
                .payload
                .iter()
                .enumerate()
                .any(|(index, byte)| *byte != pattern(frame, index))
            {
                report.failure = Some(Failure::Payload);
                break;
            }
            let waiting = if frame == 0 {
                report.held_checks += 1;
                now - *held_at.get_or_insert(now) < HOLD_US
            } else {
                false
            };
            if !waiting {
                match receiver.acknowledge(&[]) {
                    Ok(()) => {
                        report.units += 1;
                        report.bytes += LENGTHS[frame];
                    }
                    Err(udp::Error::Again) => {}
                    Err(error) => {
                        report.failure = Some(Failure::Receiver(error));
                        break;
                    }
                }
            }
        }
        report.end = receiver.receive_ended();
        report.drained = receiver.drained();
        if report.drained {
            break;
        }
        env.idle();
    }
    let (closed, stats) = receiver.close();
    report.stats = stats;
    if let Err(error) = closed {
        report.close = error;
        report.failure.get_or_insert(Failure::Close);
    }
    if report.failure.is_none()
        && (stats.late_drops != 0
            || stats.skipped != 0
            || stats.invalid != 0
            || stats.acknowledged != LENGTHS.len() as u64
            || stats.feedback_bytes != 0)
    {
        report.failure = Some(Failure::Counters);
    }
    report
}

#[cfg(target_os = "none")]
pub use native::check;

#[cfg(target_os = "none")]
mod native {
    use super::*;
    use crate::{
        device::log,
        net::{NetSocket, UdpSocket},
        sdk,
    };
    use core::cell::UnsafeCell;
    use core::ffi::c_char;
    use core::sync::atomic::{AtomicBool, Ordering};

    unsafe extern "C" {
        fn moonlightPlatformNetStart() -> bool;
        fn moonlightPlatformNetStop();
        fn moonlightIoTakeSession(
            path: *const c_char,
            data: *mut u8,
            capacity: usize,
            bytes: *mut usize,
        ) -> u32;
    }

    struct Storage(UnsafeCell<([u8; UNIT_BYTES], [u8; FEEDBACK_BYTES])>);
    unsafe impl Sync for Storage {}
    static STORAGE: Storage = Storage(UnsafeCell::new(([0; UNIT_BYTES], [0; FEEDBACK_BYTES])));
    static TAKEN: AtomicBool = AtomicBool::new(false);

    struct DeviceEnv;
    impl Env for DeviceEnv {
        type Socket = NetSocket;
        type Datagram = UdpSocket;
        fn now_us(&mut self) -> u64 {
            (unsafe { sdk::moonlightNowNs() }) / 1000
        }
        fn connect_feedback(&mut self, address: [u8; 4], port: u16) -> Result<NetSocket, IoError> {
            NetSocket::connect(address, port)
        }
        fn connect_datagram(&mut self, address: [u8; 4], port: u16) -> Result<UdpSocket, IoError> {
            UdpSocket::connect(address, port)
        }
        fn running(&mut self) -> bool {
            unsafe { sdk::appletMainLoop() }
        }
        fn idle(&mut self) {
            unsafe { sdk::svcSleepThread(1_000_000) };
        }
    }

    struct LineLog {
        bytes: [u8; 512],
        length: usize,
    }
    impl LineLog {
        fn flush(&mut self) {
            if let Ok(text) = core::str::from_utf8(&self.bytes[..self.length]) {
                log(text);
            }
            self.length = 0;
        }
    }
    impl Write for LineLog {
        fn write_str(&mut self, text: &str) -> fmt::Result {
            for byte in text.bytes() {
                if byte == b'\n' {
                    self.flush();
                } else if self.length < self.bytes.len() {
                    self.bytes[self.length] = byte;
                    self.length += 1;
                } else {
                    return Err(fmt::Error);
                }
            }
            Ok(())
        }
    }

    pub fn check() -> bool {
        if TAKEN.swap(true, Ordering::AcqRel) {
            log("udp_diag: already ran");
            return false;
        }
        let mut secret = [0; SESSION_BYTES];
        let mut bytes = 0;
        let result = unsafe {
            moonlightIoTakeSession(
                c"sdmc:/switch/moonlight-nx2/rust/udp-session".as_ptr(),
                secret.as_mut_ptr(),
                secret.len(),
                &mut bytes,
            )
        };
        let session = if result == 0 && bytes < secret.len() {
            Session::parse(&secret[..bytes])
        } else {
            None
        };
        wipe(&mut secret);
        let Some(session) = session else {
            log("udp_diag: one-time session unavailable or invalid");
            return false;
        };
        if !unsafe { moonlightPlatformNetStart() } {
            log("udp_diag: network initialization failed");
            return false;
        }
        let (units, feedback) = unsafe { &mut *STORAGE.0.get() };
        let report = run(&mut DeviceEnv, session, units, feedback);
        let mut out = LineLog {
            bytes: [0; 512],
            length: 0,
        };
        let written = report.write(&mut out).is_ok();
        out.flush();
        if report.close != udp::CloseError::default() {
            sdk::retire_process();
        }
        if !sdk::process_retired() {
            unsafe { moonlightPlatformNetStop() };
        }
        report.passed() && written
    }
}
