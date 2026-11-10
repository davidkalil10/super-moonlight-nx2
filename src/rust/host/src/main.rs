#[cfg(target_os = "linux")]
mod linux {
    use moonlight_nx2_core::control;
    use moonlight_nx2_host::{
        control_server::{Connection, Error},
        display,
        helper::Helper,
        pairing_store::{Store, hex},
        service,
    };
    use std::{
        io::{self, Read, Write},
        net::{SocketAddr, TcpListener},
        path::{Path, PathBuf},
        sync::atomic::{AtomicBool, Ordering, compiler_fence},
        thread,
        time::{Duration, Instant},
    };

    static STOP: AtomicBool = AtomicBool::new(false);
    extern "C" fn stop(_: libc::c_int) {
        STOP.store(true, Ordering::Relaxed);
    }

    fn signals() -> io::Result<()> {
        for signal in [libc::SIGINT, libc::SIGTERM] {
            if unsafe { libc::signal(signal, stop as *const () as libc::sighandler_t) }
                == libc::SIG_ERR
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    const USAGE: &str = "expected listen address, helper path and optionally --match-display";

    pub fn display_command(arguments: &[String]) -> Result<(), String> {
        display::cli::run(arguments)
    }

    const SERVICE_USAGE: &str = "usage: moonlight-nx2-host serve [--listen ADDRESS:PORT] [--state DIRECTORY] [--match-display] WORKER
       moonlight-nx2-host pair [--state DIRECTORY] CODE
       moonlight-nx2-host consoles [--state DIRECTORY]
       moonlight-nx2-host unpair [--state DIRECTORY] ID|all";

    fn default_state() -> Result<PathBuf, String> {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
            .ok_or("neither XDG_CONFIG_HOME nor HOME is set")?;
        Ok(config.join("moonlight-nx2").join("helper"))
    }

    struct ServiceArguments {
        listen: SocketAddr,
        state: PathBuf,
        match_display: bool,
        words: Vec<String>,
    }

    fn service_arguments(arguments: &[String]) -> Result<ServiceArguments, String> {
        let mut parsed = ServiceArguments {
            listen: SocketAddr::from(([0, 0, 0, 0], service::DEFAULT_PORT)),
            state: default_state()?,
            match_display: false,
            words: Vec::new(),
        };
        let mut words = arguments.iter();
        while let Some(word) = words.next() {
            match word.as_str() {
                "--listen" => {
                    parsed.listen = words
                        .next()
                        .and_then(|value| value.parse().ok())
                        .ok_or("--listen takes ADDRESS:PORT")?
                }
                "--state" => {
                    parsed.state = words
                        .next()
                        .map(PathBuf::from)
                        .filter(|path| path.is_absolute())
                        .ok_or("--state takes an absolute directory")?
                }
                "--match-display" => parsed.match_display = true,
                _ => parsed.words.push(word.clone()),
            }
        }
        Ok(parsed)
    }

    fn serve(arguments: ServiceArguments) -> Result<(), String> {
        let [worker] = arguments.words.as_slice() else {
            return Err(SERVICE_USAGE.into());
        };
        let helper =
            Helper::new(PathBuf::from(worker)).map_err(|_| "the worker path must be absolute")?;
        signals().map_err(|_| "cannot install signal handlers")?;
        if arguments.match_display {
            display::Session::from_environment().restore();
        }
        let mut service = service::Service::bind(arguments.listen, &arguments.state)
            .map_err(|error| format!("cannot start the service: {error}"))?;
        let port = service
            .port()
            .map_err(|_| "cannot read the listener address")?;
        println!("READY {port}");
        io::stdout()
            .flush()
            .map_err(|_| "cannot report readiness")?;
        service
            .serve(&helper, arguments.match_display, &STOP)
            .map_err(|error| format!("the service stopped: {error:?}"))
    }

    /// Asks the running service; `offline` answers from the files when none runs.
    fn ask(
        state: &Path,
        command: &str,
        wait: Duration,
        offline: impl FnOnce(&Store) -> io::Result<String>,
    ) -> Result<(), String> {
        let text = match service::ask(state, command, wait) {
            Ok(text) => text,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                ) =>
            {
                Store::open(state)
                    .and_then(|store| offline(&store))
                    .map_err(|error| format!("{error}"))?
            }
            Err(error) => return Err(format!("the service did not answer: {error}")),
        };
        let (body, status) = match text.trim_end().rsplit_once('\n') {
            Some((body, status)) => (body, status),
            None => ("", text.trim_end()),
        };
        if !body.is_empty() {
            println!("{body}");
        }
        match status.strip_prefix("error ") {
            Some(reason) => Err(reason.to_string()),
            None => {
                println!("{status}");
                Ok(())
            }
        }
    }

    pub fn service_command(command: &str, arguments: &[String]) -> Result<(), String> {
        let arguments = service_arguments(arguments)?;
        let state = arguments.state.clone();
        match (command, arguments.words.as_slice()) {
            ("serve", _) => serve(arguments),
            ("pair", [code]) => ask(
                &state,
                &format!("pair {code}"),
                Duration::from_secs(20),
                |_| {
                    Err(io::Error::other(
                        "the service is not running; start it first",
                    ))
                },
            ),
            ("consoles", []) => ask(&state, "consoles", Duration::from_secs(5), |store| {
                Ok(store
                    .consoles()?
                    .iter()
                    .map(|console| {
                        format!(
                            "{} {} {}\n",
                            hex(&console.id),
                            console.address,
                            console.paired_at
                        )
                    })
                    .chain(["ok\n".to_string()])
                    .collect())
            }),
            ("unpair", [prefix]) => ask(
                &state,
                &format!("unpair {prefix}"),
                Duration::from_secs(5),
                |store| Ok(format!("ok {}\n", store.remove(prefix)?)),
            ),
            _ => Err(SERVICE_USAGE.into()),
        }
    }

    pub fn run() -> Result<(), &'static str> {
        let mut args = std::env::args_os().skip(1);
        let listen = args.next().ok_or(USAGE)?;
        let executable = args.next().ok_or(USAGE)?;
        let mut display = match args.next() {
            None => None,
            Some(flag) if flag == "--match-display" => Some(display::Session::from_environment()),
            Some(_) => return Err(USAGE),
        };
        if args.next().is_some() {
            return Err(USAGE);
        }
        if let Some(display) = &mut display {
            display.restore();
        }
        let address: SocketAddr = listen
            .to_str()
            .ok_or("invalid listen address")?
            .parse()
            .map_err(|_| "invalid listen address")?;
        let helper = Helper::new(executable).map_err(|_| "helper path must be absolute")?;
        signals().map_err(|_| "cannot install signal handlers")?;
        let mut token = Secret([0; 64]);
        read_token(&mut token.0)?;
        if !token
            .0
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            return Err("invalid control token");
        }
        let listener = TcpListener::bind(address).map_err(|_| "cannot bind control listener")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "cannot configure control listener")?;
        let bound = listener
            .local_addr()
            .map_err(|_| "cannot read control listener address")?;
        println!("READY {}", bound.port());
        io::stdout()
            .flush()
            .map_err(|_| "cannot report readiness")?;
        let socket = loop {
            if STOP.load(Ordering::Relaxed) {
                return Ok(());
            }
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(e)
                    if e.kind() == io::ErrorKind::WouldBlock
                        || e.kind() == io::ErrorKind::Interrupted =>
                {
                    thread::sleep(Duration::from_millis(2))
                }
                Err(_) => {
                    return Err("control accept failed");
                }
            }
        };
        drop(listener);
        let mut storage = vec![0; control::MAX_PAYLOAD];
        let result = Connection::new(socket, token.0, helper, &mut storage);
        drop(token);
        let mut connection = result.map_err(|_| "cannot initialize control connection")?;
        if let Some(display) = display {
            connection.match_display(display);
        }
        let mut immediate_turns = 0;
        while !STOP.load(Ordering::Relaxed) {
            match connection.pump_with_video_readiness(Instant::now()) {
                Ok(true) => {
                    immediate_turns += 1;
                    if immediate_turns == 4 {
                        immediate_turns = 0;
                        thread::sleep(Duration::from_micros(250));
                    }
                }
                Ok(false) => {
                    immediate_turns = 0;
                    thread::sleep(Duration::from_millis(2));
                }
                Err(Error::Closed) => return Ok(()),
                Err(_) => return Err("control connection failed or cleanup was not established"),
            }
        }
        connection
            .close()
            .map_err(|_| "control cleanup was not established")
    }

    struct Secret([u8; 64]);
    impl Drop for Secret {
        fn drop(&mut self) {
            wipe(&mut self.0);
        }
    }

    fn read_token(token: &mut [u8; 64]) -> Result<(), &'static str> {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut used = 0;
        let mut stdin = io::stdin();
        while used < token.len() {
            if STOP.load(Ordering::Relaxed) || Instant::now() >= deadline {
                return Err("control token input timed out or was interrupted");
            }
            let mut fd = libc::pollfd {
                fd: libc::STDIN_FILENO,
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut fd, 1, 100) };
            if ready < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err("control token input failed");
            }
            if ready == 0 {
                continue;
            }
            match stdin.read(&mut token[used..]) {
                Ok(0) => return Err("control token input closed"),
                Ok(count) => used += count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return Err("control token input failed"),
            }
        }
        Ok(())
    }

    fn wipe(bytes: &mut [u8]) {
        for byte in bytes {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}

#[cfg(target_os = "linux")]
fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let command = arguments
        .next()
        .map(|word| word.to_string_lossy().into_owned())
        .unwrap_or_default();
    if matches!(
        command.as_str(),
        "display" | "serve" | "pair" | "consoles" | "unpair"
    ) {
        let arguments: Vec<String> = arguments
            .map(|word| word.to_string_lossy().into_owned())
            .collect();
        let outcome = if command == "display" {
            linux::display_command(&arguments)
        } else {
            linux::service_command(&command, &arguments)
        };
        if let Err(message) = outcome {
            eprintln!("{message}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(message) = linux::run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("The host helper requires Linux");
    std::process::exit(1);
}
