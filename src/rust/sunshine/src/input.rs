//! The NV and Sunshine input packets of moonlight-common-c (`Input.h`, `InputStream.c`), as
//! plaintext. The control channel encrypts and sends them; see `control`.

use crate::control::channel;
use alloc::vec::Vec;

pub const MAX_GAMEPADS: usize = 16;

pub const FEATURE_PEN_TOUCH: u32 = 0x01;
pub const FEATURE_CONTROLLER_TOUCH: u32 = 0x02;

pub const TYPE_UNKNOWN: u8 = 0x00;
pub const CAP_ANALOG_TRIGGERS: u16 = 0x01;
pub const CAP_RUMBLE: u16 = 0x02;
pub const CAP_TRIGGER_RUMBLE: u16 = 0x04;
pub const CAP_ACCEL: u16 = 0x10;
pub const CAP_GYRO: u16 = 0x20;

pub const MOTION_ACCEL: u8 = 0x01;
pub const MOTION_GYRO: u8 = 0x02;

pub const TOUCH_HOVER: u8 = 0x00;
pub const TOUCH_DOWN: u8 = 0x01;
pub const TOUCH_UP: u8 = 0x02;
pub const TOUCH_MOVE: u8 = 0x03;
pub const ROTATION_UNKNOWN: u16 = 0xFFFF;

pub const MOUSE_PRESS: u8 = 0x07;
pub const MOUSE_RELEASE: u8 = 0x08;
pub const MOUSE_LEFT: u8 = 0x01;

pub const KEY_DOWN: u8 = 0x03;
pub const KEY_UP: u8 = 0x04;

const HAPTICS_MAGIC: u32 = 0x0D;
const KEY_MAGIC: [u32; 2] = [0x03, 0x04];
const UTF8_MAGIC: u32 = 0x17;
const MOUSE_REL_MAGIC: u32 = 0x07;
const MOUSE_ABS_MAGIC: u32 = 0x05;
const MOUSE_BUTTON_MAGIC_BASE: u32 = 0x01;
const MULTI_CONTROLLER_MAGIC: u32 = 0x0C;
const SCROLL_MAGIC: u32 = 0x0A;
const HSCROLL_MAGIC: u32 = 0x5500_0001;
const TOUCH_MAGIC: u32 = 0x5500_0002;
const ARRIVAL_MAGIC: u32 = 0x5500_0004;
const MOTION_MAGIC: u32 = 0x5500_0006;

/// What the console announces for its pads: the face, shoulder, stick and system buttons of a
/// Switch pad as Moonlight's flags, laid out as `Limelight.h` has them.
pub const ARRIVAL_BUTTONS: u32 = 0x1000
    | 0x2000
    | 0x4000
    | 0x8000
    | 0x0001
    | 0x0002
    | 0x0004
    | 0x0008
    | 0x0100
    | 0x0200
    | 0x0010
    | 0x0020
    | 0x0040
    | 0x0080
    | 0x0400;

/// Sensors, analog and trigger motors, but no controller type: this Sunshine then picks a
/// DualShock 4 or DualSense by the motion sensors, as the helper's worker has it.
pub const ARRIVAL_CAPS: u16 =
    CAP_ANALOG_TRIGGERS | CAP_RUMBLE | CAP_TRIGGER_RUMBLE | CAP_ACCEL | CAP_GYRO;

/// One plaintext input packet and how it travels on the control connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Packet {
    pub channel: u8,
    pub reliable: bool,
    pub data: Vec<u8>,
}

/// Held button, trigger and stick values of one pad.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PadValues {
    pub buttons: u32,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub left_x: i16,
    pub left_y: i16,
    pub right_x: i16,
    pub right_y: i16,
}

fn packet(channel: u8, reliable: bool, magic: u32, body: &[u8]) -> Packet {
    let mut data = Vec::with_capacity(8 + body.len());
    data.extend_from_slice(&(4 + body.len() as u32).to_be_bytes());
    data.extend_from_slice(&magic.to_le_bytes());
    data.extend_from_slice(body);
    Packet {
        channel,
        reliable,
        data,
    }
}

/// Without it Sunshine sends no rumble; moonlight-common-c sends it first on the generic channel.
pub fn enable_haptics() -> Packet {
    packet(channel::GENERIC, true, HAPTICS_MAGIC, &1u16.to_le_bytes())
}

pub fn controller_arrival(pad: u8, kind: u8, capabilities: u16, supported_buttons: u32) -> Packet {
    let pad = pad % MAX_GAMEPADS as u8;
    let mut body = [0u8; 8];
    body[0] = pad;
    body[1] = kind;
    body[2..4].copy_from_slice(&capabilities.to_le_bytes());
    body[4..8].copy_from_slice(&supported_buttons.to_le_bytes());
    packet(channel::gamepad(pad), true, ARRIVAL_MAGIC, &body)
}

pub fn multi_controller(pad: u8, active_mask: u16, values: &PadValues) -> Packet {
    let pad = pad % MAX_GAMEPADS as u8;
    let mut body = Vec::with_capacity(26);
    body.extend_from_slice(&0x001Au16.to_le_bytes());
    body.extend_from_slice(&u16::from(pad).to_le_bytes());
    body.extend_from_slice(&active_mask.to_le_bytes());
    body.extend_from_slice(&0x0014u16.to_le_bytes());
    body.extend_from_slice(&(values.buttons as u16).to_le_bytes());
    body.push(values.left_trigger);
    body.push(values.right_trigger);
    for axis in [values.left_x, values.left_y, values.right_x, values.right_y] {
        body.extend_from_slice(&axis.to_le_bytes());
    }
    body.extend_from_slice(&0x009Cu16.to_le_bytes());
    body.extend_from_slice(&((values.buttons >> 16) as u16).to_le_bytes());
    body.extend_from_slice(&0x0055u16.to_le_bytes());
    packet(channel::gamepad(pad), true, MULTI_CONTROLLER_MAGIC, &body)
}

/// Pad values the sensor channel carries: m/s^2 for acceleration, deg/s for the gyroscope.
/// A gyroscope at rest goes reliably so the host does not keep a stale turn.
pub fn controller_motion(pad: u8, kind: u8, [x, y, z]: [f32; 3]) -> Packet {
    let pad = pad % MAX_GAMEPADS as u8;
    let mut body = [0u8; 16];
    body[0] = pad;
    body[1] = kind;
    body[4..8].copy_from_slice(&x.to_le_bytes());
    body[8..12].copy_from_slice(&y.to_le_bytes());
    body[12..16].copy_from_slice(&z.to_le_bytes());
    let at_rest = kind == MOTION_GYRO && x == 0.0 && y == 0.0 && z == 0.0;
    packet(channel::sensor(pad), at_rest, MOTION_MAGIC, &body)
}

/// Moves and hovers may be dropped when a newer one arrives; the rest are reliable.
pub fn touch(
    action: u8,
    id: u32,
    x: f32,
    y: f32,
    pressure: f32,
    area: [f32; 2],
    rotation: u16,
) -> Packet {
    let mut body = [0u8; 28];
    body[0] = action;
    body[2..4].copy_from_slice(&rotation.to_le_bytes());
    body[4..8].copy_from_slice(&id.to_le_bytes());
    for (slot, value) in [x, y, pressure, area[0], area[1]].into_iter().enumerate() {
        body[8 + slot * 4..12 + slot * 4].copy_from_slice(&value.to_le_bytes());
    }
    let reliable = !matches!(action, TOUCH_HOVER | TOUCH_MOVE);
    packet(channel::TOUCH, reliable, TOUCH_MAGIC, &body)
}

pub fn mouse_move(dx: i16, dy: i16) -> Packet {
    let mut body = [0u8; 4];
    body[..2].copy_from_slice(&dx.to_be_bytes());
    body[2..].copy_from_slice(&dy.to_be_bytes());
    packet(channel::MOUSE, true, MOUSE_REL_MAGIC, &body)
}

/// The reference size is one less than the surface, which is what GFE's scaling needs.
pub fn mouse_position(x: i16, y: i16, width: i16, height: i16) -> Packet {
    let mut body = [0u8; 10];
    body[0..2].copy_from_slice(&x.to_be_bytes());
    body[2..4].copy_from_slice(&y.to_be_bytes());
    body[6..8].copy_from_slice(&width.wrapping_sub(1).to_be_bytes());
    body[8..10].copy_from_slice(&height.wrapping_sub(1).to_be_bytes());
    packet(channel::MOUSE, true, MOUSE_ABS_MAGIC, &body)
}

/// `action` is `MOUSE_PRESS` or `MOUSE_RELEASE`.
pub fn mouse_button(action: u8, button: u8) -> Packet {
    packet(
        channel::MOUSE,
        true,
        u32::from(action) + MOUSE_BUTTON_MAGIC_BASE,
        &[button],
    )
}

pub fn scroll(amount: i16) -> Packet {
    let mut body = [0u8; 6];
    body[..2].copy_from_slice(&amount.to_be_bytes());
    body[2..4].copy_from_slice(&amount.to_be_bytes());
    packet(channel::MOUSE, true, SCROLL_MAGIC, &body)
}

pub fn hscroll(amount: i16) -> Packet {
    packet(channel::MOUSE, true, HSCROLL_MAGIC, &amount.to_be_bytes())
}

/// `down` picks the key action; `key` is a Windows virtual key code.
pub fn keyboard(key: i16, down: bool, modifiers: u8, flags: u8) -> Packet {
    let mut body = [0u8; 6];
    body[0] = flags;
    body[1..3].copy_from_slice(&key.to_le_bytes());
    body[3] = modifiers;
    packet(
        channel::KEYBOARD,
        true,
        KEY_MAGIC[usize::from(!down)],
        &body,
    )
}

/// One packet per code point, as moonlight-common-c sends them, so none straddles a packet
/// boundary on the host.
pub fn utf8_text(text: &str) -> Vec<Packet> {
    text.chars()
        .map(|character| {
            let mut bytes = [0u8; 4];
            let bytes = character.encode_utf8(&mut bytes).as_bytes();
            packet(channel::UTF8, true, UTF8_MAGIC, bytes)
        })
        .collect()
}
