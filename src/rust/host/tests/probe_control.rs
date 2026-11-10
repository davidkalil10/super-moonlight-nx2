mod common;

use common::{helper_script, one_launch_host, receive, request, send, temp_dir};
use moonlight_nx2_core::control::Kind;
use serde_json::json;
use std::{fs, net::Shutdown};

#[test]
fn probe_echoes_the_sequence_with_the_padding_asked_for() {
    let root = temp_dir("probe");
    let helper = helper_script(&root, "#!/bin/sh\nexit 1\n");
    let (mut process, mut control) = one_launch_host(&helper);

    send(&mut control, Kind::Request, 1, br#"{"op":"probe"}"#);
    let (kind, id, value) = receive(&mut control);
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
