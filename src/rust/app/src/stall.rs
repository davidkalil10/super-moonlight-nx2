//! Tells the user when the network cannot carry the stream: the picture all but stops while
//! video keeps being lost, and the stream itself stays up. One warning per episode.

/// Seconds in a row the video has to struggle before the warning. Loss recovery asks for a
/// keyframe every 500 ms, so a lost burst is over within a second; three seconds with almost
/// no picture is a link that cannot carry the bitrate, and still well before the stream is
/// given up for silence.
pub const STRUGGLING_SECONDS: u32 = 3;
/// Seconds in a row of steady video that end an episode, so a link that keeps dipping is not
/// warned about every few seconds.
pub const STEADY_SECONDS: u32 = 10;

#[derive(Clone, Copy, Debug)]
pub struct Stall {
    fps: u32,
    lost: Option<(u32, u64)>,
    struggling: u32,
    steady: u32,
    warned: bool,
}

impl Stall {
    pub fn new(fps: u32) -> Self {
        Self {
            fps,
            lost: None,
            struggling: 0,
            steady: 0,
            warned: false,
        }
    }

    /// Whether this episode was warned about and has not ended yet.
    pub fn warned(&self) -> bool {
        self.warned
    }

    /// One closed second: the frames presented in it and the session's cumulative drop and
    /// keyframe request counts. True when the warning is due now. A second presenting under a
    /// quarter of the rate struggles only when frames were lost in it: a host sends next to
    /// nothing for a still desktop, and a link that cannot carry the bitrate always loses some.
    pub fn second(&mut self, presented: u32, dropped_total: u32, idr_requests: u64) -> bool {
        let lost = self
            .lost
            .is_some_and(|(dropped, idrs)| dropped_total > dropped || idr_requests > idrs);
        self.lost = Some((dropped_total, idr_requests));
        let starved = u64::from(presented) * 4 < u64::from(self.fps);
        if starved && lost {
            self.struggling = self.struggling.saturating_add(1);
            self.steady = 0;
        } else {
            self.struggling = 0;
            self.steady = if starved {
                0
            } else {
                self.steady.saturating_add(1)
            };
        }
        if self.steady >= STEADY_SECONDS {
            self.warned = false;
        }
        if self.warned || self.struggling < STRUGGLING_SECONDS {
            return false;
        }
        self.warned = true;
        true
    }
}
