#[cfg(feature = "diagnostic-native-decode")]
extern crate alloc;

use crate::{
    render::{self, Renderer},
    render_platform as platform,
};
#[cfg(feature = "diagnostic-native-decode")]
use alloc::format;
use core::cell::Cell;
use moonlight_nx2_core::{
    codec::{Capabilities, Depth},
    decoder::{self, Backend, Decoder},
    frame::{Frame, Matrix, Plane},
    media::Header,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Unverified,
    Closed,
    Decoder(decoder::Error),
    Renderer(render::Error),
}

#[derive(Clone, Copy)]
pub struct Config {
    pub decoder: decoder::Config,
    pub fps: u32,
    pub matrix: Matrix,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub accepted_units: u64,
    pub accepted_bytes: u64,
    pub decoded: u64,
    pub uploaded: u64,
    pub dropped: u64,
    pub presented: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Presentation {
    pub received_us: Option<u64>,
    pub presented_us: u64,
}

#[derive(Clone, Copy)]
struct Arrival {
    pts_us: u64,
    received_us: Option<u64>,
    #[cfg(feature = "diagnostic-native-decode")]
    submitted_ns: u64,
}

pub struct Video<'a, B: Backend> {
    decoder: Decoder<'a, B>,
    matrix: Matrix,
    failure: Option<Error>,
    pending: bool,
    closed: bool,
    stats: Stats,
    arrivals: [Option<Arrival>; decoder::SURFACES],
    pending_arrival: Option<u64>,
    #[cfg(feature = "diagnostic-native-decode")]
    pending_timing: Option<(u64, u64, u64)>,
    presentation: Option<Presentation>,
}

impl<'a, B: Backend> Video<'a, B> {
    pub fn open(
        backend: B,
        config: Config,
        capabilities: &Capabilities,
        retired: &'a Cell<bool>,
        frames: [&'a mut [u8]; 2],
    ) -> Result<Self, Error> {
        if !capabilities.supports(
            config.decoder.codec,
            Depth::Eight,
            config.decoder.display,
            config.fps,
        ) {
            return Err(Error::Unverified);
        }
        if platform::process_retired() {
            retired.set(true);
            return Err(Error::Decoder(decoder::Error::Retired));
        }
        let decoder = match Decoder::open(backend, config.decoder, retired, frames) {
            Ok(decoder) => decoder,
            Err(error) => {
                if retired.get() {
                    platform::retire_process();
                }
                return Err(Error::Decoder(error));
            }
        };
        Ok(Self {
            decoder,
            matrix: config.matrix,
            failure: None,
            pending: false,
            closed: false,
            stats: Stats::default(),
            arrivals: [None; decoder::SURFACES],
            pending_arrival: None,
            #[cfg(feature = "diagnostic-native-decode")]
            pending_timing: None,
            presentation: None,
        })
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }
    pub fn failure(&self) -> Option<Error> {
        self.failure
    }

    pub fn take_presentation(&mut self) -> Option<Presentation> {
        self.presentation.take()
    }

    pub fn pending(&self) -> bool {
        !self.closed && (self.pending || self.decoder.pending_units() != 0)
    }

    fn fail(&mut self, error: Error) -> Error {
        if matches!(
            error,
            Error::Decoder(decoder::Error::Uncertain | decoder::Error::Retired)
                | Error::Renderer(render::Error::Retained)
        ) {
            self.decoder.retire();
            platform::retire_process();
        }
        self.failure = Some(error);
        error
    }

    fn active(&mut self) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if platform::process_retired() {
            return Err(self.fail(Error::Renderer(render::Error::Retained)));
        }
        self.failure.map_or(Ok(()), Err)
    }

    pub fn submit(&mut self, header: &Header, bytes: &[u8]) -> Result<(), Error> {
        self.submit_timed(header, bytes, None)
    }

    pub fn submit_timed(
        &mut self,
        header: &Header,
        bytes: &[u8],
        received_us: Option<u64>,
    ) -> Result<(), Error> {
        self.active()?;
        if header.payload_bytes as usize != bytes.len() {
            return Err(self.fail(Error::Decoder(decoder::Error::Invalid)));
        }
        #[cfg(feature = "diagnostic-native-decode")]
        let submitted_ns = platform::now_ns();
        match self.decoder.submit(bytes, header.pts_us) {
            Ok(()) => {
                let Some(index) = self.arrivals.iter().position(Option::is_none) else {
                    return Err(self.fail(Error::Decoder(decoder::Error::Uncertain)));
                };
                self.arrivals[index] = Some(Arrival {
                    pts_us: header.pts_us,
                    received_us,
                    #[cfg(feature = "diagnostic-native-decode")]
                    submitted_ns,
                });
                self.stats.accepted_units += 1;
                self.stats.accepted_bytes += bytes.len() as u64;
                Ok(())
            }
            Err(decoder::Error::Again) => Err(Error::Decoder(decoder::Error::Again)),
            Err(error) => Err(self.fail(Error::Decoder(error))),
        }
    }

    pub fn poll_upload(&mut self, renderer: &mut Renderer) -> Result<bool, Error> {
        self.active()?;
        let frame = self
            .decoder
            .poll()
            .map_err(|error| self.fail(Error::Decoder(error)))?;
        if let Some(info) = frame {
            self.stats.decoded += 1;
            let Some(index) = self
                .arrivals
                .iter()
                .position(|entry| entry.is_some_and(|arrival| arrival.pts_us == info.pts_us))
            else {
                return Err(self.fail(Error::Decoder(decoder::Error::Invalid)));
            };
            let arrival = self.arrivals[index].unwrap().received_us;
            #[cfg(feature = "diagnostic-native-decode")]
            let submitted_ns = self.arrivals[index].unwrap().submitted_ns;
            #[cfg(feature = "diagnostic-native-decode")]
            let decoded_ns = platform::now_ns();
            self.stats.dropped += index as u64;
            self.arrivals.rotate_left(index + 1);
            for entry in self.arrivals.iter_mut().skip(decoder::SURFACES - index - 1) {
                *entry = None;
            }
            let bytes = match self.decoder.frame(info.token) {
                Ok(bytes) => bytes,
                Err(error) => return Err(self.fail(Error::Decoder(error))),
            };
            let luma_bytes = info.coded.width() as usize * info.coded.height() as usize;
            let (luma, chroma) = bytes.split_at(luma_bytes);
            let frame = Frame {
                luma: Plane {
                    bytes: luma,
                    stride: info.coded.width(),
                },
                chroma: Plane {
                    bytes: chroma,
                    stride: info.coded.width(),
                },
                coded_width: info.coded.width(),
                coded_height: info.coded.height(),
                crop_left: 0,
                crop_top: 0,
                display_width: info.display.width(),
                display_height: info.display.height(),
                matrix: self.matrix,
                full_range: false,
                timestamp_ns: info.timestamp_ns,
            };
            let uploaded = renderer.upload(&frame);
            self.decoder
                .release(info.token)
                .map_err(|error| self.fail(Error::Decoder(error)))?;
            match uploaded {
                Ok(_) => {
                    self.stats.uploaded += 1;
                    if self.pending {
                        self.stats.dropped += 1;
                    }
                    self.pending = true;
                    self.pending_arrival = arrival;
                    #[cfg(feature = "diagnostic-native-decode")]
                    {
                        self.pending_timing = Some((info.pts_us, submitted_ns, decoded_ns));
                    }
                    return Ok(true);
                }
                Err(render::Error::Busy) => self.stats.dropped += 1,
                Err(error) => return Err(self.fail(Error::Renderer(error))),
            }
        }
        Ok(false)
    }

    pub fn present_pending(
        &mut self,
        renderer: &mut Renderer,
        interactive: bool,
    ) -> Result<bool, Error> {
        self.active()?;
        #[cfg(feature = "diagnostic-native-decode")]
        let present_start_ns = platform::now_ns();
        match renderer.present(interactive) {
            Ok(()) => {
                let presented = self.pending;
                self.pending = false;
                self.stats.presented += u64::from(presented);
                if presented {
                    #[cfg(feature = "diagnostic-native-decode")]
                    if let Some((pts, submitted, decoded)) = self.pending_timing.take() {
                        let returned = platform::now_ns();
                        platform::log(&format!(
                            "video-timing: pts_us={pts} present_return_ns={returned} submit_to_readback_us={} present_call_us={} submit_to_present_return_us={}",
                            decoded.saturating_sub(submitted) / 1000,
                            returned.saturating_sub(present_start_ns) / 1000,
                            returned.saturating_sub(submitted) / 1000
                        ));
                    }
                    self.presentation = Some(Presentation {
                        received_us: self.pending_arrival.take(),
                        presented_us: platform::now_ns() / 1000,
                    });
                }
                Ok(presented)
            }
            Err(render::Error::Busy) => Ok(false),
            Err(error) => Err(self.fail(Error::Renderer(error))),
        }
    }

    pub fn present(&mut self, renderer: &mut Renderer, interactive: bool) -> Result<bool, Error> {
        self.poll_upload(renderer)?;
        self.present_pending(renderer, interactive)
    }

    pub fn close(&mut self) -> Result<(), Error> {
        if self.closed {
            return Ok(());
        }
        if platform::process_retired() {
            self.decoder.retire();
        }
        if let Err(error) = self.decoder.close() {
            self.decoder.retire();
            platform::retire_process();
            return Err(self.fail(Error::Decoder(error)));
        }
        self.closed = true;
        self.arrivals.fill(None);
        self.pending_arrival = None;
        #[cfg(feature = "diagnostic-native-decode")]
        {
            self.pending_timing = None;
        }
        Ok(())
    }

    pub fn tick<'t>(
        &'t mut self,
        renderer: &'t mut Renderer,
        interactive: bool,
    ) -> Tick<'t, 'a, B> {
        Tick {
            video: self,
            renderer,
            interactive,
            present: true,
        }
    }

    pub fn consume_tick<'t>(&'t mut self, renderer: &'t mut Renderer) -> Tick<'t, 'a, B> {
        Tick {
            video: self,
            renderer,
            interactive: false,
            present: false,
        }
    }
}

impl<B: Backend> Drop for Video<'_, B> {
    fn drop(&mut self) {
        if !self.closed && self.close().is_err() {
            platform::log("video: teardown retained; exit process");
        }
    }
}

pub struct Tick<'t, 'a, B: Backend> {
    video: &'t mut Video<'a, B>,
    renderer: &'t mut Renderer,
    interactive: bool,
    present: bool,
}

impl<B: Backend> Tick<'_, '_, B> {
    pub fn submit(&mut self, header: &Header, bytes: &[u8]) -> moonlight_nx2_app::media::Submit {
        self.submit_timed(header, bytes, None)
    }

    pub fn submit_timed(
        &mut self,
        header: &Header,
        bytes: &[u8],
        received_us: Option<u64>,
    ) -> moonlight_nx2_app::media::Submit {
        match self.video.submit_timed(header, bytes, received_us) {
            Ok(()) => moonlight_nx2_app::media::Submit::Accepted,
            Err(Error::Decoder(decoder::Error::Again)) => moonlight_nx2_app::media::Submit::Busy,
            Err(_) => moonlight_nx2_app::media::Submit::Failed,
        }
    }

    pub fn presented(&mut self) -> Result<bool, Error> {
        self.video.present(self.renderer, self.interactive)
    }
}

impl<B: Backend> moonlight_nx2_app::media::Decoder for Tick<'_, '_, B> {
    fn pending(&mut self) -> bool {
        self.video.pending()
    }

    fn submit(&mut self, header: &Header, payload: &[u8]) -> moonlight_nx2_app::media::Submit {
        Tick::submit(self, header, payload)
    }

    fn submit_timed(
        &mut self,
        header: &Header,
        payload: &[u8],
        received_us: Option<u64>,
    ) -> moonlight_nx2_app::media::Submit {
        Tick::submit_timed(self, header, payload, received_us)
    }

    fn poll(&mut self) -> moonlight_nx2_app::media::Poll {
        if !self.present {
            return match self.video.poll_upload(self.renderer) {
                Ok(_) => moonlight_nx2_app::media::Poll::Idle,
                Err(_) => moonlight_nx2_app::media::Poll::Failed,
            };
        }
        match self.presented() {
            Ok(true) => moonlight_nx2_app::media::Poll::Presented,
            Ok(false) => moonlight_nx2_app::media::Poll::Idle,
            Err(_) => moonlight_nx2_app::media::Poll::Failed,
        }
    }
}
