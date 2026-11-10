//! What the host's integration tests share: helper scripts, an authenticated controller and
//! the one-launch host with its control connection.
#![allow(dead_code)]

use moonlight_nx2_core::control::{Frame, Header, Kind};
use moonlight_nx2_host::{controller::Controller, helper::Helper};
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, TcpStream},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

pub const TOKEN: [u8; 64] = [b'a'; 64];

/// A new directory under the system's temporary one, named after the test and this process.
pub fn temp_dir(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("moonlight-{name}-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    root
}

/// Writes an executable helper script into `root`.
pub fn helper_script(root: &Path, script: &str) -> PathBuf {
    let helper = root.join("helper");
    fs::write(&helper, script).unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    helper
}

pub fn frame(kind: Kind, id: u32, payload: &[u8]) -> Frame<'_> {
    Frame {
        header: Header::new(kind, id, payload.len()).unwrap(),
        payload,
    }
}

/// A controller over `helper` that has taken the console's token.
pub fn controller(helper: &Path) -> Controller {
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut controller = Controller::new(TOKEN, Helper::new(helper).unwrap(), ip, ip).unwrap();
    controller
        .authenticate(frame(Kind::Auth, 0, &TOKEN))
        .unwrap();
    controller
}

pub fn send(socket: &mut TcpStream, kind: Kind, id: u32, data: &[u8]) {
    socket
        .write_all(&Header::new(kind, id, data.len()).unwrap().encode().unwrap())
        .unwrap();
    socket.write_all(data).unwrap();
}

pub fn receive(socket: &mut TcpStream) -> (Kind, u32, Value) {
    let mut head = [0; 16];
    socket.read_exact(&mut head).unwrap();
    let header = Header::decode(&head).unwrap();
    let mut payload = vec![0; header.payload_bytes as usize];
    socket.read_exact(&mut payload).unwrap();
    (
        header.kind,
        header.request_id,
        serde_json::from_slice(&payload).unwrap(),
    )
}

/// Sends a request and returns the first frame that answers it.
pub fn request(socket: &mut TcpStream, id: u32, body: Value) -> (Kind, u32, Value) {
    send(
        socket,
        Kind::Request,
        id,
        &serde_json::to_vec(&body).unwrap(),
    );
    loop {
        let response = receive(socket);
        if response.1 == id {
            return response;
        }
    }
}

/// Starts the host for one launch over `helper` and opens its control connection as the
/// console would, token accepted.
pub fn one_launch_host(helper: &Path) -> (Child, TcpStream) {
    let mut process = Command::new(env!("CARGO_BIN_EXE_moonlight-nx2-host"))
        .args(["127.0.0.1:0", helper.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    process.stdin.take().unwrap().write_all(&TOKEN).unwrap();
    let mut line = String::new();
    BufReader::new(process.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let port: u16 = line.trim().strip_prefix("READY ").unwrap().parse().unwrap();
    let mut control = TcpStream::connect(("127.0.0.1", port)).unwrap();
    control
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    send(&mut control, Kind::Auth, 0, &TOKEN);
    assert_eq!(receive(&mut control).0, Kind::Accepted);
    (process, control)
}
