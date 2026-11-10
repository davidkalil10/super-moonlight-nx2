//! One layout per model screen, drawn over the console's own frame: icon and title, a thin rule,
//! the content, a thin rule and the button hints, right-aligned in the system's order.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use crate::composer::{
    Builder, CONTENT_WIDTH, Error, Face, Keys, SCREEN_WIDTH, SIDE,
    home_slot, page_count, shown_count,
};
use crate::extras::OVERRIDABLE;
use crate::glyphs::Align;
use crate::model::{APPS_PER_PAGE, Address, CATEGORIES, HOSTS_PER_PAGE, Host, Model, Screen, is_address, item};
use crate::presence::Presence;
use crate::page::{self, Shape};
use crate::readout::{Network, Readout};
use crate::settings::{Setting, SettingRow};

const TITLE: Face = Face::new(44, 500);
const STATUS: Face = Face::new(28, 500);
const NAME: Face = Face::new(40, 700);
const BODY: Face = Face::new(28, 500);
const OPTION: Face = Face::new(32, 600);
const VALUE: Face = Face::new(32, 500);
const BODY_BOLD: Face = Face::new(28, 700);
const BUTTON: Face = Face::new(32, 700);
const HINT: Face = Face::new(24, 500);
const HEADLINE: Face = Face::new(56, 700);
const APP_NAME: Face = Face::new(50, 700);
const PIN: Face = Face::new(72, 700);

const HEAD_Y: u32 = 81;
const STATUS_GAP: u32 = 34;
const LOGO: u32 = 58;
const RULE_TOP: u32 = 173;
const RULE_BOTTOM: u32 = 952;
const FOOT_Y: u32 = 984;
const BODY_Y: u32 = 219;
const RIGHT: u32 = SCREEN_WIDTH - SIDE;
const PANEL_RADIUS: u32 = 18;
const DIALOG_WIDTH: u32 = 1040;
const DIALOG_X: u32 = (SCREEN_WIDTH - DIALOG_WIDTH) / 2;
const DIALOG_PAD: u32 = 56;
const DIALOG_RADIUS: u32 = 28;
const DIALOG_HEIGHT: u32 = 460;
const DIALOG_BUTTON: u32 = 88;
const PAIRING_HEIGHT: u32 = 520;
const CATEGORY_WIDTH: u32 = 460;
const CONSOLE_CATEGORY: u8 = 4;
const CATEGORY_HEIGHT: u32 = 80;
const PANE_GAP: u32 = 58;
const PANE_X: u32 = SIDE + CATEGORY_WIDTH + PANE_GAP;
const PANE_WIDTH: u32 = CONTENT_WIDTH - CATEGORY_WIDTH - PANE_GAP;
const CATEGORY_BAR: u32 = 8;
const ROW_HEIGHT: u32 = 96;
const ROW_GAP: u32 = 4;
const LOCKED_ROW_HEIGHT: u32 = 56;
const VALUE_WIDTH: u32 = 420;
const BUTTON_RADIUS: u32 = 14;
const ROW_PAD: u32 = 27;
const CATEGORY_RADIUS: u32 = 12;

const CARD_HEIGHT: u32 = 96;
const PC_CARD_WIDTH: u32 = 400;
const PC_CARD_HEIGHT: u32 = 250;
const PC_CARD_PAD: u32 = 34;
const PC_GAP: u32 = 42;
const PC_ROW_GAP: u32 = 30;
const PCS_PER_ROW: u32 = 4;
const PAGER_Y: u32 = BODY_Y + 16 + 2 * (PC_CARD_HEIGHT + PC_ROW_GAP);
const RESUME_HEIGHT: u32 = 84;
const RESUME_Y: u32 = RULE_BOTTOM - 24 - RESUME_HEIGHT;
const RESUME_PAD: u32 = 34;
const RESUME_APP_MAX: u32 = 700;
const PLUS_PILL: (u32, u32) = (62, 40);
const DOT: u32 = 20;
const KEYPAD_Y: u32 = 430;
const KEYPAD_WIDTH: u32 = 160;
const KEYPAD_GAP: u32 = 24;
const BUTTON_WIDTH: u32 = 400;
const BUTTON_GAP: u32 = 48;
const PAGER_WIDTH: u32 = 300;
const PAGER_HEIGHT: u32 = 64;
const FOCUS_COVER: (u32, u32) = (326, 489);
const SHELF_BOTTOM: u32 = BODY_Y + 16 + FOCUS_COVER.1;
const SHELF_GAP: u32 = 31;
const SHELF_COVER_MAX: u32 = 250;
const NAME_GAP: u32 = 34;
const CHIPS_GAP: u32 = 86;
const BACK_WIDTH: u32 = 220;
const COVER_RADIUS: u32 = 12;
const CHIP_HEIGHT: u32 = 44;
const CHIP_PAD: u32 = 21;
const SHEET_WIDTH: u32 = 653;
const SHEET_PAD: u32 = 50;
const SHEET_TOP: u32 = 56;
const SHEET_ALPHA: u32 = 0xf0 << 24;
const SCREEN_HEIGHT: u32 = 1080;
const SHEET_GRID_Y: u32 = 186;
const SHEET_CELL: u32 = 46;
const SHEET_ITEMS_Y: u32 = 350;
const SHEET_ITEM: u32 = 84;
const SHEET_ITEM_GAP: u32 = 21;
const SHEET_ITEM_RADIUS: u32 = 13;
const SHEET_FOOT_Y: u32 = 984;
const BADGE_X: u32 = 58;
const BADGE_HEIGHT: u32 = 56;
const BADGE_Y: u32 = SCREEN_HEIGHT - 58 - BADGE_HEIGHT;
const BADGE_PAD: u32 = 30;
const BADGE_ALPHA: u32 = 0xeb << 24;

const KEY_LABELS: [&str; 12] = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "Erase",
];

fn error_next_step(message: Option<&str>, lost: bool) -> &'static str {
    let message = message.unwrap_or("");
    if message.contains("Moonlight helper") {
        "On the PC, start moonlight-nx2-pc serve, then open the PC again"
    } else if message.contains("code") {
        "Open the PC again for a new code"
    } else if message.contains("Pairing") || message.contains("paired") {
        "Open Sunshine on the PC and pair this console, then try again"
    } else if lost
        || message.contains("reach")
        || message.contains("connection")
        || message.contains("disconnected")
    {
        "Wake the PC and check Sunshine and Wi-Fi, then try again"
    } else {
        "Check Wi-Fi and Sunshine, then go back and try again"
    }
}

fn join(out: &mut String, part: Option<&str>) {
    let Some(part) = part.filter(|p| !p.is_empty()) else {
        return;
    };
    if !out.is_empty() {
        out.push_str(" \u{b7} ");
    }
    out.push_str(part);
}

/// Why a row cannot be changed right now, when it cannot.
fn locked_reason(row: &SettingRow) -> Option<&'static str> {
    if row.setting != Setting::Fps {
        None
    } else if !row.adjustable {
        Some("Fixed for 4K")
    } else if !row.can_left && !row.can_right {
        Some("120 fps needs a 120 Hz display")
    } else {
        None
    }
}

fn host_name(model: &Model) -> Option<&str> {
    model.host().map(|h| h.name.as_str())
}

fn pc_slot(i: u32) -> (u32, u32) {
    (
        SIDE + (i % PCS_PER_ROW) * (PC_CARD_WIDTH + PC_GAP),
        BODY_Y + 16 + (i / PCS_PER_ROW) * (PC_CARD_HEIGHT + PC_ROW_GAP),
    )
}

fn status_items(readout: &Readout) -> Vec<String> {
    let mut items = Vec::new();
    match readout.network {
        Some(Network::Wifi(bars)) => items.push(format!("Wi-Fi {}/3", bars.min(3))),
        Some(Network::Wired) => items.push(String::from("Wired")),
        None => {}
    }
    if let Some(percent) = readout.battery_percent {
        items.push(format!("{percent} %"));
    }
    if let Some((hours, minutes)) = readout.clock {
        items.push(format!("{hours}:{minutes:02}"));
    }
    items
}

/// What a screen puts in the shared frame.
#[derive(Default)]
struct Chrome<'a> {
    title: &'a str,
    left: &'a str,
    keys: Keys<'a>,
    cursor_home: u32,
    flags: u32,
}

impl Builder<'_> {
    fn frame(&mut self, model: &Model, chrome: &Chrome) {
        let pal = self.pal;
        self.background = pal.ground;
        self.cursor_home = chrome.cursor_home;
        self.flags = chrome.flags;

        self.dot(SIDE, HEAD_Y, LOGO, pal.dim);
        self.dot(SIDE + 10, HEAD_Y + 10, LOGO - 20, pal.ink);
        self.put(
            SIDE + LOGO + 27,
            HEAD_Y + 3,
            1000,
            chrome.title,
            TITLE,
            pal.ink,
            Align::Left,
        );
        let mut right = RIGHT;
        for item in status_items(model.readout()).iter().rev() {
            let width = self.text_width(item, STATUS) + 2;
            right = right.saturating_sub(width);
            self.put(right, HEAD_Y + 14, width, item, STATUS, pal.dim, Align::Left);
            right = right.saturating_sub(STATUS_GAP);
        }
        self.fill(SIDE, RULE_TOP, CONTENT_WIDTH, 2, pal.line, 0);
        self.fill(SIDE, RULE_BOTTOM, CONTENT_WIDTH, 2, pal.line, 0);

        let left = if chrome.keys.is_empty() {
            RIGHT
        } else {
            self.legend_right(RIGHT, FOOT_Y, chrome.keys, pal.ink, 0)
        };
        if !chrome.left.is_empty() {
            let width = left.saturating_sub(SIDE + 48).min(1000);
            self.put(SIDE, FOOT_Y + 5, width, chrome.left, HINT, pal.dim, Align::Left);
        }
    }

    fn button(&mut self, id: u32, x: u32, y: u32, width: u32, label: &str, greyed: bool) {
        self.sized_button(id, (x, y, width, CARD_HEIGHT), label, greyed);
    }

    fn sized_button(&mut self, id: u32, (x, y, width, height): (u32, u32, u32, u32), label: &str, greyed: bool) {
        let pal = self.pal;
        let flags = if greyed { page::ITEM_GREYED } else { 0 };
        self.item(id, x, y, width, height, flags, BUTTON_RADIUS);
        let (fill, ink) = if greyed {
            (pal.ground, pal.faint)
        } else {
            (pal.panel, pal.ink)
        };
        self.fill(x, y, width, height, fill, BUTTON_RADIUS);
        self.put(x, y + (height - 40) / 2, width, label, BUTTON, ink, Align::Center);
    }

    fn pager(&mut self, y: u32, at: u32, pages: u32) {
        let x = RIGHT - 2 * PAGER_WIDTH - BUTTON_GAP;
        let next_x = x + PAGER_WIDTH + BUTTON_GAP;
        let previous = (x, y, PAGER_WIDTH, PAGER_HEIGHT);
        let next = (next_x, y, PAGER_WIDTH, PAGER_HEIGHT);
        self.sized_button(item::PREVIOUS, previous, "\u{2039}  Previous", at == 0);
        self.sized_button(item::NEXT, next, "Next  \u{203a}", at + 1 >= pages);
    }

    fn wrapped(&mut self, x: u32, y: u32, width: u32, text: &str, face: Face, color: u32) -> u32 {
        let mut line = String::new();
        let mut y = y;
        for word in text.split(' ') {
            let candidate = if line.is_empty() {
                String::from(word)
            } else {
                format!("{line} {word}")
            };
            if !line.is_empty() && self.text_width(&candidate, face) > width {
                self.put(x, y, width, &line, face, color, Align::Center);
                y += face.size + 12;
                line = String::from(word);
            } else {
                line = candidate;
            }
        }
        if !line.is_empty() {
            self.put(x, y, width, &line, face, color, Align::Center);
            y += face.size + 12;
        }
        y
    }

    fn dialog_panel(&mut self, height: u32) -> (u32, u32) {
        let pal = self.pal;
        let y = BODY_Y + (RULE_BOTTOM - BODY_Y - height) / 2;
        self.fill(DIALOG_X, y, DIALOG_WIDTH, height, pal.panel, DIALOG_RADIUS);
        (DIALOG_X + DIALOG_PAD, y)
    }

    fn dialog_button(&mut self, id: u32, y: u32, label: &str) {
        let pal = self.pal;
        let x = DIALOG_X + (DIALOG_WIDTH - BUTTON_WIDTH) / 2;
        self.item(id, x, y, BUTTON_WIDTH, DIALOG_BUTTON, 0, BUTTON_RADIUS);
        self.fill(x, y, BUTTON_WIDTH, DIALOG_BUTTON, pal.ground, BUTTON_RADIUS);
        self.put(x, y + 20, BUTTON_WIDTH, label, BUTTON, pal.ink, Align::Center);
    }

    /// A centred panel: a title, what happened, what to do, and one default button.
    fn dialog(
        &mut self,
        model: &Model,
        title: &str,
        happened: &str,
        next: Option<&str>,
        button: Option<(u32, &str)>,
        keys: Keys,
    ) {
        self.frame(
            model,
            &Chrome {
                title: host_name(model).unwrap_or("Moonlight"),
                keys,
                flags: if button.is_some() { 0 } else { page::FLAG_HIDE_CURSOR },
                ..Chrome::default()
            },
        );
        let pal = self.pal;
        let height = if button.is_some() { DIALOG_HEIGHT } else { DIALOG_HEIGHT - DIALOG_BUTTON - 24 };
        let (x, y) = self.dialog_panel(height);
        let inner = DIALOG_WIDTH - 2 * DIALOG_PAD;
        self.put(x, y + 44, inner, title, NAME, pal.ink, Align::Center);
        let mut at = y + 124;
        at = self.wrapped(x, at, inner, happened, BODY, pal.ink);
        if let Some(next) = next.filter(|next| !next.is_empty()) {
            self.wrapped(x, at + 8, inner, next, BODY, pal.dim);
        }
        if let Some((id, label)) = button {
            self.dialog_button(id, y + height - DIALOG_BUTTON - 40, label);
        }
    }

    fn status(&mut self, model: &Model, title: &str, line: Option<&str>, keys: Keys, cancel: bool) {
        let button = cancel.then_some((item::CANCEL, "Cancel"));
        self.dialog(model, title, line.unwrap_or(""), None, button, keys);
    }

    fn hosts_page(&mut self, model: &Model) {
        let keys: Keys = &[("Y", "Options"), ("X", "Settings"), ("A", "Open")];
        let hosts = model.hosts();
        let count = hosts.len() as u32;
        let pages = page_count(count, HOSTS_PER_PAGE);
        let start = model.host_page() * HOSTS_PER_PAGE;
        let shown = shown_count(count, start, HOSTS_PER_PAGE);
        let left = match model.message() {
            Some(message) => String::from(message),
            None if count == 0 => String::from("Add a PC by its address, or find PCs on this network"),
            None => format!("{count} {}", if count == 1 { "PC" } else { "PCs" }),
        };
        self.frame(
            model,
            &Chrome {
                title: "Moonlight",
                left: &left,
                keys,
                cursor_home: home_slot(model.host_index(), start, shown),
                ..Chrome::default()
            },
        );

        for i in 0..shown {
            let host = &hosts[(start + i) as usize];
            let (x, y) = pc_slot(i);
            self.pc_card(model, host, item::HOST + start + i, x, y);
        }

        let (x, y) = pc_slot(shown);
        self.dashed_card(item::ADD_HOST, x, y, "+  Add a PC");
        let (x, y) = pc_slot(shown + 1);
        self.dashed_card(item::FIND_HOSTS, x, y, "Find PCs");
        if pages > 1 {
            self.pager(PAGER_Y, model.host_page(), pages);
        }
        if let Some(resume) = model.resume() {
            self.resume_bar(model, resume.app.as_str(), resume.address);
        }
    }

    fn pc_card(&mut self, model: &Model, host: &Host, id: u32, x: u32, y: u32) {
        let pal = self.pal;
        let inner = PC_CARD_WIDTH - 2 * PC_CARD_PAD;
        let left = x + PC_CARD_PAD;
        self.item(id, x, y, PC_CARD_WIDTH, PC_CARD_HEIGHT, 0, PANEL_RADIUS);
        self.fill(x, y, PC_CARD_WIDTH, PC_CARD_HEIGHT, pal.panel, PANEL_RADIUS);
        self.put(left, y + 24, inner, host.name.as_str(), NAME, pal.ink, Align::Left);

        let presence = model.presence(&host.address);
        let asleep = model.is_asleep(host);
        let (dot, mut state) = match presence {
            Presence::Online => (pal.ok, String::from("Online")),
            Presence::Waking => (pal.warn, String::from("Waking\u{2026}")),
            Presence::Offline if asleep => (pal.dim, String::from("Asleep")),
            Presence::Offline => (pal.dim, String::from("Offline")),
            Presence::Unknown => (pal.dim, String::from("Checking\u{2026}")),
        };
        if presence == Presence::Online {
            if let Some(ms) = model.link_ms(&host.address) {
                join(&mut state, Some(&format!("{ms} ms")));
            }
        }
        self.put(left, y + 92, DOT + 8, "\u{25cf}", BODY, dot, Align::Left);
        self.put(left + DOT + 15, y + 92, inner - DOT - 15, &state, BODY, pal.ink, Align::Left);

        let detail = if asleep {
            String::from("Press A to wake")
        } else {
            match model.last_played(&host.address) {
                Some(app) => format!("Last played: {app}"),
                None => String::from(host.address.as_str()),
            }
        };
        self.fill(left, y + 150, inner, 2, pal.line, 0);
        self.put(left, y + 168, inner, &detail, HINT, pal.dim, Align::Left);
    }

    fn dashed_card(&mut self, id: u32, x: u32, y: u32, label: &str) {
        let pal = self.pal;
        self.item(id, x, y, PC_CARD_WIDTH, PC_CARD_HEIGHT, 0, PANEL_RADIUS);
        self.shape(Shape {
            x,
            y,
            w: PC_CARD_WIDTH,
            h: PC_CARD_HEIGHT,
            radius: PANEL_RADIUS,
            stroke: pal.line,
            stroke_width: 3,
            dashed: true,
            ..Shape::default()
        });
        self.put(x, y + PC_CARD_HEIGHT / 2 - 20, PC_CARD_WIDTH, label, BODY, pal.dim, Align::Center);
    }

    fn resume_bar(&mut self, model: &Model, app: &str, address: Address) {
        let pal = self.pal;
        let name = model
            .hosts()
            .iter()
            .find(|host| host.address == address)
            .map_or("the PC", |host| host.name.as_str());
        let y = RESUME_Y;
        self.item(item::RESUME_HOST, SIDE, y, CONTENT_WIDTH, RESUME_HEIGHT, 0, PANEL_RADIUS);
        self.fill(SIDE, y, CONTENT_WIDTH, RESUME_HEIGHT, pal.panel, PANEL_RADIUS);
        let left = SIDE + RESUME_PAD;
        self.put(left, y + 20, DOT + 8, "\u{25cf}", BODY, pal.warn, Align::Left);
        let text_x = left + DOT + 30;
        let app_width = self.text_width(app, BODY_BOLD).min(RESUME_APP_MAX);
        self.put(text_x, y + 20, app_width, app, BODY_BOLD, pal.ink, Align::Left);
        let at = text_x + app_width + 10;
        let room = (RIGHT - RESUME_PAD - 300).saturating_sub(at);
        self.put(at, y + 20, room, &format!("is still running on {name}"), BODY, pal.ink, Align::Left);

        let label = "Resume";
        let width = self.text_width(label, BODY) + 2;
        let label_x = RIGHT - RESUME_PAD - width;
        self.put(label_x, y + 20, width, label, BODY, pal.ink, Align::Left);
        let pill_x = label_x - 12 - PLUS_PILL.0;
        self.fill(pill_x, y + (RESUME_HEIGHT - PLUS_PILL.1) / 2, PLUS_PILL.0, PLUS_PILL.1, pal.ink, PLUS_PILL.1 / 2);
        self.put(pill_x, y + 20, PLUS_PILL.0, "+", BODY_BOLD, pal.ground, Align::Center);
    }

    fn add_host_page(&mut self, model: &Model) {
        let keys: Keys = &[("Y", "Erase"), ("B", "Cancel"), ("A", "Type")];
        self.frame(
            model,
            &Chrome {
                title: "Add a PC",
                keys,
                ..Chrome::default()
            },
        );
        let pal = self.pal;
        let entry = model.entry();
        let (title, color) = if entry.is_empty() {
            ("_", pal.dim)
        } else {
            (entry, pal.ink)
        };
        self.put(SIDE, BODY_Y + 20, CONTENT_WIDTH, title, PIN, color, Align::Left);
        self.put(
            SIDE,
            BODY_Y + 130,
            CONTENT_WIDTH,
            "The IP address of the PC running Sunshine, such as 192.168.1.20",
            BODY,
            pal.dim,
            Align::Left,
        );

        for (i, label) in (0u32..).zip(KEY_LABELS) {
            let x = SIDE + (i % 3) * (KEYPAD_WIDTH + KEYPAD_GAP);
            let y = KEYPAD_Y + (i / 3) * (CARD_HEIGHT + KEYPAD_GAP);
            let id = if i < 11 { item::KEY + i } else { item::ERASE };
            self.button(id, x, y, KEYPAD_WIDTH, label, false);
        }
        let actions_x = SIDE + 3 * (KEYPAD_WIDTH + KEYPAD_GAP) + BUTTON_GAP;
        self.button(item::CONNECT, actions_x, KEYPAD_Y, BUTTON_WIDTH, "Connect", !is_address(entry));
        self.button(
            item::CANCEL,
            actions_x,
            KEYPAD_Y + CARD_HEIGHT + KEYPAD_GAP,
            BUTTON_WIDTH,
            "Cancel",
            false,
        );
    }

    fn host_menu_page(&mut self, model: &Model) {
        let keys: Keys = &[("B", "Back"), ("A", "Choose")];
        self.frame(
            model,
            &Chrome {
                title: host_name(model).unwrap_or("PC"),
                left: "Forget removes this PC and its helper key; unpair is for Sunshine",
                keys,
                cursor_home: 4,
                ..Chrome::default()
            },
        );
        let width = 300;
        let wakeable = model.host().is_some_and(|host| host.mac.is_some());
        let choices = [
            (item::WAKE_HOST, "Wake PC", !wakeable),
            (item::UNPAIR, "Unpair", false),
            (item::REMOVE_HOST, "Forget this PC", false),
            (item::RENAME_HOST, "Rename PC", false),
            (item::CANCEL, "Cancel", false),
        ];
        for (i, (id, label, greyed)) in (0u32..).zip(choices) {
            let x = SIDE + i * (width + BUTTON_GAP);
            self.button(id, x, BODY_Y + 100, width, label, greyed);
        }
    }

    fn rename_host_page(&mut self, model: &Model) {
        self.frame(
            model,
            &Chrome {
                title: "Rename PC",
                left: "X changes the keys",
                keys: &[("Y", "Erase"), ("X", "Keys"), ("B", "Cancel"), ("A", "Type")],
                ..Chrome::default()
            },
        );
        let pal = self.pal;
        let name = model.rename_entry();
        let (title, color) = if name.is_empty() {
            ("_", pal.dim)
        } else {
            (name, pal.ink)
        };
        self.put(SIDE, BODY_Y + 20, CONTENT_WIDTH, title, HEADLINE, color, Align::Left);
        let keys = model.name_keys();
        for (i, key) in keys.iter().enumerate() {
            let mut label = [0u8; 1];
            label[0] = *key;
            let text = if *key == b' ' {
                "Space"
            } else {
                core::str::from_utf8(&label).unwrap_or("")
            };
            let x = SIDE + (i as u32 % 7) * 144;
            let y = KEYPAD_Y + (i as u32 / 7) * 112;
            self.button(item::KEY + i as u32, x, y, 132, text, false);
        }
        let x = SIDE + 7 * 144 + 48;
        self.button(item::KEY_PAGE, x, KEYPAD_Y, 300, "Change keys", false);
        self.button(item::ERASE, x, KEYPAD_Y + 112, 300, "Erase", false);
        self.button(item::SAVE_NAME, x, KEYPAD_Y + 224, 300, "Save", name.trim().is_empty());
        self.button(item::CANCEL, x, KEYPAD_Y + 336, 300, "Cancel", false);
    }

    fn apps_page(&mut self, model: &Model) {
        let keys: Keys = &[("+", "Stream options"), ("X", "Settings"), ("B", "PCs"), ("A", "Launch")];
        let quit: Keys = &[("Y", "Quit host app")];
        let apps = model.apps();
        let count = apps.len() as u32;
        let pages = page_count(count, APPS_PER_PAGE);
        let start = model.app_page() * APPS_PER_PAGE;
        let shown = shown_count(count, start, APPS_PER_PAGE);

        let mut left = String::new();
        join(&mut left, model.message());
        join(&mut left, Some(&format!("{count} {}", if count == 1 { "app" } else { "apps" })));
        if pages > 1 {
            join(&mut left, Some(&format!("page {} of {pages}", model.app_page() + 1)));
        }
        self.frame(
            model,
            &Chrome {
                title: host_name(model).unwrap_or("Moonlight"),
                left: &left,
                keys,
                cursor_home: home_slot(model.app_index(), start, shown),
                ..Chrome::default()
            },
        );
        let pal = self.pal;
        let current = model.current_game();
        let running = (0..shown).find(|&i| current != 0 && apps[(start + i) as usize].id == current);
        if let Some(i) = running {
            let head = self.legend_right(RIGHT, FOOT_Y, keys, pal.ink, 0);
            self.legend_right(head.saturating_sub(48), FOOT_Y, quit, pal.ink, item::APP + start + i);
        }

        let focused = model.app_index().checked_sub(start).filter(|&i| i < shown);
        let others = shown.saturating_sub(1).max(1);
        let room = CONTENT_WIDTH - FOCUS_COVER.0 - others * SHELF_GAP;
        let small_w = (room / others).min(SHELF_COVER_MAX);
        let shelf_cover = (small_w, small_w * 3 / 2);
        let mut x = SIDE;
        for i in 0..shown {
            let app = &apps[(start + i) as usize];
            let is_focus = Some(i) == focused;
            let (w, h) = if is_focus { FOCUS_COVER } else { shelf_cover };
            let y = SHELF_BOTTOM - h;
            let is_current = app.id == current;
            self.item(item::APP + start + i, x, y, w, h, page::ITEM_REPORTS_FOCUS, COVER_RADIUS);
            match self.cover_tile(app.id, app.name.as_str()) {
                Some(serial) => self.image(x, y, serial, (w, h), COVER_RADIUS),
                None => self.error = Some(Error::Cover),
            }
            if is_current && !is_focus {
                self.fill(x, y + h + 8, w, 4, pal.ok, 2);
            }
            x += w + SHELF_GAP;
        }

        if let Some(app) = focused.map(|i| &apps[(start + i) as usize]) {
            let color = if app.id == current { pal.ok } else { pal.ink };
            let name_y = SHELF_BOTTOM + NAME_GAP;
            self.put(SIDE, name_y, CONTENT_WIDTH, app.name.as_str(), APP_NAME, color, Align::Left);
            if app.id == current {
                let name_width = self.text_width(app.name.as_str(), APP_NAME).min(CONTENT_WIDTH - 160);
                let pill_x = SIDE + name_width + 24;
                self.fill(pill_x, name_y + 16, 112, 32, pal.ok, 16);
                self.put(pill_x, name_y + 20, 112, "Running", Face::new(22, 600), pal.ground, Align::Center);
            }
            self.stream_chips(model, SIDE, name_y + CHIPS_GAP);
        }

        let buttons_y = RULE_BOTTOM - 24 - PAGER_HEIGHT;
        let back_x = if pages > 1 { RIGHT - 2 * PAGER_WIDTH - BUTTON_GAP - BACK_WIDTH - BUTTON_GAP } else { RIGHT - BACK_WIDTH };
        self.sized_button(item::BACK, (back_x, buttons_y, BACK_WIDTH, PAGER_HEIGHT), "\u{2039}  PCs", false);
        if pages > 1 {
            self.pager(buttons_y, model.app_page(), pages);
        }
    }

    fn stream_chips(&mut self, model: &Model, x: u32, y: u32) {
        let pal = self.pal;
        let plan = model.planned_stream();
        let mbps = plan.bitrate_kbps as f32 / 1000.0;
        let bitrate = if plan.bitrate_auto {
            format!("{mbps:.0} Mbps auto")
        } else {
            format!("{mbps:.0} Mbps")
        };
        let chips = [
            (format!("{}p", plan.height), true),
            (format!("{} fps", plan.fps), true),
            (String::from(plan.codec.text()), true),
            (bitrate, !plan.bitrate_auto),
        ];
        let mut at = x;
        for (chip, set) in &chips {
            let width = self.text_width(chip, HINT) + 2 * CHIP_PAD;
            let (stroke, ink) = if *set { (pal.accent, pal.accent) } else { (pal.line, pal.dim) };
            self.shape(Shape {
                x: at,
                y,
                w: width,
                h: CHIP_HEIGHT,
                radius: CHIP_HEIGHT / 2,
                stroke,
                stroke_width: 2,
                ..Shape::default()
            });
            self.put(at + CHIP_PAD, y + 5, width, chip, HINT, ink, Align::Left);
            at += width + 17;
        }
    }

    fn pairing_page(&mut self, model: &Model) {
        self.frame(
            model,
            &Chrome {
                title: host_name(model).unwrap_or("Moonlight"),
                keys: &[("B", "Cancel")],
                flags: page::FLAG_HIDE_CURSOR,
                ..Chrome::default()
            },
        );
        let pal = self.pal;
        let (x, y) = self.dialog_panel(PAIRING_HEIGHT);
        let inner = DIALOG_WIDTH - 2 * DIALOG_PAD;
        let host = host_name(model).unwrap_or("the PC");
        self.put(x, y + 44, inner, &format!("Pair with {host}"), NAME, pal.ink, Align::Center);
        let Some(pin) = model.pin().filter(|p| !p.is_empty()) else {
            self.wrapped(x, y + 140, inner, "Waiting for the PC to show a PIN.", BODY, pal.ink);
            return;
        };
        let steps = format!("On {host}, open Sunshine's PIN page and enter this code.");
        self.wrapped(x, y + 124, inner, &steps, BODY, pal.ink);
        self.put(x, y + 190, inner, pin, PIN, pal.accent, Align::Center);
        if let Some(left) = model.pin_left_s() {
            let total = model.pin_timeout_s().max(1);
            let bar = inner - 2 * 120;
            let bar_x = x + 120;
            let bar_y = y + 330;
            self.fill(bar_x, bar_y, bar, 12, pal.line, 6);
            let filled = (bar * left.min(total) / total).max(12);
            self.fill(bar_x, bar_y, filled, 12, pal.accent, 6);
            let countdown = format!("{}:{:02} left", left / 60, left % 60);
            self.put(x, bar_y + 28, inner, &countdown, HINT, pal.dim, Align::Center);
        }
        if let Some(url) = model.url().filter(|u| !u.is_empty()) {
            let page = format!("{}/pin", url.trim_end_matches('/'));
            self.put(x, y + PAIRING_HEIGHT - 64, inner, &page, HINT, pal.dim, Align::Center);
        }
    }

    /// Pairing with the PC helper: the code this console made, to be typed on the PC.
    fn helper_pairing_page(&mut self, model: &Model, code: &str) {
        self.frame(
            model,
            &Chrome {
                title: host_name(model).unwrap_or("Moonlight"),
                keys: &[("B", "Cancel")],
                flags: page::FLAG_HIDE_CURSOR,
                ..Chrome::default()
            },
        );
        let pal = self.pal;
        let (x, y) = self.dialog_panel(PAIRING_HEIGHT);
        let inner = DIALOG_WIDTH - 2 * DIALOG_PAD;
        let host = host_name(model).unwrap_or("the PC");
        self.put(x, y + 44, inner, &format!("Pair with {host}"), NAME, pal.ink, Align::Center);
        let steps = format!("On {host}, type this code into the Moonlight helper.");
        self.wrapped(x, y + 124, inner, &steps, BODY, pal.ink);
        let (first, second) = code.split_at(code.len() / 2);
        self.put(x, y + 190, inner, &format!("{first} {second}"), PIN, pal.accent, Align::Center);
        if let Some(left) = model.helper_left_s() {
            let countdown = format!("{}:{:02} left", left / 60, left % 60);
            self.put(x, y + 358, inner, &countdown, HINT, pal.dim, Align::Center);
        }
        let command = format!("moonlight-nx2-pc pair {code}");
        self.put(x, y + PAIRING_HEIGHT - 64, inner, &command, HINT, pal.dim, Align::Center);
    }

    fn category_list(&mut self, model: &Model) {
        let pal = self.pal;
        let names = ["Picture", "Sound", "Controls", "Network", "This console"];
        for (i, name) in (0u32..).zip(names) {
            let y = BODY_Y + 16 + i * (CATEGORY_HEIGHT + 12);
            self.item(
                item::CATEGORY + i,
                SIDE,
                y,
                CATEGORY_WIDTH,
                CATEGORY_HEIGHT,
                page::ITEM_REPORTS_FOCUS,
                PANEL_RADIUS,
            );
            let current = i == u32::from(model.category());
            if current {
                self.fill(SIDE, y, CATEGORY_WIDTH, CATEGORY_HEIGHT, pal.accent, CATEGORY_RADIUS);
                self.fill(
                    SIDE + CATEGORY_BAR,
                    y,
                    CATEGORY_WIDTH - CATEGORY_BAR,
                    CATEGORY_HEIGHT,
                    pal.panel,
                    CATEGORY_RADIUS,
                );
            }
            let (face, ink) = if current { (BUTTON, pal.accent) } else { (OPTION, pal.dim) };
            self.put(SIDE + 28, y + 20, CATEGORY_WIDTH - 56, name, face, ink, Align::Left);
        }
    }

    fn setting_row(&mut self, model: &Model, row: &SettingRow, slot: u32, own: Option<bool>) {
        let pal = self.pal;
        let editing = model.editing() == Some(row.setting);
        let (x, pane) = if own.is_some() { (SIDE, CONTENT_WIDTH) } else { (PANE_X, PANE_WIDTH) };
        let y = BODY_Y + 16 + slot * (ROW_HEIGHT + ROW_GAP);
        let mut flags = 0;
        if row.adjustable {
            flags |= page::ITEM_ADJUSTABLE;
        }
        if row.adjustable && editing {
            flags |= page::ITEM_EDITING;
        }
        if row.greyed {
            flags |= page::ITEM_GREYED;
        }
        self.item(item::SETTING + row.setting as u32, x, y, pane, ROW_HEIGHT, flags, PANEL_RADIUS);
        self.fill(x + ROW_PAD, y + ROW_HEIGHT, pane - 2 * ROW_PAD, 2, pal.line, 0);
        let ink = if row.greyed { pal.faint } else { pal.ink };
        let inherited = own == Some(false);
        let value_ink = if row.greyed {
            pal.faint
        } else if inherited {
            pal.dim
        } else {
            pal.accent
        };
        self.put(x + ROW_PAD, y + 14, 520, row.setting.label(), OPTION, ink, Align::Left);
        let hint_width = pane - 2 * ROW_PAD - VALUE_WIDTH;
        let hint = match own {
            Some(true) => "Set for this app",
            Some(false) => "Same as Settings",
            None if row.setting == Setting::Size && model.settings().size_auto() => {
                "Picked from the network test and the dock"
            }
            None => row.setting.hint(),
        };
        self.put(x + ROW_PAD, y + 54, hint_width, hint, HINT, pal.dim, Align::Left);

        let value_x = x + pane - ROW_PAD - VALUE_WIDTH;
        let value_y = y + 22;
        if let Some(reason) = locked_reason(row) {
            self.put(value_x, y + 12, VALUE_WIDTH, row.value.as_str(), VALUE, pal.dim, Align::Right);
            self.put(value_x, y + 58, VALUE_WIDTH, reason, HINT, pal.dim, Align::Right);
        } else if !row.adjustable {
            self.put(value_x, value_y, VALUE_WIDTH, row.value.as_str(), VALUE, value_ink, Align::Right);
        } else {
            self.stepper(
                value_x,
                value_y,
                row.value.as_str(),
                VALUE,
                VALUE_WIDTH,
                value_ink,
                editing && row.can_left,
                editing && row.can_right,
            );
        }
    }

    fn export_row(&mut self, slot: u32) {
        let pal = self.pal;
        let y = BODY_Y + 16 + slot * (ROW_HEIGHT + ROW_GAP);
        self.item(item::EXPORT_LOGS, PANE_X, y, PANE_WIDTH, ROW_HEIGHT, 0, PANEL_RADIUS);
        self.fill(PANE_X + ROW_PAD, y + ROW_HEIGHT, PANE_WIDTH - 2 * ROW_PAD, 2, pal.line, 0);
        self.put(PANE_X + ROW_PAD, y + 14, 520, "Export log", OPTION, pal.ink, Align::Left);
        let hint = "Copy the newest log to the logs folder on the SD card";
        self.put(PANE_X + ROW_PAD, y + 54, PANE_WIDTH - 2 * ROW_PAD - VALUE_WIDTH, hint, HINT, pal.dim, Align::Left);
        let value_x = PANE_X + PANE_WIDTH - ROW_PAD - VALUE_WIDTH;
        self.put(value_x - 38, y + 22, VALUE_WIDTH, "Copy", VALUE, pal.accent, Align::Right);
    }

    /// A choice this console cannot make now: greyed, with the reason at the right.
    fn unavailable_row(&mut self, label: &str, reason: &str, y: u32) {
        let pal = self.pal;
        self.fill(PANE_X, y, PANE_WIDTH, LOCKED_ROW_HEIGHT, pal.ground, PANEL_RADIUS);
        self.outline_row(y);
        self.put(PANE_X + ROW_PAD, y + 12, 520, label, BODY, pal.dim, Align::Left);
        let width = VALUE_WIDTH;
        self.put(PANE_X + PANE_WIDTH - ROW_PAD - width, y + 12, width, reason, BODY, pal.dim, Align::Right);
    }

    fn outline_row(&mut self, y: u32) {
        let pal = self.pal;
        self.shape(Shape {
            x: PANE_X,
            y,
            w: PANE_WIDTH,
            h: LOCKED_ROW_HEIGHT,
            radius: PANEL_RADIUS,
            stroke: pal.line,
            stroke_width: 2,
            ..Shape::default()
        });
    }

    fn settings_page(&mut self, model: &Model, settings_error: Option<&str>) {
        let editing_keys: Keys = &[("\u{25c2}\u{25b8}", "Change"), ("B", "Done"), ("A", "Done")];
        let browsing_keys: Keys = &[
            ("Y", "Reset"),
            ("X", "Test network"),
            ("B", "Back"),
            ("A", "Change"),
        ];
        let rows = model.settings().rows(model.docked(), model.capabilities());
        let editing = model.editing().is_some_and(|s| rows[s as usize].adjustable);
        let left = match settings_error.filter(|e| !e.is_empty()) {
            Some(error) => format!("Settings could not be saved: {error}"),
            None if !model.link_note().is_empty() => String::from(model.link_note()),
            None => String::from("Changes apply to the next stream"),
        };
        let shown: Vec<&SettingRow> = rows
            .iter()
            .filter(|row| row.setting.category() == model.category())
            .collect();
        self.frame(
            model,
            &Chrome {
                title: "Settings",
                left: &left,
                keys: if editing { editing_keys } else { browsing_keys },
                cursor_home: u32::from(CATEGORIES),
                ..Chrome::default()
            },
        );
        self.category_list(model);
        let mut count = 0;
        for (slot, row) in (0u32..).zip(shown) {
            self.setting_row(model, row, slot, None);
            count = slot + 1;
        }
        if model.category() == CONSOLE_CATEGORY {
            self.export_row(count);
        }
        if model.category() == 0 && !(model.docked() && model.capabilities().docked_sizes) {
            let mut y = BODY_Y + 16 + count * (ROW_HEIGHT + ROW_GAP) + 14;
            for size in ["1440p", "4K"] {
                self.unavailable_row(size, "Docked only", y);
                y += LOCKED_ROW_HEIGHT + ROW_GAP;
            }
        }
    }

    fn app_options_page(&mut self, model: &Model) {
        let editing_keys: Keys = &[("\u{25c2}\u{25b8}", "Change"), ("B", "Done"), ("A", "Done")];
        let browsing_keys: Keys = &[("Y", "Reset"), ("X", "Settings"), ("B", "Back"), ("A", "Change")];
        let stream = model.stream_settings();
        let rows = stream.rows(model.docked(), model.capabilities());
        let editing = model.editing().is_some_and(|s| rows[s as usize].adjustable);
        let app = model
            .apps()
            .get(model.app_index() as usize)
            .map_or("this app", |app| app.name.as_str());
        let left = format!("These choices apply to {app} only");
        self.frame(
            model,
            &Chrome {
                title: "Stream options",
                left: &left,
                keys: if editing { editing_keys } else { browsing_keys },
                ..Chrome::default()
            },
        );
        for (slot, setting) in (0u32..).zip(OVERRIDABLE) {
            let own = stream.index(setting) != model.settings().index(setting);
            self.setting_row(model, &rows[setting as usize], slot, Some(own));
        }
    }

    fn quit_confirm_page(&mut self, model: &Model) {
        self.frame(
            model,
            &Chrome {
                title: host_name(model).unwrap_or("Moonlight"),
                keys: &[("B", "Back"), ("A", "Choose")],
                cursor_home: 1,
                ..Chrome::default()
            },
        );
        let current = model.current_game();
        let running = model
            .apps()
            .iter()
            .find(|a| a.id == current)
            .map_or("the running app", |a| a.name.as_str());
        let title = format!("Quit {running}?");
        let pal = self.pal;
        let (x, y) = self.dialog_panel(DIALOG_HEIGHT);
        let inner = DIALOG_WIDTH - 2 * DIALOG_PAD;
        self.put(x, y + 44, inner, &title, NAME, pal.ink, Align::Center);
        self.wrapped(x, y + 124, inner, "The stream ends and the app closes on the PC.", BODY, pal.ink);
        let button_y = y + DIALOG_HEIGHT - DIALOG_BUTTON - 40;
        let width = (inner - BUTTON_GAP) / 2;
        for (i, (id, label)) in [(item::CONFIRM_QUIT, "Quit"), (item::CANCEL, "Cancel")]
            .into_iter()
            .enumerate()
        {
            let bx = x + i as u32 * (width + BUTTON_GAP);
            self.item(id, bx, button_y, width, DIALOG_BUTTON, 0, BUTTON_RADIUS);
            self.fill(bx, button_y, width, DIALOG_BUTTON, pal.ground, BUTTON_RADIUS);
            self.put(bx, button_y + 20, width, label, BUTTON, pal.ink, Align::Center);
        }
    }

    fn overlay_page(&mut self, model: &Model) {
        let pal = self.pal;
        self.background = pal.scrim;
        self.flags = page::FLAG_OVERLAY | page::FLAG_NO_CHORD;
        let x = SCREEN_WIDTH - SHEET_WIDTH;
        let sheet = (pal.ground & 0x00ff_ffff) | SHEET_ALPHA;
        self.fill(x, 0, SHEET_WIDTH, SCREEN_HEIGHT, sheet, 0);
        let inner = SHEET_WIDTH - 2 * SHEET_PAD;
        let left = x + SHEET_PAD;

        let title = model.app().map_or("Moonlight", |a| a.name.as_str());
        self.put(left, SHEET_TOP, inner, title, NAME, pal.ink, Align::Left);
        let minutes = model.stream().session_s / 60;
        let session = match minutes {
            0 => String::from("less than a minute"),
            minutes => format!("{minutes} min"),
        };
        let subtitle = format!("{} \u{b7} {session}", host_name(model).unwrap_or(""));
        self.put(left, SHEET_TOP + 62, inner, &subtitle, BODY, pal.dim, Align::Left);

        let stream = model.stream();
        let readout = model.readout();
        let tenths = |value: u32| format!("{}.{}", value / 10, value % 10);
        let cells = [
            ("Frame rate", stream.fps_x10.map(tenths)),
            (
                "Bitrate",
                stream.bitrate_kbps.map(|kbps| format!("{} Mbps", tenths(kbps / 100))),
            ),
            ("Decode", stream.decode_us.map(|us| format!("{} ms", tenths(us / 100)))),
            ("Network", stream.network_us.map(|us| format!("{} ms", tenths(us / 100)))),
            ("Battery", readout.battery_percent.map(|percent| format!("{percent} %"))),
            (
                "Wi-Fi",
                match readout.network {
                    Some(Network::Wifi(bars)) => Some(format!("{}/3", bars.min(3))),
                    Some(Network::Wired) => Some(String::from("Wired")),
                    None => None,
                },
            ),
        ];
        let cell_width = inner / 2;
        for (i, (label, value)) in cells.iter().enumerate() {
            let cx = left + (i as u32 % 2) * cell_width;
            let cy = SHEET_GRID_Y + (i as u32 / 2) * SHEET_CELL;
            self.put(cx, cy, cell_width, label, HINT, pal.dim, Align::Left);
            let at = cx + self.text_width(label, HINT) + 12;
            let text = value.as_deref().unwrap_or("--");
            self.put(at, cy, cell_width.saturating_sub(at - cx), text, HINT, pal.ink, Align::Left);
        }

        let items = [
            (item::RESUME_STREAM, "Resume", None, pal.ink),
            (
                item::TOGGLE_STATS,
                "Show stats on screen",
                Some(model.stats().label()),
                pal.ink,
            ),
            (item::RETURN_TO_APPS, "Disconnect", None, pal.ink),
            (item::QUIT_HOST, "Quit app on PC", None, pal.warn),
        ];
        for (i, (id, label, value, ink)) in items.into_iter().enumerate() {
            let y = SHEET_ITEMS_Y + i as u32 * (SHEET_ITEM + SHEET_ITEM_GAP);
            self.item(id, left, y, inner, SHEET_ITEM, 0, SHEET_ITEM_RADIUS);
            self.fill(left, y, inner, SHEET_ITEM, pal.panel, SHEET_ITEM_RADIUS);
            self.put(left + 27, y + 20, inner - 54, label, OPTION, ink, Align::Left);
            if let Some(value) = value {
                self.put(left + 27, y + 20, inner - 54, value, OPTION, pal.dim, Align::Right);
            }
        }
        self.legend_right(SCREEN_WIDTH - SHEET_PAD, SHEET_FOOT_Y, &[("B", "Close"), ("A", "Choose")], pal.dim, 0);
        if model.settings().on(Setting::MenuChord) {
            self.put(left, SHEET_FOOT_Y - 48, inner, "Hold + and \u{2212} to open this menu", HINT, pal.dim, Align::Left);
        }

        let plan = model.planned_stream();
        let badge = format!(
            "{}p{} \u{b7} {} \u{b7} {:.0} Mbps",
            plan.height,
            plan.fps,
            plan.codec.text(),
            plan.bitrate_kbps as f32 / 1000.0
        );
        let width = self.text_width(&badge, HINT) + BADGE_PAD * 2 + DOT + 19;
        let badge_color = (pal.ground & 0x00ff_ffff) | BADGE_ALPHA;
        self.fill(BADGE_X, BADGE_Y, width, BADGE_HEIGHT, badge_color, BADGE_HEIGHT / 2);
        self.dot(BADGE_X + BADGE_PAD, BADGE_Y + (BADGE_HEIGHT - DOT) / 2, DOT, pal.ok);
        self.put(BADGE_X + BADGE_PAD + DOT + 19, BADGE_Y + 10, width, &badge, HINT, pal.ink, Align::Left);
    }

    fn error_page(&mut self, model: &Model) {
        let lost = model.screen() == Screen::ConnectionLost;
        let can_reconnect = lost && model.host().is_some();
        let keys: Keys = if can_reconnect {
            &[("B", "PCs"), ("A", "Reconnect")]
        } else {
            &[("A", "OK")]
        };
        let title = if lost { "Connection lost" } else { "Something went wrong" };
        let happened = model.message().unwrap_or("Something went wrong");
        let label = if can_reconnect { "Reconnect" } else { "OK" };
        self.dialog(
            model,
            title,
            happened,
            Some(error_next_step(model.message(), lost)),
            Some((item::BACK, label)),
            keys,
        );
    }

    pub(crate) fn compose(&mut self, model: &Model, settings_error: Option<&str>) -> bool {
        let cancel: Keys = &[("B", "Cancel")];
        let host = host_name(model).unwrap_or("");
        match model.screen() {
            Screen::Hosts => self.hosts_page(model),
            Screen::AddHost => self.add_host_page(model),
            Screen::HostMenu => self.host_menu_page(model),
            Screen::RenameHost => self.rename_host_page(model),
            Screen::Unpairing => {
                self.status(model, "Unpairing", Some("Asking the PC to forget this console\u{2026}"), &[], false);
            }
            Screen::Connecting if model.helper_code().is_some() => {
                self.helper_pairing_page(model, model.helper_code().unwrap_or(""));
            }
            Screen::Connecting => {
                let wait = format!("Reaching {host} at {}", model.host().map_or("", |h| h.address.as_str()));
                let line = model.message().unwrap_or(&wait);
                self.status(model, "Connecting", Some(line), cancel, true);
            }
            Screen::Pairing => self.pairing_page(model),
            Screen::Apps => self.apps_page(model),
            Screen::QuitConfirm => self.quit_confirm_page(model),
            Screen::Settings => self.settings_page(model, settings_error),
            Screen::AppOptions => self.app_options_page(model),
            Screen::Launching => {
                let title = model.app().map_or("", |a| a.name.as_str());
                let line = model.message().unwrap_or("Starting the stream\u{2026}");
                self.status(model, title, Some(line), cancel, true);
            }
            Screen::Streaming => self.overlay_page(model),
            Screen::Quitting => {
                self.status(model, host, Some("Closing the app on the PC\u{2026}"), &[], false);
            }
            Screen::ConnectionLost | Screen::Error => self.error_page(model),
            Screen::Splash | Screen::Stopped => return false,
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::error_next_step;

    #[test]
    fn errors_offer_an_actionable_next_step() {
        assert!(error_next_step(Some("Pairing failed"), false).contains("pair"));
        let lost = error_next_step(Some("Cannot reach PC"), true);
        assert!(lost.contains("Wake") && lost.contains("Wi-Fi") && lost.contains("Sunshine"));
        assert!(error_next_step(None, false).contains("go back"));
    }
}
