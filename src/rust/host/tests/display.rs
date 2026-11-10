use moonlight_nx2_core::control::{Frame, Header, Kind};
use moonlight_nx2_host::{
    Codec, StreamOptions, Transport,
    controller::{Controller, Event, Started},
    display::{
        Backend, Change, Failure, Mode, RESTORE_DELAY, Reason, Session, Setting,
        config::Config,
        is_local,
        kscreen::{Kscreen, parse_outputs},
        saved::Store,
    },
    helper::Helper,
};
use serde_json::{Value, json};
use std::{
    fs,
    net::{IpAddr, Ipv4Addr},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "moonlight-display-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn store(&self) -> Store {
        Store::at(self.0.join("state/saved.json"))
    }
    fn saved_file(&self) -> PathBuf {
        self.0.join("state/saved.json")
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const STREAM_1080P60: Mode = Mode {
    width: 1920,
    height: 1080,
    fps: 60,
};
const STREAM_1440P120: Mode = Mode {
    width: 2560,
    height: 1440,
    fps: 120,
};

fn desktop() -> Setting {
    Setting {
        output: "DP-2".into(),
        mode: Some("36".into()),
        width: 3840,
        height: 2160,
        refresh_mhz: 59_968,
        scale: 1.5,
    }
}

#[derive(Default)]
struct Screen {
    current: Option<Setting>,
    commits: Vec<Setting>,
    refuse_commit: bool,
    lacks_mode: bool,
}

/// A display that takes any mode at once.
#[derive(Clone)]
struct FakeDisplay(Arc<Mutex<Screen>>);

impl FakeDisplay {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(Screen {
            current: Some(desktop()),
            ..Screen::default()
        })))
    }
    fn current(&self) -> Setting {
        self.0.lock().unwrap().current.clone().unwrap()
    }
    fn commits(&self) -> usize {
        self.0.lock().unwrap().commits.len()
    }
    fn session(&self, scratch: &Scratch) -> Session {
        Session::new(Box::new(self.clone()), scratch.store(), false)
    }
}

impl Backend for FakeDisplay {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn current(&mut self) -> Result<Setting, Failure> {
        Ok(FakeDisplay::current(self))
    }
    fn plan(&mut self, wanted: &Setting) -> Result<Change, Failure> {
        let screen = self.0.lock().unwrap();
        if screen.lacks_mode {
            return Err(Failure::new(Reason::NoMode, "no such mode"));
        }
        let commands = if screen.current.as_ref().unwrap().matches(wanted) {
            Vec::new()
        } else {
            vec![format!("set {wanted}")]
        };
        Ok(Change {
            target: wanted.clone(),
            commands,
        })
    }
    fn commit(&mut self, change: &Change) -> Result<(), Failure> {
        let mut screen = self.0.lock().unwrap();
        if screen.refuse_commit {
            return Err(Failure::new(Reason::Failed, "refused"));
        }
        screen.current = Some(change.target.clone());
        screen.commits.push(change.target.clone());
        Ok(())
    }
}

fn options(sops: bool) -> StreamOptions {
    StreamOptions {
        transport: Transport::TcpV1,
        width: 1920,
        height: 1080,
        fps: 60,
        bitrate_kbps: 20_000,
        codec: Codec::H264,
        sops,
        local_audio: false,
        quit_on_stop: false,
    }
}

#[test]
fn stream_mode_is_applied_and_the_desktop_mode_comes_back() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut session = display.session(&scratch);

    session.apply(STREAM_1080P60).unwrap();
    let streaming = display.current();
    assert_eq!((streaming.width, streaming.height), (1920, 1080));
    assert_eq!(streaming.refresh_mhz, 60_000);
    assert_eq!(streaming.scale, 1.0);
    assert_eq!(scratch.store().load().unwrap(), Some(desktop()));

    assert!(session.restore());
    assert_eq!(display.current(), desktop());
    assert!(!scratch.saved_file().exists());
}

#[test]
fn desktop_mode_is_on_disk_before_the_display_changes() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    display.0.lock().unwrap().refuse_commit = true;
    let mut session = display.session(&scratch);

    let failure = session.apply(STREAM_1080P60).unwrap_err();
    assert_eq!(failure.reason, Reason::Failed);
    assert_eq!(display.commits(), 0);
    assert_eq!(scratch.store().load().unwrap(), Some(desktop()));
}

#[test]
fn saved_file_is_private_and_survives_a_second_stream_mode() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut session = display.session(&scratch);

    session.apply(STREAM_1080P60).unwrap();
    session.apply(STREAM_1440P120).unwrap();
    assert_eq!(display.commits(), 2);
    assert_eq!(scratch.store().load().unwrap(), Some(desktop()));
    let mode = fs::metadata(scratch.saved_file())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);

    session.restore();
    assert_eq!(display.current(), desktop());
}

#[test]
fn same_mode_twice_changes_the_display_once() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut session = display.session(&scratch);

    session.apply(STREAM_1080P60).unwrap();
    session.apply(STREAM_1080P60).unwrap();
    assert_eq!(display.commits(), 1);
}

#[test]
fn display_already_in_the_stream_mode_is_left_alone() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    display.0.lock().unwrap().current = Some(Setting {
        mode: None,
        width: 1920,
        height: 1080,
        refresh_mhz: 59_940,
        scale: 1.0,
        ..desktop()
    });
    let mut session = display.session(&scratch);

    session.apply(STREAM_1080P60).unwrap();
    assert_eq!(display.commits(), 0);
    assert!(!scratch.saved_file().exists());
}

#[test]
fn restore_waits_for_a_relaunch_before_switching_back() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut session = display.session(&scratch);
    let stopped = Instant::now();

    session.apply(STREAM_1080P60).unwrap();
    session.release(stopped);
    session.poll(stopped + RESTORE_DELAY / 2);
    assert_eq!(display.commits(), 1);

    session.apply(STREAM_1440P120).unwrap();
    session.poll(stopped + RESTORE_DELAY * 2);
    assert_eq!(display.current().width, 2560);

    session.release(stopped);
    session.poll(stopped + RESTORE_DELAY);
    assert_eq!(display.current(), desktop());
}

#[test]
fn dropped_session_restores_the_desktop_mode() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut session = display.session(&scratch);

    session.apply(STREAM_1080P60).unwrap();
    drop(session);
    assert_eq!(display.current(), desktop());
    assert!(!scratch.saved_file().exists());
}

#[test]
fn next_start_restores_what_a_killed_host_left_behind() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut killed = display.session(&scratch);
    killed.apply(STREAM_1080P60).unwrap();
    std::mem::forget(killed);
    assert_eq!(display.current().width, 1920);

    let mut next = display.session(&scratch);
    assert!(next.restore());
    assert_eq!(display.current(), desktop());
    assert!(!scratch.saved_file().exists());
}

#[test]
fn failed_restore_keeps_the_saved_mode_for_another_try() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut session = display.session(&scratch);

    session.apply(STREAM_1080P60).unwrap();
    display.0.lock().unwrap().refuse_commit = true;
    assert!(!session.restore());
    assert_eq!(scratch.store().load().unwrap(), Some(desktop()));

    display.0.lock().unwrap().refuse_commit = false;
    assert!(session.restore());
    assert_eq!(display.current(), desktop());
}

#[test]
fn kept_session_leaves_the_mode_and_the_saved_file() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut session = display.session(&scratch);

    session.apply(STREAM_1080P60).unwrap();
    session.keep();
    drop(session);
    assert_eq!(display.current().width, 1920);
    assert_eq!(scratch.store().load().unwrap(), Some(desktop()));
}

#[test]
fn dry_run_changes_and_saves_nothing() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut session = Session::new(Box::new(display.clone()), scratch.store(), true);

    session.apply(STREAM_1080P60).unwrap();
    session.release(Instant::now());
    session.restore();
    assert_eq!(display.commits(), 0);
    assert_eq!(display.current(), desktop());
    assert!(!scratch.saved_file().exists());
}

#[test]
fn stream_without_optimise_never_touches_the_display() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut session = display.session(&scratch);

    assert_eq!(session.match_stream("127.0.0.1", &options(false)), None);
    assert_eq!(display.commits(), 0);
}

#[test]
fn unmatched_stream_reports_why_and_goes_on() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut session = display.session(&scratch);

    assert_eq!(
        session.match_stream("192.0.2.7", &options(true)),
        Some(Reason::RemotePc)
    );
    display.0.lock().unwrap().lacks_mode = true;
    assert_eq!(
        session.match_stream("127.0.0.1", &options(true)),
        Some(Reason::NoMode)
    );
    assert_eq!(display.commits(), 0);
    assert!(!scratch.saved_file().exists());

    display.0.lock().unwrap().lacks_mode = false;
    assert_eq!(session.match_stream("127.0.0.1", &options(true)), None);
    assert_eq!(display.current().width, 1920);
}

#[test]
fn only_this_computer_counts_as_local() {
    assert!(is_local("127.0.0.1"));
    assert!(is_local("::1"));
    assert!(is_local("localhost"));
    assert!(!is_local("192.0.2.7"));
    assert!(!is_local("no such host.invalid"));
}

#[test]
fn unreadable_saved_mode_is_dropped_not_applied() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    fs::create_dir(scratch.0.join("state")).unwrap();
    for bad in [
        "not json",
        r#"{"version":2,"setting":{"output":"DP-2","mode":null,"width":1,"height":1,"refresh_mhz":1,"scale":1.0}}"#,
        r#"{"version":1,"setting":{"output":"DP-2; rm","mode":null,"width":1,"height":1,"refresh_mhz":1,"scale":1.0}}"#,
        r#"{"version":1,"setting":{"output":"DP-2","mode":null,"width":0,"height":1,"refresh_mhz":1,"scale":1.0}}"#,
        r#"{"version":1,"setting":{"output":"DP-2","mode":null,"width":1,"height":1,"refresh_mhz":1,"scale":0.0}}"#,
    ] {
        fs::write(scratch.saved_file(), bad).unwrap();
        assert!(scratch.store().load().is_err(), "{bad}");
        let mut session = display.session(&scratch);
        assert!(!session.restore());
        assert!(!scratch.saved_file().exists());
    }
    assert_eq!(display.commits(), 0);
}

#[test]
fn stream_modes_parse_strictly() {
    assert_eq!(Mode::parse("2560x1440@120"), Some(STREAM_1440P120));
    for bad in [
        "2560x1440",
        "2560@120",
        "0x1440@120",
        "2560x1440@0",
        "ax1@2",
        "",
    ] {
        assert_eq!(Mode::parse(bad), None, "{bad}");
    }
}

#[test]
fn config_takes_only_known_plain_settings() {
    let config = Config::parse(
        br#"{"version":1,"output":"DP-2","wayland_display":"wayland-1","custom_modes":true,"dry_run":true}"#,
    )
    .unwrap();
    assert_eq!(config.output.as_deref(), Some("DP-2"));
    assert_eq!(config.wayland_display.as_deref(), Some("wayland-1"));
    assert!(config.custom_modes && config.dry_run);
    assert!(Config::parse(br#"{"version":1}"#).is_ok());

    for bad in [
        &br#"{"version":2}"#[..],
        br#"{"version":1,"output":"DP-2 ; reboot"}"#,
        br#"{"version":1,"outputs":"DP-2"}"#,
        br#"{"version":1,"hosts":{"192.0.2.1":{"command":["/bin/true"],"options":{}}}}"#,
        br#"{"output":"DP-2"}"#,
        b"[]",
    ] {
        assert!(Config::parse(bad).is_err());
    }
}

fn mode(id: &str, width: u32, height: u32, rate: f64) -> Value {
    json!({"id": id, "name": format!("{width}x{height}@{}", rate.round()),
           "size": {"width": width, "height": height}, "refreshRate": rate})
}

/// The modes that matter from the desk monitor this was written against.
fn monitor() -> Value {
    json!({
        "name": "DP-2", "connected": true, "enabled": true, "priority": 1, "scale": 1.5,
        "currentModeId": "36",
        "modes": [
            mode("1", 2560, 1440, 59.951),
            mode("7", 1920, 1080, 59.94),
            mode("9", 1920, 1080, 120.0),
            mode("11", 1920, 1080, 60.0),
            mode("12", 1920, 1080, 60.0),
            mode("20", 2560, 1440, 119.998),
            mode("36", 3840, 2160, 59.96799850463867),
        ],
    })
}

struct FakeKscreen {
    scratch: Scratch,
}

impl FakeKscreen {
    fn new(outputs: Value) -> Self {
        let scratch = Scratch::new();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kscreen-doctor");
        std::os::unix::fs::symlink(fixture, scratch.0.join("kscreen-doctor")).unwrap();
        let fake = Self { scratch };
        fake.write(&json!({"outputs": outputs}));
        fake
    }
    fn backend(&self) -> Kscreen {
        Kscreen::new(self.scratch.0.join("kscreen-doctor"))
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.scratch.0.join("state.json")).unwrap()).unwrap()
    }
    fn write(&self, state: &Value) {
        fs::write(self.scratch.0.join("state.json"), state.to_string()).unwrap();
    }
    fn set(&self, key: &str, value: Value) {
        let mut state = self.state();
        state[key] = value;
        self.write(&state);
    }
    fn changes(&self) -> Vec<Value> {
        self.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|call| **call != json!(["-j"]))
            .cloned()
            .collect()
    }
}

fn wanted(mode: Mode) -> Setting {
    Setting::for_stream("DP-2", mode)
}

#[test]
fn kscreen_reads_the_current_mode_of_the_only_output() {
    let fake = FakeKscreen::new(json!([monitor()]));
    assert_eq!(fake.backend().current().unwrap(), desktop());
}

#[test]
fn kscreen_skips_outputs_that_are_off_and_prefers_the_primary() {
    let mut second = monitor();
    second["name"] = json!("HDMI-A-1");
    second["priority"] = json!(2);
    let mut off = monitor();
    off["name"] = json!("eDP-1");
    off["enabled"] = json!(false);
    let fake = FakeKscreen::new(json!([second.clone(), off, monitor()]));
    assert_eq!(fake.backend().current().unwrap().output, "DP-2");
    assert_eq!(
        fake.backend().output("HDMI-A-1").current().unwrap().output,
        "HDMI-A-1"
    );
    assert_eq!(
        fake.backend().output("eDP-1").current().unwrap_err().reason,
        Reason::NoOutput
    );

    let mut first = monitor();
    first["priority"] = json!(3);
    let unclear = FakeKscreen::new(json!([first, second]));
    assert_eq!(
        unclear.backend().current().unwrap_err().reason,
        Reason::NoOutput
    );
}

#[test]
fn kscreen_plans_the_nearest_rate_without_changing_anything() {
    let fake = FakeKscreen::new(json!([monitor()]));
    let change = fake.backend().plan(&wanted(STREAM_1080P60)).unwrap();
    assert_eq!(change.target.mode.as_deref(), Some("11"));
    assert_eq!(
        change.commands,
        ["kscreen-doctor output.DP-2.mode.11 output.DP-2.scale.1"]
    );

    let change = fake.backend().plan(&wanted(STREAM_1440P120)).unwrap();
    assert_eq!(change.target.mode.as_deref(), Some("20"));
    assert_eq!(change.target.refresh_mhz, 119_998);
    assert!(fake.changes().is_empty());
}

#[test]
fn kscreen_plan_goes_back_to_the_saved_mode_by_name() {
    let fake = FakeKscreen::new(json!([monitor()]));
    let saved = Setting {
        mode: Some("12".into()),
        scale: 1.25,
        ..wanted(STREAM_1080P60)
    };
    let change = fake.backend().plan(&saved).unwrap();
    assert_eq!(
        change.commands,
        ["kscreen-doctor output.DP-2.mode.12 output.DP-2.scale.1.25"]
    );
    assert!(fake.backend().plan(&desktop()).unwrap().commands.is_empty());
}

#[test]
fn kscreen_reports_a_missing_mode_and_a_missing_output() {
    let fake = FakeKscreen::new(json!([monitor()]));
    let ultrawide = Mode {
        width: 3440,
        height: 1440,
        fps: 60,
    };
    assert_eq!(
        fake.backend().plan(&wanted(ultrawide)).unwrap_err().reason,
        Reason::NoMode
    );
    let fast_4k = Mode {
        width: 3840,
        height: 2160,
        fps: 120,
    };
    assert_eq!(
        fake.backend().plan(&wanted(fast_4k)).unwrap_err().reason,
        Reason::NoMode
    );
    assert_eq!(
        fake.backend()
            .plan(&Setting::for_stream("HDMI-A-1", STREAM_1080P60))
            .unwrap_err()
            .reason,
        Reason::NoOutput
    );
    assert_eq!(
        fake.backend()
            .plan(&Setting::for_stream("DP-2.disable", STREAM_1080P60))
            .unwrap_err()
            .reason,
        Reason::NoOutput
    );
}

#[test]
fn kscreen_commit_switches_and_confirms_then_restores() {
    let fake = FakeKscreen::new(json!([monitor()]));
    let mut backend = fake.backend();
    let change = backend.plan(&wanted(STREAM_1080P60)).unwrap();
    backend.commit(&change).unwrap();
    assert_eq!(fake.state()["outputs"][0]["currentModeId"], "11");
    assert_eq!(fake.state()["outputs"][0]["scale"], 1.0);

    let back = backend.plan(&desktop()).unwrap();
    backend.commit(&back).unwrap();
    assert_eq!(backend.current().unwrap(), desktop());
    assert_eq!(
        fake.changes(),
        [
            json!(["output.DP-2.mode.11", "output.DP-2.scale.1"]),
            json!(["output.DP-2.mode.36", "output.DP-2.scale.1.5"]),
        ]
    );
}

#[test]
fn kscreen_commit_fails_when_the_display_keeps_its_mode() {
    let fake = FakeKscreen::new(json!([monitor()]));
    let mut backend = fake.backend();
    let change = backend.plan(&wanted(STREAM_1080P60)).unwrap();
    fake.set("ignore_changes", json!(true));
    assert_eq!(backend.commit(&change).unwrap_err().reason, Reason::Failed);
}

#[test]
fn kscreen_adds_a_custom_mode_only_when_allowed() {
    let fake = FakeKscreen::new(json!([monitor()]));
    let fast_4k = Mode {
        width: 3840,
        height: 2160,
        fps: 120,
    };
    let mut backend = fake.backend().custom_modes(true);
    let change = backend.plan(&wanted(fast_4k)).unwrap();
    assert_eq!(
        change.commands,
        [
            "kscreen-doctor output.DP-2.addCustomMode.3840.2160.120000.reduced",
            "kscreen-doctor output.DP-2.mode.NEW output.DP-2.scale.1",
        ]
    );
    assert!(fake.changes().is_empty());

    backend.commit(&change).unwrap();
    let current = backend.current().unwrap();
    assert_eq!((current.width, current.refresh_mhz), (3840, 120_000));
}

#[test]
fn kscreen_that_cannot_run_is_an_unsupported_setup() {
    let scratch = Scratch::new();
    let missing = Kscreen::new(scratch.0.join("kscreen-doctor")).current();
    assert_eq!(missing.unwrap_err().reason, Reason::Unsupported);

    let fake = FakeKscreen::new(json!([monitor()]));
    fake.set("abort", json!(true));
    assert_eq!(
        fake.backend().current().unwrap_err().reason,
        Reason::Unsupported
    );
}

#[test]
fn kscreen_session_restores_through_the_real_command_path() {
    let fake = FakeKscreen::new(json!([monitor()]));
    let scratch = Scratch::new();
    let mut session = Session::new(Box::new(fake.backend()), scratch.store(), false);

    assert_eq!(session.match_stream("127.0.0.1", &options(true)), None);
    assert_eq!(fake.state()["outputs"][0]["currentModeId"], "11");
    assert_eq!(scratch.store().load().unwrap(), Some(desktop()));
    drop(session);
    assert_eq!(fake.state()["outputs"][0]["currentModeId"], "36");
    assert_eq!(fake.state()["outputs"][0]["scale"], 1.5);
}

#[test]
fn outputs_parse_tolerates_numeric_ids_and_rejects_broken_modes() {
    let outputs = parse_outputs(
        r#"{"outputs":[{"name":"DP-1","connected":true,"enabled":true,"scale":1,"currentModeId":4,
            "modes":[{"id":4,"size":{"width":1280,"height":720},"refreshRate":60}]}]}"#,
    )
    .unwrap();
    assert_eq!(outputs[0].current.as_deref(), Some("4"));
    assert!(!outputs[0].primary);
    assert!(
        parse_outputs(
            r#"{"outputs":[{"name":"DP-1","connected":true,"enabled":true,"scale":1,
        "modes":[{"id":4,"size":{"width":1280},"refreshRate":60}]}]}"#
        )
        .is_err()
    );
    assert!(parse_outputs("{}").is_err());
}

fn frame(kind: Kind, id: u32, payload: &[u8]) -> Frame<'_> {
    Frame {
        header: Header::new(kind, id, payload.len()).unwrap(),
        payload,
    }
}

fn start_request(sops: bool) -> Vec<u8> {
    json!({"op": "start", "host": "127.0.0.1", "app": "Desktop", "options": {
        "width": 1920, "height": 1080, "fps": 60, "bitrate_kbps": 20000, "codec": "h264",
        "sops": sops, "local_audio": false, "quit_on_stop": false}})
    .to_string()
    .into_bytes()
}

fn controller() -> Controller {
    let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/paired-helper");
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut controller =
        Controller::new([b'a'; 64], Helper::new(&helper).unwrap(), ip, ip).unwrap();
    controller
        .authenticate(frame(Kind::Auth, 0, &[b'a'; 64]))
        .unwrap();
    controller
}

fn start(controller: &mut Controller, id: u32, sops: bool) {
    assert!(matches!(
        controller
            .request(frame(Kind::Request, id, &start_request(sops)))
            .unwrap(),
        Started::StartPending
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match controller.poll(Instant::now()).unwrap() {
            Some(Event::Stream { .. }) => return,
            None => std::thread::sleep(Duration::from_millis(2)),
            Some(_) => panic!("unexpected event before the stream descriptor"),
        }
        assert!(Instant::now() < deadline, "no stream descriptor");
    }
}

#[test]
fn controller_switches_for_an_optimised_start_and_restores_on_close() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut controller = controller();
    controller.match_display(display.session(&scratch));

    start(&mut controller, 1, true);
    assert_eq!(display.current().width, 1920);
    assert_eq!(scratch.store().load().unwrap(), Some(desktop()));

    controller.close().unwrap();
    assert_eq!(display.current(), desktop());
    assert!(!scratch.saved_file().exists());
}

#[test]
fn controller_restores_a_while_after_the_stream_stops() {
    let scratch = Scratch::new();
    let display = FakeDisplay::new();
    let mut controller = controller();
    controller.match_display(display.session(&scratch));

    start(&mut controller, 1, true);
    assert!(matches!(
        controller
            .request(frame(Kind::Request, 2, br#"{"op":"stop"}"#))
            .unwrap(),
        Started::StopPending
    ));
    let stopped = Instant::now();
    assert!(matches!(
        controller.poll(stopped).unwrap(),
        Some(Event::Stopped {
            request_id: Some(2)
        })
    ));
    assert_eq!(display.current().width, 1920);

    assert!(
        controller
            .poll(stopped + RESTORE_DELAY * 2)
            .unwrap()
            .is_none()
    );
    assert_eq!(display.current(), desktop());
}

#[test]
fn controller_without_display_matching_ignores_optimise() {
    let scratch = Scratch::new();
    let mut controller = controller();
    start(&mut controller, 1, true);
    controller.close().unwrap();
    assert!(!scratch.saved_file().exists());
}
