use moonlight_nx2_core::control::{Header, Kind};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::{Shutdown, TcpStream},
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    time::Duration,
};

fn send(socket: &mut TcpStream, kind: Kind, id: u32, data: &[u8]) {
    socket
        .write_all(&Header::new(kind, id, data.len()).unwrap().encode().unwrap())
        .unwrap();
    socket.write_all(data).unwrap();
}
fn receive(socket: &mut TcpStream) -> (Kind, u32, Value) {
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
fn request(socket: &mut TcpStream, id: u32, body: Value) -> (Kind, u32, Value) {
    send(
        socket,
        Kind::Request,
        id,
        &serde_json::to_vec(&body).unwrap(),
    );
    receive(socket)
}

#[test]
fn probe_echoes_the_sequence_with_the_padding_asked_for() {
    let root = std::env::temp_dir().join(format!("moonlight-probe-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let helper = root.join("helper");
    fs::write(&helper, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    let mut process = Command::new(env!("CARGO_BIN_EXE_moonlight-nx2-host"))
        .args(["127.0.0.1:0", helper.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(&[b'a'; 64])
        .unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(process.stdout.take().unwrap()),
        &mut line,
    )
    .unwrap();
    let port: u16 = line.trim().strip_prefix("READY ").unwrap().parse().unwrap();
    let mut control = TcpStream::connect(("127.0.0.1", port)).unwrap();
    control
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    send(&mut control, Kind::Auth, 0, &[b'a'; 64]);
    assert_eq!(receive(&mut control).0, Kind::Accepted);

    let (kind, id, value) = request(&mut control, 1, json!({"op":"probe"}));
    assert_eq!((kind, id), (Kind::Event, 1));
    assert_eq!(value["op"], "probe");
    assert_eq!(value["value"]["sequence"], 0);
    assert_eq!(value["value"]["pad"], "");

    let (kind, _, value) = request(
        &mut control,
        2,
        json!({"op":"probe","sequence":7,"bytes":32768}),
    );
    assert_eq!(kind, Kind::Event);
    assert_eq!(value["value"]["sequence"], 7);
    assert_eq!(value["value"]["bytes"], 32768);
    assert_eq!(value["value"]["pad"].as_str().unwrap().len(), 32768);

    let (kind, _, value) = request(&mut control, 3, json!({"op":"probe","bytes":48001}));
    assert_eq!(kind, Kind::Error);
    assert_eq!(value["code"], "invalid_request");

    control.shutdown(Shutdown::Both).unwrap();
    assert!(process.wait().unwrap().success());
    fs::remove_dir_all(root).unwrap();
}
