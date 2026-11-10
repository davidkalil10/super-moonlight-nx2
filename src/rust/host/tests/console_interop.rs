//! The console's own socket and control channel (io crate) against the real helper service.

use moonlight_nx2_io::{
    control::{Channel, Config, State},
    secure::SecureSocket,
    socket::{IoError, Socket},
};
use moonlight_nx2_secure::{Error, Mode, Random, SESSION_TOKEN, Status};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const HOST: &str = env!("CARGO_BIN_EXE_moonlight-nx2-host");
const CONSOLE: [u8; 16] = [0x5a; 16];

struct Tcp(TcpStream);

fn map(error: std::io::Error) -> IoError {
    match error.kind() {
        std::io::ErrorKind::WouldBlock => IoError::WouldBlock,
        std::io::ErrorKind::Interrupted => IoError::Interrupted,
        _ => IoError::Disconnected(0),
    }
}

impl Socket for Tcp {
    fn poll_connect(&mut self) -> Result<bool, IoError> {
        Ok(true)
    }
    fn send(&mut self, bytes: &[u8]) -> Result<usize, IoError> {
        self.0.write(bytes).map_err(map)
    }
    fn recv(&mut self, bytes: &mut [u8]) -> Result<usize, IoError> {
        self.0.read(bytes).map_err(map)
    }
    fn close(&mut self) -> Result<(), IoError> {
        let _ = self.0.shutdown(std::net::Shutdown::Both);
        Ok(())
    }
}

struct Helper {
    root: PathBuf,
    process: Child,
    port: u16,
}

impl Helper {
    fn start(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("moonlight-interop-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let worker = root.join("worker");
        fs::write(&worker, "#!/bin/sh\nif [ \"$1\" = list ]; then printf '%s\\n' '{\"currentGame\":0,\"apps\":[{\"id\":1,\"name\":\"test\"}]}'; fi\n").unwrap();
        fs::set_permissions(&worker, fs::Permissions::from_mode(0o700)).unwrap();
        let mut process = Command::new(HOST)
            .args(["serve", "--listen", "127.0.0.1:0", "--state"])
            .arg(root.join("state"))
            .arg(&worker)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(process.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let port = line.trim().strip_prefix("READY ").unwrap().parse().unwrap();
        Self {
            root,
            process,
            port,
        }
    }

    fn socket(&self) -> Tcp {
        let socket = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        socket.set_nonblocking(true).unwrap();
        Tcp(socket)
    }

    /// Types `code` on the PC once a console waits for it; true when it paired.
    fn type_code(&self, code: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let output = Command::new(HOST)
                .args(["pair", "--state"])
                .arg(self.root.join("state"))
                .arg(code)
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&output.stderr).into_owned();
            if !text.contains("no console is waiting") {
                return output.status.success();
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn random() -> Random<fn(&mut [u8])> {
    Random(moonlight_nx2_host::service::os_random)
}

/// Polls the handshake the way the frontend does, once a frame.
fn settle(socket: &mut SecureSocket<Tcp>) -> Result<(), IoError> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if socket.poll_connect()? {
            return Ok(());
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn the_console_stack_pairs_and_runs_control_over_the_session() {
    let helper = Helper::start("stack");
    let code = *b"31415926";
    let mut pairing = SecureSocket::secured(helper.socket(), Mode::Pair, CONSOLE, &code, random());
    assert_eq!(pairing.poll_connect(), Ok(false));
    let typing = std::thread::scope(|scope| {
        let typed = scope.spawn(|| helper.type_code("31415926"));
        let settled = settle(&mut pairing);
        assert!(typed.join().unwrap());
        settled
    });
    typing.unwrap();
    let (_, key) = pairing.take_pairing().unwrap();
    pairing.close().unwrap();

    let mut session =
        SecureSocket::secured(helper.socket(), Mode::Session, CONSOLE, &key, random());
    settle(&mut session).unwrap();
    assert!(session.take_pairing().is_none());

    let mut memory = vec![0; 65_536];
    let mut outbound = vec![0; 4096];
    let config = Config {
        token: SESSION_TOKEN,
        memory: &mut memory,
        outbound: &mut outbound,
        read_budget: 65_536,
        connect_timeout_ms: 5_000,
    };
    let Ok(mut channel) = Channel::open(config, session, 0) else {
        panic!("control channel");
    };
    let started = Instant::now();
    let now = || started.elapsed().as_millis() as u64;
    while channel.state() != State::Ready {
        let _ = channel.pump(now());
        assert!(now() < 5_000, "{:?}", channel.failure());
        std::thread::sleep(Duration::from_millis(2));
    }
    let id = channel.request(br#"{"op":"list","host":"pc"}"#).unwrap();
    let reply = loop {
        let _ = channel.pump(now());
        if let Some(frame) = channel.peek() {
            assert_eq!(frame.header.request_id, id);
            break String::from_utf8(frame.payload.to_vec()).unwrap();
        }
        assert!(now() < 10_000, "{:?}", channel.failure());
        std::thread::sleep(Duration::from_millis(2));
    };
    assert!(reply.contains("\"name\":\"test\""), "{reply}");
}

#[test]
fn the_console_socket_reports_why_a_handshake_was_refused() {
    let helper = Helper::start("refused");
    let mut unknown =
        SecureSocket::secured(helper.socket(), Mode::Session, CONSOLE, &[1; 32], random());
    assert!(settle(&mut unknown).is_err());
    assert_eq!(
        unknown.failure(),
        Some(Error::Refused(Status::UnknownConsole))
    );

    let mut pairing =
        SecureSocket::secured(helper.socket(), Mode::Pair, CONSOLE, b"00000001", random());
    assert_eq!(pairing.poll_connect(), Ok(false));
    let outcome = std::thread::scope(|scope| {
        let typed = scope.spawn(|| helper.type_code("00000002"));
        let settled = settle(&mut pairing);
        assert!(!typed.join().unwrap());
        settled
    });
    assert!(outcome.is_err());
    assert_eq!(pairing.failure(), Some(Error::Confirm));
    assert!(pairing.take_pairing().is_none());
}
