const uint UI_PAGE_MAGIC = 0x47504248u;
const uint UI_HDR_EPOCH = 1u, UI_HDR_SEQUENCE = 2u, UI_HDR_FLAGS = 3u,
           UI_HDR_ITEMS = 4u, UI_HDR_TEXTS = 5u, UI_HDR_IMAGES = 6u;
const uint UI_HDR_BODY = 7u, UI_HDR_BACKGROUND = 8u, UI_HDR_HOME = 9u,
           UI_HDR_CHECKSUM = 10u;
const uint UI_ITEMS = 16u, UI_TEXTS = 272u, UI_IMAGES = 656u,
           UI_TABLES_END = 1024u, UI_BODY = 1024u;
const uint UI_MAX_ITEMS = 32u, UI_MAX_TEXTS = 48u, UI_MAX_IMAGES = 24u,
           UI_MAX_BODY = UI_PAGE_WORDS * 4u - 4096u;
const uint UI_FLAG_OVERLAY = 1u, UI_FLAG_HIDE_CURSOR = 2u, UI_FLAG_NO_CHORD = 4u;
const uint UI_ITEM_GREYED = 1u, UI_ITEM_CURRENT = 2u, UI_ITEM_ADJUSTABLE = 4u,
           UI_ITEM_PENDING = 8u, UI_ITEM_EDITING = 16u;
const uint UI_OP_A = 1u, UI_OP_B = 2u, UI_OP_X = 3u, UI_OP_Y = 4u,
           UI_OP_ADJUST = 5u, UI_OP_CHORD = 6u, UI_OP_EDIT = 7u;
const uint UI_CHORD_FRAMES = 60u, UI_STICK_REPEAT = 12u;

uint uiPageBase(uint page) { return UI_BASE + page * UI_PAGE_WORDS; }
uint uiShownBase() { return uiPageBase(uiWord(UI_SHOWN) & 1u); }
uint uiByte(uint base, uint offset) {
  return (uiWord(base + offset / 4u) >> ((offset & 3u) * 8u)) & 255u;
}
uvec4 uiRect(uint base, uint table, uint index, uint first) {
  uint o = base + table + index * 8u + first;
  return uvec4(uiWord(o), uiWord(o + 1u), uiWord(o + 2u), uiWord(o + 3u));
}
bool uiInside(vec2 p, uvec4 r) {
  return p.x >= float(r.x) && p.y >= float(r.y) && p.x < float(r.x + r.z) &&
         p.y < float(r.y + r.w);
}
vec4 uiColor(uint packed) {
  return vec4(packed & 255u, (packed >> 8u) & 255u, (packed >> 16u) & 255u,
              packed >> 24u) /
         255.0;
}
// The page replaces the video unless it is an overlay, which shows only while
// raised.
bool uiShowsPage() {
  if (uiWord(UI_MAGIC) != UI_PROTOCOL_MAGIC || uiWord(UI_APPLIED) == 0u)
    return false;
  return (uiWord(uiShownBase() + UI_HDR_FLAGS) & UI_FLAG_OVERLAY) == 0u ||
         uiWord(UI_OVERLAY) != 0u;
}

bool uiRectOk(uvec4 r, uint maxW, uint maxH) {
  return r.z > 0u && r.w > 0u && r.z <= maxW && r.w <= maxH &&
         r.x + r.z <= 1920u && r.y + r.w <= 1080u;
}
// The checks ui-page.js validate() makes, on the buffer the host named.
bool uiValid(uint base, uint epoch, uint sequence) {
  if (uiWord(base) != UI_PAGE_MAGIC || uiWord(base + UI_HDR_EPOCH) != epoch ||
      uiWord(base + UI_HDR_SEQUENCE) != sequence)
    return false;
  uint items = uiWord(base + UI_HDR_ITEMS), texts = uiWord(base + UI_HDR_TEXTS),
       images = uiWord(base + UI_HDR_IMAGES), body = uiWord(base + UI_HDR_BODY);
  if (items > UI_MAX_ITEMS || texts > UI_MAX_TEXTS || images > UI_MAX_IMAGES ||
      body > UI_MAX_BODY)
    return false;
  if (uiWord(base + UI_HDR_HOME) >= max(items, 1u))
    return false;
  uint checksum = 2166136261u;
  for (uint w = 0u; w < UI_HDR_CHECKSUM; w++)
    checksum = (checksum ^ uiWord(base + w)) * 16777619u;
  for (uint w = UI_ITEMS; w < UI_TABLES_END; w++)
    checksum = (checksum ^ uiWord(base + w)) * 16777619u;
  if (checksum != uiWord(base + UI_HDR_CHECKSUM))
    return false;
  for (uint i = 0u; i < items; i++)
    if (uiWord(base + UI_ITEMS + i * 8u) == 0u ||
        !uiRectOk(uiRect(base, UI_ITEMS, i, 1u), 1920u, 1080u))
      return false;
  for (uint i = 0u; i < texts; i++) {
    uvec4 r = uiRect(base, UI_TEXTS, i, 0u);
    uint offset = uiWord(base + UI_TEXTS + i * 8u + 4u);
    if (!uiRectOk(r, 1920u, 96u) || (offset & 3u) != 0u ||
        offset + r.z * r.w > body || uiWord(base + UI_TEXTS + i * 8u + 6u) > items)
      return false;
  }
  for (uint i = 0u; i < images; i++) {
    uvec4 r = uiRect(base, UI_IMAGES, i, 0u);
    uint offset = uiWord(base + UI_IMAGES + i * 8u + 4u);
    if (!uiRectOk(r, 320u, 180u) || (offset & 3u) != 0u ||
        offset + r.z * r.w * 4u > body ||
        uiWord(base + UI_IMAGES + i * 8u + 5u) != 1u)
      return false;
  }
  return true;
}
uint uiItemId(uint base, uint index) {
  return uiWord(base + UI_ITEMS + index * 8u);
}
uint uiItemFlags(uint base, uint index) {
  return uiWord(base + UI_ITEMS + index * 8u + 5u);
}
bool uiHasItem(uint base, uint id) {
  uint items = uiWord(base + UI_HDR_ITEMS);
  for (uint i = 0u; i < items; i++)
    if (uiItemId(base, i) == id)
      return true;
  return false;
}
// A new page keeps the cursor on the item with the same id, else goes to the
// page's home. A page is current only when the shown page carries both its
// sequence and its epoch, so a new service whose first sequence equals the
// stale uiApplied still applies.
void uiApply() {
  uint sequence = uiWord(UI_SEQUENCE), epoch = uiWord(UI_EPOCH),
       page = uiWord(UI_PAGE);
  if (uiWord(UI_MAGIC) != UI_PROTOCOL_MAGIC || sequence == 0u || page > 1u)
    return;
  uint applied = uiWord(UI_APPLIED), shown = uiShownBase();
  bool sameEpoch = applied != 0u && uiWord(shown + UI_HDR_EPOCH) == epoch;
  if (sequence == applied && sameEpoch)
    return;
  uint base = uiPageBase(page);
  if (!uiValid(base, epoch, sequence))
    return;
  uint cursor = uiWord(base + UI_HDR_HOME);
  if (sameEpoch) {
    uint id = uiItemId(shown, min(uiWord(UI_CURSOR), UI_MAX_ITEMS - 1u)),
         items = uiWord(base + UI_HDR_ITEMS);
    for (uint i = 0u; i < items; i++)
      if (uiItemId(base, i) == id)
        cursor = i;
  }
  if ((uiWord(base + UI_HDR_FLAGS) & UI_FLAG_OVERLAY) == 0u || !sameEpoch)
    storage.words[UI_OVERLAY] = 0u;
  if (!sameEpoch || !uiHasItem(base, uiWord(UI_EDIT)))
    storage.words[UI_EDIT] = 0u;
  storage.words[UI_CURSOR] = cursor;
  storage.words[UI_SHOWN] = page;
  memoryBarrierBuffer();
  storage.words[UI_APPLIED] = sequence;
}
// Args, then the op, then the sequence, so the host never pairs a new op with
// old args.
void uiCommand(uint op, uint item, uint value) {
  storage.words[CMD_ITEM] = item;
  storage.words[CMD_VALUE] = value;
  storage.words[CMD_PAGE] = uiWord(UI_APPLIED);
  storage.words[CMD_EPOCH] = uiWord(UI_EPOCH);
  memoryBarrierBuffer();
  storage.words[CMD_OP] = op;
  memoryBarrierBuffer();
  uint sequence = uiWord(CMD_SEQUENCE) + 1u;
  storage.words[CMD_SEQUENCE] = sequence == 0u ? 1u : sequence;
}
// The edit lives here, not in the page, so input right after A already steps
// the value (streamer/civ7/README.md, "Console UI"). A ends an edit; on an
// adjustable item it starts one; elsewhere it is a plain A.
void uiPress(uint base, uint index) {
  uint id = uiItemId(base, index);
  if (uiWord(UI_EDIT) != 0u) {
    storage.words[UI_EDIT] = 0u;
    uiCommand(UI_OP_EDIT, 0u, 0u);
  } else if ((uiItemFlags(base, index) & UI_ITEM_ADJUSTABLE) != 0u) {
    storage.words[UI_EDIT] = id;
    uiCommand(UI_OP_EDIT, id, 0u);
  } else
    uiCommand(UI_OP_A, id, 0u);
}
// Nearest selectable item whose centre lies in the pressed direction, dominant
// axis, no wrap.
uint uiNeighbour(uint base, uint cursor, vec2 direction) {
  uint items = uiWord(base + UI_HDR_ITEMS), best = cursor;
  float bestDistance = 1e9;
  uvec4 from = uiRect(base, UI_ITEMS, cursor, 1u);
  vec2 origin = vec2(from.xy) + vec2(from.zw) * 0.5;
  for (uint i = 0u; i < items; i++) {
    if (i == cursor || (uiItemFlags(base, i) & UI_ITEM_GREYED) != 0u)
      continue;
    uvec4 r = uiRect(base, UI_ITEMS, i, 1u);
    vec2 d = vec2(r.xy) + vec2(r.zw) * 0.5 - origin;
    float along = dot(d, direction),
          across = abs(dot(d, vec2(direction.y, direction.x)));
    if (along <= 0.5 || across > along)
      continue;
    float distance = along + across * 2.0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
// Input for the applied page: cursor moves on the console, presses become
// commands. Scratch: inputState.chordFrames chord frames,
// inputState.stickRepeat stick repeat, inputState.touchHeld touch held.
void uiInput() {
  uint applied = uiWord(UI_APPLIED);
  if (uiWord(UI_MAGIC) != UI_PROTOCOL_MAGIC || applied == 0u)
    return;
  uint base = uiShownBase(), held = inputButtons(), pressed = inputPressed();
  bool sent = false;
  bool chord = (uiWord(base + UI_HDR_FLAGS) & UI_FLAG_NO_CHORD) == 0u;
  if (chord && inputConnected() &&
      (held & (BUTTON_L | BUTTON_R)) == (BUTTON_L | BUTTON_R)) {
    inputState.chordFrames++;
    if (inputState.chordFrames == UI_CHORD_FRAMES) {
      uiCommand(UI_OP_CHORD, 0u, 0u);
      sent = true;
      if ((uiWord(base + UI_HDR_FLAGS) & UI_FLAG_OVERLAY) != 0u)
        storage.words[UI_OVERLAY] = 1u;
    }
  } else
    inputState.chordFrames = 0u;
  if ((uiWord(base + UI_HDR_FLAGS) & UI_FLAG_OVERLAY) != 0u &&
      uiWord(UI_OVERLAY) == 0u)
    return;
  uint items = uiWord(base + UI_HDR_ITEMS),
       cursor = min(uiWord(UI_CURSOR), max(items, 1u) - 1u);
  vec2 stick = inputStick();
  vec2 move = vec2(0);
  if ((pressed & BUTTON_UP) != 0u)
    move = vec2(0, -1);
  else if ((pressed & BUTTON_DOWN) != 0u)
    move = vec2(0, 1);
  else if ((pressed & BUTTON_LEFT) != 0u)
    move = vec2(-1, 0);
  else if ((pressed & BUTTON_RIGHT) != 0u)
    move = vec2(1, 0);
  else if (length(stick) > 0.6) {
    if (inputState.stickRepeat == 0u) {
      move = abs(stick.x) > abs(stick.y) ? vec2(sign(stick.x), 0)
                                         : vec2(0, -sign(stick.y));
      inputState.stickRepeat = UI_STICK_REPEAT;
    } else
      inputState.stickRepeat--;
  } else
    inputState.stickRepeat = 0u;
  // An item being edited holds the cursor: left and right step it, up and
  // down do nothing until A or B ends the edit.
  if (items > 0u && move != vec2(0)) {
    bool editing = uiWord(UI_EDIT) != 0u;
    if (!editing)
      cursor = uiNeighbour(base, cursor, move);
    else if (move.y == 0.0 && !sent) {
      uiCommand(UI_OP_ADJUST, uiWord(UI_EDIT),
                move.x > 0.0 ? 1u : 0xffffffffu);
      sent = true;
    }
  }
  bool touching = inputState.touch[2] == 1u && (inputState.touch[6] & 2u) == 0u;
  if (touching && inputState.touchHeld == 0u) {
    vec2 p = vec2(inputState.touch[8], inputState.touch[9]) * 1.5;
    for (uint i = 0u; i < items; i++)
      if ((uiItemFlags(base, i) & UI_ITEM_GREYED) == 0u &&
          uiInside(p, uiRect(base, UI_ITEMS, i, 1u))) {
        cursor = i;
        storage.words[UI_TOUCH_ITEM] = i;
        if (!sent) {
          uiPress(base, i);
          sent = true;
        }
      }
  }
  inputState.touchHeld = touching ? 1u : 0u;
  if (!sent && items > 0u) {
    uint id = uiItemId(base, cursor);
    bool greyed = (uiItemFlags(base, cursor) & UI_ITEM_GREYED) != 0u;
    if ((pressed & BUTTON_A) != 0u && !greyed) {
      uiPress(base, cursor);
      sent = true;
    } else if ((pressed & BUTTON_X) != 0u) {
      uiCommand(UI_OP_X, id, 0u);
      sent = true;
    } else if ((pressed & BUTTON_Y) != 0u) {
      uiCommand(UI_OP_Y, id, 0u);
      sent = true;
    }
  }
  if (!sent && (pressed & BUTTON_B) != 0u && uiWord(UI_EDIT) != 0u) {
    storage.words[UI_EDIT] = 0u;
    uiCommand(UI_OP_EDIT, 0u, 0u);
  } else if (!sent && (pressed & BUTTON_B) != 0u) {
    if ((uiWord(base + UI_HDR_FLAGS) & UI_FLAG_OVERLAY) != 0u)
      storage.words[UI_OVERLAY] = 0u;
    uiCommand(UI_OP_B, 0u, 0u);
  }
  storage.words[UI_CURSOR] = cursor;
}
