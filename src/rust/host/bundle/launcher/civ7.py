"""Brings a Civ7 install's host list, settings and display options over to this bundle.

The Civ7 service keeps `hosts.json`, `settings.json` and `host-display.json` in the config
directory this bundle shares with it. The console reads the first two as they are, from
`rust-client/` on its SD card. Nothing here overwrites a file that already exists.
"""
import json
import re

MAX_BYTES = 4096
MAX_HOSTS = 64
MAX_FIELD = 63
PLAIN_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")
MAC = re.compile(r"[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}")
SIZE = re.compile(r"[1-9][0-9]{2,3}x[1-9][0-9]{2,3}")

# The console files that stand in the way of each import.
CONSOLE_FILES = {
    "hosts.json": {"hosts.json"},
    "settings.json": {"settings.json", "settings-0.json", "settings-1.json"},
}

SETTING_TYPES = {
    "version": int, "size": str, "fps": int, "fpsBefore4k": int, "bitrate": (int, float),
    "codec": str, "audio": str, "presentHz": int, "hostAudio": bool, "optimise": bool,
    "quitOnReturn": bool, "menuChord": bool, "streamInfo": bool, "frameCounter": bool,
    "touchMouse": bool, "lowLatency": bool,
}


class Invalid(ValueError):
    pass


def _document(data):
    if len(data) > MAX_BYTES:
        raise Invalid(f"larger than the {MAX_BYTES} bytes the console reads")
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise Invalid(f"not JSON: {error}") from None


def _text(entry, key, required=False):
    value = entry.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or len(value.encode()) > MAX_FIELD or (required and not value.strip()):
        raise Invalid(f"{key} must be text of at most {MAX_FIELD} bytes")
    return value


def check_hosts(data):
    """Returns how many PCs a Civ7 hosts.json holds; raises Invalid when the console would not read it whole."""
    root = _document(data)
    hosts, removed = (root, []) if isinstance(root, list) else (None, None)
    if isinstance(root, dict):
        hosts, removed = root.get("hosts"), root.get("removed", [])
    if not isinstance(hosts, list) or not isinstance(removed, list):
        raise Invalid("expected {hosts, removed} or a list of hosts")
    if len(hosts) > MAX_HOSTS:
        raise Invalid(f"more than {MAX_HOSTS} hosts")
    seen = set()
    for entry in hosts + removed:
        if not isinstance(entry, dict):
            raise Invalid("every host must be an object")
        _text(entry, "address", required=True)
        _text(entry, "uniqueid")
    for entry in hosts:
        address = entry["address"].strip()
        if address in seen:
            raise Invalid(f"{address} is listed twice")
        seen.add(address)
        _text(entry, "name")
        mac = entry.get("mac")
        if mac is not None and not (isinstance(mac, str) and MAC.fullmatch(mac)):
            raise Invalid(f"{address} has a malformed mac")
    return len(hosts)


def check_settings(data):
    """Raises Invalid unless this is a Civ7 settings.json the console can take over."""
    root = _document(data)
    if not isinstance(root, dict):
        raise Invalid("expected an object of settings")
    for key, value in root.items():
        wanted = SETTING_TYPES.get(key)
        if wanted is None:
            if isinstance(value, (dict, list)):
                raise Invalid(f"{key} is not a plain value")
            continue
        if isinstance(value, bool) != (wanted is bool) or not isinstance(value, wanted):
            raise Invalid(f"{key} has the wrong type")
    if "size" in root and not SIZE.fullmatch(root["size"]):
        raise Invalid("size must look like 1920x1080")


CHECKS = {"hosts.json": check_hosts, "settings.json": check_settings}


def console_files(config_dir):
    """The valid Civ7 files to offer the console, and one line per file about what was found."""
    files, notes = {}, []
    for name, check in CHECKS.items():
        source = config_dir / name
        try:
            data = source.read_bytes()
        except FileNotFoundError:
            notes.append(f"{name}: no Civ7 file")
            continue
        try:
            count = check(data)
        except Invalid as error:
            notes.append(f"{name}: left out, {error}")
            continue
        if count == 0:
            notes.append(f"{name}: left out, it lists no PC")
            continue
        files[name] = data
        notes.append(f"{name}: ready for the console")
    return files, notes


def missing_on_console(files, present):
    """The files the console has no version of; one that exists there is never replaced."""
    return {name: data for name, data in files.items() if not CONSOLE_FILES[name] & set(present)}


def display_options(data, sunshine):
    """Turns the Civ7 kscreen.py hook options for `sunshine` into this host's display.json."""
    try:
        root = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise Invalid(f"not JSON: {error}") from None
    hosts = root.get("hosts") if isinstance(root, dict) else None
    if not isinstance(hosts, dict) or root.get("version") != 1:
        raise Invalid("not a Civ7 host-display.json")
    entry = hosts.get(sunshine)
    if entry is None and len(hosts) == 1:
        entry = next(iter(hosts.values()))
    if not isinstance(entry, dict):
        raise Invalid(f"no display hook for {sunshine}")
    command, options = entry.get("command"), entry.get("options", {})
    if not isinstance(command, list) or not command or not isinstance(options, dict):
        raise Invalid("malformed display hook")
    if not str(command[-1]).endswith("/kscreen.py"):
        raise Invalid("a custom display hook; only the kscreen.py adapter is taken over")
    display = {"version": 1}
    for theirs, ours in (("output", "output"), ("waylandDisplay", "wayland_display")):
        value = options.get(theirs)
        if value is None:
            continue
        if not isinstance(value, str) or not PLAIN_NAME.fullmatch(value):
            raise Invalid(f"{theirs} is not a plain name")
        display[ours] = value
    custom = options.get("allowCustomModes", False)
    if not isinstance(custom, bool):
        raise Invalid("allowCustomModes must be true or false")
    display["custom_modes"] = custom
    return display


def import_display(config_dir, sunshine):
    """Writes display.json from the Civ7 hook file unless one exists; returns what happened."""
    target = config_dir / "display.json"
    if target.exists():
        return "display.json: kept, it already exists"
    try:
        data = (config_dir / "host-display.json").read_bytes()
    except FileNotFoundError:
        return "display.json: no Civ7 host-display.json"
    try:
        display = display_options(data, sunshine)
    except Invalid as error:
        return f"display.json: not written, {error}"
    try:
        with open(target, "x", encoding="utf-8") as file:
            file.write(json.dumps(display, indent=2) + "\n")
    except FileExistsError:
        return "display.json: kept, it already exists"
    return f"display.json: written from the Civ7 hook ({json.dumps(display)})"
