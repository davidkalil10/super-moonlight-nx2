//! The console half of the UI (src/streamer/civ7/console-ui.js) over the renderer's storage:
//! shader commands into the model, composed pages into the buffer not shown, the header words.
//! Port of ui/bridge.c. Every call takes the storage, so no borrow of it outlives the call.

use alloc::vec::Vec;

use crate::composer::{self, Composer};
use crate::json::Json;
use crate::model::{Event, Host, Intent, IntentKind, Model, Op, Screen, Step};
use crate::page::{self, Placement};
use crate::settings::{Capabilities, Settings};
use crate::store::{Files, Source, Store};

pub const BLOCK: usize = 0xc000;
pub const MAGIC_WORD: usize = BLOCK;
pub const EPOCH: usize = BLOCK + 4;
pub const SEQUENCE: usize = BLOCK + 8;
pub const PAGE: usize = BLOCK + 12;
pub const APPLIED: usize = BLOCK + 16;
pub const CURSOR: usize = BLOCK + 20;
pub const OVERLAY: usize = BLOCK + 24;
pub const TOUCH_ITEM: usize = BLOCK + 28;
pub const CMD_SEQUENCE: usize = BLOCK + 32;
pub const CMD_OP: usize = BLOCK + 36;
pub const CMD_ITEM: usize = BLOCK + 40;
pub const CMD_VALUE: usize = BLOCK + 44;
pub const CMD_PAGE: usize = BLOCK + 48;
pub const CMD_EPOCH: usize = BLOCK + 52;
pub const SHOWN: usize = BLOCK + 56;
pub const EDIT: usize = BLOCK + 60;
pub const HOST_ACK: usize = BLOCK + 64;
pub const HOST_BUSY: usize = BLOCK + 68;
pub const PROTOCOL_MAGIC: u32 = 0x4955_4248;
pub const PAGES_OFFSET: usize = 40_030_208;
pub const PAGE_BUFFER_BYTES: usize = 4 << 20;
pub const STORAGE_BYTES: usize = PAGES_OFFSET + 2 * PAGE_BUFFER_BYTES;
pub const APPLY_TIMEOUT_NS: u64 = 5_000_000_000;
pub const MAX_QUEUED: usize = 16;

const SAVE_FAILED: &str = "Settings write failed";
const OPS: [Op; 7] = [Op::A, Op::B, Op::X, Op::Y, Op::Adjust, Op::Chord, Op::Edit];

pub type Storage = [u8; STORAGE_BYTES];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    NotNext,
    NotInBuffer,
    Compose(composer::Error),
}

impl Error {
    pub fn message(self) -> &'static str {
        match self {
            Self::NotNext => "UI page is not the next page",
            Self::NotInBuffer => "UI page is not in its buffer",
            Self::Compose(error) => error.message(),
        }
    }
}

fn word(storage: &Storage, offset: usize) -> u32 {
    let mut bytes = [0; 4];
    bytes.copy_from_slice(&storage[offset..offset + 4]);
    u32::from_ne_bytes(bytes)
}

fn put(storage: &mut Storage, offset: usize, value: u32) {
    storage[offset..offset + 4].copy_from_slice(&value.to_ne_bytes());
}

fn page_buffer(slot: u32) -> core::ops::Range<usize> {
    let start = PAGES_OFFSET + slot as usize * PAGE_BUFFER_BYTES;
    start..start + PAGE_BUFFER_BYTES
}

fn write_header(storage: &mut Storage, words: [u32; 4]) {
    for (index, value) in words.into_iter().enumerate() {
        put(storage, MAGIC_WORD + index * 4, value);
    }
}

fn header_holds(storage: &Storage, words: [u32; 4]) -> bool {
    (0..4).all(|index| word(storage, MAGIC_WORD + index * 4) == words[index])
}

fn following(value: u32) -> u32 {
    match value.wrapping_add(1) {
        0 => 1,
        next => next,
    }
}

/// UI state between the model and the renderer. Holds the model and a JSON reader
/// (~170 KiB together), so keep it boxed.
pub struct Bridge<F> {
    store: Option<Store<F>>,
    json: Json,
    model: Model,
    storage_error: Option<&'static str>,
    revision: u64,
    epoch: u32,
    sequence: u32,
    applied: u32,
    seen: u32,
    header: Option<[u32; 4]>,
    shown_screen: Option<Screen>,
    published_at: u64,
    stale: bool,
    header_rewrites: u32,
    apply_timeouts: u32,
    intents: Vec<Intent>,
    dropped_intents: u32,
    composed_revision: Option<u64>,
    placed: [Option<Placement>; 2],
}

impl<F: Files> Bridge<F> {
    /// Loads settings (saving them back unless they loaded as they are), then picks an epoch
    /// past the page left in storage and clears the header.
    pub fn new(
        storage: &mut Storage,
        hosts: &[Host],
        store: Option<Store<F>>,
        capabilities: Capabilities,
        epoch_hint: u32,
    ) -> Self {
        let mut json = Json::new();
        let mut store = store;
        let (source, settings) = match store.as_mut() {
            Some(store) => store.load(&mut json),
            None => (Source::Defaults, Settings::default()),
        };

        let shown_slot = word(storage, SHOWN) & 1;
        let shown = page_buffer(shown_slot).start;
        let shown_epoch = if word(storage, shown) == page::MAGIC {
            word(storage, shown + 4)
        } else {
            0
        };
        let epoch = epoch_hint.max(shown_epoch.wrapping_add(1));
        let sequence = word(storage, APPLIED);

        let mut bridge = Self {
            store,
            json,
            model: Model::new(hosts, settings, capabilities),
            storage_error: None,
            revision: 0,
            epoch: if epoch == 0 { 1 } else { epoch },
            sequence,
            applied: sequence,
            seen: word(storage, CMD_SEQUENCE),
            header: None,
            shown_screen: None,
            published_at: 0,
            stale: false,
            header_rewrites: 0,
            apply_timeouts: 0,
            intents: Vec::with_capacity(MAX_QUEUED),
            dropped_intents: 0,
            composed_revision: None,
            placed: [None, None],
        };
        if bridge.store.is_some() && source != Source::Loaded {
            bridge.save_settings();
        }
        write_header(storage, [0; 4]);
        bridge
    }

    /// Recomposes the page on the next publish (e.g. box art arrived).
    pub fn invalidate(&mut self) {
        self.revision += 1;
    }

    pub fn model(&self) -> &Model {
        &self.model
    }

    pub fn set_stream_stats(&mut self, text: &str) {
        if self.model.set_stream_stats(text) {
            self.revision += 1;
        }
    }

    pub fn overlay_ready(&self, storage: &Storage) -> bool {
        self.shown_is(Screen::Streaming)
            && self.header.is_some()
            && word(storage, APPLIED) == self.sequence
    }

    pub fn show_overlay(&mut self, storage: &mut Storage) -> bool {
        if !self.overlay_ready(storage) {
            return false;
        }
        put(storage, OVERLAY, 1);
        true
    }

    pub fn set_capabilities(&mut self, capabilities: Capabilities) {
        if self.model.set_capabilities(capabilities) {
            self.revision += 1;
        }
    }

    pub fn set_status(&mut self, text: Option<&str>) {
        if self.model.set_status(text) {
            self.revision += 1;
        }
    }

    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    pub fn settings_error(&self) -> Option<&'static str> {
        self.storage_error
    }

    pub fn header_rewrites(&self) -> u32 {
        self.header_rewrites
    }

    pub fn apply_timeouts(&self) -> u32 {
        self.apply_timeouts
    }

    pub fn dropped_intents(&self) -> u32 {
        self.dropped_intents
    }

    pub fn next_sequence(&self) -> u32 {
        let next = following(self.sequence);
        let on_applied_page = next & 1 == self.applied & 1 && self.applied != 0;
        if on_applied_page {
            following(next)
        } else {
            next
        }
    }

    fn sync_applied(&mut self, storage: &Storage) {
        if self.header.is_some() {
            self.applied = word(storage, APPLIED);
        }
    }

    fn save_settings(&mut self) {
        let Some(store) = self.store.as_mut() else {
            self.storage_error = None;
            return;
        };
        let saved = store.save(self.model.settings(), &mut self.json);
        self.storage_error = (!saved).then_some(SAVE_FAILED);
    }

    fn queue(&mut self, intent: &Intent) {
        if self.intents.len() >= MAX_QUEUED {
            self.dropped_intents += 1;
            return;
        }
        self.intents.push(*intent);
    }

    /// Runs the event through the model; settings saves happen here, input pauses are the
    /// bridge's own, and every other intent queues for `take_intents`.
    pub fn dispatch(&mut self, storage: &Storage, event: &Event<'_>) {
        let before = self.storage_error;
        let step = self.reduce(event);

        for intent in step.intents() {
            match intent.kind {
                IntentKind::SaveSettings => self.save_settings(),
                IntentKind::PauseInput | IntentKind::ResumeInput => {}
                _ => self.queue(intent),
            }
        }
        if self.storage_error != before {
            self.revision += 1;
        }
        self.sync_applied(storage);
    }

    pub fn reduce(&mut self, event: &Event<'_>) -> Step {
        let step = self.model.reduce(event);
        if step.changed {
            self.revision += 1;
        }
        step
    }

    pub fn persist_settings(&mut self) {
        let before = self.storage_error;
        self.save_settings();
        if self.storage_error != before {
            self.revision += 1;
        }
    }

    /// Points the header at page `sequence`, which must be the next page and already encoded
    /// in its buffer.
    pub fn show(
        &mut self,
        storage: &mut Storage,
        sequence: u32,
        screen: Screen,
        now_ns: u64,
    ) -> Result<(), Error> {
        let next = self.next_sequence();
        if sequence != next {
            return Err(Error::NotNext);
        }

        let start = page_buffer(next & 1).start;
        let page = [0, 4, 8].map(|offset| word(storage, start + offset));
        if page != [page::MAGIC, self.epoch, next] {
            return Err(Error::NotInBuffer);
        }

        let words = [PROTOCOL_MAGIC, self.epoch, next, next & 1];
        self.header = Some(words);
        write_header(storage, words);
        self.sequence = next;
        self.shown_screen = Some(screen);
        self.published_at = now_ns;
        self.stale = false;
        self.sync_applied(storage);
        Ok(())
    }

    fn watch(&mut self, storage: &mut Storage, now_ns: u64) {
        let Some(header) = self.header else {
            return;
        };
        if self.applied == self.sequence {
            return;
        }
        self.applied = word(storage, APPLIED);
        if self.applied == self.sequence {
            return;
        }

        if !header_holds(storage, header) {
            write_header(storage, header);
            self.header_rewrites += 1;
        }
        if !self.stale && now_ns.wrapping_sub(self.published_at) > APPLY_TIMEOUT_NS {
            self.apply_timeouts += 1;
            self.stale = true;
        }
    }

    fn shown_is(&self, screen: Screen) -> bool {
        self.model.screen() == screen && self.shown_screen == Some(screen)
    }

    fn command(&mut self, storage: &Storage, op: Op, item: u32, value: i32) {
        self.dispatch(storage, &Event::Command { op, item, value });
    }

    fn follow_edit(&mut self, storage: &Storage) {
        if self.shown_is(Screen::Settings) {
            self.command(storage, Op::Edit, word(storage, EDIT), 0);
        }
    }

    fn consume_command(&mut self, storage: &mut Storage) {
        let sequence = word(storage, CMD_SEQUENCE);
        if sequence == self.seen {
            return;
        }
        self.seen = sequence;
        put(storage, HOST_ACK, sequence);

        let op = (word(storage, CMD_OP) as usize)
            .checked_sub(1)
            .and_then(|index| OPS.get(index));
        let current = word(storage, CMD_EPOCH) == word(storage, EPOCH)
            && word(storage, CMD_PAGE) == word(storage, SEQUENCE);
        let Some(&op) = op.filter(|_| current) else {
            return;
        };
        if self.shown_screen != Some(self.model.screen()) {
            return;
        }
        let item = word(storage, CMD_ITEM);
        let value = word(storage, CMD_VALUE) as i32;
        self.command(storage, op, item, value);
    }

    fn follow_overlay(&mut self, storage: &Storage) {
        let page_applied = self.header.is_some() && word(storage, APPLIED) == self.sequence;
        let streaming = self.shown_is(Screen::Streaming);
        if !streaming || !page_applied || self.model.overlay() {
            return;
        }
        if word(storage, OVERLAY) != 0 {
            self.command(storage, Op::Chord, 0, 0);
        }
    }

    /// Once per frame: re-asserts an unapplied header, follows the shader's edit and overlay
    /// state and takes its command.
    pub fn poll(&mut self, storage: &mut Storage, now_ns: u64) {
        self.watch(storage, now_ns);
        self.follow_edit(storage);
        self.consume_command(storage);
        self.follow_overlay(storage);
        self.sync_applied(storage);
    }

    /// Composes the model into the buffer not shown and shows it, when the model changed since
    /// the last compose. True when a page went up.
    pub fn publish(
        &mut self,
        storage: &mut Storage,
        composer: &mut Composer,
        now_ns: u64,
    ) -> Result<bool, Error> {
        if self.composed_revision == Some(self.revision) {
            return Ok(false);
        }

        let next = self.next_sequence();
        let slot = (next & 1) as usize;
        let resident = self.placed[slot].as_ref();
        let out = &mut storage[page_buffer(slot as u32)];
        let rendered = composer.render(
            &self.model,
            self.storage_error,
            self.epoch,
            next,
            resident,
            out,
        );
        let placed = match rendered {
            Ok(placed) => placed,
            Err(error) => {
                self.placed[slot] = None;
                return Err(Error::Compose(error));
            }
        };

        self.composed_revision = Some(self.revision);
        let Some(placed) = placed else {
            return Ok(false);
        };
        self.placed[slot] = Some(placed);
        let screen = self.model.screen();
        self.show(storage, next, screen, now_ns)?;
        Ok(true)
    }

    /// Up to `capacity` queued intents, oldest first.
    pub fn take_intents(&mut self, capacity: usize) -> impl Iterator<Item = Intent> + '_ {
        let count = self.intents.len().min(capacity);
        self.intents.drain(..count)
    }

    pub fn interactive(&self, storage: &Storage) -> bool {
        let applied = self.header.is_none() || word(storage, APPLIED) == self.sequence;
        self.model.interactive(applied)
    }

    pub fn allow_input(&self) -> bool {
        self.model.allow_input()
    }

    pub fn set_busy(&self, storage: &mut Storage, busy: bool) {
        put(storage, HOST_BUSY, u32::from(busy));
    }

    pub fn close(&mut self, storage: &mut Storage) {
        write_header(storage, [0; 4]);
        self.header = None;
    }
}
