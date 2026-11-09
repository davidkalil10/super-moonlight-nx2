use super::audio_callbacks::AudioOwner;
use super::lifecycle::Engine;
use super::listener_callbacks::ListenerOwner;
use super::native;
use super::video_callbacks::VideoOwner;
use std::ffi::{CStr, CString};
use std::ptr;
use std::sync::Mutex;
use std::sync::atomic::{Ordering, compiler_fence};

pub struct Server {
    address: CString,
    app_version: CString,
    gfe_version: Option<CString>,
    rtsp_url: Option<CString>,
    codec_support: i32,
}

impl Server {
    pub unsafe fn from_upstream(info: &native::SERVER_INFORMATION) -> Result<Self, ()> {
        unsafe fn read(pointer: *const libc::c_char) -> Result<Option<String>, ()> {
            if pointer.is_null() {
                return Ok(None);
            }
            if unsafe { libc::strnlen(pointer, 4097) } > 4096 {
                return Err(());
            }
            Ok(Some(
                unsafe { CStr::from_ptr(pointer) }
                    .to_str()
                    .map_err(|_| ())?
                    .to_owned(),
            ))
        }
        let address = unsafe { read(info.address) }?.ok_or(())?;
        let version = unsafe { read(info.serverInfoAppVersion) }?.ok_or(())?;
        let gfe = unsafe { read(info.serverInfoGfeVersion) }?;
        let rtsp = unsafe { read(info.rtspSessionUrl) }?;
        Self::new(
            &address,
            &version,
            gfe.as_deref(),
            rtsp.as_deref(),
            info.serverCodecModeSupport,
        )
    }

    pub fn new(
        address: &str,
        app_version: &str,
        gfe_version: Option<&str>,
        rtsp_url: Option<&str>,
        codec_support: i32,
    ) -> Result<Self, ()> {
        fn required(value: &str) -> Result<CString, ()> {
            if value.is_empty() || value.len() > 4096 {
                return Err(());
            }
            CString::new(value).map_err(|_| ())
        }
        fn optional(value: Option<&str>) -> Result<Option<CString>, ()> {
            value.map(required).transpose()
        }
        if codec_support == 0 {
            return Err(());
        }
        Ok(Self {
            address: required(address)?,
            app_version: required(app_version)?,
            gfe_version: optional(gfe_version)?,
            rtsp_url: optional(rtsp_url)?,
            codec_support,
        })
    }

    fn information(&self) -> native::SERVER_INFORMATION {
        let mut info = unsafe { std::mem::zeroed() };
        unsafe { native::LiInitializeServerInformation(&mut info) };
        info.address = self.address.as_ptr();
        info.serverInfoAppVersion = self.app_version.as_ptr();
        info.serverInfoGfeVersion = self
            .gfe_version
            .as_ref()
            .map_or(ptr::null(), |s| s.as_ptr());
        info.rtspSessionUrl = self.rtsp_url.as_ref().map_or(ptr::null(), |s| s.as_ptr());
        info.serverCodecModeSupport = self.codec_support;
        info
    }
}

struct Inputs {
    server: Server,
    config: native::STREAM_CONFIGURATION,
    video: native::DECODER_RENDERER_CALLBACKS,
    audio: Option<native::AUDIO_RENDERER_CALLBACKS>,
    listener: native::CONNECTION_LISTENER_CALLBACKS,
    _video_owner: VideoOwner,
    _audio_owner: Option<AudioOwner>,
    _listener_owner: ListenerOwner,
}

impl Drop for Inputs {
    fn drop(&mut self) {
        for byte in self
            .config
            .remoteInputAesKey
            .iter_mut()
            .chain(self.config.remoteInputAesIv.iter_mut())
        {
            unsafe { ptr::write_volatile(byte, 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}

pub struct NativeEngine {
    inputs: Mutex<Inputs>,
}

impl NativeEngine {
    pub fn new(
        server: Server,
        config: native::STREAM_CONFIGURATION,
        video: VideoOwner,
        audio: Option<AudioOwner>,
        listener: ListenerOwner,
    ) -> Self {
        let video_callbacks = video.callbacks();
        let audio_callbacks = audio.as_ref().map(AudioOwner::callbacks);
        let listener_callbacks = listener.callbacks();
        Self {
            inputs: Mutex::new(Inputs {
                server,
                config,
                video: video_callbacks,
                audio: audio_callbacks,
                listener: listener_callbacks,
                _video_owner: video,
                _audio_owner: audio,
                _listener_owner: listener,
            }),
        }
    }
}

impl Engine for NativeEngine {
    fn start(&self) -> bool {
        let Ok(mut inputs) = self.inputs.lock() else {
            return false;
        };
        let Inputs {
            server,
            config,
            video,
            audio,
            listener,
            ..
        } = &mut *inputs;
        let mut information = server.information();
        let audio = audio
            .as_mut()
            .map_or(ptr::null_mut(), |callbacks| callbacks as *mut _);
        unsafe {
            native::LiStartConnection(
                &mut information,
                config,
                listener,
                video,
                audio,
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                0,
            ) == 0
        }
    }

    fn interrupt(&self) {
        unsafe { native::LiInterruptConnection() };
    }

    fn stop(&self) {
        unsafe { native::LiStopConnection() };
    }
}
