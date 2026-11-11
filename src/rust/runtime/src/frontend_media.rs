use crate::{
    client::Client,
    hid::FrameInput,
    media_session::{self, Session},
    render::Renderer,
};
use moonlight_nx2_app::{
    media::{InputSource, PcmChannel, VideoChannel},
    policy::{Epoch, Observation},
};
use moonlight_nx2_core::decoder::Backend;
use moonlight_nx2_io::{audio::Device, media::MAX_INPUT_BYTES, socket::Socket};
use moonlight_nx2_ui::store::Files;

#[derive(Clone, Copy)]
pub struct Tick {
    pub epoch: Epoch,
    pub now_ms: u64,
    pub interactive: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Stale,
    Media(media_session::Error),
    ObservationOverflow,
}

struct Timed<I>(I);

impl<I: InputSource> InputSource for Timed<I> {
    fn take(&mut self, out: &mut [u8; MAX_INPUT_BYTES]) -> usize {
        let length = self.0.take(out);
        if length != 0 {
            crate::stream_stats::input_sent(crate::render_platform::now_ns());
        }
        length
    }
}

pub fn pump_network<
    F: Files + Clone,
    B: Backend<N>,
    S: Socket,
    D: Device,
    V: VideoChannel,
    P: PcmChannel,
    const N: usize,
>(
    session: &mut Session<'_, B, S, D, V, N, P>,
    client: &mut Client<F>,
    epoch: Epoch,
    now_ms: u64,
) -> Result<(), Error> {
    if client.session_epoch() != Some(epoch) {
        return Err(Error::Stale);
    }
    let mut failed = false;
    let result = session.pump_network_observed(now_ms, &mut |event| {
        failed |= matches!(event, Observation::Failed);
    });
    if failed {
        client.observe(epoch, Observation::Failed);
    }
    result.map_err(Error::Media)
}

pub fn step<
    F: Files + Clone,
    B: Backend<N>,
    S: Socket,
    D: Device,
    V: VideoChannel,
    P: PcmChannel,
    const N: usize,
>(
    session: &mut Session<'_, B, S, D, V, N, P>,
    client: &mut Client<F>,
    renderer: &mut Renderer,
    input: &FrameInput,
    tick: Tick,
) -> Result<media_session::Step, Error> {
    if client.session_epoch() != Some(tick.epoch) {
        return Err(Error::Stale);
    }
    let mut observations = [None; 5];
    let mut count = 0;
    let mut overflow = false;
    let result = {
        let mut input = Timed(client.input(input));
        session.step_observed(
            renderer,
            &mut input,
            tick.now_ms,
            tick.interactive,
            &mut |event| {
                if let Some(slot) = observations.get_mut(count) {
                    *slot = Some(event);
                    count += 1;
                } else {
                    overflow = true;
                }
            },
        )
    };
    for observation in observations.into_iter().flatten() {
        client.observe(tick.epoch, observation);
    }
    if overflow {
        crate::render_platform::retire_process();
        client.observe(tick.epoch, Observation::Failed);
        return Err(Error::ObservationOverflow);
    }
    result.map_err(Error::Media)
}

pub fn close<
    F: Files + Clone,
    B: Backend<N>,
    S: Socket,
    D: Device,
    V: VideoChannel,
    P: PcmChannel,
    const N: usize,
>(
    session: &mut Session<'_, B, S, D, V, N, P>,
    client: &mut Client<F>,
    epoch: Epoch,
) -> Option<media_session::Closed<D>> {
    session.close_observed(&mut |observation| {
        client.observe(epoch, observation);
    })
}
