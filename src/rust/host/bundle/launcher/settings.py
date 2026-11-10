"""pc.json: what `setup` decided for this computer."""
import ipaddress
import json
import os

from . import paths

FILE = "pc.json"
VERSION = 1
WORKERS = ("native", "container")
DEFAULT_FTP_PORT = 5000


class Invalid(ValueError):
    pass


def check(settings):
    def address(key):
        try:
            return str(ipaddress.IPv4Address(settings.get(key)))
        except ValueError:
            raise Invalid(f"{key} must be an IPv4 address") from None

    if not isinstance(settings, dict) or settings.get("version") != VERSION:
        raise Invalid(f"version must be {VERSION}")
    port = settings.get("console_port", DEFAULT_FTP_PORT)
    if isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
        raise Invalid("console_port must be a TCP port")
    for key in ("match_display", "import_civ7"):
        if not isinstance(settings.get(key, False), bool):
            raise Invalid(f"{key} must be true or false")
    worker = settings.get("worker", "native")
    if worker not in WORKERS:
        raise Invalid("worker must be native or container")
    return {
        "version": VERSION,
        "address": address("address"),
        "sunshine": address("sunshine"),
        "console": address("console"),
        "console_port": port,
        "match_display": settings.get("match_display", False),
        "import_civ7": settings.get("import_civ7", False),
        "worker": worker,
    }


def load():
    path = paths.config_dir() / FILE
    try:
        return check(json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        raise Invalid(f"{path} is missing; run `moonlight-nx2-pc setup` first") from None
    except ValueError as error:
        raise Invalid(f"{path}: {error}") from None


def save(settings):
    settings = check(settings)
    directory = paths.config_dir()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = directory / (FILE + ".tmp")
    temporary.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, directory / FILE)
    return settings
