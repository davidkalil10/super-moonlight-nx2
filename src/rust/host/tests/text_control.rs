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
fn text_reaches_the_worker_as_one_line_and_is_refused_when_invalid() {
    let root = temp_dir("text");
    let marker = root.join("text");
    let helper = helper_script(
        &root,
        &format!(
            "#!/bin/sh\nif [ \"$1\" = list ]; then printf '%s\\n' '{{\"currentGame\":0,\"apps\":[{{\"id\":1,\"name\":\"test\"}}]}}'; exit; fi\nprintf '%s\\n' '{{\"event\":\"connected\"}}' >&2\nwhile IFS= read -r line; do case \"$line\" in *'\"type\":\"text\"'*) printf '%s\\n' \"$line\" >> '{}' ;; esac; done\n",
            marker.display()
        ),
    );
    let (mut process, mut control) = one_launch_host(&helper);
    let (kind, _, value) = request(&mut control, 1, json!({"op":"text","text":"early"}));
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
    let text = "h\u{e9}llo \"w\" \\ \n\u{1f600}";
    let (kind, _, value) = request(&mut control, 3, json!({"op":"text","text":text}));
    assert_eq!(kind, Kind::Event);
    assert_eq!(value["op"], "text");
    assert_eq!(value["value"]["queued"], true);
    for (id, bad) in [(4, json!("")), (5, json!("a".repeat(513))), (6, json!("a\u{0}b"))] {
        let (kind, _, value) = request(&mut control, id, json!({"op":"text","text":bad}));
        assert_eq!(kind, Kind::Error);
        assert_eq!(value["code"], "invalid_request");
    }
    let (_, _, value) = request(&mut control, 7, json!({"op":"text","text":"a".repeat(512)}));
    assert_eq!(value["value"]["queued"], true);
    while fs::read_to_string(&marker).unwrap_or_default().lines().count() != 2 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    let lines = fs::read_to_string(&marker).unwrap();
    let first: serde_json::Value = serde_json::from_str(lines.lines().next().unwrap()).unwrap();
    assert_eq!(first, json!({"type":"text","text":text}));
    let (kind, _, value) = request(&mut control, 8, json!({"op":"stop"}));
    assert_eq!(kind, Kind::Event);
    assert_eq!(value["op"], "stop");
    let (kind, _, value) = request(&mut control, 9, json!({"op":"text","text":"late"}));
    assert_eq!(kind, Kind::Error);
    assert_eq!(value["code"], "invalid_state");
    control.shutdown(Shutdown::Both).unwrap();
    drop(video);
    drop(audio);
    assert!(process.wait().unwrap().success());
    fs::remove_dir_all(root).unwrap();
}
