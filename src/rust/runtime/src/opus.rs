//! The console's hwopus decoder behind `direct_media::OpusDecoder`, through nro/opus.c.

use moonlight_nx2_app::direct_media::OpusDecoder;
use moonlight_nx2_app::sunshine::{media::AUDIO_SAMPLE_RATE, stream::Audio};

unsafe extern "C" {
    fn moonlightOpusOpen(
        rate: i32,
        channels: i32,
        streams: i32,
        coupled: i32,
        mapping: *const [u8; 8],
    ) -> u32;
    fn moonlightOpusDecode(
        packet: *const u8,
        size: usize,
        pcm: *mut i16,
        pcm_bytes: usize,
        samples: *mut i32,
    ) -> u32;
    fn moonlightOpusClose();
}

/// The one open decoder; dropping it closes the service session.
pub struct HwOpus(());

impl HwOpus {
    pub fn open(audio: &Audio) -> Result<Self, u32> {
        let streams = i32::from(audio.streams.max(1));
        let result = unsafe {
            moonlightOpusOpen(
                AUDIO_SAMPLE_RATE as i32,
                i32::from(audio.channels),
                streams,
                i32::from(audio.coupled_streams),
                &audio.mapping,
            )
        };
        if result == 0 {
            Ok(Self(()))
        } else {
            Err(result)
        }
    }
}

impl OpusDecoder for HwOpus {
    fn decode(&mut self, packet: &[u8], pcm: &mut [i16]) -> Option<usize> {
        let mut samples = 0;
        let result = unsafe {
            moonlightOpusDecode(
                packet.as_ptr(),
                packet.len(),
                pcm.as_mut_ptr(),
                core::mem::size_of_val(pcm),
                &mut samples,
            )
        };
        usize::try_from(samples).ok().filter(|_| result == 0)
    }
}

impl Drop for HwOpus {
    fn drop(&mut self) {
        unsafe { moonlightOpusClose() };
    }
}
