use moonlight_nx2_core::control::{Frame, Header, Kind};
use moonlight_nx2_host::{
    bridge,
    controller::{Controller, Event, Started},
    cover::{CHUNK_BYTES, encode_base64},
    helper::Helper,
    management::OperationName,
    response::Code,
};
use std::{
    fs,
    net::{IpAddr, Ipv4Addr},
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};

fn frame(kind: Kind, id: u32, payload: &[u8]) -> Frame<'_> {
    Frame {
        header: Header::new(kind, id, payload.len()).unwrap(),
        payload,
    }
}

fn result(controller: &mut Controller) -> bridge::Event {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(Event::Management(event)) = controller.poll(Instant::now()).unwrap() {
            return event;
        }
        assert!(Instant::now() < deadline, "helper timed out");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn cover_fetch_is_chunked_cached_and_correlated() {
    let root = std::env::temp_dir().join(format!("moonlight-cover-test-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let fixture = root.join("helper");
    let marker = root.join("calls");
    let mut png = vec![0u8; CHUNK_BYTES + 1];
    png[..16].copy_from_slice(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
    png[16..20].copy_from_slice(&600u32.to_be_bytes());
    png[20..24].copy_from_slice(&800u32.to_be_bytes());
    let mut script = format!("#!/bin/sh\nprintf x >> '{}'\n", marker.display());
    for (index, chunk) in png.chunks(CHUNK_BYTES).enumerate() {
        let value = serde_json::json!({"event":"cover_chunk","total":png.len(),"offset":index*CHUNK_BYTES,"data":encode_base64(chunk)});
        script.push_str(&format!("printf '%s\\n' '{}'\n", value));
    }
    script.push_str(&format!(
        "printf '%s\\n' '{{\"event\":\"cover_done\",\"sha256\":\"{}\"}}'\n",
        "a".repeat(64)
    ));
    fs::write(&fixture, script).unwrap();
    fs::set_permissions(&fixture, fs::Permissions::from_mode(0o700)).unwrap();
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut controller =
        Controller::new([b'a'; 64], Helper::new(&fixture).unwrap(), ip, ip).unwrap();
    controller
        .authenticate(frame(Kind::Auth, 0, &[b'a'; 64]))
        .unwrap();
    assert!(matches!(
        controller
            .request(frame(
                Kind::Request,
                1,
                br#"{"op":"cover","host":"pc","app":7}"#
            ))
            .unwrap(),
        Started::Management
    ));
    match result(&mut controller) {
        bridge::Event::Result {
            request_id,
            operation,
            value,
        } => {
            assert_eq!(request_id, 1);
            assert_eq!(operation, OperationName::Cover);
            assert_eq!(value["total"], png.len());
            assert_eq!(
                value["data"].as_str().unwrap(),
                encode_base64(&png[..CHUNK_BYTES])
            );
        }
        other => panic!("unexpected result: {other:?}"),
    }
    assert!(matches!(
        controller
            .request(frame(
                Kind::Request,
                2,
                br#"{"op":"cover","host":"pc","app":7,"offset":48000}"#
            ))
            .unwrap(),
        Started::CoverReady
    ));
    match result(&mut controller) {
        bridge::Event::Result {
            request_id, value, ..
        } => {
            assert_eq!(request_id, 2);
            assert_eq!(value["data"], "AA==");
        }
        other => panic!("unexpected result: {other:?}"),
    }
    assert_eq!(fs::read(&marker).unwrap(), b"x");
    assert!(matches!(
        controller
            .request(frame(
                Kind::Request,
                3,
                br#"{"op":"cover","host":"pc","app":7,"offset":48001}"#
            ))
            .unwrap(),
        Started::CoverReady
    ));
    assert!(matches!(
        result(&mut controller),
        bridge::Event::Failure {
            request_id: 3,
            code: Code::InvalidRequest
        }
    ));
    assert!(
        controller
            .request(frame(
                Kind::Request,
                3,
                br#"{"op":"cover","host":"pc","app":7}"#
            ))
            .is_err()
    );
    controller.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn large_cover_stream_is_bounded_and_drains_with_backpressure() {
    let root =
        std::env::temp_dir().join(format!("moonlight-large-cover-test-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let fixture = root.join("helper");
    let script = r##"#!/usr/bin/env python3
import base64, hashlib, json, sys
size=4*1024*1024
png=bytearray(size)
png[:16]=b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR'
png[16:20]=(600).to_bytes(4,'big')
png[20:24]=(800).to_bytes(4,'big')
for offset in range(0,size,48000):
 print(json.dumps({'event':'cover_chunk','total':size,'offset':offset,'data':base64.b64encode(png[offset:offset+48000]).decode()}),flush=True)
print(json.dumps({'event':'cover_done','sha256':hashlib.sha256(png).hexdigest()}),flush=True)
"##;
    fs::write(&fixture, script).unwrap();
    fs::set_permissions(&fixture, fs::Permissions::from_mode(0o700)).unwrap();
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut controller =
        Controller::new([b'a'; 64], Helper::new(&fixture).unwrap(), ip, ip).unwrap();
    controller
        .authenticate(frame(Kind::Auth, 0, &[b'a'; 64]))
        .unwrap();
    assert!(matches!(
        controller
            .request(frame(
                Kind::Request,
                1,
                br#"{"op":"cover","host":"pc","app":9}"#
            ))
            .unwrap(),
        Started::Management
    ));
    match result(&mut controller) {
        bridge::Event::Result { value, .. } => assert_eq!(value["total"], 4 * 1024 * 1024),
        other => panic!("unexpected result: {other:?}"),
    }
    controller.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn closing_during_cover_fetch_reaps_helper() {
    let root = std::env::temp_dir().join(format!(
        "moonlight-cover-cancel-test-{}",
        std::process::id()
    ));
    fs::create_dir(&root).unwrap();
    let fixture = root.join("helper");
    let marker = root.join("pid");
    fs::write(
        &fixture,
        format!(
            "#!/bin/sh\nprintf '%s' $$ > '{}'\nexec sleep 30\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&fixture, fs::Permissions::from_mode(0o700)).unwrap();
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut controller =
        Controller::new([b'a'; 64], Helper::new(&fixture).unwrap(), ip, ip).unwrap();
    controller
        .authenticate(frame(Kind::Auth, 0, &[b'a'; 64]))
        .unwrap();
    assert!(matches!(
        controller
            .request(frame(
                Kind::Request,
                1,
                br#"{"op":"cover","host":"pc","app":7}"#
            ))
            .unwrap(),
        Started::Management
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    let pid: i32 = fs::read_to_string(&marker).unwrap().parse().unwrap();
    controller.close().unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    fs::remove_dir_all(root).unwrap();
}
