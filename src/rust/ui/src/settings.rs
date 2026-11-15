//! Settings catalog, adjustment rules, save format and stream options of
//! dev reference/native/ui/settings.c.

use core::fmt::Write;

use crate::extras::{INHERIT, OVERRIDABLE};
use crate::json::{Json, Kind, Value};
use crate::text::Text;
use crate::theme::Preference;

pub const VERSION: u32 = 9;
pub const JSON_BYTES: usize = 512;
pub const ROW_TEXT_BYTES: usize = 96;

const CURRENT_DEFAULTS: f64 = 2.0;
const AUTO_BITRATE: u8 = 0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Setting {
    Size,
    Fps,
    Bitrate,
    Codec,
    HostAudio,
    Optimise,
    QuitOnReturn,
    MenuChord,
    StreamInfo,
    FrameCounter,
    TouchMouse,
    Theme,
    RumbleOn,
    Rumble,
    ButtonLayout,
    JoyConMouse,
    MouseSensitivity,
    VirtualPad,
    PadOpacity,
}

impl Setting {
    pub const COUNT: usize = 19;
    pub const ALL: [Setting; Self::COUNT] = [
        Setting::Size,
        Setting::Fps,
        Setting::Bitrate,
        Setting::Codec,
        Setting::HostAudio,
        Setting::Optimise,
        Setting::QuitOnReturn,
        Setting::MenuChord,
        Setting::StreamInfo,
        Setting::FrameCounter,
        Setting::TouchMouse,
        Setting::Theme,
        Setting::RumbleOn,
        Setting::Rumble,
        Setting::ButtonLayout,
        Setting::JoyConMouse,
        Setting::MouseSensitivity,
        Setting::VirtualPad,
        Setting::PadOpacity,
    ];

    pub fn from_index(index: usize) -> Option<Self> {
        Self::ALL.get(index).copied()
    }

    pub fn id(self) -> &'static str {
        self.row().id
    }

    pub fn label(self) -> &'static str {
        self.row().label
    }

    /// The pane of the Settings page the row sits in: Picture, Sound, Controls or This
    /// console, in that order.
    pub fn category(self) -> u8 {
        match self {
            Self::Size | Self::Fps | Self::Bitrate | Self::Codec | Self::Optimise => 0,
            Self::HostAudio => 1,
            Self::MenuChord
            | Self::TouchMouse
            | Self::RumbleOn
            | Self::Rumble
            | Self::ButtonLayout
            | Self::JoyConMouse
            | Self::MouseSensitivity
            | Self::VirtualPad
            | Self::PadOpacity => 2,
            Self::QuitOnReturn | Self::StreamInfo | Self::FrameCounter | Self::Theme => 3,
        }
    }

    /// One line on what the row does, shown under its name.
    pub fn hint(self) -> &'static str {
        match self {
            Self::Size => "Resolution of the stream",
            Self::Fps => "Frames per second the PC sends",
            Self::Bitrate => "Auto picks only the bitrate from the network test",
            Self::Codec => "AV1 looks better at the same bitrate, H.264 is the fallback",
            Self::Optimise => "Let the PC adjust game settings for the stream",
            Self::HostAudio => "Also play the sound on the PC",
            Self::MenuChord => "Hold + and \u{2212} for a second to open the stream menu",
            Self::TouchMouse => "Touches move the PC mouse instead of sending touch",
            Self::QuitOnReturn => "Disconnect also quits the app on the PC",
            Self::StreamInfo => "A small badge with the stream mode over the video",
            Self::FrameCounter => "Adds the frame rate and delays to the badge",
            Self::Theme => "System follows the console's theme",
            Self::RumbleOn => "Vibrate the controllers when the PC rumbles them",
            Self::Rumble => "How strongly the controllers vibrate",
            Self::ButtonLayout => {
                "Xbox sends each button as the one in the same place, Nintendo by its label"
            }
            Self::JoyConMouse => {
                "Player 1's Joy-Con on a table moves the mouse; its shoulder buttons click"
            }
            Self::MouseSensitivity => "How far the pointer moves for each move of the Joy-Con",
            Self::VirtualPad => "Touch controls over the stream in handheld mode",
            Self::PadOpacity => "How strongly the touch controls show over the stream",
        }
    }

    fn row(self) -> &'static Row {
        &ROWS[self as usize]
    }
}

/// How the face buttons reach the PC: Xbox by position, Nintendo by label.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonLayout {
    #[default]
    Xbox,
    Nintendo,
}

/// Which of player 1's Joy-Con is the PC mouse, read from its optical sensor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MouseSide {
    #[default]
    Off,
    Right,
    Left,
}

impl MouseSide {
    pub fn label(self) -> &'static str {
        SIDES[self as usize].2
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Size {
    P720,
    P1080,
    P1440,
    P2160,
}

impl Size {
    pub const ALL: [Size; 4] = [Size::P720, Size::P1080, Size::P1440, Size::P2160];

    /// Every size as width and height, largest first.
    pub fn largest_first() -> impl Iterator<Item = (u32, u32)> {
        Self::ALL
            .iter()
            .rev()
            .map(|size| (size.width(), size.height()))
    }

    /// The size of a stream this many lines high.
    pub fn from_height(height: u32) -> Self {
        match height {
            720 => Size::P720,
            1080 => Size::P1080,
            1440 => Size::P1440,
            _ => Size::P2160,
        }
    }

    pub fn width(self) -> u32 {
        [1280, 1920, 2560, 3840][self as usize]
    }

    pub fn height(self) -> u32 {
        [720, 1080, 1440, 2160][self as usize]
    }

    /// The rate Automatic resolution streams this size at for the saved `fps`: 4K plays at 60.
    pub fn auto_rate(self, fps: u32) -> u32 {
        if self == Size::P2160 {
            fps.min(60)
        } else {
            fps
        }
    }

    fn docked_only(self) -> bool {
        matches!(self, Size::P1440 | Size::P2160)
    }

    fn saved(self) -> &'static str {
        ["1280x720", "1920x1080", "2560x1440", "3840x2160"][self as usize]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Codec {
    H264,
    Av1,
    Hevc,
}

impl Codec {
    pub fn name(self) -> &'static str {
        ["h264", "av1", "hevc"][self as usize]
    }

    pub fn text(self) -> &'static str {
        ["H.264", "AV1", "HEVC"][self as usize]
    }
}

const RATES: [u32; 2] = [60, 120];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub h264: bool,
    pub av1: bool,
    pub hevc: bool,
    pub verified_modes: Option<[u8; 3]>,
    pub fps120: bool,
    pub docked_sizes: bool,
}

impl Capabilities {
    pub const ALL: Capabilities = Capabilities {
        h264: true,
        av1: true,
        hevc: true,
        verified_modes: None,
        fps120: true,
        docked_sizes: true,
    };

    /// Nothing may launch until the console has proven a codec.
    pub fn launchable(&self) -> bool {
        self.h264 || self.av1 || self.hevc
    }

    pub fn verify_mode(&mut self, codec: Codec, size: Size, fps: u32) {
        let Some(rate) = RATES.iter().position(|value| *value == fps) else {
            return;
        };
        let modes = self.verified_modes.get_or_insert([0; 3]);
        modes[codec as usize] |= 1 << (size as usize * 2 + rate);
    }

    /// Whether the decoder and display offer this mode.
    pub fn mode(&self, codec: Codec, size: Size, fps: u32) -> bool {
        let Some(rate) = RATES.iter().position(|value| *value == fps) else {
            return false;
        };
        self.codec(codec)
            && (fps != 120 || self.fps120)
            && self
                .verified_modes
                .is_none_or(|modes| modes[codec as usize] & (1 << (size as usize * 2 + rate)) != 0)
    }

    fn codec(&self, codec: Codec) -> bool {
        match codec {
            Codec::H264 => self.h264,
            Codec::Av1 => self.av1,
            Codec::Hevc => self.hevc,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RowKind {
    Size,
    Fps,
    Bitrate,
    Codec,
    Toggle,
    Theme,
    Percent,
    Layout,
    Side,
    Sensitivity,
    Opacity,
}

struct Row {
    id: &'static str,
    label: &'static str,
    kind: RowKind,
    count: u8,
    fallback: u8,
    reset_before: u32,
    former_default: Option<u8>,
}

const fn row(id: &'static str, label: &'static str, kind: RowKind, count: u8, fallback: u8) -> Row {
    Row {
        id,
        label,
        kind,
        count,
        fallback,
        reset_before: 0,
        former_default: None,
    }
}

const ROWS: [Row; Setting::COUNT] = [
    row("size", "Resolution", RowKind::Size, 5, AUTO_SIZE),
    Row {
        reset_before: 9,
        ..row("fps", "Frame rate", RowKind::Fps, 2, 1)
    },
    Row {
        former_default: Some(7),
        ..row("bitrate", "Bitrate", RowKind::Bitrate, 22, AUTO_BITRATE)
    },
    Row {
        reset_before: 4,
        ..row("codec", "Codec", RowKind::Codec, 3, Codec::Av1 as u8)
    },
    row("hostAudio", "Play audio on the PC", RowKind::Toggle, 2, 0),
    row("optimise", "Optimise game settings", RowKind::Toggle, 2, 0),
    row(
        "quitOnReturn",
        "Quit host app on return",
        RowKind::Toggle,
        2,
        0,
    ),
    row("menuChord", "Hold + and - for menu", RowKind::Toggle, 2, 1),
    row("streamInfo", "Stream info badge", RowKind::Toggle, 2, 0),
    row("frameCounter", "Frame counter", RowKind::Toggle, 2, 0),
    row("touchMouse", "Touch as mouse", RowKind::Toggle, 2, 0),
    row("theme", "Theme", RowKind::Theme, 3, 0),
    row("rumbleOn", "Rumble", RowKind::Toggle, 2, 1),
    row("rumble", "Rumble strength", RowKind::Percent, 5, 4),
    row("buttons", "Button layout", RowKind::Layout, 2, 0),
    row("joyconMouse", "Joy-Con mouse", RowKind::Side, 3, 0),
    row(
        "mouseSensitivity",
        "Mouse sensitivity",
        RowKind::Sensitivity,
        8,
        3,
    ),
    row("virtualPad", "Virtual gamepad", RowKind::Toggle, 2, 0),
    row("padOpacity", "Gamepad opacity", RowKind::Opacity, 5, 2),
];

const STRENGTHS: [u32; 5] = [0, 25, 50, 75, 100];
const LAYOUTS: [(ButtonLayout, &str, &str); 2] = [
    (ButtonLayout::Xbox, "position", "Xbox"),
    (ButtonLayout::Nintendo, "labels", "Nintendo"),
];
const SIDES: [(MouseSide, &str, &str); 3] = [
    (MouseSide::Off, "off", "Off"),
    (MouseSide::Right, "right", "Right"),
    (MouseSide::Left, "left", "Left"),
];
const SENSITIVITIES: [u32; 8] = [25, 50, 75, 100, 125, 150, 200, 300];
const OPACITIES: [u32; 5] = [20, 35, 50, 65, 80];

fn multiplier(index: u8) -> f64 {
    f64::from(SENSITIVITIES[index as usize]) / 100.0
}

/// Above 40 Mbps the steps widen up to Moonlight's usual 150 Mbps cap. Sunshine takes any
/// bitrate unless its own max_bitrate is set.
const HIGH_BITRATES: [f64; 6] = [50.0, 60.0, 80.0, 100.0, 120.0, 150.0];

fn bitrate_mbps(index: u8) -> f64 {
    match index.checked_sub(16) {
        Some(high) => HIGH_BITRATES[high as usize],
        None => 5.0 + (index as f64 - 1.0) * 2.5,
    }
}

fn known_rate(value: f64) -> bool {
    value == 60.0 || value == 120.0
}

fn is_integer(value: f64) -> bool {
    const EXACT: f64 = 4_503_599_627_370_496.0;
    if !value.is_finite() {
        return false;
    }
    value.abs() >= EXACT || value as i64 as f64 == value
}

/// `floor(value + 0.5)` for the positive values the catalog produces.
fn round_half_up(value: f64) -> u32 {
    (value + 0.5) as u32
}

/// Saved settings: one catalog index per row, plus the frame rate to restore when leaving 4K.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    value: [u8; Setting::COUNT],
    fps_before_4k: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettingRow {
    pub setting: Setting,
    pub value: Text<ROW_TEXT_BYTES>,
    pub adjustable: bool,
    pub greyed: bool,
    pub can_left: bool,
    pub can_right: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamOptions {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub bitrate_auto: bool,
    pub codec: Codec,
    pub host_audio: bool,
    pub optimise: bool,
    pub quit_on_return: bool,
    pub menu_chord: bool,
    pub stream_info: bool,
    pub frame_counter: bool,
    /// Touches drive the PC mouse instead of touch input.
    pub touch_mouse: bool,
    pub button_layout: ButtonLayout,
    pub joycon_mouse: MouseSide,
    /// The Joy-Con mouse's sensitivity in percent.
    pub mouse_sensitivity: u32,
    pub launchable: bool,
    /// The size was left to the dock state and the network test (Resolution: Automatic).
    pub size_auto: bool,
}

/// Helper arguments for a launch.
#[derive(Clone, Copy, Debug, Default)]
pub struct StreamArgs {
    argv: [Arg; 24],
    count: usize,
    numbers: [Text<10>; 2],
}

#[derive(Clone, Copy, Debug, Default)]
enum Arg {
    #[default]
    None,
    Static(&'static str),
    Number(usize),
}

impl StreamArgs {
    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn get(&self, index: usize) -> Option<&str> {
        match self.argv[..self.count].get(index)? {
            Arg::Static(text) => Some(text),
            Arg::Number(slot) => Some(self.numbers[*slot].as_str()),
            Arg::None => None,
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> {
        (0..self.count).filter_map(|index| self.get(index))
    }

    fn push(&mut self, arg: Arg) {
        if self.count < self.argv.len() {
            self.argv[self.count] = arg;
            self.count += 1;
        }
    }

    fn push_number(&mut self, slot: usize, value: u32) {
        let _ = write!(self.numbers[slot], "{value}");
        self.push(Arg::Number(slot));
    }
}

/// 4K60 over Wi-Fi settles three quarters of the way up the table: Auto stepped every docked
/// AV1 stream from 56 down to 42 Mbps, so it starts there.
const P2160_60_REACH: f64 = 0.75;

/// moonlight-common's default bitrate for a catalog size, catalog rate and codec, with 4K60
/// started lower.
fn default_bitrate(size: Size, fps: u32, codec: Codec) -> u32 {
    let factor = match size {
        Size::P720 => 5.0,
        Size::P1080 => 10.0,
        Size::P1440 => 20.0,
        Size::P2160 => 40.0,
    };
    let linear = match fps {
        120 => core::f64::consts::SQRT_2 * 60.0,
        _ => fps as f64,
    };
    let rate = linear / 30.0;
    let share = match codec {
        Codec::Av1 => 0.7,
        Codec::H264 | Codec::Hevc => 1.0,
    };
    let reach = if size == Size::P2160 && fps == 60 {
        P2160_60_REACH
    } else {
        1.0
    };
    round_half_up(factor * rate * share * reach) * 1000
}

impl Default for Settings {
    fn default() -> Self {
        let mut value = [0; Setting::COUNT];
        for (slot, row) in value.iter_mut().zip(&ROWS) {
            *slot = row.fallback;
        }
        Self {
            value,
            fps_before_4k: 0,
        }
    }
}

impl Settings {
    /// The saved size. Automatic reads as the largest, which is what it asks for until the
    /// console and the link have had their say.
    pub fn size(&self) -> Size {
        Size::ALL
            .get(self.value[Setting::Size as usize] as usize)
            .copied()
            .unwrap_or(Size::P2160)
    }

    /// The size is left to the dock state and the network test.
    pub fn size_auto(&self) -> bool {
        self.value[Setting::Size as usize] == AUTO_SIZE
    }

    pub fn fps(&self) -> u32 {
        RATES[self.value[Setting::Fps as usize] as usize]
    }

    pub fn codec(&self) -> Codec {
        match self.value[Setting::Codec as usize] {
            0 => Codec::H264,
            1 => Codec::Av1,
            _ => Codec::Hevc,
        }
    }

    pub fn fps_before_4k(&self) -> u32 {
        self.fps_before_4k
    }

    /// These settings with the values an app overrides.
    pub fn with_override(&self, values: &[u8; 4]) -> Settings {
        let mut out = *self;
        for (setting, &value) in OVERRIDABLE.iter().zip(values) {
            if value != INHERIT && value < setting.row().count {
                out.value[*setting as usize] = value;
            }
        }
        out
    }

    /// The values these settings change from `base`, as an app's override.
    pub fn override_from(&self, base: &Settings) -> [u8; 4] {
        OVERRIDABLE.map(|setting| {
            let index = setting as usize;
            if self.value[index] == base.value[index] {
                INHERIT
            } else {
                self.value[index]
            }
        })
    }

    /// Raw catalog index of `setting`.
    pub fn index(&self, setting: Setting) -> u8 {
        self.value[setting as usize]
    }

    /// How much of the PC's rumble reaches the controller, in percent; none while Rumble is off.
    pub fn rumble_percent(&self) -> u32 {
        if !self.on(Setting::RumbleOn) {
            return 0;
        }
        STRENGTHS[self.value[Setting::Rumble as usize] as usize]
    }

    pub fn button_layout(&self) -> ButtonLayout {
        LAYOUTS[self.value[Setting::ButtonLayout as usize] as usize].0
    }

    pub fn joycon_mouse(&self) -> MouseSide {
        SIDES[self.value[Setting::JoyConMouse as usize] as usize].0
    }

    /// These settings with player 1's Joy-Con mouse on `side`.
    pub fn with_joycon_mouse(mut self, side: MouseSide) -> Settings {
        self.value[Setting::JoyConMouse as usize] = side as u8;
        self
    }

    /// How far the Joy-Con mouse moves the pointer, in percent of its sensor's counts.
    pub fn mouse_sensitivity(&self) -> u32 {
        SENSITIVITIES[self.value[Setting::MouseSensitivity as usize] as usize]
    }

    pub fn virtual_pad(&self) -> bool {
        self.on(Setting::VirtualPad)
    }

    /// These settings with the on-screen gamepad on or off.
    pub fn with_virtual_pad(mut self, on: bool) -> Settings {
        self.value[Setting::VirtualPad as usize] = u8::from(on);
        self
    }

    /// How opaque the on-screen gamepad is drawn, in percent.
    pub fn pad_opacity(&self) -> u32 {
        OPACITIES[self.value[Setting::PadOpacity as usize] as usize]
    }

    /// Whether the Settings page lists the row; sensitivity only matters with a Joy-Con mouse
    /// and opacity only with the on-screen gamepad.
    pub fn shown(&self, setting: Setting) -> bool {
        match setting {
            Setting::MouseSensitivity => self.joycon_mouse() != MouseSide::Off,
            Setting::PadOpacity => self.virtual_pad(),
            _ => true,
        }
    }

    pub fn theme(&self) -> Preference {
        Preference::from_index(self.value[Setting::Theme as usize])
    }

    /// Whether a toggle (or any nonzero index) is set.
    pub fn on(&self, setting: Setting) -> bool {
        self.value[setting as usize] != 0
    }

    /// Reads a saved record. Anything unknown, invalid or retired falls back to defaults.
    pub fn from_json(text: &[u8], json: &mut Json) -> Self {
        let mut settings = Self::default();
        let Some(root) = json.parse(text) else {
            return settings;
        };
        settings.sanitize(root);
        settings
    }

    pub(crate) fn sanitize(&mut self, root: Value<'_>) {
        *self = Self::default();
        if root.kind() != Kind::Object {
            return;
        }

        let version = root
            .member("version")
            .map_or(f64::NAN, |value| value.to_number());
        let versioned = is_integer(version);
        let old_defaults = !versioned || version < CURRENT_DEFAULTS;
        for (slot, row) in self.value.iter_mut().zip(&ROWS) {
            let found = root
                .member(row.id)
                .and_then(|value| match_value(value, row));
            let former =
                old_defaults && row.former_default.is_some() && found == row.former_default;
            let reset = row.reset_before > 0 && (!versioned || version < row.reset_before as f64);
            if let Some(value) = found.filter(|_| !former && !reset) {
                *slot = value;
            }
        }

        let before = root
            .member("fpsBefore4k")
            .map_or(f64::NAN, |value| value.to_number());
        self.clamp_4k(before);
    }

    fn clamp_4k(&mut self, before: f64) {
        if !self.chose_4k() {
            return;
        }

        self.fps_before_4k = if known_rate(before) {
            before as u32
        } else {
            self.fps()
        };
        self.value[Setting::Fps as usize] = 0;
    }

    /// False while the row is locked, as the frame rate is at 4K.
    pub fn adjustable(&self, setting: Setting) -> bool {
        !self.locked(setting)
    }

    fn locked(&self, setting: Setting) -> bool {
        setting == Setting::Fps && self.chose_4k()
    }

    /// 2160p picked by name. Automatic may resolve to it and still keeps its own rate rules.
    fn chose_4k(&self) -> bool {
        !self.size_auto() && self.size() == Size::P2160
    }

    /// Steps `setting` left or right past values this console does not offer.
    pub fn adjust(
        &self,
        setting: Setting,
        direction: i32,
        docked: bool,
        caps: &Capabilities,
    ) -> Option<Settings> {
        if self.locked(setting) || direction == 0 {
            return None;
        }

        let row = setting.row();
        let step = if direction > 0 { 1 } else { -1 };
        let current = self.in_use(docked, caps);
        let mode_setting = matches!(setting, Setting::Size | Setting::Fps | Setting::Codec);
        let mut index = if setting == Setting::Size && self.size_auto() {
            AUTO_SIZE
        } else if mode_setting {
            current.value[setting as usize]
        } else {
            self.value[setting as usize]
        } as i32
            + step;
        let mut selected = None;
        while (0..row.count as i32).contains(&index) {
            if offered(row, index as u8, docked, caps) {
                let mut candidate = if mode_setting { current } else { *self };
                candidate.value[setting as usize] = index as u8;
                if !mode_setting || (setting == Setting::Size && index as u8 == AUTO_SIZE) {
                    selected = Some(candidate);
                } else {
                    selected = candidate.compatible_mode(setting, docked, caps, &current);
                }
                if selected.is_some() {
                    break;
                }
            }
            index += step;
        }
        let mut out = selected?;
        if self.size_auto() && setting != Setting::Size {
            out.value[Setting::Size as usize] = AUTO_SIZE;
            return Some(out);
        }
        let to_4k = setting == Setting::Size && index == Size::P2160 as i32;
        let from_4k = setting == Setting::Size && self.chose_4k();
        if to_4k {
            out.fps_before_4k = self.fps();
            out.value[Setting::Fps as usize] = 0;
        } else if from_4k {
            if known_rate(self.fps_before_4k as f64)
                && caps.mode(out.codec(), out.size(), self.fps_before_4k)
            {
                out.value[Setting::Fps as usize] = u8::from(self.fps_before_4k == 120);
            }
            out.fps_before_4k = 0;
        }
        Some(out)
    }

    fn compatible_mode(
        &self,
        changed: Setting,
        docked: bool,
        caps: &Capabilities,
        previous: &Settings,
    ) -> Option<Settings> {
        let mut best: Option<(u8, Settings)> = None;
        for size in Size::ALL {
            if (size.docked_only() && (!docked || !caps.docked_sizes))
                || (changed == Setting::Size && size != self.size())
            {
                continue;
            }
            for fps in RATES {
                if (size == Size::P2160 && fps == 120)
                    || (changed == Setting::Fps && fps != self.fps())
                    || !caps.mode(self.codec(), size, fps)
                {
                    continue;
                }
                let score = u8::from(size == previous.size()) * 2 + u8::from(fps == previous.fps());
                if best.is_none_or(|(old, _)| score > old) {
                    let mut result = *self;
                    result.value[Setting::Size as usize] = size as u8;
                    result.value[Setting::Fps as usize] = u8::from(fps == 120);
                    best = Some((score, result));
                }
            }
        }
        best.map(|(_, settings)| settings)
    }

    /// The settings a stream would use on this console right now.
    pub fn in_use(&self, docked: bool, caps: &Capabilities) -> Settings {
        let mut out = *self;
        if out.size_auto() {
            out.capability_fallback(caps);
            out.largest_size(docked && caps.docked_sizes, caps);
        }
        out.dock_fallback(docked && caps.docked_sizes);
        out.capability_fallback(caps);
        out.mode_fallback(docked, caps);
        out
    }

    /// Automatic: the largest size this dock state plays at the saved codec and the rate
    /// `Size::auto_rate` allows it.
    fn largest_size(&mut self, docked: bool, caps: &Capabilities) {
        let (codec, fps) = (self.codec(), self.fps());
        let rate = |size: Size| size.auto_rate(fps);
        let fits = |size: &&Size| {
            (docked || !size.docked_only()) && caps.mode(codec, **size, rate(**size))
        };
        let size = *Size::ALL.iter().rev().find(fits).unwrap_or(&Size::P1080);
        self.value[Setting::Size as usize] = size as u8;
        if rate(size) != fps {
            self.value[Setting::Fps as usize] = 0;
        }
    }

    fn dock_fallback(&mut self, docked: bool) {
        let size = self.size();
        if docked || !size.docked_only() {
            return;
        }

        self.value[Setting::Size as usize] = Size::P1080 as u8;
        if size == Size::P2160 {
            self.value[Setting::Fps as usize] = 1;
        }
    }

    fn capability_fallback(&mut self, caps: &Capabilities) {
        if !caps.fps120 {
            self.value[Setting::Fps as usize] = 0;
        }
        let codec = &mut self.value[Setting::Codec as usize];
        if *codec == Codec::Av1 as u8 && !caps.av1 && caps.h264 {
            *codec = Codec::H264 as u8;
        }
        if *codec == Codec::H264 as u8 && !caps.h264 && caps.av1 {
            *codec = Codec::Av1 as u8;
        }
    }

    fn mode_fallback(&mut self, docked: bool, caps: &Capabilities) {
        if caps.verified_modes.is_none() || caps.mode(self.codec(), self.size(), self.fps()) {
            return;
        }
        let mut best = None;
        for codec in [Codec::Av1, Codec::H264, Codec::Hevc] {
            for size in Size::ALL {
                if size.docked_only() && !docked {
                    continue;
                }
                for fps in RATES {
                    if size == Size::P2160 && fps == 120 {
                        continue;
                    }
                    if !caps.mode(codec, size, fps) {
                        continue;
                    }
                    // Closest to the saved mode; between equals, the largest picture.
                    let score = (
                        u8::from(codec == self.codec()) * 4
                            + u8::from(size == self.size()) * 2
                            + u8::from(fps == self.fps()),
                        size as u8,
                    );
                    if best.is_none_or(|(old, _, _, _)| score > old) {
                        best = Some((score, codec, size, fps));
                    }
                }
            }
        }
        if let Some((_, codec, size, fps)) = best {
            self.value[Setting::Codec as usize] = codec as u8;
            self.value[Setting::Size as usize] = size as u8;
            self.value[Setting::Fps as usize] = u8::from(fps == 120);
        }
    }

    pub fn rows(&self, docked: bool, caps: &Capabilities) -> [SettingRow; Setting::COUNT] {
        Setting::ALL.map(|setting| {
            let index = setting as usize;
            let moves = |direction| self.adjust(setting, direction, docked, caps);
            let changes = |out: Option<Settings>| {
                out.is_some_and(|out| out.value[index] != self.value[index])
            };
            SettingRow {
                setting,
                value: self.row_text(setting, docked, caps),
                adjustable: self.adjustable(setting),
                greyed: false,
                can_left: changes(moves(-1)),
                can_right: changes(moves(1)),
            }
        })
    }

    fn row_text(
        &self,
        setting: Setting,
        docked: bool,
        caps: &Capabilities,
    ) -> Text<ROW_TEXT_BYTES> {
        let mut out = Text::new();
        let used = self.in_use(docked, caps);
        let saved = self.value[setting as usize];
        let in_use = used.value[setting as usize];

        if setting == Setting::Size && self.size_auto() {
            let _ = write!(out, "{}", value_text(setting, &used, saved));
            return out;
        }
        if matches!(setting, Setting::Codec | Setting::Size | Setting::Fps)
            && !caps.mode(used.codec(), used.size(), used.fps())
        {
            let _ = write!(out, "{} unavailable", value_text(setting, self, saved));
            return out;
        }
        if in_use == saved {
            let _ = write!(out, "{}", value_text(setting, &used, saved));
            return out;
        }

        let mut by_dock = *self;
        by_dock.dock_fallback(docked);
        let dock_only = by_dock.value[setting as usize] != saved && !docked;
        let mut short = Text::<40>::new();
        let _ = match setting {
            Setting::Size => write!(short, "{}", short_size(saved)),
            _ => write!(short, "{}", value_text(setting, self, saved)),
        };
        let reason = if dock_only {
            "when docked"
        } else {
            "unavailable"
        };
        let _ = write!(
            out,
            "{} \u{b7} {} {}",
            value_text(setting, &used, in_use),
            short,
            reason
        );
        out
    }

    /// The saved record, as the JS settings code wrote it.
    pub fn to_json(&self) -> Text<JSON_BYTES> {
        let mut out = Text::new();
        let _ = write!(out, "{{\"version\":{VERSION}");
        for (row, &value) in ROWS.iter().zip(&self.value) {
            let _ = write!(out, ",\"{}\":", row.id);
            let _ = match row.kind {
                RowKind::Size if value == AUTO_SIZE => write!(out, "\"auto\""),
                RowKind::Size => write!(out, "\"{}\"", Size::ALL[value as usize].saved()),
                RowKind::Fps => write!(out, "{}", RATES[value as usize]),
                RowKind::Bitrate if value == AUTO_BITRATE => write!(out, "\"auto\""),
                RowKind::Bitrate => write!(out, "{}", bitrate_mbps(value)),
                RowKind::Codec => write!(out, "\"{}\"", codec_at(value).name()),
                RowKind::Toggle => write!(out, "{}", value != 0),
                RowKind::Theme => write!(out, "\"{}\"", Preference::from_index(value).saved()),
                RowKind::Percent => write!(out, "{}", STRENGTHS[value as usize]),
                RowKind::Layout => write!(out, "\"{}\"", LAYOUTS[value as usize].1),
                RowKind::Side => write!(out, "\"{}\"", SIDES[value as usize].1),
                RowKind::Sensitivity => write!(out, "{}", multiplier(value)),
                RowKind::Opacity => write!(out, "{}", OPACITIES[value as usize]),
            };
        }
        if self.fps_before_4k != 0 {
            let _ = write!(out, ",\"fpsBefore4k\":{}", self.fps_before_4k);
        }
        let _ = write!(out, "}}");
        out
    }

    /// Helper arguments, from the record as it would load back.
    pub fn stream_args(&self) -> StreamArgs {
        let mut saved = *self;
        saved.clamp_4k(self.fps_before_4k as f64);
        let mut args = StreamArgs::default();
        let bitrate = saved.value[Setting::Bitrate as usize];

        args.push(Arg::Static("--codec"));
        args.push(Arg::Static(saved.codec().name()));
        args.push(Arg::Static("--size"));
        args.push(Arg::Static(saved.size().saved()));
        args.push(Arg::Static("--fps"));
        args.push_number(0, saved.fps());
        args.push(Arg::Static("--bitrate"));
        if bitrate == AUTO_BITRATE {
            args.push(Arg::Static("auto"));
        } else {
            args.push_number(1, round_half_up(bitrate_mbps(bitrate) * 1000.0));
        }
        args.push(Arg::Static("--staggered"));
        args.push(Arg::Static("--socket-audio"));
        if saved.chose_4k() {
            args.push(Arg::Static("--undocked-fps"));
            args.push(Arg::Static("120"));
        }

        let flags = [
            (saved.on(Setting::HostAudio), "--local-audio"),
            (saved.on(Setting::Optimise), "--sops"),
            (!saved.on(Setting::MenuChord), "--no-menu-chord"),
            (saved.on(Setting::StreamInfo), "--stream-info"),
            (saved.on(Setting::FrameCounter), "--frame-counter"),
        ];
        for (set, flag) in flags {
            if set {
                args.push(Arg::Static(flag));
            }
        }
        args
    }

    pub fn stream_options(&self, docked: bool, caps: &Capabilities) -> StreamOptions {
        let used = self.in_use(docked, caps);
        let size = used.size();
        let bitrate = used.value[Setting::Bitrate as usize];
        let codec = used.codec();
        let fps = used.fps();
        let bitrate_kbps = match bitrate {
            AUTO_BITRATE => default_bitrate(size, fps, codec),
            _ => round_half_up(bitrate_mbps(bitrate) * 1000.0),
        };

        StreamOptions {
            width: size.width(),
            height: size.height(),
            fps,
            bitrate_kbps,
            bitrate_auto: bitrate == AUTO_BITRATE,
            codec,
            host_audio: used.on(Setting::HostAudio),
            optimise: used.on(Setting::Optimise),
            quit_on_return: used.on(Setting::QuitOnReturn),
            menu_chord: used.on(Setting::MenuChord),
            stream_info: used.on(Setting::StreamInfo),
            frame_counter: used.on(Setting::FrameCounter),
            touch_mouse: used.on(Setting::TouchMouse),
            button_layout: used.button_layout(),
            joycon_mouse: used.joycon_mouse(),
            mouse_sensitivity: used.mouse_sensitivity(),
            launchable: caps.codec(codec),
            size_auto: self.size_auto(),
        }
    }
}

fn codec_at(value: u8) -> Codec {
    match value {
        0 => Codec::H264,
        1 => Codec::Av1,
        _ => Codec::Hevc,
    }
}

fn short_size(value: u8) -> &'static str {
    ["", "", "1440p", "4K", "Automatic"][value as usize]
}

fn match_value(value: Value<'_>, row: &Row) -> Option<u8> {
    let number = value.number();
    match row.kind {
        RowKind::Size if value.string_is("auto") => Some(AUTO_SIZE),
        RowKind::Size => Size::ALL
            .iter()
            .position(|size| value.string_is(size.saved()))
            .map(|i| i as u8),
        RowKind::Fps => RATES
            .iter()
            .position(|&rate| number == Some(rate as f64))
            .map(|i| i as u8),
        RowKind::Bitrate if value.string_is("auto") => Some(AUTO_BITRATE),
        RowKind::Bitrate => (1..row.count).find(|&i| number == Some(bitrate_mbps(i))),
        RowKind::Codec => [Codec::H264, Codec::Av1, Codec::Hevc]
            .iter()
            .position(|c| value.string_is(c.name()))
            .map(|i| i as u8),
        RowKind::Toggle => match value.kind() {
            Kind::False => Some(0),
            Kind::True => Some(1),
            _ => None,
        },
        RowKind::Theme => Preference::ALL
            .iter()
            .position(|preference| value.string_is(preference.saved()))
            .map(|i| i as u8),
        RowKind::Percent => STRENGTHS
            .iter()
            .position(|&percent| number == Some(f64::from(percent)))
            .map(|i| i as u8),
        RowKind::Layout => LAYOUTS
            .iter()
            .position(|&(_, saved, _)| value.string_is(saved))
            .map(|i| i as u8),
        RowKind::Side => SIDES
            .iter()
            .position(|&(_, saved, _)| value.string_is(saved))
            .map(|i| i as u8),
        RowKind::Sensitivity => {
            (0..SENSITIVITIES.len() as u8).find(|&i| number == Some(multiplier(i)))
        }
        RowKind::Opacity => OPACITIES
            .iter()
            .position(|&percent| number == Some(f64::from(percent)))
            .map(|i| i as u8),
    }
}

fn offered(row: &Row, value: u8, docked: bool, caps: &Capabilities) -> bool {
    match row.kind {
        RowKind::Size if value == AUTO_SIZE => true,
        RowKind::Size => !Size::ALL[value as usize].docked_only() || (docked && caps.docked_sizes),
        RowKind::Fps => RATES[value as usize] != 120 || caps.fps120,
        RowKind::Codec => caps.codec(codec_at(value)),
        _ => true,
    }
}

struct ValueText<'a> {
    setting: Setting,
    for_auto: &'a Settings,
    value: u8,
}

fn value_text(setting: Setting, for_auto: &Settings, value: u8) -> ValueText<'_> {
    ValueText {
        setting,
        for_auto,
        value,
    }
}

impl core::fmt::Display for ValueText<'_> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let value = self.value;
        match self.setting.row().kind {
            RowKind::Size if value == AUTO_SIZE => {
                write!(f, "Auto ({}p)", self.for_auto.size().height())
            }
            RowKind::Size => f.write_str(SIZE_TEXT[value as usize]),
            RowKind::Fps => write!(f, "{} fps", RATES[value as usize]),
            RowKind::Bitrate if value != AUTO_BITRATE => write!(f, "{} Mbps", bitrate_mbps(value)),
            RowKind::Bitrate => {
                let auto = self.for_auto;
                let kbps = default_bitrate(auto.size(), auto.fps(), auto.codec());
                write!(f, "Auto ({} Mbps)", kbps / 1000)
            }
            RowKind::Codec => f.write_str(codec_at(value).text()),
            RowKind::Toggle => f.write_str(if value != 0 { "On" } else { "Off" }),
            RowKind::Theme => f.write_str(Preference::from_index(value).label()),
            RowKind::Percent => write!(f, "{} %", STRENGTHS[value as usize]),
            RowKind::Layout => f.write_str(LAYOUTS[value as usize].2),
            RowKind::Side => f.write_str(SIDES[value as usize].2),
            RowKind::Sensitivity => write!(f, "{}\u{d7}", multiplier(value)),
            RowKind::Opacity => write!(f, "{} %", OPACITIES[value as usize]),
        }
    }
}

const SIZE_TEXT: [&str; 4] = [
    "1280 \u{d7} 720",
    "1920 \u{d7} 1080",
    "2560 \u{d7} 1440 (docked)",
    "3840 \u{d7} 2160 (docked, 60 fps)",
];
/// The size row's last value: the largest size the dock state, the console's output and the
/// decoder play, lowered by the network test when the link cannot carry it. Sunshine does not
/// report the PC's display mode, so Auto cannot hold a stream to it: a 1440p PC on a 4K output
/// streams 2160p, scaled up by the PC. A size picked by name is the way to match the PC.
pub const AUTO_SIZE: u8 = 4;

#[cfg(test)]
mod verified_tests {
    use super::*;

    #[test]
    fn mode_combinations_do_not_borrow_another_codec_or_resolution() {
        let mut caps = Capabilities {
            h264: true,
            av1: true,
            hevc: true,
            fps120: true,
            docked_sizes: true,
            verified_modes: Some([0; 3]),
        };
        caps.verify_mode(Codec::H264, Size::P1080, 60);
        caps.verify_mode(Codec::Av1, Size::P720, 120);
        caps.verify_mode(Codec::Hevc, Size::P1080, 60);
        let mut settings = Settings::default();
        settings.value[Setting::Codec as usize] = Codec::H264 as u8;
        settings.value[Setting::Size as usize] = Size::P1080 as u8;
        assert!(settings.adjust(Setting::Fps, 1, false, &caps).is_none());
        assert!(settings.adjust(Setting::Size, -1, false, &caps).is_none());
        let av1 = settings.adjust(Setting::Codec, 1, false, &caps).unwrap();
        assert_eq!(
            (av1.codec(), av1.size(), av1.fps()),
            (Codec::Av1, Size::P720, 120)
        );
        let hevc = av1.adjust(Setting::Codec, 1, false, &caps).unwrap();
        assert_eq!(
            (hevc.codec(), hevc.size(), hevc.fps()),
            (Codec::Hevc, Size::P1080, 60)
        );
        let parsed = Settings::from_json(hevc.to_json().as_str().as_bytes(), &mut Json::new());
        assert_eq!(parsed.codec(), Codec::Hevc);
        let auto = hevc.stream_options(false, &caps);
        assert!(auto.bitrate_auto);
        assert!(auto.bitrate_kbps > 0);
        caps.hevc = false;
        caps.h264 = false;
        caps.av1 = false;
        assert!(settings.adjust(Setting::Codec, 1, false, &caps).is_none());
        assert!(
            settings.rows(false, &caps)[Setting::Codec as usize]
                .value
                .as_str()
                .contains("unavailable")
        );
    }

    #[test]
    fn restored_mode_uses_only_a_verified_combination() {
        let mut caps = Capabilities {
            h264: true,
            fps120: true,
            verified_modes: Some([0; 3]),
            ..Capabilities::default()
        };
        caps.verify_mode(Codec::H264, Size::P720, 60);
        let settings = Settings::default();
        let used = settings.in_use(false, &caps);
        assert_eq!(
            (used.codec(), used.size(), used.fps()),
            (Codec::H264, Size::P720, 60)
        );
        assert!(settings.size_auto());
    }
}

#[cfg(test)]
mod rate_tests {
    use super::*;

    #[test]
    fn streams_default_to_120_fps_except_at_4k() {
        let caps = Capabilities::ALL;
        let settings = Settings::default();
        assert_eq!(settings.fps(), 120);
        let handheld = settings.in_use(false, &caps);
        assert_eq!((handheld.size(), handheld.fps()), (Size::P1080, 120));
        let docked = settings.in_use(true, &caps);
        assert_eq!((docked.size(), docked.fps()), (Size::P2160, 60));

        let old = Settings::from_json(br#"{"version":8,"fps":60}"#, &mut Json::new());
        assert_eq!(old.fps(), 120);
        let kept = Settings::from_json(br#"{"version":9,"fps":60}"#, &mut Json::new());
        assert_eq!(kept.fps(), 60);
    }
}

#[cfg(test)]
mod retired_row_tests {
    use super::*;

    #[test]
    fn a_saved_low_latency_choice_is_ignored() {
        let mut json = Json::new();
        let loaded = Settings::from_json(
            br#"{"version":9,"touchMouse":true,"lowLatency":true,"theme":"dark"}"#,
            &mut json,
        );
        assert!(loaded.on(Setting::TouchMouse));
        assert_eq!(loaded.theme(), crate::theme::Preference::Dark);
        assert!(!loaded.to_json().as_str().contains("lowLatency"));
    }
}

#[cfg(test)]
mod legacy_capability_tests {
    use super::*;

    #[test]
    fn leaving_4k_does_not_restore_unavailable_120fps() {
        let mut json = Json::new();
        let settings = Settings::from_json(
            br#"{"version":8,"size":"3840x2160","fps":60,"fpsBefore4k":120,"codec":"h264"}"#,
            &mut json,
        );
        let caps = Capabilities {
            h264: true,
            fps120: false,
            ..Capabilities::default()
        };
        let changed = settings.adjust(Setting::Size, -1, false, &caps).unwrap();
        assert_eq!(changed.fps(), 60);
        assert_eq!(changed.fps_before_4k(), 0);
    }
}

#[cfg(test)]
mod av1_rate_tests {
    use super::*;

    fn handheld(fps120: bool) -> Capabilities {
        let mut caps = Capabilities {
            av1: true,
            fps120,
            ..Capabilities::default()
        };
        for size in [Size::P720, Size::P1080] {
            for fps in RATES {
                caps.verify_mode(Codec::Av1, size, fps);
            }
        }
        caps
    }

    fn played(settings: &Settings, caps: &Capabilities) -> (u32, u32) {
        let options = settings.stream_options(false, caps);
        (options.height, options.fps)
    }

    #[test]
    fn av1_1080p_defaults_to_120_fps_where_the_display_has_120_hz() {
        let fresh = Settings::default();
        assert!(fresh.size_auto());
        assert_eq!(fresh.codec(), Codec::Av1);
        assert_eq!(played(&fresh, &handheld(true)), (1080, 120));
        assert_eq!(played(&fresh, &handheld(false)), (1080, 60));

        let mut json = Json::new();
        let picked = Settings::from_json(
            br#"{"version":9,"size":"1920x1080","fps":120,"codec":"av1"}"#,
            &mut json,
        );
        assert_eq!(played(&picked, &handheld(true)), (1080, 120));
        assert_eq!(played(&picked, &handheld(false)), (1080, 60));
    }
}
