//! Console input records to worker lines: player indexes, removal and motion units.

use moonlight_nx2_host::input::Forwarder;
use serde_json::Value;

fn pad(connected: bool, buttons: u16) -> String {
    format!(
        r#"{{"connected":{connected},"buttonFlags":{buttons},"leftTrigger":0,"rightTrigger":0,"leftStickX":0,"leftStickY":0,"rightStickX":0,"rightStickY":0}}"#
    )
}

fn lines(forwarder: &mut Forwarder, record: &str) -> Vec<Value> {
    let output = forwarder.apply(record.as_bytes()).unwrap();
    output
        .lines
        .iter()
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect()
}

#[test]
fn other_players_keep_their_controller_number() {
    let mut forwarder = Forwarder::new();
    let record = format!(
        r#"{{"v":2,"pads":[{{"index":1,"pad":{}}},{{"index":3,"pad":{}}}]}}"#,
        pad(true, 0x1000),
        pad(true, 0)
    );
    let sent = lines(&mut forwarder, &record);
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["type"], "controller");
    assert_eq!(sent[0]["index"], 1);
    assert_eq!(sent[0]["buttonFlags"], 0x1000);
    assert_eq!(sent[1]["index"], 3);
}

#[test]
fn a_removed_player_is_sent_once_as_disconnected() {
    let mut forwarder = Forwarder::new();
    let connect = format!(r#"{{"v":2,"pads":[{{"index":2,"pad":{}}}]}}"#, pad(true, 0));
    lines(&mut forwarder, &connect);
    let remove = format!(r#"{{"v":2,"pads":[{{"index":2,"pad":{}}}]}}"#, pad(false, 0));
    let sent = lines(&mut forwarder, &remove);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["index"], 2);
    assert_eq!(sent[0]["connected"], false);
    assert!(lines(&mut forwarder, &remove).is_empty());
}

#[test]
fn motion_reaches_the_worker_in_m_per_s2_and_deg_per_s() {
    let mut forwarder = Forwarder::new();
    let sent = lines(
        &mut forwarder,
        r#"{"v":2,"motion":[{"index":1,"accel":[0,9807,-500],"gyro":[360000,-90000,1]}]}"#,
    );
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["type"], "motion");
    assert_eq!(sent[0]["index"], 1);
    let axis = |key: &str, i: usize| sent[0][key][i].as_f64().unwrap();
    assert!((axis("accel", 1) - 9.807).abs() < 1e-4);
    assert!((axis("accel", 2) + 0.5).abs() < 1e-4);
    assert!((axis("gyro", 0) - 360.0).abs() < 1e-3);
    assert!((axis("gyro", 1) + 90.0).abs() < 1e-3);
}

#[test]
fn players_past_the_eighth_are_refused() {
    let mut forwarder = Forwarder::new();
    let record = format!(r#"{{"v":2,"pads":[{{"index":8,"pad":{}}}]}}"#, pad(true, 0));
    assert!(forwarder.apply(record.as_bytes()).is_err());
}
