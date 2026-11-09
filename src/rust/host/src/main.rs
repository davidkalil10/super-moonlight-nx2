#[cfg(target_os = "linux")]
mod linux {
    use moonlight_nx2_core::control;
    use moonlight_nx2_host::{
        control_server::{Connection, Error},
        helper::Helper,
    };
    use std::{
        io::{self, Read, Write},
        net::{SocketAddr, TcpListener},
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

    pub fn run() -> Result<(), &'static str> {
        let mut args = std::env::args_os().skip(1);
        let listen = args
            .next()
            .ok_or("expected listen address and helper path")?;
        let executable = args
            .next()
            .ok_or("expected listen address and helper path")?;
        if args.next().is_some() {
            return Err("expected listen address and helper path");
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
