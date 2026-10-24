#!/usr/bin/env python3
"""Screen capture for Wayland desktops through the xdg-desktop-portal ScreenCast API.

Asks once for a monitor, then writes raw RGB24 frames of WIDTHxHEIGHT at FPS to stdout.
Usage: screencast.py WIDTH HEIGHT FPS
"""
import os
import sys

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gio, GLib, Gst

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SCREENCAST = "org.freedesktop.portal.ScreenCast"
MONITOR = 1
CURSOR_EMBEDDED = 2


class Portal:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.sender = self.bus.get_unique_name()[1:].replace(".", "_")
        self.loop = GLib.MainLoop()
        self.counter = 0

    def request(self, method, *args):
        self.counter += 1
        token = f"hblauncher{os.getpid()}_{self.counter}"
        path = f"{PORTAL_PATH}/request/{self.sender}/{token}"
        result = {}

        def on_response(_bus, _sender, _path, _iface, _signal, parameters):
            code, results = parameters.unpack()
            result["code"], result["results"] = code, results
            self.loop.quit()

        subscription = self.bus.signal_subscribe(
            PORTAL, "org.freedesktop.portal.Request", "Response", path, None,
            Gio.DBusSignalFlags.NO_MATCH_RULE, on_response)
        options = dict(args[-1])
        options["handle_token"] = GLib.Variant("s", token)
        signature = "(" + "".join(arg[0] for arg in args[:-1]) + "a{sv})"
        values = [arg[1] for arg in args[:-1]] + [options]
        self.bus.call_sync(PORTAL, PORTAL_PATH, SCREENCAST, method,
                           GLib.Variant(signature, tuple(values)), None,
                           Gio.DBusCallFlags.NONE, -1, None)
        self.loop.run()
        self.bus.signal_unsubscribe(subscription)
        if result["code"] != 0:
            sys.exit(f"Screen capture {method} was refused or cancelled")
        return result["results"]

    def open(self):
        session = self.request("CreateSession", {
            "session_handle_token": GLib.Variant("s", f"hblauncher{os.getpid()}"),
        })["session_handle"]
        self.request("SelectSources", ("o", session), {
            "types": GLib.Variant("u", MONITOR),
            "multiple": GLib.Variant("b", False),
            "cursor_mode": GLib.Variant("u", CURSOR_EMBEDDED),
        })
        streams = self.request("Start", ("o", session), ("s", ""), {})["streams"]
        node = streams[0][0]
        reply, fds = self.bus.call_with_unix_fd_list_sync(
            PORTAL, PORTAL_PATH, SCREENCAST, "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (session, {})), None,
            Gio.DBusCallFlags.NONE, -1, None, None)
        return fds.get(reply.unpack()[0]), node


def main():
    width, height, fps = (int(value) for value in sys.argv[1:4])
    fd, node = Portal().open()
    Gst.init(None)
    pipeline = Gst.parse_launch(
        f"pipewiresrc fd={fd} path={node} do-timestamp=true keepalive-time=1000 "
        f"! videorate drop-only=true max-rate={fps} ! videoconvert ! videoscale method=bilinear "
        f"! video/x-raw,format=RGB,width={width},height={height},pixel-aspect-ratio=1/1 "
        f"! fdsink fd=1 sync=false")
    pipeline.set_state(Gst.State.PLAYING)
    print(f"Capturing PipeWire node {node} at {width}x{height}@{fps}", file=sys.stderr)
    bus = pipeline.get_bus()
    message = bus.timed_pop_filtered(Gst.CLOCK_TIME_NONE, Gst.MessageType.ERROR | Gst.MessageType.EOS)
    pipeline.set_state(Gst.State.NULL)
    if message.type == Gst.MessageType.ERROR:
        sys.exit(message.parse_error()[0].message)


if __name__ == "__main__":
    main()
