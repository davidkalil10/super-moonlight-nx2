use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const OUTPUT_LIMIT: u64 = 1 << 20;

/// Runs a display tool to its end and returns what it printed, or why it did not finish well.
pub fn run(mut command: Command, timeout: Duration) -> Result<String, String> {
    let program = command.get_program().to_string_lossy().into_owned();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("cannot run {program}: {error}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let reader = thread::spawn(move || {
        let mut text = String::new();
        stdout
            .take(OUTPUT_LIMIT)
            .read_to_string(&mut text)
            .map(|_| text)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} timed out"));
            }
            Err(error) => return Err(format!("cannot wait for {program}: {error}")),
        }
    };
    if !status.success() {
        return Err(format!("{program} ended with {status}"));
    }
    reader
        .join()
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| format!("cannot read {program} output"))
}
