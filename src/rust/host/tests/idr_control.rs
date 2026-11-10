mod common;

use common::{helper_script, one_launch_host, receive, request, temp_dir};
use moonlight_nx2_core::control::Kind;
use serde_json::json;
use std::{
    fs,
    io::Write,
    net::{Shutdown, TcpStream},
    time::{Duration, Instant},
};

#[test]
fn idr_requests_reach_helper_are_throttled_and_stop_cleanly() {
    let root = temp_dir("idr");
    let marker = root.join("idr");
    let helper = helper_script(
        &root,
        &format!(
            "#!/bin/sh\nif [ \"$1\" = list ]; then printf '%s\\n' '{{\"currentGame\":0,\"apps\":[{{\"id\":1,\"name\":\"test\"}}]}}'; exit; fi\nprintf '%s\\n' '{{\"event\":\"connected\"}}' >&2\nwhile IFS= read -r line; do case \"$line\" in *request-idr*) printf x >> '{}' ;; esac; done\n",
            marker.display()
        ),
    );
    let (mut process, mut control) = one_launch_host(&helper);
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
