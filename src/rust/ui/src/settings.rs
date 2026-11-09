//! Settings catalog, adjustment rules, save format and stream options of src/native/ui/settings.c.

use core::fmt::Write;

use crate::json::{Json, Kind, Value};
use crate::text::Text;

pub const VERSION: u32 = 8;
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
    LowLatency,
}

impl Setting {
    pub const COUNT: usize = 12;
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
        Setting::LowLatency,
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

    fn row(self) -> &'static Row {
        &ROWS[self as usize]
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
    const ALL: [Size; 4] = [Size::P720, Size::P1080, Size::P1440, Size::P2160];

    pub fn width(self) -> u32 {
        [1280, 1920, 2560, 3840][self as usize]
    }

    pub fn height(self) -> u32 {
        [720, 1080, 1440, 2160][self as usize]
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

    fn text(self) -> &'static str {
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

    fn mode(&self, codec: Codec, size: Size, fps: u32) -> bool {
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
    row("size", "Resolution", RowKind::Size, 4, Size::P1080 as u8),
    row("fps", "Frame rate", RowKind::Fps, 2, 0),
    Row {
        former_default: Some(7),
        ..row("bitrate", "Bitrate", RowKind::Bitrate, 16, AUTO_BITRATE)
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
    row("menuChord", "Hold L+R for menu", RowKind::Toggle, 2, 1),
    row("streamInfo", "Stream info badge", RowKind::Toggle, 2, 0),
    row("frameCounter", "Frame counter", RowKind::Toggle, 2, 0),
    row("touchMouse", "Touch as mouse", RowKind::Toggle, 2, 0),
    row("lowLatency", "Low latency (restart)", RowKind::Toggle, 2, 0),
];

fn bitrate_mbps(index: u8) -> f64 {
    5.0 + (index as f64 - 1.0) * 2.5
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
    pub launchable: bool,
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

/// moonlight-common's default bitrate for a catalog size, catalog rate and codec.
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
    round_half_up(factor * rate * share) * 1000
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
    pub fn size(&self) -> Size {
        Size::ALL[self.value[Setting::Size as usize] as usize]
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

    /// Raw catalog index of `setting`.
    pub fn index(&self, setting: Setting) -> u8 {
        self.value[setting as usize]
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
        if self.size() != Size::P2160 {
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
        setting == Setting::Fps && self.size() == Size::P2160
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
        let mut index = if mode_setting {
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
                if !mode_setting {
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
        let to_4k = setting == Setting::Size && index == Size::P2160 as i32;
        let from_4k = setting == Setting::Size && self.size() == Size::P2160;
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
        out.dock_fallback(docked && caps.docked_sizes);
        out.capability_fallback(caps);
        out.mode_fallback(docked, caps);
        out
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
        for codec in [Codec::H264, Codec::Av1, Codec::Hevc] {
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
                    let score = u8::from(codec == self.codec()) * 4
                        + u8::from(size == self.size()) * 2
                        + u8::from(fps == self.fps());
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
                RowKind::Size => write!(out, "\"{}\"", Size::ALL[value as usize].saved()),
                RowKind::Fps => write!(out, "{}", RATES[value as usize]),
                RowKind::Bitrate if value == AUTO_BITRATE => write!(out, "\"auto\""),
                RowKind::Bitrate => write!(out, "{}", bitrate_mbps(value)),
                RowKind::Codec => write!(out, "\"{}\"", codec_at(value).name()),
                RowKind::Toggle => write!(out, "{}", value != 0),
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
        if saved.size() == Size::P2160 {
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
            launchable: caps.codec(codec),
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
    ["", "", "1440p", "4K"][value as usize]
}

fn match_value(value: Value<'_>, row: &Row) -> Option<u8> {
    let number = value.number();
    match row.kind {
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
    }
}

fn offered(row: &Row, value: u8, docked: bool, caps: &Capabilities) -> bool {
    match row.kind {
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
        }
    }
}

const SIZE_TEXT: [&str; 4] = [
    "1280 \u{d7} 720",
    "1920 \u{d7} 1080",
    "2560 \u{d7} 1440 (docked)",
    "3840 \u{d7} 2160 (docked, 60 fps)",
];

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
        assert_eq!(settings.size(), Size::P1080);
    }
}

#[cfg(test)]
mod low_latency_tests {
    use super::*;

    #[test]
    fn low_latency_is_off_by_default_and_round_trips() {
        let mut json = Json::new();
        let legacy = Settings::from_json(br#"{"version":7,"touchMouse":true}"#, &mut json);
        assert!(!legacy.on(Setting::LowLatency));
        assert!(legacy.on(Setting::TouchMouse));
        let enabled = legacy
            .adjust(Setting::LowLatency, 1, false, &Capabilities::default())
            .unwrap();
        assert!(enabled.on(Setting::LowLatency));
        let loaded = Settings::from_json(enabled.to_json().as_str().as_bytes(), &mut json);
        assert!(loaded.on(Setting::LowLatency));
        assert!(loaded.on(Setting::TouchMouse));
    }
    #[derive(Default)]
    struct MemoryFiles {
        slots: [Option<alloc::vec::Vec<u8>>; 2],
    }

    impl crate::store::Files for MemoryFiles {
        fn read(&mut self, name: &str, output: &mut [u8]) -> Option<usize> {
            let index = crate::store::SLOTS.iter().position(|slot| *slot == name)?;
            let bytes = self.slots[index].as_ref()?;
            output.get_mut(..bytes.len())?.copy_from_slice(bytes);
            Some(bytes.len())
        }

        fn write(&mut self, name: &str, bytes: &[u8]) -> bool {
            let Some(index) = crate::store::SLOTS.iter().position(|slot| *slot == name) else {
                return false;
            };
            self.slots[index] = Some(bytes.into());
            true
        }
    }

    #[test]
    fn low_latency_survives_settings_store_reload() {
        let mut store = crate::store::Store::new(MemoryFiles::default());
        let mut json = Json::new();
        let enabled = Settings::default()
            .adjust(Setting::LowLatency, 1, false, &Capabilities::default())
            .unwrap();
        assert!(store.save(&enabled, &mut json));
        let (source, loaded) = store.load(&mut json);
        assert_eq!(source, crate::store::Source::Loaded);
        assert!(loaded.on(Setting::LowLatency));
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
