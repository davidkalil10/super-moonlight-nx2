#!/usr/bin/env python3
"""Loopback latency probe, PC side: a fullscreen black window whose top-left patch flips
black/white on each D-pad Up press of Sunshine's virtual pad.

Runs on the Sunshine PC while the Desktop app streams. Each flip logs one JSON line on stdout:
the press's kernel evdev time and the time the flipped frame was swapped, in microseconds. The
swap time is CLOCK_REALTIME; the evdev time can be on a clock of the pad's own (Sunshine's pad
was, in loop1), so pair presses with flips by the swap time.

    python3 flip-window.py [--device /dev/input/eventN] [--patch PX]

The pad is found by its Sunshine Uniq when --device is not given (the event number changes per
session). The device is read, never grabbed. --patch is the side in physical pixels; on a
2560x1440 desktop streamed at 1920x1080 a stream pixel is 4/3 physical ones. Esc or q quits.
"""
import argparse
import json
import re
import signal
import struct
import sys
import threading
import time

from PyQt6.QtCore import QObject, QRect, Qt, pyqtSignal
from PyQt6.QtGui import QColor, QGuiApplication, QPainter
from PyQt6.QtOpenGL import QOpenGLWindow

EVENT = struct.Struct('llHHi')
EV_KEY, EV_ABS = 1, 3
BTN_DPAD_UP, ABS_HAT0Y = 0x220, 17
SUNSHINE_UNIQ = re.compile(r'sunshine-gamepad-\d+$')


def find_pad():
    """The event node of the first Sunshine virtual pad in /proc/bus/input/devices."""
    with open('/proc/bus/input/devices') as devices:
        for block in devices.read().split('\n\n'):
            uniq = re.search(r'^U: Uniq=(.*)$', block, re.M)
            handler = re.search(r'^H: Handlers=.*\b(event\d+)\b', block, re.M)
            if uniq and handler and SUNSHINE_UNIQ.search(uniq.group(1)):
                return '/dev/input/' + handler.group(1)
    return None


def log(record):
    print(json.dumps(record), flush=True)


class Presses(QObject):
    """Reads the pad on its own thread and signals each Up press with its evdev time."""

    pressed = pyqtSignal(int, int)

    def __init__(self, device):
        super().__init__()
        self.device = device
        self.edge = 0

    def start(self):
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        up = False
        with open(self.device, 'rb', buffering=0) as pad:
            while True:
                data = pad.read(EVENT.size)
                if len(data) < EVENT.size:
                    return
                seconds, micros, kind, code, value = EVENT.unpack(data)
                if kind == EV_ABS and code == ABS_HAT0Y:
                    now = value < 0
                elif kind == EV_KEY and code == BTN_DPAD_UP:
                    now = value != 0
                else:
                    continue
                if now and not up:
                    self.edge += 1
                    self.pressed.emit(self.edge, seconds * 1_000_000 + micros)
                up = now


class FlipWindow(QOpenGLWindow):
    def __init__(self, patch):
        super().__init__()
        self.patch = patch
        self.white = False
        self.pending = []

    def flip(self, edge, evdev_us):
        self.white = not self.white
        self.pending.append({'edge': edge, 'evdevUs': evdev_us, 'state': int(self.white)})
        self.update()

    def paintGL(self):
        side = round(self.patch / self.devicePixelRatio())
        painter = QPainter(self)
        painter.fillRect(QRect(0, 0, self.width(), self.height()), QColor('black'))
        painter.fillRect(QRect(0, 0, side, side), QColor('white' if self.white else 'black'))
        painter.end()

    def swapped(self):
        flip_us = time.time_ns() // 1000
        for record in self.pending:
            log({'event': 'flip', **record, 'flipUs': flip_us})
        self.pending = []

    def keyPressEvent(self, event):
        if event.key() in (Qt.Key.Key_Escape, Qt.Key.Key_Q):
            QGuiApplication.quit()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--device', help='the pad event node (default: find Sunshine\'s)')
    parser.add_argument('--patch', type=int, default=240, help='patch side, physical pixels')
    args = parser.parse_args()
    device = args.device or find_pad()
    if not device:
        sys.exit('no Sunshine virtual pad in /proc/bus/input/devices')

    app = QGuiApplication(sys.argv)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    window = FlipWindow(args.patch)
    window.frameSwapped.connect(window.swapped)
    presses = Presses(device)
    presses.pressed.connect(window.flip)
    window.showFullScreen()
    screen = window.screen()
    log({'event': 'flip-window', 'device': device, 'patch': args.patch,
         'screen': screen.name(), 'size': [screen.size().width(), screen.size().height()],
         'ratio': screen.devicePixelRatio(), 'hz': screen.refreshRate()})
    presses.start()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()
