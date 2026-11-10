//! One layout per model screen, drawn over the console's own frame: icon and title, a thin rule,
//! the content, a thin rule and the button hints, right-aligned in the system's order.

use alloc::format;
use alloc::string::String;

use crate::composer::{
    Builder, CONTENT_WIDTH, Error, Face, Keys, SCREEN_WIDTH, SIDE,
    home_slot, page_count, shown_count,
};
use crate::glyphs::Align;
use crate::model::{APPS_PER_PAGE, Address, HOSTS_PER_PAGE, Host, Model, Screen, is_address, item};
use crate::presence::Presence;
use crate::page::{self, Shape};
use crate::readout::{Network, Readout};
use crate::settings::{Setting, SettingRow};

const TITLE: Face = Face::new(40, 500);
const STATUS: Face = Face::new(28, 500);
const NAME: Face = Face::new(40, 700);
const BODY: Face = Face::new(28, 500);
const OPTION: Face = Face::new(32, 600);
const BODY_BOLD: Face = Face::new(28, 700);
const BUTTON: Face = Face::new(32, 700);
const HINT: Face = Face::new(24, 500);
const HEADLINE: Face = Face::new(56, 700);
const PIN: Face = Face::new(72, 700);

const HEAD_Y: u32 = 81;
const LOGO: u32 = 58;
const RULE_TOP: u32 = 173;
const RULE_BOTTOM: u32 = 952;
const FOOT_Y: u32 = 984;
const BODY_Y: u32 = 219;
const RIGHT: u32 = SCREEN_WIDTH - SIDE;
const PANEL_RADIUS: u32 = 18;
const BUTTON_RADIUS: u32 = 14;

const CARD_WIDTH: u32 = 840;
const CARD_HEIGHT: u32 = 96;
const PC_CARD_HEIGHT: u32 = 144;
const RESUME_HEIGHT: u32 = 88;
const DOT: u32 = 20;
const CARD_GAP_X: u32 = 48;
const CARD_GAP_Y: u32 = 16;
const CARD_PAD: u32 = 32;
const KEYPAD_Y: u32 = 430;
const KEYPAD_WIDTH: u32 = 160;
const KEYPAD_GAP: u32 = 24;
const BUTTON_Y: u32 = 640;
const BUTTON_WIDTH: u32 = 400;
const BUTTON_GAP: u32 = 48;
const PAGER_WIDTH: u32 = 300;
const SHELF_Y: u32 = 230;
const SHELF_GAP: u32 = 16;
const FOCUS_COVER: (u32, u32) = (400, 225);
const SHELF_COVER_MAX: u32 = 200;
const FOCUS_MARGIN: u32 = 12;
const COVER_RADIUS: u32 = 12;
const CHIP_HEIGHT: u32 = 48;
const CHIP_PAD: u32 = 22;
const SHEET_WIDTH: u32 = 760;
const SHEET_PAD: u32 = 40;
const SHEET_MARGIN: u32 = 24;
const SCREEN_HEIGHT: u32 = 1080;
const SHEET_RADIUS: u32 = 28;
const SHEET_GRID_Y: u32 = 236;
const SHEET_CELL: u32 = 104;
const SHEET_ITEMS_Y: u32 = 584;
const SHEET_ITEM: u32 = 76;
const SHEET_ITEM_GAP: u32 = 12;

const KEY_LABELS: [&str; 12] = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "Erase",
];

fn error_next_step(message: Option<&str>, lost: bool) -> &'static str {
    let message = message.unwrap_or("");
    if message.contains("Pairing") || message.contains("paired") {
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

fn host_name(model: &Model) -> Option<&str> {
    model.host().map(|h| h.name.as_str())
}

fn card_at(i: u32, top: u32, height: u32, gap_y: u32) -> (u32, u32) {
    (
        SIDE + (i % 2) * (CARD_WIDTH + CARD_GAP_X),
        top + (i / 2) * (height + gap_y),
    )
}

fn status_line(readout: &Readout) -> String {
    let mut line = String::new();
    match readout.network {
        Some(Network::Wifi(bars)) => join(&mut line, Some(&format!("Wi-Fi {}/3", bars.min(3)))),
        Some(Network::Wired) => join(&mut line, Some("Wired")),
        None => {}
    }
    if let Some(percent) = readout.battery_percent {
        join(&mut line, Some(&format!("{percent} %")));
    }
    if let Some((hours, minutes)) = readout.clock {
        join(&mut line, Some(&format!("{hours}:{minutes:02}")));
    }
    line
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
            HEAD_Y + 6,
            1000,
            chrome.title,
            TITLE,
            pal.ink,
            Align::Left,
        );
        let status = status_line(model.readout());
        if !status.is_empty() {
            self.put(RIGHT - 700, HEAD_Y + 14, 700, &status, STATUS, pal.dim, Align::Right);
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
        let pal = self.pal;
        let flags = if greyed { page::ITEM_GREYED } else { 0 };
        self.item(id, x, y, width, CARD_HEIGHT, flags, BUTTON_RADIUS);
        let (fill, ink) = if greyed {
            (pal.ground, pal.line)
        } else {
            (pal.panel, pal.ink)
        };
        self.fill(x, y, width, CARD_HEIGHT, fill, BUTTON_RADIUS);
        self.put(x, y + 28, width, label, BUTTON, ink, Align::Center);
    }

    fn pager(&mut self, y: u32, at: u32, pages: u32) {
        let x = RIGHT - 2 * PAGER_WIDTH - BUTTON_GAP;
        let next_x = x + PAGER_WIDTH + BUTTON_GAP;
        self.button(item::PREVIOUS, x, y, PAGER_WIDTH, "\u{2039}  Previous", at == 0);
        self.button(item::NEXT, next_x, y, PAGER_WIDTH, "Next  \u{203a}", at + 1 >= pages);
    }

    fn message(&mut self, kicker: &str, title: &str, line: Option<&str>, y: u32, color: u32) {
        let pal = self.pal;
        self.put(SIDE, y, CONTENT_WIDTH, kicker, BODY, pal.dim, Align::Left);
        self.put(SIDE, y + 44, CONTENT_WIDTH, title, HEADLINE, color, Align::Left);
        if let Some(line) = line.filter(|l| !l.is_empty()) {
            self.put(SIDE, y + 128, CONTENT_WIDTH, line, BODY, pal.dim, Align::Left);
        }
    }

    fn status(&mut self, model: &Model, title: &str, line: Option<&str>, keys: Keys) {
        self.frame(
            model,
            &Chrome {
                title: host_name(model).unwrap_or("Moonlight"),
                keys,
                flags: page::FLAG_HIDE_CURSOR,
                ..Chrome::default()
            },
        );
        let ink = self.pal.ink;
        self.message("Moonlight", title, line, 340, ink);
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
            let (x, y) = card_at(i, BODY_Y + 24, PC_CARD_HEIGHT, CARD_GAP_Y);
            self.pc_card(model, host, item::HOST + start + i, x, y);
        }

        let buttons_y = BODY_Y + 24 + 3 * (PC_CARD_HEIGHT + CARD_GAP_Y);
        self.add_card(SIDE, buttons_y, PAGER_WIDTH);
        self.button(
            item::FIND_HOSTS,
            SIDE + PAGER_WIDTH + BUTTON_GAP,
            buttons_y,
            PAGER_WIDTH,
            "Find PCs",
            false,
        );
        if pages > 1 {
            self.pager(buttons_y, model.host_page(), pages);
        }
        if let Some(resume) = model.resume() {
            self.resume_bar(model, resume.app.as_str(), resume.address);
        }
    }

    fn pc_card(&mut self, model: &Model, host: &Host, id: u32, x: u32, y: u32) {
        let pal = self.pal;
        let inner = CARD_WIDTH - 2 * CARD_PAD;
        self.item(id, x, y, CARD_WIDTH, PC_CARD_HEIGHT, 0, PANEL_RADIUS);
        self.fill(x, y, CARD_WIDTH, PC_CARD_HEIGHT, pal.panel, PANEL_RADIUS);
        self.put(x + CARD_PAD, y + 10, inner, host.name.as_str(), NAME, pal.ink, Align::Left);

        let presence = model.presence(&host.address);
        let asleep = model.is_asleep(host);
        let (dot, mut state) = match presence {
            Presence::Online => (pal.ok, String::from("Online")),
            Presence::Waking => (pal.warn, String::from("Waking\u{2026}")),
            Presence::Offline if asleep => (pal.warn, String::from("Asleep")),
            Presence::Offline => (pal.line, String::from("Offline")),
            Presence::Unknown => (pal.line, String::from("Checking\u{2026}")),
        };
        if presence == Presence::Online {
            if let Some(ms) = model.link_ms(&host.address) {
                join(&mut state, Some(&format!("{ms} ms")));
            }
        }
        self.dot(x + CARD_PAD, y + 74, DOT, dot);
        self.put(x + CARD_PAD + DOT + 12, y + 62, inner - DOT - 12, &state, BODY, pal.ink, Align::Left);

        let detail = if asleep {
            String::from("Press A to wake")
        } else {
            match model.last_played(&host.address) {
                Some(app) => format!("Last played: {app}"),
                None => String::from(host.address.as_str()),
            }
        };
        self.put(x + CARD_PAD, y + 104, inner, &detail, HINT, pal.dim, Align::Left);
    }

    fn add_card(&mut self, x: u32, y: u32, width: u32) {
        let pal = self.pal;
        self.item(item::ADD_HOST, x, y, width, CARD_HEIGHT, 0, PANEL_RADIUS);
        self.shape(Shape {
            x,
            y,
            w: width,
            h: CARD_HEIGHT,
            radius: PANEL_RADIUS,
            stroke: pal.line,
            stroke_width: 2,
            dashed: true,
            ..Shape::default()
        });
        self.put(x, y + 28, width, "+  Add a PC", BUTTON, pal.ink, Align::Center);
    }

    fn resume_bar(&mut self, model: &Model, app: &str, address: Address) {
        let pal = self.pal;
        let name = model
            .hosts()
            .iter()
            .find(|host| host.address == address)
            .map_or("the PC", |host| host.name.as_str());
        let y = RULE_BOTTOM - 24 - RESUME_HEIGHT;
        self.item(item::RESUME_HOST, SIDE, y, CONTENT_WIDTH, RESUME_HEIGHT, 0, PANEL_RADIUS);
        self.fill(SIDE, y, CONTENT_WIDTH, RESUME_HEIGHT, pal.panel, PANEL_RADIUS);
        self.dot(SIDE + CARD_PAD, y + 34, DOT, pal.ok);
        let text = format!("{app} is still running on {name}");
        self.put(SIDE + CARD_PAD + DOT + 16, y + 24, 1200, &text, BODY_BOLD, pal.ink, Align::Left);
        self.put(RIGHT - CARD_PAD - 300, y + 24, 300, "Resume", BUTTON, pal.accent, Align::Right);
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
                left: "Remove keeps the pairing; unpair makes the PC forget this console",
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
            (item::REMOVE_HOST, "Remove PC", false),
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
        let keys: Keys = &[("X", "Settings"), ("B", "PCs"), ("A", "Launch")];
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
        let room = CONTENT_WIDTH - FOCUS_COVER.0 - 2 * FOCUS_MARGIN - others * SHELF_GAP;
        let small_w = (room / others).min(SHELF_COVER_MAX);
        let shelf_cover = (small_w, small_w * 9 / 16);
        let mut x = SIDE;
        for i in 0..shown {
            let app = &apps[(start + i) as usize];
            let is_focus = Some(i) == focused;
            let (w, h) = if is_focus { FOCUS_COVER } else { shelf_cover };
            let y = SHELF_Y + (FOCUS_COVER.1 - h) / 2;
            if is_focus && i > 0 {
                x += FOCUS_MARGIN;
            }
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
            if is_focus {
                x += FOCUS_MARGIN;
            }
        }

        if let Some(app) = focused.map(|i| &apps[(start + i) as usize]) {
            let color = if app.id == current { pal.ok } else { pal.ink };
            let name_y = SHELF_Y + FOCUS_COVER.1 + 40;
            self.put(SIDE, name_y, CONTENT_WIDTH, app.name.as_str(), NAME, color, Align::Left);
            if app.id == current {
                let name_width = self.text_width(app.name.as_str(), NAME).min(CONTENT_WIDTH - 160);
                let pill_x = SIDE + name_width + 24;
                self.fill(pill_x, name_y + 8, 112, 32, pal.ok, 16);
                self.put(pill_x, name_y + 12, 112, "Running", Face::new(22, 600), pal.ground, Align::Center);
            }
            self.stream_chips(model, SIDE, SHELF_Y + FOCUS_COVER.1 + 112);
        }

        let buttons_y = RULE_BOTTOM - 24 - CARD_HEIGHT;
        self.button(item::BACK, SIDE, buttons_y, PAGER_WIDTH, "\u{2039}  PCs", false);
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
            format!("{}p", plan.height),
            format!("{} fps", plan.fps),
            String::from(plan.codec.text()),
            bitrate,
        ];
        let mut at = x;
        for chip in &chips {
            let width = self.text_width(chip, BODY) + 2 * CHIP_PAD;
            self.fill(at, y, width, CHIP_HEIGHT, pal.panel, CHIP_HEIGHT / 2);
            self.put(at + CHIP_PAD, y + 9, width, chip, BODY, pal.ink, Align::Left);
            at += width + 12;
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
        let Some(pin) = model.pin().filter(|p| !p.is_empty()) else {
            self.message(
                "Pairing",
                "Waiting for a PIN\u{2026}",
                Some("The PC is starting the pairing"),
                340,
                pal.ink,
            );
            return;
        };
        self.message(
            "Pairing",
            pin,
            Some("Enter this PIN in Sunshine within 5 minutes"),
            340,
            pal.accent,
        );
        if let Some(url) = model.url().filter(|u| !u.is_empty()) {
            self.put(SIDE, 340 + 190, CONTENT_WIDTH, url, HINT, pal.dim, Align::Left);
        }
        if let Some(left) = model.pin_left_s() {
            let countdown = format!("{}:{:02} left", left / 60, left % 60);
            self.put(SIDE, 340 + 230, CONTENT_WIDTH, &countdown, HINT, pal.dim, Align::Left);
        }
    }

    fn setting_row(&mut self, row: &SettingRow, i: u32, editing: bool) {
        let pal = self.pal;
        let height = 80;
        let (x, y) = card_at(i, BODY_Y + 16, height, 16);
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
        self.item(item::SETTING + i, x, y, CARD_WIDTH, height, flags, PANEL_RADIUS);
        let fill = if row.greyed { pal.ground } else { pal.panel };
        self.fill(x, y, CARD_WIDTH, height, fill, PANEL_RADIUS);
        let ink = if row.greyed { pal.line } else { pal.ink };
        let label = row.setting.label();
        self.put(x + CARD_PAD, y + 22, 360, label, BODY, pal.dim, Align::Left);
        let value_x = x + CARD_PAD + 340;
        let value_width = CARD_WIDTH - 2 * CARD_PAD - 340;
        if row.greyed {
            self.put(value_x, y + 22, value_width, "Not available yet", BODY, pal.line, Align::Right);
        } else if !row.adjustable {
            self.put(value_x, y + 22, value_width, row.value.as_str(), BODY_BOLD, ink, Align::Right);
        } else {
            self.stepper(
                value_x,
                y + 22,
                row.value.as_str(),
                BODY_BOLD,
                value_width,
                ink,
                editing && row.can_left,
                editing && row.can_right,
            );
        }
    }

    fn settings_page(&mut self, model: &Model, settings_error: Option<&str>) {
        let editing_keys: Keys = &[("\u{25c2}\u{25b8}", "Change"), ("B", "Done"), ("A", "Done")];
        let browsing_keys: Keys = &[
            ("Y", "Reset"),
            ("X", "Test network"),
            ("B", "Back"),
            ("A", "Edit"),
        ];
        let rows = model.settings().rows(model.docked(), model.capabilities());
        let editing = model.editing().is_some_and(|s| rows[s as usize].adjustable);
        let left = match settings_error.filter(|e| !e.is_empty()) {
            Some(error) => format!("Settings could not be saved: {error}"),
            None if !model.link_note().is_empty() => String::from(model.link_note()),
            None => String::from("Changes apply to the next stream"),
        };
        self.frame(
            model,
            &Chrome {
                title: "Settings",
                left: &left,
                keys: if editing { editing_keys } else { browsing_keys },
                ..Chrome::default()
            },
        );
        for (i, row) in (0u32..).zip(&rows) {
            self.setting_row(row, i, model.editing() == Some(row.setting));
        }
        if !model.docked() {
            let pal = self.pal;
            let cursor = item::SETTING + Setting::Size as u32;
            self.put_when(
                SIDE,
                FOOT_Y - 76,
                CONTENT_WIDTH,
                "1440p and 4K are only available when docked",
                HINT,
                pal.dim,
                Align::Left,
                cursor,
            );
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
        let ink = self.pal.ink;
        self.message(
            "Quit host app",
            &title,
            Some("The stream ends and the app closes on the PC"),
            340,
            ink,
        );
        self.button(item::CONFIRM_QUIT, SIDE, BUTTON_Y, BUTTON_WIDTH, "Quit", false);
        self.button(
            item::CANCEL,
            SIDE + BUTTON_WIDTH + BUTTON_GAP,
            BUTTON_Y,
            BUTTON_WIDTH,
            "Cancel",
            false,
        );
    }

    fn overlay_page(&mut self, model: &Model) {
        let pal = self.pal;
        self.background = pal.scrim;
        self.flags = page::FLAG_OVERLAY | page::FLAG_NO_CHORD;
        let x = SCREEN_WIDTH - SHEET_WIDTH - SHEET_MARGIN;
        self.fill(x, SHEET_MARGIN, SHEET_WIDTH, SCREEN_HEIGHT - 2 * SHEET_MARGIN, pal.ground, SHEET_RADIUS);
        let inner = SHEET_WIDTH - 2 * SHEET_PAD;
        let left = x + SHEET_PAD;

        let first = [
            (item::RESUME_STREAM, "Resume", None, pal.ink),
            (
                item::TOGGLE_STATS,
                "Show stats on screen",
                Some(if model.settings().on(Setting::FrameCounter) { "On" } else { "Off" }),
                pal.ink,
            ),
            (item::RETURN_TO_APPS, "Disconnect", None, pal.ink),
            (item::QUIT_HOST, "Quit app on PC", None, pal.warn),
        ];
        for (i, (id, label, value, ink)) in first.into_iter().enumerate() {
            let y = SHEET_ITEMS_Y + i as u32 * (SHEET_ITEM + SHEET_ITEM_GAP);
            self.item(id, left, y, inner, SHEET_ITEM, 0, BUTTON_RADIUS);
            self.fill(left, y, inner, SHEET_ITEM, pal.panel, BUTTON_RADIUS);
            self.put(left + 28, y + 22, inner - 56, label, OPTION, ink, Align::Left);
            if let Some(value) = value {
                self.put(left + 28, y + 22, inner - 56, value, OPTION, pal.dim, Align::Right);
            }
        }

        let title = model.app().map_or("Moonlight", |a| a.name.as_str());
        self.put(left, 64, inner, title, NAME, pal.ink, Align::Left);
        let minutes = model.stream().session_s / 60;
        let session = match minutes {
            0 => String::from("less than a minute"),
            minutes => format!("{minutes} min"),
        };
        let subtitle = format!("{} \u{b7} {session}", host_name(model).unwrap_or(""));
        self.put(left, 120, inner, &subtitle, BODY, pal.dim, Align::Left);
        let plan = model.planned_stream();
        let mode = format!(
            "{}p{} \u{b7} {} \u{b7} {:.0} Mbps",
            plan.height,
            plan.fps,
            plan.codec.text(),
            plan.bitrate_kbps as f32 / 1000.0
        );
        self.put(left, 160, inner, &mode, BODY, pal.dim, Align::Left);
        self.fill(left, SHEET_GRID_Y - 24, inner, 2, pal.line, 0);

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
        for (i, (label, value)) in cells.iter().enumerate() {
            let cx = left + (i as u32 % 2) * (inner / 2);
            let cy = SHEET_GRID_Y + (i as u32 / 2) * SHEET_CELL;
            self.put(cx, cy, inner / 2, label, HINT, pal.dim, Align::Left);
            let text = value.as_deref().unwrap_or("--");
            self.put(cx, cy + 32, inner / 2, text, NAME, pal.ink, Align::Left);
        }
        self.legend_right(SCREEN_WIDTH - SHEET_MARGIN - SHEET_PAD, FOOT_Y, &[("B", "Close"), ("A", "Choose")], pal.ink, 0);
    }

    fn error_page(&mut self, model: &Model) {
        let lost = model.screen() == Screen::ConnectionLost;
        let can_reconnect = lost && model.host().is_some();
        let keys: Keys = if can_reconnect {
            &[("B", "PCs"), ("A", "Reconnect")]
        } else {
            &[("A", "Back")]
        };
        self.frame(
            model,
            &Chrome {
                title: host_name(model).unwrap_or("Moonlight"),
                keys,
                ..Chrome::default()
            },
        );
        let kicker = if lost { "Connection lost" } else { "Something went wrong" };
        let ink = self.pal.ink;
        self.message(
            kicker,
            model.message().unwrap_or("Something went wrong"),
            Some(error_next_step(model.message(), lost)),
            340,
            ink,
        );
        let label = if can_reconnect { "Reconnect" } else { "Back" };
        self.button(item::BACK, SIDE, BUTTON_Y, BUTTON_WIDTH, label, false);
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
                self.status(model, host, Some("Asking the PC to forget this console\u{2026}"), &[]);
            }
            Screen::Connecting => {
                let address = model.host().map(|h| h.address.as_str());
                let line = model.message().or(address);
                self.status(model, host, line, cancel);
            }
            Screen::Pairing => self.pairing_page(model),
            Screen::Apps => self.apps_page(model),
            Screen::QuitConfirm => self.quit_confirm_page(model),
            Screen::Settings => self.settings_page(model, settings_error),
            Screen::Launching => {
                let title = model.app().map_or("", |a| a.name.as_str());
                let line = model.message().unwrap_or("Starting the stream\u{2026}");
                self.status(model, title, Some(line), cancel);
            }
            Screen::Streaming => self.overlay_page(model),
            Screen::Quitting => self.status(model, host, Some("Closing the app on the PC\u{2026}"), &[]),
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
