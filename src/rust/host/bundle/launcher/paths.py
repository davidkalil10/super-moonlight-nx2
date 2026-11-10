"""Where the bundle keeps its settings and its run logs."""
import os
from pathlib import Path

BUNDLE = Path(__file__).resolve().parent.parent
NAME = "moonlight-nx2"


def base(variable, fallback):
    value = os.environ.get(variable, "")
    return Path(value) if os.path.isabs(value) else Path.home() / fallback


def config_dir():
    return base("XDG_CONFIG_HOME", ".config") / NAME


def state_dir():
    return base("XDG_STATE_HOME", ".local/state") / NAME


def unit_dir():
    return base("XDG_CONFIG_HOME", ".config") / "systemd" / "user"
