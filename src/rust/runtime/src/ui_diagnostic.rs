extern crate alloc;

use alloc::{boxed::Box, format};
use moonlight_nx2_ui::{
    bridge::{self, Bridge, Storage},
    composer::Composer,
    glyphs::Glyphs,
    model::{Address, App, Event, Host, IntentKind, Name, Screen},
    settings::Capabilities,
    store::Files,
};

pub const DURATION_NS: u64 = if cfg!(any(
    feature = "diagnostic-ui-order",
    feature = "diagnostic-ui-data"
)) {
    20_000_000_000
} else {
    40_000_000_000
};
const REPLY_NS: u64 = 800_000_000;

pub struct NoFiles;

impl Files for NoFiles {
    fn read(&mut self, _name: &str, _buffer: &mut [u8]) -> Option<usize> {
        None
    }

    fn write(&mut self, _name: &str, _bytes: &[u8]) -> bool {
        false
    }
}

pub struct Scene {
    pub bridge: Box<Bridge<NoFiles>>,
    composer: Composer,
    reply: Option<(IntentKind, u64)>,
    hosts: [Host; 2],
    apps: [App; 12],
    synthetic_overlay: bool,
}

#[derive(Debug)]
pub enum Error {
    Storage,
    Atlas,
    Bridge(bridge::Error),
}

pub struct Frame {
    pub screen: Screen,
    pub published: bool,
    pub interactive: bool,
    pub applied: u32,
    pub command: u32,
    pub cached_bytes: usize,
}

fn storage(bytes: &mut [u8]) -> Result<&mut Storage, Error> {
    bytes.try_into().map_err(|_| Error::Storage)
}

pub fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

impl Scene {
    pub fn new(bytes: &mut [u8], atlas: &[u8], epoch: u32) -> Result<Self, Error> {
        let hosts = [
            Host {
                name: Name::of("Desk"),
                address: Address::of("192.168.8.245"),
                uniqueid: Address::of("A1B2"),
                mac: None,
            },
            Host {
                name: Name::of("Living room"),
                address: Address::of("10.0.0.7"),
                uniqueid: Address::default(),
                mac: None,
            },
        ];
        let mut bridge = Box::new(Bridge::new(
            storage(bytes)?,
            &hosts,
            None,
            Capabilities::default(),
            epoch,
        ));
        bridge.dispatch(storage(bytes)?, &Event::Attached);
        Ok(Self {
            bridge,
            composer: Composer::new(Glyphs::new(atlas).ok_or(Error::Atlas)?, 0),
            reply: None,
            hosts,
            apps: core::array::from_fn(|index| App {
                id: 100 + index as u32,
                name: Name::of(&format!("Game {}", index + 1)),
            }),
            synthetic_overlay: false,
        })
    }

    pub fn frame(&mut self, bytes: &mut [u8], now_ns: u64) -> Result<Frame, Error> {
        let bytes = storage(bytes)?;
        self.bridge.poll(bytes, now_ns);
        if let Some((kind, at)) = self.reply
            && now_ns >= at
        {
            self.reply = None;
            let event = match kind {
                IntentKind::List => Event::Listed {
                    apps: &self.apps,
                    current_game: 103,
                    message: None,
                },
                IntentKind::UnpairHost => Event::Unpaired,
                _ => Event::Hosts { hosts: &self.hosts },
            };
            self.bridge.dispatch(bytes, &event);
        }
        for intent in self.bridge.take_intents(bridge::MAX_QUEUED) {
            match intent.kind {
                IntentKind::List | IntentKind::RefreshHosts | IntentKind::UnpairHost => {
                    self.reply = Some((intent.kind, now_ns.saturating_add(REPLY_NS)));
                }
                IntentKind::CancelList => self.reply = None,
                _ => {}
            }
        }
        self.bridge.set_busy(bytes, self.reply.is_some());
        let published = self
            .bridge
            .publish(bytes, &mut self.composer, now_ns)
            .map_err(Error::Bridge)?;
        if self.synthetic_overlay {
            bytes[bridge::OVERLAY..bridge::OVERLAY + 4].copy_from_slice(&1u32.to_le_bytes());
        }
        Ok(Frame {
            screen: self.bridge.model().screen(),
            published,
            interactive: self.bridge.interactive(bytes),
            applied: word(bytes, bridge::APPLIED),
            command: word(bytes, bridge::HOST_ACK),
            cached_bytes: self.composer.cached_bytes(),
        })
    }

    pub fn open_apps(&mut self, bytes: &mut [u8]) -> Result<(), Error> {
        self.bridge.dispatch(
            storage(bytes)?,
            &Event::Command {
                op: moonlight_nx2_ui::model::Op::A,
                item: moonlight_nx2_ui::model::item::HOST,
                value: 0,
            },
        );
        Ok(())
    }

    pub fn open_mock_stream(&mut self, bytes: &mut [u8]) -> Result<(), Error> {
        use moonlight_nx2_ui::model::{Op, item};
        let storage = storage(bytes)?;
        self.bridge.set_capabilities(Capabilities {
            av1: true,
            ..Capabilities::default()
        });
        for event in [
            Event::Command {
                op: Op::A,
                item: item::HOST,
                value: 0,
            },
            Event::Listed {
                apps: &self.apps,
                current_game: 103,
                message: None,
            },
            Event::Command {
                op: Op::A,
                item: item::APP + 3,
                value: 0,
            },
            Event::StreamStarted,
        ] {
            self.bridge.dispatch(storage, &event);
        }
        self.bridge
            .take_intents(bridge::MAX_QUEUED)
            .for_each(|_| {});
        self.reply = None;
        Ok(())
    }

    pub fn open_overlay(&mut self, bytes: &mut [u8]) -> Result<(), Error> {
        self.open_mock_stream(bytes)?;
        self.bridge.dispatch(
            storage(bytes)?,
            &Event::Command {
                op: moonlight_nx2_ui::model::Op::Chord,
                item: 0,
                value: 0,
            },
        );
        self.synthetic_overlay = true;
        Ok(())
    }

    pub fn close(&mut self, bytes: &mut [u8]) -> Result<(), Error> {
        self.bridge.close(storage(bytes)?);
        Ok(())
    }
}

#[cfg(target_os = "none")]
pub fn check() -> bool {
    use crate::{device::log, render};
    unsafe extern "C" {
        fn moonlightPlatformStackAvailable() -> u64;
    }
    let stack = unsafe { moonlightPlatformStackAvailable() };
    log(&format!("ui: stack available={stack} required=786432"));
    if stack < 786_432 {
        log("ui: insufficient stack for bounded UI constructor");
        return false;
    }
    let mut renderer = match render::Renderer::open(render::Config {
        capture_ui: cfg!(feature = "diagnostic-ui-data"),
        ui_shader: if cfg!(feature = "diagnostic-ui-alpha") {
            render::UiShader::Alpha
        } else if cfg!(any(
            feature = "diagnostic-ui-text",
            feature = "diagnostic-ui-text-interactive"
        )) {
            render::UiShader::Text
        } else {
            render::UiShader::Standard
        },
        ..render::Config::default()
    }) {
        Ok(renderer) => renderer,
        Err(error) => {
            log(&format!("ui: renderer open FAILED {error:?}"));
            return false;
        }
    };
    let result = run(&mut renderer);
    let closed = renderer.close();
    log(&format!("ui: renderer close {closed:?}"));
    result && closed.is_ok()
}

#[cfg(target_os = "none")]
fn run(renderer: &mut crate::render::Renderer) -> bool {
    use crate::{device::log, hid::Sampler, render, sdk};
    const ATLAS: &[u8] = include_bytes!("../../../streamer/ui/fonts/glyphs.bin");
    let start = unsafe { sdk::moonlightNowNs() };
    let Ok(bytes) = renderer.storage_mut() else {
        return false;
    };
    let mut scene = match Scene::new(bytes, ATLAS, (start >> 20) as u32 | 1) {
        Ok(scene) => scene,
        Err(error) => {
            log(&format!("ui: scene open FAILED {error:?}"));
            return false;
        }
    };
    let mut sampler = match Sampler::open() {
        Ok(sampler) => sampler,
        Err(error) => {
            log(&format!("ui: input open FAILED {error:?}"));
            return false;
        }
    };
    #[cfg(feature = "diagnostic-ui-text-apps")]
    {
        let opened = renderer
            .storage_mut()
            .ok()
            .and_then(|bytes| scene.open_apps(bytes).ok());
        if opened.is_none() {
            return false;
        }
        log("ui.data: fixed mock Apps; original text colors; no launch or codec");
    }
    #[cfg(feature = "diagnostic-ui-text-overlay")]
    {
        let opened = renderer
            .storage_mut()
            .ok()
            .and_then(|bytes| scene.open_overlay(bytes).ok());
        if opened.is_none() {
            return false;
        }
        log(
            "ui.data: fixed synthetic streaming overlay; mock UI AV1 flag only, no decoder capability or stream",
        );
    }
    log(&format!(
        "ui: mock PCs; all codecs disabled; {} seconds; Plus exits; no files/network",
        DURATION_NS / 1_000_000_000
    ));
    let mut frames = 0;
    let mut publishes = 0;
    let mut second = start;
    let mut failed = false;
    #[cfg(feature = "diagnostic-ui-data")]
    let mut dumped = false;
    #[cfg(feature = "diagnostic-ui-order")]
    let mut separate = false;
    #[cfg(feature = "diagnostic-ui-order")]
    log("ui.order: instanced; switches to separate after10seconds, no navigation");
    while unsafe { sdk::appletMainLoop() } {
        let now = unsafe { sdk::moonlightNowNs() };
        if now.saturating_sub(start) >= DURATION_NS {
            break;
        }
        #[cfg(feature = "diagnostic-ui-order")]
        if !separate && now.saturating_sub(start) >= 10_000_000_000 {
            if let Err(error) = renderer.set_ui_draws(render::UiDraws::Separate) {
                log(&format!("ui.order: switch FAILED {error:?}"));
                failed = true;
                break;
            }
            log("ui.order: separate");
            separate = true;
        }
        let sample = match sampler.read(renderer, true) {
            Ok(sample) => sample,
            Err(error) => {
                log(&format!("ui: input FAILED {error:?}"));
                failed = true;
                break;
            }
        };
        if sample.raw_buttons & (1 << 10) != 0 {
            log("ui: Plus exit");
            break;
        }
        #[cfg(feature = "diagnostic-ui-data")]
        match renderer.input_mut() {
            Ok(input) => {
                input[8..32].fill(0);
                input[crate::hid::TOUCH_OFFSET..crate::hid::REQUIRED_BYTES].fill(0);
            }
            Err(error) => {
                log(&format!("ui.data: input mask FAILED {error:?}"));
                failed = true;
                break;
            }
        }
        let frame = match renderer.storage_mut() {
            Ok(bytes) => scene.frame(bytes, now),
            Err(error) => {
                log(&format!("ui: storage FAILED {error:?}"));
                failed = true;
                break;
            }
        };
        let frame = match frame {
            Ok(frame) => frame,
            Err(error) => {
                log(&format!("ui: frame FAILED {error:?}"));
                failed = true;
                break;
            }
        };
        if frame.published {
            publishes += 1;
            log(&format!("ui: page {}", frame.screen.name()));
        }
        match renderer.present(frame.interactive) {
            Ok(()) => frames += 1,
            Err(render::Error::Busy) => {}
            Err(error) => {
                log(&format!("ui: present FAILED {error:?}"));
                failed = true;
                break;
            }
        }
        #[cfg(feature = "diagnostic-ui-data")]
        if !dumped && now.saturating_sub(start) >= 3_000_000_000 {
            if !dump(renderer, start) {
                log("ui.data: capture FAILED");
                failed = true;
                break;
            }
            dumped = true;
        }
        if now.saturating_sub(second) >= 1_000_000_000 {
            log(&format!(
                "ui: frames={frames} publishes={publishes} screen={} applied={} ack={} cached={}",
                frame.screen.name(),
                frame.applied,
                frame.command,
                frame.cached_bytes
            ));
            second = now;
        }
    }
    if !sdk::process_retired() {
        match renderer.storage_mut() {
            Ok(bytes) => failed |= scene.close(bytes).is_err(),
            Err(_) => failed = true,
        }
    }
    log(&format!(
        "ui: total frames={frames} publishes={publishes} elapsed_ms={} rewrites={} timeouts={} dropped={}",
        unsafe { sdk::moonlightNowNs() }.saturating_sub(start) / 1_000_000,
        scene.bridge.header_rewrites(),
        scene.bridge.apply_timeouts(),
        scene.bridge.dropped_intents()
    ));
    #[cfg(feature = "diagnostic-ui-data")]
    let failed = failed || !dumped;
    !failed && frames > 0 && publishes > 0 && scene.bridge.apply_timeouts() == 0
}

#[cfg(all(target_os = "none", feature = "diagnostic-ui-data"))]
fn dump(renderer: &mut crate::render::Renderer, start: u64) -> bool {
    use crate::{device::log, files::Directory};
    use alloc::ffi::CString;
    unsafe extern "C" {
        fn moonlightPlatformDumpFile(
            path: *const core::ffi::c_char,
            bytes: *const u8,
            length: usize,
        ) -> bool;
    }
    let gpu = match renderer.ui_readback() {
        Ok(bytes) => bytes,
        Err(error) => {
            log(&format!("ui.data: GPU readback FAILED {error:?}"));
            return false;
        }
    };
    let cpu = match renderer.ui_snapshot() {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    let pixels = match renderer.readback() {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    let path = CString::new(format!(
        "sdmc:/switch/moonlight-nx2/rust/ui-data-{start:016x}"
    ))
    .unwrap();
    if Directory::open(&path).is_none() {
        return false;
    }
    log(&format!(
        "ui.data: directory={} format={} width={} height={}",
        path.to_str().unwrap(),
        renderer.info().unwrap().format,
        renderer.info().unwrap().width,
        renderer.info().unwrap().height
    ));
    let different = cpu.iter().zip(&gpu).filter(|(a, b)| a != b).count();
    log(&format!(
        "ui.data: bytes={} cpu_gpu_equal={} different={different}",
        cpu.len(),
        cpu == gpu
    ));
    for (name, bytes) in [
        ("cpu-ui.bin", &cpu),
        ("gpu-ui.bin", &gpu),
        ("out.rgba", &pixels),
    ] {
        let file = CString::new(format!("{}/{name}", path.to_str().unwrap())).unwrap();
        if !unsafe { moonlightPlatformDumpFile(file.as_ptr(), bytes.as_ptr(), bytes.len()) } {
            return false;
        }
        log(&format!("ui.data: saved {name} bytes={}", bytes.len()));
    }
    true
}
