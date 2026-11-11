use super::{
    Deadline, WorkerError, WorkerResult,
    audio_callbacks::AudioOwner,
    connect,
    direct_input::{self, DirectInput},
    key_directory,
    lifecycle::{Event as LifecycleEvent, Lifecycle},
    listener_callbacks::{Event as ListenerEvent, ListenerOwner},
    native,
    native_engine::{NativeEngine, Server},
    not_paired,
    video_callbacks::{Frame, VideoOwner},
};
use std::collections::VecDeque;
use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const MAX_INPUT: usize = 4094;
const STOP_TIMEOUT: Duration = Duration::from_secs(9);

struct Options {
    host: String,
    app: String,
    video_fd: i32,
    audio_fd: Option<i32>,
    format: i32,
    codec: &'static str,
    width: i32,
    height: i32,
    fps: i32,
    bitrate: i32,
    sops: bool,
    local_audio: bool,
    quit: bool,
}

fn parse(args: &[String]) -> Result<Options, ()> {
    if args.len() < 2 {
        return Err(());
    }
    let host = args[0].clone();
    let app = args[1].clone();
    if host.is_empty() || host.len() > 255 || app.is_empty() || app.len() > 1024 {
        return Err(());
    }
    let mut video_fd = None;
    let mut audio_fd = None;
    let mut format = None;
    let mut size = None;
    let mut fps = None;
    let mut bitrate = None;
    let mut sops = false;
    let mut local_audio = false;
    let mut quit = false;
    let mut index = 2;
    while index < args.len() {
        let flag = args[index].as_str();
        index += 1;
        match flag {
            "--sops" if !sops => sops = true,
            "--local-audio" if !local_audio => local_audio = true,
            "--quit" if !quit => quit = true,
            "--raw-fd" if video_fd.is_none() => {
                video_fd = Some(args.get(index).ok_or(())?.parse::<i32>().map_err(|_| ())?);
                index += 1;
            }
            "--audio-fd" if audio_fd.is_none() => {
                audio_fd = Some(args.get(index).ok_or(())?.parse::<i32>().map_err(|_| ())?);
                index += 1;
            }
            "--codec" if format.is_none() => {
                format = Some(match args.get(index).map(String::as_str) {
                    Some("h264") => (native::VIDEO_FORMAT_H264 as i32, "h264"),
                    Some("hevc") => (native::VIDEO_FORMAT_H265 as i32, "hevc"),
                    Some("av1") => (native::VIDEO_FORMAT_AV1_MAIN8 as i32, "av1"),
                    _ => return Err(()),
                });
                index += 1;
            }
            "--size" if size.is_none() => {
                let (width, height) = args.get(index).ok_or(())?.split_once('x').ok_or(())?;
                size = Some((
                    width.parse::<i32>().map_err(|_| ())?,
                    height.parse::<i32>().map_err(|_| ())?,
                ));
                index += 1;
            }
            "--fps" if fps.is_none() => {
                fps = Some(args.get(index).ok_or(())?.parse::<i32>().map_err(|_| ())?);
                index += 1;
            }
            "--bitrate" if bitrate.is_none() => {
                bitrate = Some(args.get(index).ok_or(())?.parse::<i32>().map_err(|_| ())?);
                index += 1;
            }
            _ => return Err(()),
        }
    }
    let video_fd = video_fd.ok_or(())?;
    let (format, codec) = format.ok_or(())?;
    let (width, height) = size.ok_or(())?;
    let fps = fps.ok_or(())?;
    let bitrate = bitrate.ok_or(())?;
    if video_fd < 3
        || audio_fd.is_some_and(|fd| fd < 3 || fd == video_fd)
        || !(2..=3840).contains(&width)
        || width % 2 != 0
        || !(2..=2160).contains(&height)
        || height % 2 != 0
        || !(1..=120).contains(&fps)
        || !(1..=1_000_000).contains(&bitrate)
    {
        return Err(());
    }
    Ok(Options {
        host,
        app,
        video_fd,
        audio_fd,
        format,
        codec,
        width,
        height,
        fps,
        bitrate,
        sops,
        local_audio,
        quit,
    })
}

fn nonblocking(fd: i32) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn find_app(server: &mut native::SERVER_DATA, wanted: &CString) -> Result<i32, ()> {
    let mut apps = std::ptr::null_mut();
    let _deadline = Deadline::new(15);
    if unsafe { native::gs_applist(server, &mut apps) } != 0 {
        return Err(());
    }
    let mut end = std::ptr::null_mut();
    let id = unsafe { libc::strtol(wanted.as_ptr(), &mut end, 10) };
    for _ in 0..4096 {
        if apps.is_null() {
            return Err(());
        }
        let app = unsafe { &*apps };
        if !app.name.is_null()
            && ((unsafe { *end } == 0 && i64::from(app.id) == id)
                || unsafe { libc::strcasecmp(app.name, wanted.as_ptr()) } == 0)
        {
            return Ok(app.id);
        }
        apps = app.next;
    }
    Err(())
}

pub fn run(args: &[String]) -> WorkerResult {
    let options = parse(args)?;
    nonblocking(options.video_fd).map_err(|_| ())?;
    if let Some(fd) = options.audio_fd {
        nonblocking(fd).map_err(|_| ())?;
    }
    nonblocking(libc::STDIN_FILENO).map_err(|_| ())?;
    let video_fd = unsafe { OwnedFd::from_raw_fd(options.video_fd) };
    let mut video = File::from(video_fd);
    let mut audio = options
        .audio_fd
        .map(|fd| File::from(unsafe { OwnedFd::from_raw_fd(fd) }));
    let host = CString::new(options.host.as_str()).map_err(|_| ())?;
    let app = CString::new(options.app.as_str()).map_err(|_| ())?;
    let key_path = key_directory()?;
    let keys = CString::new(key_path.as_os_str().as_bytes()).map_err(|_| ())?;
    let mut server = connect(&host, &keys)?;
    if !server.paired {
        return Err(not_paired());
    }
    let app_id = find_app(&mut server, &app)?;
    let mut config: native::STREAM_CONFIGURATION = unsafe { std::mem::zeroed() };
    unsafe { native::LiInitializeStreamConfiguration(&mut config) };
    config.width = options.width;
    config.height = options.height;
    config.fps = options.fps;
    config.bitrate = options.bitrate;
    config.packetSize = 1392;
    config.streamingRemotely = native::STREAM_CFG_LOCAL as i32;
    config.audioConfiguration = native::MOONLIGHT_AUDIO_STEREO as i32;
    config.supportedVideoFormats = options.format;
    config.colorSpace = native::COLORSPACE_REC_709 as i32;
    config.colorRange = native::COLOR_RANGE_LIMITED as i32;
    config.encryptionFlags = native::ENCFLG_ALL as i32;
    if unsafe {
        native::gs_start_app(
            &mut server,
            &mut config,
            app_id,
            options.sops,
            options.local_audio,
            1,
        )
    } != 0
    {
        return Err(WorkerError::Failed);
    }
    let server_info = unsafe { Server::from_upstream(&server.serverInfo) }?;
    let (video_owner, frames) =
        VideoOwner::new(options.format, options.width, options.height, options.fps)?;
    let audio_owner = if audio.is_some() {
        Some(AudioOwner::new()?)
    } else {
        None
    };
    let pcm = audio_owner.as_ref().map(AudioOwner::reader);
    let (listener, events) = ListenerOwner::new()?;
    let monitor = listener.monitor();
    let engine = Arc::new(NativeEngine::new(
        server_info,
        config,
        video_owner,
        audio_owner,
        listener,
    ));
    let mut lifecycle = Lifecycle::new(engine).map_err(|_| ())?;
    let mut input = DirectInput::default();
    let mut input_bytes = Vec::new();
    let mut queued_input = VecDeque::new();
    let mut queued_input_bytes = 0usize;
    let mut video_pending: Option<(Frame, usize)> = None;
    let mut audio_pending: Option<(Vec<u8>, usize)> = None;
    let mut sequence = 0u64;
    let mut native_connected = false;
    let mut started = false;
    let mut announced = false;
    let mut stopping: Option<Instant> = None;
    let mut failed = false;
    let mut native_stopped = false;
    let mut next_rtt = Instant::now() + Duration::from_secs(1);
    loop {
        if monitor.overflowed() && !failed {
            eprintln!("{{\"event\":\"listener-overflow\"}}");
            failed = true;
            request_stop(&mut lifecycle, &mut stopping);
        }
        while let Ok(event) = events.try_recv() {
            match event {
                ListenerEvent::Connected => native_connected = true,
                ListenerEvent::StageFailed { stage, code } => {
                    eprintln!("{{\"event\":\"stage-failed\",\"stage\":{stage},\"code\":{code}}}");
                    failed = true;
                    request_stop(&mut lifecycle, &mut stopping);
                }
                ListenerEvent::Terminated(code) => {
                    eprintln!("{{\"event\":\"terminated\",\"code\":{code}}}");
                    failed |= code != 0;
                    request_stop(&mut lifecycle, &mut stopping);
                }
                ListenerEvent::Status(value) => {
                    let status = if value == 1 { "poor" } else { "okay" };
                    eprintln!("{{\"event\":\"connection-status\",\"status\":\"{status}\"}}");
                }
            }
        }
        if announced && stopping.is_none() {
            input.set_motion_rates(monitor.motion_rates());
            monitor.take_rumble(|rumble| {
                eprintln!(
                    "{{\"event\":\"rumble\",\"controller\":{},\"low\":{},\"high\":{}}}",
                    rumble.controller, rumble.low, rumble.high
                );
            });
        }
        if let Some(event) = lifecycle.poll() {
            match event {
                LifecycleEvent::Started => started = true,
                LifecycleEvent::Failed => return Err(WorkerError::Failed),
                LifecycleEvent::Stopped => native_stopped = true,
            }
        }
        if native_connected && started && !announced && stopping.is_none() {
            eprintln!("{{\"event\":\"video\",\"codec\":\"{}\"}}", options.codec);
            eprintln!("{{\"event\":\"connected\"}}");
            direct_input::announce(0, 1);
            announced = true;
        }
        if stopping.is_none() {
            let mut chunk = [0u8; 4096];
            match io::stdin().read(&mut chunk) {
                Ok(0) => request_stop(&mut lifecycle, &mut stopping),
                Ok(count) => {
                    for byte in &chunk[..count] {
                        if *byte == b'\n' {
                            if queued_input_bytes + input_bytes.len() > 32 * 1024 {
                                return Err(WorkerError::Failed);
                            }
                            queued_input_bytes += input_bytes.len();
                            queued_input.push_back(std::mem::take(&mut input_bytes));
                        } else {
                            if input_bytes.len() == MAX_INPUT {
                                return Err(WorkerError::Failed);
                            }
                            input_bytes.push(*byte);
                        }
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return Err(WorkerError::Failed),
            }
        }
        forward_queued_input(
            started,
            stopping.is_some(),
            native_stopped,
            &mut input,
            &mut queued_input,
            &mut queued_input_bytes,
        )?;
        let now = Instant::now();
        if now >= next_rtt && announced && stopping.is_none() && !native_stopped {
            if let Some((rtt, variance)) = upstream_rtt() {
                eprintln!("{{\"event\":\"rtt\",\"ms\":{rtt},\"varianceMs\":{variance}}}");
            }
            next_rtt = now + Duration::from_secs(1);
        }
        if video_pending.is_none() {
            video_pending = frames.try_recv().ok().map(|frame| (frame, 0));
        }
        if let Some((frame, offset)) = &mut video_pending {
            if write_some(&mut video, &frame.bytes, offset).is_err() {
                return Err(WorkerError::Failed);
            }
            if *offset == frame.bytes.len() {
                eprintln!(
                    "{{\"type\":\"au\",\"seq\":{sequence},\"frame\":{},\"bytes\":{},\"keyframe\":{},\"pts\":{}}}",
                    frame.number as u32,
                    frame.bytes.len(),
                    frame.keyframe,
                    frame.pts_us
                );
                sequence = sequence.checked_add(1).ok_or(())?;
                video_pending = None;
            }
        }
        if let (Some(audio), Some(pcm)) = (&mut audio, &pcm) {
            if audio_pending.is_none() {
                audio_pending = pcm.take().map(|bytes| (bytes, 0));
            }
            if let Some((bytes, offset)) = &mut audio_pending {
                if write_some(audio, bytes, offset).is_err() {
                    return Err(WorkerError::Failed);
                }
                if *offset == bytes.len() {
                    audio_pending = None;
                }
            }
        }
        if native_stopped {
            if video_pending.is_none() {
                video_pending = frames.try_recv().ok().map(|frame| (frame, 0));
            }
            if audio_pending.is_none()
                && let Some(pcm) = &pcm
            {
                audio_pending = pcm.take().map(|bytes| (bytes, 0));
            }
            if video_pending.is_none() && audio_pending.is_none() {
                break;
            }
        }
        if stopping.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(WorkerError::Failed);
        }
        thread::sleep(Duration::from_millis(2));
    }
    if options.quit && started {
        unsafe { native::gs_quit_app(&mut server) };
    }
    if failed {
        return Err(WorkerError::Failed);
    }
    eprintln!("{{\"event\":\"stopped\"}}");
    Ok(())
}

fn upstream_rtt() -> Option<(u32, u32)> {
    let mut rtt = 0;
    let mut variance = 0;
    unsafe { native::LiGetEstimatedRttInfo(&mut rtt, &mut variance) }.then_some((rtt, variance))
}

pub(super) fn forward_queued_input(
    started: bool,
    stopping: bool,
    stopped: bool,
    input: &mut DirectInput,
    queued: &mut VecDeque<Vec<u8>>,
    queued_bytes: &mut usize,
) -> WorkerResult {
    if !started || stopping || stopped {
        return Ok(());
    }
    while let Some(line) = queued.pop_front() {
        *queued_bytes -= line.len();
        for supported in input.handle(&line).map_err(|_| ())? {
            eprintln!("{{\"event\":\"touch\",\"supported\":{supported}}}");
        }
    }
    Ok(())
}

fn write_some(file: &mut File, bytes: &[u8], offset: &mut usize) -> io::Result<()> {
    match file.write(&bytes[*offset..]) {
        Ok(0) => Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "media output closed",
        )),
        Ok(count) => {
            *offset += count;
            Ok(())
        }
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn request_stop(lifecycle: &mut Lifecycle<NativeEngine>, deadline: &mut Option<Instant>) {
    if deadline.is_none() {
        lifecycle.request_stop();
        *deadline = Some(Instant::now() + STOP_TIMEOUT);
    }
}
