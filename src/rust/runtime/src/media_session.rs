use crate::{
    render::Renderer,
    render_platform as platform,
    video::{self, Presentation, Video},
};
use moonlight_nx2_app::{
    media::{self, InputSource, Media, Progress, VideoChannel},
    policy::Observation,
    service::RuntimeEvent,
};
use moonlight_nx2_core::decoder::{Backend, SURFACES};
use moonlight_nx2_io::{audio::Device, socket::Socket};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Closed,
    Media(media::Failure),
}

pub struct Step {
    pub progress: Progress,
    pub presentation: Option<Presentation>,
    pub accepted_bytes: Option<u32>,
    pub skipped_frames: u64,
}

pub struct Closed<D> {
    pub media: media::Closed<D>,
    pub decoder: Result<(), video::Error>,
}

pub struct Session<
    'a,
    B: Backend<N>,
    S: Socket,
    D: Device,
    V: VideoChannel,
    const N: usize = SURFACES,
> {
    video: Video<'a, B, N>,
    media: Option<Media<'a, S, D, V>>,
    closing: bool,
    ended: bool,
    failure: Option<Error>,
}

impl<'a, B: Backend<N>, S: Socket, D: Device, V: VideoChannel, const N: usize>
    Session<'a, B, S, D, V, N>
{
    pub fn new(video: Video<'a, B, N>, media: Media<'a, S, D, V>) -> Self {
        Self {
            video,
            media: Some(media),
            closing: false,
            ended: false,
            failure: None,
        }
    }

    pub fn video_stats(&self) -> video::Stats {
        self.video.stats()
    }

    pub fn video_recovery(&self) -> moonlight_nx2_core::recovery::Counters {
        self.video.recovery()
    }

    pub fn begin_drain(&mut self, now_ms: u64) {
        if let Some(media) = self.media.as_mut() {
            self.closing = true;
            media.begin_drain(now_ms);
        }
    }

    pub fn pump_network(
        &mut self,
        now_ms: u64,
        report: &mut impl FnMut(RuntimeEvent),
    ) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let media = self.media.as_mut().ok_or(Error::Closed)?;
        match media.pump_network(now_ms) {
            Ok(()) => Ok(()),
            Err(failure) => {
                let error = Error::Media(failure);
                self.failure = Some(error);
                report(RuntimeEvent::MediaFailed);
                Err(error)
            }
        }
    }

    pub fn pump_network_observed(
        &mut self,
        now_ms: u64,
        report: &mut impl FnMut(Observation),
    ) -> Result<(), Error> {
        self.pump_network(now_ms, &mut |event| {
            if event == RuntimeEvent::MediaFailed {
                report(Observation::Failed);
            }
        })
    }

    pub fn step(
        &mut self,
        renderer: &mut Renderer,
        input: &mut impl InputSource,
        now_ms: u64,
        interactive: bool,
        report: &mut impl FnMut(RuntimeEvent),
    ) -> Result<Step, Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let media = self.media.as_mut().ok_or(Error::Closed)?;
        let before = self.video.stats();
        let progress = match media.step(&mut self.video.tick(renderer, interactive), input, now_ms)
        {
            Ok(progress) => progress,
            Err(failure) => {
                let error = Error::Media(failure);
                self.failure = Some(error);
                report(RuntimeEvent::MediaFailed);
                return Err(error);
            }
        };
        let presentation = self.video.take_presentation();
        if progress.presented {
            report(RuntimeEvent::FramePresented);
        }
        if progress.drained && !self.closing && !self.ended {
            self.ended = true;
            report(RuntimeEvent::MediaEnded);
        }
        Ok(Step {
            progress,
            presentation,
            accepted_bytes: (self.video.stats().accepted_units != before.accepted_units)
                .then_some((self.video.stats().accepted_bytes - before.accepted_bytes) as u32),
            skipped_frames: self.video.stats().dropped - before.dropped,
        })
    }

    pub fn step_observed(
        &mut self,
        renderer: &mut Renderer,
        input: &mut impl InputSource,
        now_ms: u64,
        interactive: bool,
        report: &mut impl FnMut(Observation),
    ) -> Result<Step, Error> {
        let (mut ended, mut failed) = (false, false);
        let result = self.step(renderer, input, now_ms, interactive, &mut |event| {
            ended |= event == RuntimeEvent::MediaEnded;
            failed |= event == RuntimeEvent::MediaFailed;
        });
        if let Ok(step) = &result {
            if let Some(bytes) = step.accepted_bytes {
                report(Observation::Received { bytes });
            }
            for _ in 0..step.skipped_frames {
                report(Observation::Skipped);
            }
            if let Some(presentation) = step.presentation {
                report(Observation::Presented {
                    received_us: presentation.received_us,
                    presented_us: presentation.presented_us,
                });
            }
            if ended {
                report(Observation::Ended);
            }
        }
        if failed {
            report(Observation::Failed);
        }
        result
    }

    pub fn close(&mut self, report: &mut impl FnMut(RuntimeEvent)) -> Option<Closed<D>> {
        let mut media = self.media.take()?.close();
        let decoder = self.video.close();
        media.retained |= decoder.is_err() || platform::process_retired();
        if media.retained {
            platform::retire_process();
        }
        report(RuntimeEvent::MediaClosed {
            retained: media.retained,
        });
        Some(Closed { media, decoder })
    }

    pub fn close_observed(&mut self, report: &mut impl FnMut(Observation)) -> Option<Closed<D>> {
        self.close(&mut |event| {
            if let RuntimeEvent::MediaClosed { retained } = event {
                report(Observation::Closed { retained });
            }
        })
    }
}

impl<B: Backend<N>, S: Socket, D: Device, V: VideoChannel, const N: usize> Drop
    for Session<'_, B, S, D, V, N>
{
    fn drop(&mut self) {
        if self
            .close(&mut |_| {})
            .is_some_and(|closed| closed.media.retained)
        {
            platform::log("media session: teardown retained; exit process");
        }
    }
}
