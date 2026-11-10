#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Pad {
    pub connected: bool,
    pub buttons: u16,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub left_x: i16,
    pub left_y: i16,
    pub right_x: i16,
    pub right_y: i16,
}

const FACE_SWAPS: [(u16, u16); 4] = [
    (0x1000, 0x2000),
    (0x2000, 0x1000),
    (0x4000, 0x8000),
    (0x8000, 0x4000),
];

/// Sends each face button as the Xbox button in the same place: A/B and X/Y trade flags.
pub fn face_buttons_by_position(buttons: u16) -> u16 {
    let mut mapped = buttons;
    for (label, _) in FACE_SWAPS {
        mapped &= !label;
    }
    for (label, place) in FACE_SWAPS {
        if buttons & label != 0 {
            mapped |= place;
        }
    }
    mapped
}

pub const DEFAULT_START_CHORD: u64 = (1 << 4) | (1 << 5);
const FLAGS: [u16; 16] = [
    0x1000, 0x2000, 0x4000, 0x8000, 0x0040, 0x0080, 0x0100, 0x0200, 0, 0, 0x0010, 0x0020, 0x0004,
    0x0001, 0x0008, 0x0002,
];

pub fn map_pad_with_start_chord(
    connected: bool,
    buttons: u64,
    sticks: [i32; 4],
    chord: u64,
) -> Pad {
    let mut pad = map_pad(connected, buttons, sticks);
    if connected && chord != 0 && buttons & chord == chord {
        for (bit, flag) in FLAGS.into_iter().enumerate() {
            if chord & (1 << bit) != 0 {
                pad.buttons &= !flag;
            }
        }
        pad.buttons |= 0x0010;
    }
    pad
}

pub fn map_pad(connected: bool, buttons: u64, sticks: [i32; 4]) -> Pad {
    if !connected {
        return Pad::default();
    }

    let mut mapped = 0;
    for (bit, flag) in FLAGS.into_iter().enumerate() {
        if buttons & (1 << bit) != 0 {
            mapped |= flag;
        }
    }
    const HORIZONTAL: u64 = (1 << 12) | (1 << 14);
    const VERTICAL: u64 = (1 << 13) | (1 << 15);
    if buttons & HORIZONTAL == HORIZONTAL {
        mapped &= !(0x0004 | 0x0008);
    }
    if buttons & VERTICAL == VERTICAL {
        mapped &= !(0x0001 | 0x0002);
    }

    let axes = sticks.map(|value| value.clamp(i16::MIN.into(), i16::MAX.into()) as i16);
    Pad {
        connected,
        buttons: mapped,
        left_trigger: if buttons & (1 << 8) != 0 { 255 } else { 0 },
        right_trigger: if buttons & (1 << 9) != 0 { 255 } else { 0 },
        left_x: axes[0],
        left_y: axes[1],
        right_x: axes[2],
        right_y: axes[3],
    }
}

pub fn stop_held(buttons: u64) -> bool {
    const CHORD: u64 = (3 << 6) | (3 << 10);
    buttons & CHORD == CHORD
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_face_button_goes_to_the_one_in_the_same_place() {
        let by_label = [0x1000, 0x2000, 0x4000, 0x8000];
        assert_eq!(
            by_label.map(face_buttons_by_position),
            [0x2000, 0x1000, 0x8000, 0x4000]
        );
    }

    #[test]
    fn the_other_buttons_are_left_alone() {
        let others = 0x0004 | 0x0040 | 0x0100 | 0x0010;
        assert_eq!(face_buttons_by_position(others), others);
        assert_eq!(
            face_buttons_by_position(others | 0x1000 | 0x8000),
            others | 0x2000 | 0x4000
        );
    }
}
