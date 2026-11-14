//! USB keyboard and mouse as the platform reads them (`nn::hid` mouse and keyboard states), and
//! what they become on the host: key events with Windows virtual key codes, relative mouse
//! moves, buttons and wheel clicks. Sans-IO; the runtime supplies the samples.

use moonlight_nx2_sunshine::session::Session;

const WHEEL_CLICK: i32 = 120;

const MODIFIER_SHIFT: u8 = 0x01;
const MODIFIER_CTRL: u8 = 0x02;
const MODIFIER_ALT: u8 = 0x04;
const MODIFIER_META: u8 = 0x08;

const HID_CONTROL: u64 = 1 << 0;
const HID_SHIFT: u64 = 1 << 1;
const HID_ALT: u64 = (1 << 2) | (1 << 3);
const HID_GUI: u64 = 1 << 4;

/// Mouse buttons as the platform reports them, with Moonlight's number for each.
const BUTTONS: [(u32, u8); 5] = [
    (1 << 0, 1),
    (1 << 2, 2),
    (1 << 1, 3),
    (1 << 4, 4),
    (1 << 3, 5),
];

/// Motion and wheel summed since the previous sample, and the buttons held now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MouseSample {
    pub dx: i32,
    pub dy: i32,
    pub wheel_x: i32,
    pub wheel_y: i32,
    pub buttons: u32,
    pub connected: bool,
}

/// One axis of relative motion scaled linearly by `percent`. The hundredths it leaves over
/// carry in `remainder` to the next move, so slow motion at a low sensitivity still counts.
pub fn scale(delta: i32, percent: u32, remainder: &mut i32) -> i32 {
    let total = delta
        .saturating_mul(percent as i32)
        .saturating_add(*remainder);
    *remainder = total % 100;
    total / 100
}

/// The modifier bits and the 256-bit map of held keys, indexed by USB usage.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KeyboardSample {
    pub modifiers: u64,
    pub keys: [u64; 4],
}

/// The Windows virtual key code of a USB keyboard usage, for the keys a PC game or desktop
/// needs; `None` for the rest.
pub fn virtual_key(usage: u8) -> Option<i16> {
    let code = match usage {
        4..=29 => 0x41 + i16::from(usage - 4),
        30..=38 => 0x31 + i16::from(usage - 30),
        39 => 0x30,
        40 => 0x0D,
        41 => 0x1B,
        42 => 0x08,
        43 => 0x09,
        44 => 0x20,
        45 => 0xBD,
        46 => 0xBB,
        47 => 0xDB,
        48 => 0xDD,
        49 | 50 => 0xDC,
        51 => 0xBA,
        52 => 0xDE,
        53 => 0xC0,
        54 => 0xBC,
        55 => 0xBE,
        56 => 0xBF,
        57 => 0x14,
        58..=69 => 0x70 + i16::from(usage - 58),
        70 => 0x2C,
        71 => 0x91,
        72 => 0x13,
        73 => 0x2D,
        74 => 0x24,
        75 => 0x21,
        76 => 0x2E,
        77 => 0x23,
        78 => 0x22,
        79 => 0x27,
        80 => 0x25,
        81 => 0x28,
        82 => 0x26,
        83 => 0x90,
        84 => 0x6F,
        85 => 0x6A,
        86 => 0x6D,
        87 => 0x6B,
        88 => 0x0D,
        89..=97 => 0x61 + i16::from(usage - 89),
        98 => 0x60,
        99 => 0x6E,
        101 => 0x5D,
        104..=115 => 0x7C + i16::from(usage - 104),
        224 => 0xA2,
        225 => 0xA0,
        226 => 0xA4,
        227 => 0x5B,
        228 => 0xA3,
        229 => 0xA1,
        230 => 0xA5,
        231 => 0x5C,
        _ => return None,
    };
    Some(code)
}

fn modifiers(hid: u64) -> u8 {
    [
        (HID_SHIFT, MODIFIER_SHIFT),
        (HID_CONTROL, MODIFIER_CTRL),
        (HID_ALT, MODIFIER_ALT),
        (HID_GUI, MODIFIER_META),
    ]
    .iter()
    .filter(|(bit, _)| hid & bit != 0)
    .fold(0, |all, (_, flag)| all | flag)
}

/// What is held on the host, so only changes are sent and nothing stays stuck.
#[derive(Default)]
pub struct Pointer {
    buttons: u32,
    keys: [u64; 4],
    modifiers: u64,
}

impl Pointer {
    pub fn mouse(&mut self, sample: &MouseSample, session: &mut Session) {
        let sample = if sample.connected {
            *sample
        } else {
            MouseSample::default()
        };
        let (mut dx, mut dy) = (sample.dx, sample.dy);
        while dx != 0 || dy != 0 {
            let step_x = dx.clamp(i16::MIN.into(), i16::MAX.into());
            let step_y = dy.clamp(i16::MIN.into(), i16::MAX.into());
            session.mouse_move(step_x as i16, step_y as i16);
            dx -= step_x;
            dy -= step_y;
        }
        for (flag, number) in BUTTONS {
            let held = sample.buttons & flag != 0;
            if held != (self.buttons & flag != 0) {
                session.mouse_button(held, number);
            }
        }
        self.buttons = sample.buttons;
        if sample.wheel_y != 0 {
            session.scroll(clicks(sample.wheel_y));
        }
        if sample.wheel_x != 0 {
            session.hscroll(clicks(sample.wheel_x));
        }
    }

    /// Key changes, releases first so a swapped key never counts as two held. A keyboard that
    /// went away releases everything.
    pub fn keyboard(&mut self, sample: Option<&KeyboardSample>, session: &mut Session) {
        let now = sample.copied().unwrap_or_default();
        for pass in [false, true] {
            for usage in 0..=255u8 {
                let (word, bit) = (usize::from(usage / 64), 1u64 << (usage % 64));
                let held = now.keys[word] & bit != 0;
                if held == (self.keys[word] & bit != 0) || held != pass {
                    continue;
                }
                let Some(code) = virtual_key(usage) else {
                    continue;
                };
                let state = if held { now.modifiers } else { self.modifiers };
                session.key(code, held, modifiers(state));
            }
        }
        self.keys = now.keys;
        self.modifiers = now.modifiers;
    }

    pub fn release(&mut self, session: &mut Session) {
        self.mouse(&MouseSample::default(), session);
        self.keyboard(None, session);
    }
}

fn clicks(delta: i32) -> i16 {
    delta
        .saturating_mul(WHEEL_CLICK)
        .clamp(i16::MIN.into(), i16::MAX.into()) as i16
}
