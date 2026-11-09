#![allow(unsafe_code)]

mod native {
    #![allow(dead_code, non_camel_case_types, non_snake_case)]
    #![allow(clippy::upper_case_acronyms)]
    include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
}

#[allow(dead_code)]
mod audio_callbacks;
mod cover_fetch;
#[allow(dead_code)]
mod direct_input;
#[allow(dead_code)]
mod lifecycle;
#[allow(dead_code)]
mod listener_callbacks;
#[allow(dead_code)]
mod native_engine;
mod stream_worker;
#[allow(dead_code)]
mod video_callbacks;

use std::ffi::{CStr, CString};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

static PAIR_ACTIVE: AtomicBool = AtomicBool::new(false);
static PAIR_OUTPUT: AtomicI32 = AtomicI32::new(libc::STDOUT_FILENO);

fn main() {
    PAIR_ACTIVE.store(
        std::env::args().nth(1).as_deref() == Some("pair"),
        Ordering::Relaxed,
    );
    if unsafe { libc::signal(libc::SIGALRM, on_timeout as *const () as libc::sighandler_t) }
        == libc::SIG_ERR
    {
        eprintln!("cannot install timeout handler");
        std::process::exit(1);
    }
    if let Err(error) = run() {
        let code = match error {
            WorkerError::Failed => 1,
            WorkerError::TooLarge => 4,
            WorkerError::NotPaired => moonlight_nx2_host::helper::NOT_PAIRED_EXIT_CODE,
            WorkerError::PairReported => 1,
        };
        if PAIR_ACTIVE.load(Ordering::Relaxed) && !matches!(error, WorkerError::PairReported) {
            let _ = output(
                &serde_json::json!({"event":"failed", "reason":"worker failed", "code":code}),
            );
        }
        eprintln!("upstream worker failed");
        std::process::exit(code);
    }
}

extern "C" fn on_timeout(_: libc::c_int) {
    if PAIR_ACTIVE.load(Ordering::Relaxed) {
        let message = b"{\"event\":\"failed\",\"reason\":\"pairing timed out\",\"code\":3}\n";
        unsafe {
            libc::write(
                PAIR_OUTPUT.load(Ordering::Relaxed),
                message.as_ptr().cast(),
                message.len(),
            )
        };
    }
    unsafe { libc::_exit(3) }
}

enum WorkerError {
    Failed,
    TooLarge,
    NotPaired,
    PairReported,
}

impl From<()> for WorkerError {
    fn from(_: ()) -> Self {
        Self::Failed
    }
}

type WorkerResult = Result<(), WorkerError>;

fn run() -> WorkerResult {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if arguments.first().is_some_and(|value| value == "stream") {
        return stream_worker::run(&arguments[1..]);
    }
    let mut args = arguments.into_iter();
    let operation = args.next().ok_or(())?;
    let host = CString::new(args.next().ok_or(())?).map_err(|_| ())?;
    let app = if operation == "cover" {
        let value: u32 = args.next().ok_or(())?.parse().map_err(|_| ())?;
        if value == 0 {
            return Err(WorkerError::Failed);
        }
        Some(value)
    } else {
        None
    };
    let timeout = if operation == "pair" {
        if args.next().as_deref() != Some("--timeout") {
            return Err(WorkerError::Failed);
        }
        let value: u32 = args.next().ok_or(())?.parse().map_err(|_| ())?;
        if !(1..=600).contains(&value) {
            return Err(WorkerError::Failed);
        }
        value.min(moonlight_nx2_host::helper::PAIR_TIMEOUT_MAX_SECONDS)
    } else {
        0
    };
    if args.next().is_some()
        || !matches!(
            operation.as_str(),
            "list" | "pair" | "unpair" | "quit" | "cover"
        )
    {
        return Err(WorkerError::Failed);
    }
    let key_path = key_directory()?;
    let keys = CString::new(key_path.as_os_str().as_bytes()).map_err(|_| ())?;
    let mut server = connect(&host, &keys)?;
    match operation.as_str() {
        "pair" => pair(&mut server, &host, timeout),
        "unpair" => unpair(&mut server),
        "quit" => quit(&mut server, &host, &keys),
        "list" => list(&mut server, &host, &key_path),
        "cover" => cover_fetch::fetch(&server, &host, &key_path, app.expect("cover app")),
        _ => Err(WorkerError::Failed),
    }
}

struct Deadline;

impl Deadline {
    fn new(seconds: u32) -> Self {
        unsafe { libc::alarm(seconds) };
        Self
    }
}

impl Drop for Deadline {
    fn drop(&mut self) {
        unsafe { libc::alarm(0) };
    }
}

fn connect(host: &CStr, keys: &CStr) -> Result<native::SERVER_DATA, ()> {
    let mut server = unsafe { std::mem::zeroed::<native::SERVER_DATA>() };
    unsafe { libc::fflush(ptr::null_mut()) };
    let saved = unsafe { libc::dup(libc::STDOUT_FILENO) };
    if saved < 0 {
        return Err(());
    }
    PAIR_OUTPUT.store(saved, Ordering::Relaxed);
    if unsafe { libc::dup2(libc::STDERR_FILENO, libc::STDOUT_FILENO) } < 0 {
        unsafe { libc::close(saved) };
        return Err(());
    }
    let result = {
        let _deadline = Deadline::new(15);
        unsafe {
            native::gs_init(
                &mut server,
                host.as_ptr().cast_mut(),
                47989,
                keys.as_ptr(),
                0,
                true,
            )
        }
    };
    unsafe { libc::fflush(ptr::null_mut()) };
    let restored = unsafe { libc::dup2(saved, libc::STDOUT_FILENO) };
    PAIR_OUTPUT.store(libc::STDOUT_FILENO, Ordering::Relaxed);
    unsafe { libc::close(saved) };
    if restored < 0 || result != 0 {
        return Err(());
    }
    Ok(server)
}

fn output(value: &serde_json::Value) -> WorkerResult {
    let bytes = serde_json::to_vec(value).map_err(|_| ())?;
    if bytes.len() > 64 * 1024 - 1 {
        return Err(WorkerError::TooLarge);
    }
    let mut stdout = io::stdout().lock();
    stdout.write_all(&bytes).map_err(|_| ())?;
    stdout.write_all(b"\n").map_err(|_| ())?;
    stdout.flush().map_err(|_| WorkerError::Failed)
}

fn pair(server: &mut native::SERVER_DATA, host: &CStr, timeout: u32) -> WorkerResult {
    if server.paired {
        return output(&serde_json::json!({"event":"paired", "already":true}));
    }
    if server.currentGame != 0 {
        output(
            &serde_json::json!({"event":"failed", "reason":"pc_busy", "code":-4, "app":server.currentGame}),
        )?;
        return Err(WorkerError::PairReported);
    }
    let mut random = [0u8; 4];
    std::fs::File::open("/dev/urandom")
        .map_err(|_| ())?
        .read_exact(&mut random)
        .map_err(|_| ())?;
    let pin: String = random
        .into_iter()
        .map(|byte| char::from(b'0' + byte % 10))
        .collect();
    let host = host.to_str().map_err(|_| ())?;
    let url = if host.contains(':') {
        format!("https://[{host}]:47990/pin")
    } else {
        format!("https://{host}:47990/pin")
    };
    output(&serde_json::json!({"event":"pin", "pin":pin, "url":url, "timeout":timeout}))?;
    let pin = CString::new(pin).map_err(|_| ())?;
    let result = {
        let _deadline = Deadline::new(timeout);
        unsafe { native::gs_pair(server, pin.as_ptr().cast_mut()) }
    };
    eprintln!("moonlight-worker gs_pair_return={result}");
    if result != 0 {
        output(
            &serde_json::json!({"event":"failed", "reason":"pairing request failed", "code":result}),
        )?;
        return Err(WorkerError::PairReported);
    }
    output(&serde_json::json!({"event":"paired", "already":false}))
}

fn unpair(server: &mut native::SERVER_DATA) -> WorkerResult {
    if !server.paired {
        return output(&serde_json::json!({"event":"unpaired", "already":true}));
    }
    let result = {
        let _deadline = Deadline::new(15);
        unsafe { native::gs_unpair(server) }
    };
    if result != 0 {
        return Err(WorkerError::Failed);
    }
    output(&serde_json::json!({"event":"unpaired", "already":false}))
}

fn not_paired() -> WorkerError {
    eprintln!(
        r#"{{"event":"error","message":"not paired","detail":"run: hbmoonlight pair HOST"}}"#
    );
    WorkerError::NotPaired
}

fn quit(server: &mut native::SERVER_DATA, host: &CStr, keys: &CStr) -> WorkerResult {
    if !server.paired {
        return Err(not_paired());
    }
    if server.currentGame == 0 {
        return output(
            &serde_json::json!({"event":"quit", "cancelled":false, "already":true, "currentGame":0}),
        );
    }
    let result = {
        let _deadline = Deadline::new(30);
        unsafe { native::gs_quit_app(server) }
    };
    if result != 0 {
        return Err(WorkerError::Failed);
    }
    unsafe { native::http_cleanup() };
    let current = connect(host, keys).map_or(-1, |server| server.currentGame);
    output(
        &serde_json::json!({"event":"quit", "cancelled":true, "already":false, "currentGame":current}),
    )
}

fn list(server: &mut native::SERVER_DATA, host: &CStr, key_path: &std::path::Path) -> WorkerResult {
    if !server.paired {
        return Err(not_paired());
    }
    let _deadline = Deadline::new(15);
    let mut list = ptr::null_mut();
    if unsafe { native::gs_applist(server, &mut list) } != 0 {
        return Err(WorkerError::Failed);
    }
    let mut apps = Vec::new();
    let mut app_bytes = 0usize;
    let mut current = list;
    while !current.is_null() {
        if apps.len() >= 4096 {
            return Err(WorkerError::TooLarge);
        }
        let app = unsafe { &*current };
        if app.name.is_null() {
            return Err(WorkerError::Failed);
        }
        let length = unsafe { libc::strnlen(app.name, 65_536) };
        if length == 65_536 {
            return Err(WorkerError::TooLarge);
        }
        let name =
            String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(app.name.cast(), length) });
        let value = serde_json::json!({"id": app.id, "name": name});
        app_bytes = app_bytes
            .checked_add(serde_json::to_vec(&value).map_err(|_| ())?.len() + 1)
            .ok_or(())?;
        if app_bytes > 65_536 {
            return Err(WorkerError::TooLarge);
        }
        apps.push(value);
        current = app.next;
    }
    apps.reverse();
    let mut value = serde_json::json!({"currentGame": server.currentGame, "apps": apps});
    if let Some((server_id, mac)) = server_details(server, host, key_path) {
        if let Some(server_id) = server_id {
            value["uniqueid"] = server_id.into();
        }
        if let Some(mac) = mac {
            value["macs"] = serde_json::json!([mac]);
        }
    }
    output(&value)
}

fn server_details(
    server: &native::SERVER_DATA,
    host: &CStr,
    key_path: &std::path::Path,
) -> Option<(Option<String>, Option<String>)> {
    let mut client_id = Vec::new();
    std::fs::File::open(key_path.join("uniqueid.dat"))
        .ok()?
        .take(63)
        .read_to_end(&mut client_id)
        .ok()?;
    let client_id = std::str::from_utf8(&client_id).ok()?;
    if client_id.is_empty() || client_id.contains('\0') {
        return None;
    }
    let mut random = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .ok()?
        .read_exact(&mut random)
        .ok()?;
    random[6] = (random[6] & 0x0f) | 0x40;
    random[8] = (random[8] & 0x3f) | 0x80;
    let uuid = format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        random[0],
        random[1],
        random[2],
        random[3],
        random[4],
        random[5],
        random[6],
        random[7],
        random[8],
        random[9],
        random[10],
        random[11],
        random[12],
        random[13],
        random[14],
        random[15]
    );
    let url = CString::new(format!(
        "https://{}:{}/serverinfo?uniqueid={client_id}&uuid={uuid}",
        host.to_str().ok()?,
        server.httpsPort
    ))
    .ok()?;
    unsafe {
        let data = native::http_create_data();
        if data.is_null() {
            return None;
        }
        let result = if native::http_request(url.as_ptr().cast_mut(), data) == 0 {
            let read = |name: &CStr| {
                let mut found = ptr::null_mut();
                let result = if native::xml_search(
                    (*data).memory,
                    (*data).size,
                    name.as_ptr().cast_mut(),
                    &mut found,
                ) == 0
                    && !found.is_null()
                {
                    CStr::from_ptr(found).to_str().ok().map(str::to_owned)
                } else {
                    None
                };
                libc::free(found.cast());
                result.filter(|value| !value.is_empty())
            };
            Some((
                read(c"uniqueid"),
                read(c"mac").and_then(|value| moonlight_nx2_host::mac::normalize(&value)),
            ))
        } else {
            None
        };
        native::http_free_data(data);
        result
    }
}

fn key_directory() -> Result<PathBuf, ()> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or(())?;
    let current = base.join("moonlight-nx2");
    if current.exists() {
        return Ok(current);
    }
    let legacy = base.join("hblauncher/moonlight");
    if legacy.is_dir() {
        return Ok(legacy);
    }
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&current)
        .map_err(|_| ())?;
    Ok(current)
}
