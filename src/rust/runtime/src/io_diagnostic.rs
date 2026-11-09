//! Device entry of the io diagnostic (moonlight-nx2-dev/src/rust/io/README.md, "Diagnostic").
//! Reads and removes the one-time session file, runs `io::diagnostic` once over libounce
//! sockets and, in audio mode, audout, then logs the report. Never logs a token.

use crate::audio_device::Audout;
use crate::device::log;
use crate::net::NetSocket;
use crate::sdk;
use core::cell::UnsafeCell;
use core::ffi::c_char;
use core::fmt::{self, Write};
use core::sync::atomic::{AtomicBool, Ordering};
use moonlight_nx2_io::audio::{Retained, SLOT_BYTES, SLOTS, Slots};
use moonlight_nx2_io::diagnostic::{
    self, CONTROL_OUTBOUND_BYTES, Env, Memory, Mode, OUTBOUND_BYTES, PCM_CHUNK_BYTES, Retention,
    Session, VIDEO_MEMORY,
};
use moonlight_nx2_io::socket::IoError;

const SESSION_PATH: &[u8] = b"sdmc:/switch/moonlight-nx2/rust/io-session\0";
const SESSION_BYTES: usize = 1024;

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

struct Buffers {
    control: [u8; 65536],
    control_outbound: [u8; CONTROL_OUTBOUND_BYTES],
    video: [u8; VIDEO_MEMORY],
    video_outbound: [u8; OUTBOUND_BYTES],
    pcm: [u8; PCM_CHUNK_BYTES],
    pcm_outbound: [u8; OUTBOUND_BYTES],
    slots: Slots,
}

struct Storage(UnsafeCell<Buffers>);

unsafe impl Sync for Storage {}

static STORAGE: Storage = Storage(UnsafeCell::new(Buffers {
    control: [0; 65536],
    control_outbound: [0; CONTROL_OUTBOUND_BYTES],
    video: [0; VIDEO_MEMORY],
    video_outbound: [0; OUTBOUND_BYTES],
    pcm: [0; PCM_CHUNK_BYTES],
    pcm_outbound: [0; OUTBOUND_BYTES],
    slots: Slots([[0; SLOT_BYTES]; SLOTS]),
}));
static TAKEN: AtomicBool = AtomicBool::new(false);

/// The static buffers, handed out once per process. The slots stay borrowed for good when
/// audio keeps them.
fn take_storage() -> Option<&'static mut Buffers> {
    if TAKEN.swap(true, Ordering::AcqRel) {
        return None;
    }
    Some(unsafe { &mut *STORAGE.0.get() })
}

struct DeviceEnv;

impl Env for DeviceEnv {
    type Socket = NetSocket;

    fn now_ms(&mut self) -> u64 {
        (unsafe { sdk::moonlightNowNs() }) / 1_000_000
    }

    fn connect(&mut self, address: [u8; 4], port: u16) -> Result<NetSocket, IoError> {
        NetSocket::connect(address, port)
    }

    fn idle(&mut self) {
        unsafe { sdk::svcSleepThread(1_000_000) };
    }
}

/// Collects `Report::write` output and logs it one line at a time.
struct LineLog {
    line: [u8; 512],
    length: usize,
}

impl LineLog {
    fn flush(&mut self) {
        if let Ok(text) = core::str::from_utf8(&self.line[..self.length]) {
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
            } else if self.length < self.line.len() {
                self.line[self.length] = byte;
                self.length += 1;
            }
        }
        Ok(())
    }
}

fn take_session() -> Option<Session> {
    let mut text = [0u8; SESSION_BYTES];
    let mut bytes = 0;
    let status = unsafe {
        moonlightIoTakeSession(
            SESSION_PATH.as_ptr().cast(),
            text.as_mut_ptr(),
            text.len(),
            &mut bytes,
        )
    };
    let session = match status {
        0 => Session::parse(&text[..bytes.min(SESSION_BYTES)]),
        _ => None,
    };
    for byte in &mut text {
        unsafe { core::ptr::write_volatile(byte, 0) };
    }
    if session.is_none() {
        log(match status {
            0 => "io: session file invalid; removed",
            1 => "io: no session file",
            2 => "io: session file too large; removed",
            _ => "io: session file could not be removed; refusing to run",
        });
    }
    session
}

/// One bounded run. Returns whether every check passed. Audio memory the device may still
/// own is never returned; the process is retired instead.
pub fn io_check() -> bool {
    let Some(session) = take_session() else {
        return false;
    };
    let Some(buffers) = take_storage() else {
        log("io: diagnostic already ran in this process");
        return false;
    };
    if !unsafe { moonlightPlatformNetStart() } {
        log("io: socket initialization failed");
        return false;
    }

    let mode = session.mode;
    log(match mode {
        Mode::Sockets => "io: diagnostic start, sockets only",
        Mode::Audio => "io: diagnostic start, sockets and audio",
    });
    let memory = Memory {
        control: &mut buffers.control,
        control_outbound: &mut buffers.control_outbound,
        video: &mut buffers.video,
        video_outbound: &mut buffers.video_outbound,
        pcm: &mut buffers.pcm,
        pcm_outbound: &mut buffers.pcm_outbound,
    };
    let audio = match mode {
        Mode::Audio => Some((Audout::new(), &mut buffers.slots)),
        Mode::Sockets => None,
    };

    let mut env = DeviceEnv;
    let (report, retained) = diagnostic::run(&mut env, session, memory, audio);
    unsafe { moonlightPlatformNetStop() };

    let mut out = LineLog {
        line: [0; 512],
        length: 0,
    };
    let _ = report.write(&mut out);
    out.flush();

    match retained {
        Some(Retained::Returned(device, _)) if device.last_result() != 0 => {
            let mut out = LineLog {
                line: [0; 512],
                length: 0,
            };
            let _ = writeln!(out, "io: audout last result 0x{:x}", device.last_result());
        }
        Some(Retained::Kept) => {
            log("io: audio memory kept by the device; retiring process");
            sdk::retire_process();
        }
        _ => {}
    }
    if report.retention == Retention::Kept {
        sdk::retire_process();
    }
    report.passed()
}
