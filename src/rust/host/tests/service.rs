//! The real helper binary in `serve` mode against a console built from the secure crate.

use moonlight_nx2_core::control::{Header, Kind};
use moonlight_nx2_secure::{
    ANSWER_BYTES, Error, Established, HELLO_BYTES, Initiator, MAX_RECORD, Mode, Opener, PAIRED,
    Random, SESSION_TOKEN, Status,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};

const HOST: &str = env!("CARGO_BIN_EXE_moonlight-nx2-host");
const CONSOLE: [u8; 16] = [0xc1; 16];

fn random() -> Random<fn(&mut [u8])> {
    Random(moonlight_nx2_host::service::os_random)
}

struct Helper {
    root: PathBuf,
    process: Child,
    port: u16,
}

impl Helper {
    fn start(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("moonlight-serve-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let worker = root.join("worker");
        fs::write(&worker, "#!/bin/sh\nif [ \"$1\" = list ]; then printf '%s\\n' '{\"currentGame\":0,\"apps\":[{\"id\":1,\"name\":\"test\"}]}'; fi\n").unwrap();
        fs::set_permissions(&worker, fs::Permissions::from_mode(0o700)).unwrap();
        let mut helper = Self {
            root,
            process: Command::new("true").spawn().unwrap(),
            port: 0,
        };
        helper.launch();
        helper
    }

    fn state(&self) -> PathBuf {
        self.root.join("state")
    }

    fn launch(&mut self) {
        let mut process = Command::new(HOST)
            .args(["serve", "--listen", "127.0.0.1:0", "--state"])
            .arg(self.state())
            .arg(self.root.join("worker"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(process.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        self.port = line.trim().strip_prefix("READY ").unwrap().parse().unwrap();
        self.process = process;
    }

    fn stop(&mut self) {
        unsafe { libc::kill(self.process.id() as i32, libc::SIGTERM) };
        assert!(self.process.wait().unwrap().success());
    }

    fn command(&self, words: &[&str]) -> Output {
        Command::new(HOST)
            .arg(words[0])
            .arg("--state")
            .arg(self.state())
            .args(&words[1..])
            .output()
            .unwrap()
    }

    fn connect(&self) -> TcpStream {
        let socket = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket
    }

    /// Runs the console's side of a pairing while `code` is typed on the PC.
    fn pair(
        &self,
        console: [u8; 16],
        shown: &[u8],
        typed: &str,
    ) -> (Result<[u8; 32], Error>, Output) {
        let mut socket = self.connect();
        let (initiator, hello) = Initiator::start(Mode::Pair, console, shown, random());
        socket.write_all(&hello).unwrap();
        let state = self.state();
        let typed = typed.to_string();
        let typed_on_pc = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let output = Command::new(HOST)
                    .args(["pair", "--state"])
                    .arg(&state)
                    .arg(&typed)
                    .output()
                    .unwrap();
                let early =
                    String::from_utf8_lossy(&output.stderr).contains("no console is waiting");
                if !early || Instant::now() >= deadline {
                    return output;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let mut answer = [0; ANSWER_BYTES];
        let key = match socket.read_exact(&mut answer) {
            Ok(()) => initiator
                .finish(&answer)
                .and_then(|(mut established, proof)| {
                    socket.write_all(&proof).unwrap();
                    stored(&mut socket, &mut established)?;
                    Ok(established.pairing_key.take().unwrap())
                }),
            Err(_) => Err(Error::Malformed),
        };
        drop(socket);
        (key, typed_on_pc.join().unwrap())
    }

    fn open(&self, console: [u8; 16], key: &[u8; 32]) -> Result<Console, Error> {
        let mut socket = self.connect();
        let (initiator, hello) = Initiator::start(Mode::Session, console, key, random());
        socket.write_all(&hello).unwrap();
        let mut answer = [0; ANSWER_BYTES];
        socket
            .read_exact(&mut answer)
            .map_err(|_| Error::Malformed)?;
        let (keys, proof) = initiator.finish(&answer)?;
        socket.write_all(&proof).unwrap();
        Ok(Console {
            socket,
            keys,
            hello,
            proof,
        })
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct Console {
    socket: TcpStream,
    keys: Established,
    hello: [u8; HELLO_BYTES],
    proof: [u8; 32],
}

impl Console {
    fn send(&mut self, kind: Kind, id: u32, data: &[u8]) {
        let mut frame = Header::new(kind, id, data.len())
            .unwrap()
            .encode()
            .unwrap()
            .to_vec();
        frame.extend_from_slice(data);
        let mut record = [0; MAX_RECORD];
        let size = self.keys.sealer.seal(&frame, &mut record).unwrap();
        self.socket.write_all(&record[..size]).unwrap();
    }

    fn receive(&mut self) -> Option<(Kind, u32, Value)> {
        let mut length = [0; 2];
        self.socket.read_exact(&mut length).ok()?;
        let mut body = vec![0; Opener::body_bytes(length).ok()?];
        self.socket.read_exact(&mut body).ok()?;
        let size = self.keys.opener.open(&mut body).ok()?;
        let header = Header::decode(body[..16].try_into().unwrap()).ok()?;
        assert_eq!(size, 16 + header.payload_bytes as usize);
        Some((
            header.kind,
            header.request_id,
            serde_json::from_slice(&body[16..size]).unwrap(),
        ))
    }

    /// The MNC1 opening inside the session; false when the helper closed instead.
    fn accepted(&mut self) -> bool {
        self.send(Kind::Auth, 0, &SESSION_TOKEN);
        self.receive()
            .is_some_and(|(kind, _, _)| kind == Kind::Accepted)
    }

    fn lists(&mut self, id: u32) -> bool {
        self.send(
            Kind::Request,
            id,
            &serde_json::to_vec(&json!({"op":"list","host":"pc"})).unwrap(),
        );
        loop {
            match self.receive() {
                Some((Kind::Event, reply, value)) if reply == id => {
                    return value["value"]["apps"][0]["name"] == "test";
                }
                Some(_) => {}
                None => return false,
            }
        }
    }

    fn closed(&mut self) -> bool {
        let mut byte = [0; 1];
        matches!(self.socket.read(&mut byte), Ok(0) | Err(_))
    }
}

/// Reads the record a helper sends once it has stored a pairing.
fn stored(socket: &mut TcpStream, keys: &mut Established) -> Result<(), Error> {
    let mut length = [0; 2];
    socket
        .read_exact(&mut length)
        .map_err(|_| Error::Malformed)?;
    let mut body = vec![0; Opener::body_bytes(length)?];
    socket.read_exact(&mut body).map_err(|_| Error::Malformed)?;
    let size = keys.opener.open(&mut body)?;
    if body[..size] == *PAIRED {
        Ok(())
    } else {
        Err(Error::Confirm)
    }
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn a_console_pairs_once_and_then_opens_sessions_with_the_key() {
    let mut helper = Helper::start("pair");
    let (key, typed) = helper.pair(CONSOLE, b"12345678", "12345678");
    let key = key.unwrap();
    assert!(typed.status.success(), "{typed:?}");
    let state = helper.state();
    assert_eq!(
        [
            mode(&state),
            mode(&state.join("consoles.json")),
            mode(&state.join("identity")),
            mode(&state.join("admin.sock")),
        ],
        [0o700, 0o600, 0o600, 0o600]
    );
    let listed = String::from_utf8(helper.command(&["consoles"]).stdout).unwrap();
    assert!(listed.starts_with(&"c1".repeat(16)), "{listed}");

    let mut console = helper.open(CONSOLE, &key).unwrap();
    assert!(console.accepted());
    assert!(console.lists(1));
    drop(console);

    helper.stop();
    helper.launch();
    let mut console = helper.open(CONSOLE, &key).unwrap();
    assert!(console.accepted() && console.lists(1));
}

#[test]
fn wrong_codes_never_pair_and_lock_pairing() {
    let helper = Helper::start("wrong");
    for _ in 0..3 {
        let (key, typed) = helper.pair(CONSOLE, b"12345678", "87654321");
        assert_eq!(key.err(), Some(Error::Confirm));
        assert!(!typed.status.success());
        assert!(String::from_utf8_lossy(&typed.stderr).contains("did not match"));
    }
    assert!(helper.command(&["consoles"]).stdout.starts_with(b"ok"));
    let (key, typed) = helper.pair(CONSOLE, b"12345678", "12345678");
    assert_eq!(key.err(), Some(Error::Refused(Status::PairingUnavailable)));
    assert!(String::from_utf8_lossy(&typed.stderr).contains("pairing is off"));
}

#[test]
fn strangers_wrong_keys_and_the_token_path_get_nothing() {
    let helper = Helper::start("strangers");
    let (key, _) = helper.pair(CONSOLE, b"00000001", "00000001");
    let key = key.unwrap();

    assert_eq!(
        helper.open([0xee; 16], &key).err(),
        Some(Error::Refused(Status::UnknownConsole))
    );
    assert_eq!(helper.open(CONSOLE, &[7; 32]).err(), Some(Error::Confirm));

    let mut plain = helper.connect();
    let mut auth = Header::new(Kind::Auth, 0, 64)
        .unwrap()
        .encode()
        .unwrap()
        .to_vec();
    auth.extend_from_slice(&[b'a'; 64]);
    plain.write_all(&auth).unwrap();
    let mut reply = Vec::new();
    let _ = plain.read_to_end(&mut reply);
    assert!(reply.is_empty(), "the token path answered: {reply:?}");

    let mut console = helper.open(CONSOLE, &key).unwrap();
    assert!(console.accepted() && console.lists(1));
}

#[test]
fn replayed_handshakes_and_changed_records_close_the_connection() {
    let helper = Helper::start("replay");
    let (key, _) = helper.pair(CONSOLE, b"00000002", "00000002");
    let key = key.unwrap();
    let mut console = helper.open(CONSOLE, &key).unwrap();
    assert!(console.accepted());
    let (hello, proof) = (console.hello, console.proof);
    drop(console);

    let mut replay = helper.connect();
    replay.write_all(&hello).unwrap();
    let mut answer = [0; ANSWER_BYTES];
    replay.read_exact(&mut answer).unwrap();
    replay.write_all(&proof).unwrap();
    let mut auth = Header::new(Kind::Auth, 0, 64)
        .unwrap()
        .encode()
        .unwrap()
        .to_vec();
    auth.extend_from_slice(&SESSION_TOKEN);
    let _ = replay.write_all(&auth);
    let mut reply = Vec::new();
    let _ = replay.read_to_end(&mut reply);
    assert!(reply.is_empty());

    let mut console = helper.open(CONSOLE, &key).unwrap();
    assert!(console.accepted());
    let mut frame = Header::new(Kind::Request, 1, 2)
        .unwrap()
        .encode()
        .unwrap()
        .to_vec();
    frame.extend_from_slice(b"{}");
    let mut record = [0; MAX_RECORD];
    let size = console.keys.sealer.seal(&frame, &mut record).unwrap();
    record[10] ^= 1;
    console.socket.write_all(&record[..size]).unwrap();
    assert!(console.closed());
}

#[test]
fn the_same_console_takes_over_and_another_console_waits() {
    let helper = Helper::start("takeover");
    let other = [0xd2; 16];
    let (key, _) = helper.pair(CONSOLE, b"00000003", "00000003");
    let (other_key, _) = helper.pair(other, b"00000004", "00000004");
    let (key, other_key) = (key.unwrap(), other_key.unwrap());

    let mut first = helper.open(CONSOLE, &key).unwrap();
    assert!(first.accepted() && first.lists(1));

    let mut stranger = helper.open(other, &other_key).unwrap();
    assert!(!stranger.accepted());
    assert!(first.lists(2));

    let mut second = helper.open(CONSOLE, &key).unwrap();
    assert!(second.accepted() && second.lists(1));
    assert!(first.closed());
    drop(second);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut waiting = helper.open(other, &other_key).unwrap();
        if waiting.accepted() {
            assert!(waiting.lists(1));
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn unpairing_closes_the_open_session_and_refuses_the_key() {
    let helper = Helper::start("unpair");
    let (key, _) = helper.pair(CONSOLE, b"00000005", "00000005");
    let key = key.unwrap();
    let mut console = helper.open(CONSOLE, &key).unwrap();
    assert!(console.accepted());

    let removed = helper.command(&["unpair", "c1c1"]);
    assert_eq!(String::from_utf8_lossy(&removed.stdout).trim(), "ok 1");
    console
        .socket
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    assert!(console.closed());
    assert_eq!(
        helper.open(CONSOLE, &key).err(),
        Some(Error::Refused(Status::UnknownConsole))
    );
}

#[test]
fn consoles_and_unpair_work_on_the_files_when_no_service_runs() {
    let mut helper = Helper::start("offline");
    let (key, _) = helper.pair(CONSOLE, b"00000006", "00000006");
    key.unwrap();
    helper.stop();
    let listed = String::from_utf8(helper.command(&["consoles"]).stdout).unwrap();
    assert!(listed.starts_with(&"c1".repeat(16)), "{listed}");
    assert!(!helper.command(&["pair", "00000006"]).status.success());
    assert_eq!(
        String::from_utf8_lossy(&helper.command(&["unpair", "all"]).stdout).trim(),
        "ok 1"
    );
    assert_eq!(
        String::from_utf8_lossy(&helper.command(&["consoles"]).stdout).trim(),
        "ok"
    );
}

/// The helper has a pairing only once it read the console's proof and stored the key; it
/// says so with one record. A key session sent before that is refused, the first one after
/// it must succeed, with no pause in between.
#[test]
fn the_first_session_after_the_stored_record_succeeds_at_once() {
    let helper = Helper::start("first-session");
    let mut socket = helper.connect();
    let (initiator, hello) = Initiator::start(Mode::Pair, CONSOLE, b"27182818", random());
    socket.write_all(&hello).unwrap();
    let state = helper.state();
    let typed = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let output = Command::new(HOST)
                .args(["pair", "--state"])
                .arg(&state)
                .arg("27182818")
                .output()
                .unwrap();
            if output.status.success() || Instant::now() >= deadline {
                return output;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let mut answer = [0; ANSWER_BYTES];
    socket.read_exact(&mut answer).unwrap();
    let (mut established, proof) = initiator.finish(&answer).unwrap();
    let key = established.pairing_key.unwrap();

    assert_eq!(
        helper.open(CONSOLE, &key).err(),
        Some(Error::Refused(Status::UnknownConsole)),
        "the proof has not been sent yet"
    );
    socket.write_all(&proof).unwrap();
    stored(&mut socket, &mut established).unwrap();
    let mut console = helper.open(CONSOLE, &key).unwrap();
    assert!(console.accepted() && console.lists(1));
    assert!(typed.join().unwrap().status.success());
}

#[test]
fn a_console_that_forgets_the_pc_is_revoked_and_must_pair_again_with_a_code() {
    let helper = Helper::start("revoke");
    let other = [0xd2; 16];
    let (key, _) = helper.pair(CONSOLE, b"00000007", "00000007");
    let (other_key, _) = helper.pair(other, b"00000008", "00000008");
    let (key, other_key) = (key.unwrap(), other_key.unwrap());

    let mut console = helper.open(CONSOLE, &key).unwrap();
    assert!(console.accepted());
    console.send(Kind::Request, 1, br#"{"op":"revoke"}"#);
    let (kind, id, value) = console.receive().unwrap();
    assert_eq!((kind, id), (Kind::Event, 1));
    assert_eq!(value["op"], "revoke");
    assert_eq!(value["value"]["event"], "revoked");
    console
        .socket
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    assert!(console.closed());

    let listed = String::from_utf8(helper.command(&["consoles"]).stdout).unwrap();
    assert!(!listed.contains(&"c1".repeat(16)), "{listed}");
    assert!(listed.contains(&"d2".repeat(16)), "{listed}");
    assert_eq!(
        helper.open(CONSOLE, &key).err(),
        Some(Error::Refused(Status::UnknownConsole))
    );
    assert!(helper.open(other, &other_key).unwrap().accepted());

    let (fresh, _) = helper.pair(CONSOLE, b"00000009", "00000009");
    let mut again = helper.open(CONSOLE, &fresh.unwrap()).unwrap();
    assert!(again.accepted() && again.lists(1));
}

#[test]
fn a_wrong_code_does_not_bring_a_revoked_console_back() {
    let helper = Helper::start("revoked-wrong-code");
    let (key, _) = helper.pair(CONSOLE, b"00000010", "00000010");
    let key = key.unwrap();
    let mut console = helper.open(CONSOLE, &key).unwrap();
    assert!(console.accepted());
    console.send(Kind::Request, 1, br#"{"op":"revoke"}"#);
    console.receive().unwrap();

    let (rejected, _) = helper.pair(CONSOLE, b"00000011", "00000012");
    assert!(rejected.is_err());
    assert_eq!(
        helper.open(CONSOLE, &key).err(),
        Some(Error::Refused(Status::UnknownConsole))
    );
}
