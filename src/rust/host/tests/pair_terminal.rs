use moonlight_nx2_core::control::{Frame, Header, Kind};
use moonlight_nx2_host::{
    bridge,
    controller::{Controller, Event, Started},
    helper::Helper,
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

#[test]
fn failed_pair_is_correlated_and_never_reported_as_success() {
    let root = std::env::temp_dir().join(format!("moonlight-pair-terminal-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let helper = root.join("helper");
    fs::write(&helper, "#!/bin/sh\nprintf '%s\\n%s\\n' '{\"event\":\"pin\",\"pin\":\"1234\",\"url\":\"https://pc/pin\",\"timeout\":600}' '{\"event\":\"failed\",\"reason\":\"pairing request failed\",\"code\":-23}'\nexit 1\n").unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut controller =
        Controller::new([b'a'; 64], Helper::new(&helper).unwrap(), ip, ip).unwrap();
    controller
        .authenticate(frame(Kind::Auth, 0, &[b'a'; 64]))
        .unwrap();
    assert!(matches!(
        controller
            .request(frame(
                Kind::Request,
                1,
                br#"{"op":"pair","host":"pc","timeout_seconds":600}"#
            ))
            .unwrap(),
        Started::Management
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut saw_pin = false;
    loop {
        if let Some(Event::Management(event)) = controller.poll(Instant::now()).unwrap() {
            if matches!(event, bridge::Event::Progress { request_id: 1, .. }) {
                assert!(!saw_pin);
                saw_pin = true;
                continue;
            }
            assert!(saw_pin);
            assert!(matches!(
                event,
                bridge::Event::PairFailure {
                    request_id: 1,
                    code: Code::BackendFailed,
                    worker_code: -23,
                    busy_app: None,
                }
            ));
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    controller.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn busy_pair_is_refused_before_pin_and_timeout_is_capped() {
    let root = std::env::temp_dir().join(format!("moonlight-pair-busy-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let helper = root.join("helper");
    let arguments = root.join("args");
    fs::write(&helper, format!("#!/bin/sh\nprintf '%s' \"$4\" > '{}'\nprintf '%s\\n' '{{\"event\":\"failed\",\"reason\":\"pc_busy\",\"code\":-4,\"app\":42}}'\nexit 1\n", arguments.display())).unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut controller =
        Controller::new([b'a'; 64], Helper::new(&helper).unwrap(), ip, ip).unwrap();
    controller
        .authenticate(frame(Kind::Auth, 0, &[b'a'; 64]))
        .unwrap();
    controller
        .request(frame(
            Kind::Request,
            1,
            br#"{"op":"pair","host":"pc","timeout_seconds":600}"#,
        ))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(Event::Management(event)) = controller.poll(Instant::now()).unwrap() {
            assert!(matches!(
                event,
                bridge::Event::PairFailure {
                    request_id: 1,
                    code: Code::BackendFailed,
                    worker_code: -4,
                    busy_app: Some(42)
                }
            ));
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(fs::read_to_string(arguments).unwrap(), "290");
    let mut bytes = vec![0; 1024];
    let count = moonlight_nx2_host::response::pair_failure(
        1,
        Code::BackendFailed,
        -4,
        Some(42),
        &mut bytes,
    )
    .unwrap();
    let payload: serde_json::Value = serde_json::from_slice(&bytes[16..count]).unwrap();
    assert_eq!(
        payload["message"],
        "The PC is busy with app 42; close it in Sunshine first"
    );
    controller.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}
