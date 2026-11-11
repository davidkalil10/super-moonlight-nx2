//! The worker's view of the Moonlight gamepads: the active mask with arrival and removal, the
//! motion reports the host asked for, and trigger rumble folded into the pad motors.

/// Controllers the worker forwards, as Moonlight controller numbers 0 to 7.
pub const PADS: usize = 8;

/// What one controller event sends: the active mask, and whether to announce the pad first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Update {
    pub index: u8,
    pub mask: u16,
    pub arrived: bool,
}

/// Controller 0 is the primary pad: always present, and announced when the stream connects.
/// Other pads arrive when they connect and leave the mask when they disconnect; a pad that
/// comes back is announced again.
#[derive(Clone, Copy, Debug)]
pub struct Gamepads {
    active: u16,
}

impl Default for Gamepads {
    fn default() -> Self {
        Self { active: 1 }
    }
}

impl Gamepads {
    pub fn update(&mut self, index: u8, connected: bool) -> Update {
        let bit = 1 << index;
        let arrived = index != 0 && connected && self.active & bit == 0;
        if index != 0 {
            if connected {
                self.active |= bit;
            } else {
                self.active &= !bit;
            }
        }
        Update {
            index,
            mask: self.active,
            arrived,
        }
    }

    pub fn mask(&self) -> u16 {
        self.active
    }

    /// Removes every pad, primary included, each with the mask left after it goes.
    pub fn remove_all(&mut self) -> Vec<Update> {
        let mut removed = Vec::new();
        for index in 0..PADS as u8 {
            let bit = 1 << index;
            if self.active & bit != 0 {
                self.active &= !bit;
                removed.push(Update {
                    index,
                    mask: self.active,
                    arrived: false,
                });
            }
        }
        removed
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MotionKind {
    Accel,
    Gyro,
}

impl MotionKind {
    /// From the `LI_MOTION_TYPE_*` value of a motion state request.
    pub fn from_wire(kind: u8) -> Option<Self> {
        match kind {
            1 => Some(Self::Accel),
            2 => Some(Self::Gyro),
            _ => None,
        }
    }
}

/// The report rate the host asked for per pad and sensor, in Hz; 0 means none.
pub type MotionRates = [[u16; 2]; PADS];

/// Lets motion through only when the host asked for it, no faster than its rate. Samples
/// arrive in bursts with the input records, so a burst sends at most one per quarter period.
#[derive(Clone, Copy, Debug, Default)]
pub struct MotionGate {
    rates: MotionRates,
    next_us: [[u64; 2]; PADS],
}

impl MotionGate {
    pub fn set_rates(&mut self, rates: &MotionRates) {
        for (pad, wanted) in rates.iter().enumerate() {
            for kind in 0..2 {
                if self.rates[pad][kind] != wanted[kind] {
                    self.rates[pad][kind] = wanted[kind];
                    self.next_us[pad][kind] = 0;
                }
            }
        }
    }

    pub fn due(&mut self, index: u8, kind: MotionKind, now_us: u64) -> bool {
        let Some(rate) = self
            .rates
            .get(usize::from(index))
            .map(|rates| rates[kind as usize])
        else {
            return false;
        };
        if rate == 0 {
            return false;
        }
        let next = &mut self.next_us[usize::from(index)][kind as usize];
        if now_us < *next {
            return false;
        }
        let period = 1_000_000 / u64::from(rate);
        *next = (*next + period).max(now_us + period / 4);
        true
    }
}

/// Switch pads have no trigger motors: each trigger adds to the motor on its side.
pub fn fold_triggers(low: u16, high: u16, left_trigger: u16, right_trigger: u16) -> (u16, u16) {
    (low.max(left_trigger), high.max(right_trigger))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sent(index: u8, mask: u16, arrived: bool) -> Update {
        Update {
            index,
            mask,
            arrived,
        }
    }

    #[test]
    fn the_primary_stays_in_the_mask_and_is_never_announced_again() {
        let mut pads = Gamepads::default();
        assert_eq!(pads.update(0, true), sent(0, 1, false));
        assert_eq!(pads.update(0, false), sent(0, 1, false));
    }

    #[test]
    fn another_pad_arrives_once_and_leaves_on_removal() {
        let mut pads = Gamepads::default();
        assert_eq!(pads.update(2, true), sent(2, 0b101, true));
        assert_eq!(pads.update(2, true), sent(2, 0b101, false));
        assert_eq!(pads.update(1, true), sent(1, 0b111, true));
        assert_eq!(pads.update(2, false), sent(2, 0b011, false));
        assert_eq!(pads.mask(), 0b011);
    }

    #[test]
    fn a_pad_that_comes_back_is_announced_again() {
        let mut pads = Gamepads::default();
        pads.update(3, true);
        pads.update(3, false);
        assert_eq!(pads.update(3, true), sent(3, 0b1001, true));
    }

    #[test]
    fn a_removal_of_an_unknown_pad_keeps_the_mask() {
        let mut pads = Gamepads::default();
        assert_eq!(pads.update(5, false), sent(5, 1, false));
    }

    #[test]
    fn two_pads_get_their_own_numbers_and_masks() {
        let mut pads = Gamepads::default();
        assert_eq!(pads.update(0, true), sent(0, 0b01, false));
        assert_eq!(pads.update(1, true), sent(1, 0b11, true));
        assert_eq!(pads.update(0, true), sent(0, 0b11, false));
        assert_eq!(pads.update(1, true), sent(1, 0b11, false));
    }

    #[test]
    fn the_end_of_a_stream_removes_every_pad() {
        let mut pads = Gamepads::default();
        pads.update(1, true);
        pads.update(3, true);
        assert_eq!(
            pads.remove_all(),
            [
                sent(0, 0b1010, false),
                sent(1, 0b1000, false),
                sent(3, 0, false)
            ]
        );
        assert_eq!(pads.mask(), 0);
        assert!(pads.remove_all().is_empty());
    }

    #[test]
    fn motion_waits_for_the_host_to_ask() {
        let mut gate = MotionGate::default();
        assert!(!gate.due(0, MotionKind::Accel, 0));
        let mut rates = [[0; 2]; PADS];
        rates[0][MotionKind::Gyro as usize] = 100;
        gate.set_rates(&rates);
        assert!(!gate.due(0, MotionKind::Accel, 10));
        assert!(gate.due(0, MotionKind::Gyro, 10));
        assert!(!gate.due(1, MotionKind::Gyro, 10));
        assert!(!gate.due(PADS as u8, MotionKind::Gyro, 10));
    }

    #[test]
    fn motion_keeps_to_the_asked_rate() {
        let mut gate = MotionGate::default();
        let mut rates = [[0; 2]; PADS];
        rates[1] = [100, 100];
        gate.set_rates(&rates);
        let sent = (0..1_000u64)
            .filter(|step| gate.due(1, MotionKind::Accel, step * 4_000))
            .count();
        assert_eq!(sent, 400);
        let sent = (0..120u64)
            .filter(|step| gate.due(1, MotionKind::Gyro, step * 8_333))
            .count();
        assert!((90..=100).contains(&sent), "{sent}");
    }

    #[test]
    fn a_burst_sends_one_sample() {
        let mut gate = MotionGate::default();
        let mut rates = [[0; 2]; PADS];
        rates[0] = [200, 200];
        gate.set_rates(&rates);
        assert!(gate.due(0, MotionKind::Accel, 1_000_000));
        assert!(!gate.due(0, MotionKind::Accel, 1_000_000));
        assert!(!gate.due(0, MotionKind::Accel, 1_001_000));
        assert!(gate.due(0, MotionKind::Accel, 1_005_000));
    }

    #[test]
    fn a_stop_request_stops_motion() {
        let mut gate = MotionGate::default();
        let mut rates = [[50, 50]; PADS];
        gate.set_rates(&rates);
        assert!(gate.due(4, MotionKind::Accel, 0));
        rates[4] = [0, 50];
        gate.set_rates(&rates);
        assert!(!gate.due(4, MotionKind::Accel, 1_000_000));
        assert!(gate.due(4, MotionKind::Gyro, 1_000_000));
    }

    #[test]
    fn wire_motion_types_follow_limelight() {
        assert_eq!(MotionKind::from_wire(1), Some(MotionKind::Accel));
        assert_eq!(MotionKind::from_wire(2), Some(MotionKind::Gyro));
        assert_eq!(MotionKind::from_wire(0), None);
    }

    #[test]
    fn trigger_rumble_adds_to_the_motor_on_its_side() {
        assert_eq!(fold_triggers(100, 200, 0, 0), (100, 200));
        assert_eq!(fold_triggers(100, 200, 5_000, 0), (5_000, 200));
        assert_eq!(fold_triggers(0, 0, 0, 65_535), (0, 65_535));
    }
}
