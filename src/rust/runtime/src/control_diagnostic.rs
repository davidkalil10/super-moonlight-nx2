extern crate alloc;

use crate::{
    client::{Client, SingleList},
    client_session::Session,
    device::log,
    files::Directory,
    hid::Sampler,
    net::PeerConnector,
    render::{self, Renderer},
    sdk,
};
use alloc::{ffi::CString, format, vec};
use core::ffi::c_char;
use moonlight_nx2_app::{
    driver::Effect,
    link::Link,
    service::{Action, RuntimeEvent},
};
use moonlight_nx2_io::control::{self, Channel};
use moonlight_nx2_ui::{
    hosts::HostBook,
    model::{Event, Op, Screen, item},
    store::Store,
};

unsafe extern "C" {
    fn moonlightPlatformNetStart() -> bool;
    fn moonlightPlatformNetStop();
    fn moonlightPlatformStackAvailable() -> u64;
    fn moonlightIoTakeSession(
        path: *const c_char,
        data: *mut u8,
        capacity: usize,
        bytes: *mut usize,
    ) -> u32;
}

struct Secret([u8; 512]);
impl Drop for Secret {
    fn drop(&mut self) {
        for byte in &mut self.0 {
            unsafe { core::ptr::write_volatile(byte, 0) };
        }
    }
}

fn take_session() -> Option<Session> {
    let mut secret = Secret([0; 512]);
    let mut bytes = 0;
    let result = unsafe {
        moonlightIoTakeSession(
            c"sdmc:/switch/moonlight-nx2/rust/client-session".as_ptr(),
            secret.0.as_mut_ptr(),
            secret.0.len(),
            &mut bytes,
        )
    };
    if result != 0 || bytes >= secret.0.len() {
        return None;
    }
    Session::parse(&secret.0[..bytes])
}

pub fn check() -> bool {
    let stack = unsafe { moonlightPlatformStackAvailable() };
    log(&format!("client: stack available={stack} required=786432"));
    if stack < 786_432 {
        return false;
    }
    let Some(mut session) = take_session() else {
        log("client: one-time session unavailable or invalid");
        return false;
    };
    if !unsafe { moonlightPlatformNetStart() } {
        return false;
    }
    let result = match Renderer::open(render::Config::default()) {
        Ok(mut renderer) => {
            let passed = run(&mut renderer, &mut session);
            let closed = renderer.close();
            log(&format!("client: renderer close {closed:?}"));
            passed && closed.is_ok()
        }
        Err(error) => {
            log(&format!("client: renderer open FAILED {error:?}"));
            false
        }
    };
    if !sdk::process_retired() {
        unsafe { moonlightPlatformNetStop() };
    }
    result
}

#[inline(never)]
fn run(renderer: &mut Renderer, session: &mut Session) -> bool {
    const ATLAS: &[u8] = include_bytes!("../../../streamer/ui/fonts/glyphs.bin");
    let start = unsafe { sdk::moonlightNowNs() } / 1_000_000;
    let path = CString::new(format!(
        "sdmc:/switch/moonlight-nx2/rust/client-{start:016x}"
    ))
    .unwrap();
    let Some(files) = Directory::open(&path) else {
        return false;
    };
    log(&format!("client: files {}", path.to_str().unwrap()));
    let mut book = HostBook::default();
    if book.remember(&session.host).is_err() || !Store::new(files.clone()).save_hosts(&mut book) {
        return false;
    }
    let Ok(storage) = renderer.storage_mut() else {
        return false;
    };
    let mut client = match Client::new(storage, ATLAS, files, start as u32 | 1) {
        Ok(client) => client,
        Err(error) => {
            log(&format!("client: open FAILED {error:?}"));
            return false;
        }
    };
    client.event(&Event::Command {
        op: Op::A,
        item: item::HOST,
        value: 0,
    });
    let mut memory = vec![0; 65536];
    let mut outbound = vec![0; 4096];
    let mut buffers = Some((memory.as_mut_slice(), outbound.as_mut_slice()));
    let mut peer = PeerConnector::new(session.address);
    let mut control: Option<SingleList<Channel<'_, crate::net::NetSocket>>> = None;
    let mut attempted = false;
    let mut authenticated = false;
    let mut listed_at = None;
    let mut sampler = match Sampler::open() {
        Ok(sampler) => sampler,
        Err(_) => return false,
    };
    let mut frames = 0;
    let mut failed = false;
    log(
        "client: one read-only list; 20second bound; codecs disabled; no pair/start/quit/unpair/reconnect",
    );
    while unsafe { sdk::appletMainLoop() } {
        let now = unsafe { sdk::moonlightNowNs() } / 1_000_000;
        if now.saturating_sub(start) >= 20_000 {
            failed = listed_at.is_none();
            break;
        }
        if listed_at.is_some_and(|at| now.saturating_sub(at) >= 5_000) {
            break;
        }
        if sampler.read(renderer, true).is_err() {
            failed = true;
            break;
        }
        if let Some(channel) = control.as_mut() {
            match channel.link.pump(now) {
                Ok(()) | Err(control::Error::Again) => {}
                Err(error) => {
                    log(&format!("client: control FAILED {error:?}"));
                    failed = true;
                    break;
                }
            }
            if !authenticated && channel.ready() {
                authenticated = true;
                client.runtime(RuntimeEvent::LinkOpened);
                log("client: authenticated");
            }
        }
        let mut effects = vec![];
        let mut absent = Offline;
        let frame = match renderer.storage_mut() {
            Ok(bytes) => match control.as_mut() {
                Some(link) => client.frame(bytes, link, now, &mut |effect| effects.push(effect)),
                None => client.frame(bytes, &mut absent, now, &mut |effect| effects.push(effect)),
            },
            Err(_) => {
                failed = true;
                break;
            }
        };
        let frame = match frame {
            Ok(frame) => frame,
            Err(error) => {
                log(&format!("client: UI FAILED {error:?}"));
                failed = true;
                break;
            }
        };
        for effect in effects {
            match effect {
                Effect::Action(Action::OpenControl) if !attempted => {
                    attempted = true;
                    let Some((memory, outbound)) = buffers.take() else {
                        failed = true;
                        break;
                    };
                    let config = control::Config {
                        token: core::mem::replace(&mut session.token, [0; 64]),
                        memory,
                        outbound,
                        read_budget: 65536,
                        connect_timeout_ms: 5000,
                    };
                    match peer.open_control(session.port, config, now) {
                        Ok(link) => {
                            control = Some(SingleList::new(link));
                            log("client: connecting");
                        }
                        Err(error) => {
                            log(&format!("client: connect FAILED {error:?}"));
                            failed = true;
                        }
                    }
                }
                other => {
                    log(&format!("client: unexpected effect {other:?}"));
                    failed = true;
                }
            }
        }
        if failed {
            break;
        }
        if frame.screen == Screen::Apps && listed_at.is_none() {
            if client.bridge.model().apps().is_empty() {
                failed = true;
                break;
            }
            log(&format!(
                "client: list PASS apps={}",
                client.bridge.model().apps().len()
            ));
            listed_at = Some(now);
        }
        match renderer.present(frame.interactive) {
            Ok(()) => frames += 1,
            Err(render::Error::Busy) => {}
            Err(error) => {
                log(&format!("client: present FAILED {error:?}"));
                failed = true;
                break;
            }
        }
    }
    let sent = control.as_ref().is_some_and(SingleList::sent);
    let rejected = control.as_ref().is_some_and(SingleList::rejected);
    if let Some(link) = control {
        let closed = link.link.close();
        log(&format!(
            "client: control close {}",
            if closed.is_ok() { "PASS" } else { "FAIL" }
        ));
        failed |= closed.is_err();
    }
    if !sdk::process_retired() {
        match renderer.storage_mut() {
            Ok(bytes) => failed |= client.close(bytes).is_err(),
            Err(_) => failed = true,
        }
    }
    log(&format!(
        "client: total frames={frames} authenticated={authenticated} list_sent={sent} rejected={rejected} listed={}",
        listed_at.is_some()
    ));
    !failed && authenticated && sent && !rejected && listed_at.is_some() && frames > 0
}

struct Offline;
impl Link for Offline {
    fn ready(&self) -> bool {
        false
    }
    fn failed(&self) -> bool {
        false
    }
    fn request(&mut self, _: &[u8]) -> Result<u32, moonlight_nx2_app::link::LinkError> {
        Err(moonlight_nx2_app::link::LinkError::Again)
    }
    fn peek(&self) -> Option<moonlight_nx2_core::control::Frame<'_>> {
        None
    }
    fn consume(&mut self) -> Result<(), moonlight_nx2_app::link::LinkError> {
        Err(moonlight_nx2_app::link::LinkError::Again)
    }
}
