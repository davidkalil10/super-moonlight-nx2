use moonlight_nx2_core::control::{Header, Kind};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::{Shutdown, TcpStream},
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    time::{Duration, Instant},
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
    loop {
        let response = receive(socket);
        if response.1 == id {
            return response;
        }
    }
}

#[test]
fn idr_requests_reach_helper_are_throttled_and_stop_cleanly() {
    let root = std::env::temp_dir().join(format!("moonlight-idr-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let helper = root.join("helper");
    let marker = root.join("idr");
    fs::write(&helper, format!("#!/bin/sh\nif [ \"$1\" = list ]; then printf '%s\\n' '{{\"currentGame\":0,\"apps\":[{{\"id\":1,\"name\":\"test\"}}]}}'; exit; fi\nprintf '%s\\n' '{{\"event\":\"connected\"}}' >&2\nwhile IFS= read -r line; do case \"$line\" in *request-idr*) printf x >> '{}' ;; esac; done\n", marker.display())).unwrap();
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
    let (kind, _, value) = request(&mut control, 1, json!({"op":"idr"}));
    assert_eq!(kind, Kind::Error);
    assert_eq!(value["code"], "invalid_state");
    let options = json!({"width":1920,"height":1080,"fps":60,"bitrate_kbps":20000,"codec":"h264","sops":false,"local_audio":false,"quit_on_stop":false});
    let (kind, _, descriptor) = request(
        &mut control,
        2,
        json!({"op":"start","host":"pc","app":"1","options":options}),
    );
    assert_eq!(kind, Kind::Stream);
    let open = |name: &str| {
        let media = &descriptor[name];
        let mut s =
            TcpStream::connect(("127.0.0.1", media["port"].as_u64().unwrap() as u16)).unwrap();
        s.write_all(media["token"].as_str().unwrap().as_bytes())
            .unwrap();
        s
    };
    let video = open("video");
    let audio = open("audio");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (_, _, event) = receive(&mut control);
        if event["event"] == "connected" {
            break;
        }
        assert!(Instant::now() < deadline);
    }
    let (kind, _, value) = request(&mut control, 3, json!({"op":"idr"}));
    assert_eq!(kind, Kind::Event);
    assert_eq!(value["value"]["queued"], true);
    let (_, _, value) = request(&mut control, 4, json!({"op":"idr"}));
    assert_eq!(value["value"]["queued"], false);
    while fs::read(&marker).unwrap_or_default().len() != 1 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    std::thread::sleep(Duration::from_millis(550));
    let (_, _, value) = request(&mut control, 5, json!({"op":"idr"}));
    assert_eq!(value["value"]["queued"], true);
    while fs::read(&marker).unwrap_or_default().len() != 2 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    let (kind, _, value) = request(&mut control, 6, json!({"op":"stop"}));
    assert_eq!(kind, Kind::Event);
    assert_eq!(value["op"], "stop");
    let (kind, _, value) = request(&mut control, 7, json!({"op":"idr"}));
    assert_eq!(kind, Kind::Error);
    assert_eq!(value["code"], "invalid_state");
    control.shutdown(Shutdown::Both).unwrap();
    drop(video);
    drop(audio);
    assert!(process.wait().unwrap().success());
    assert_eq!(fs::read(&marker).unwrap(), b"xx");
    fs::remove_dir_all(root).unwrap();
}
