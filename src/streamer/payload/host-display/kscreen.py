#!/usr/bin/env python3
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def kscreen(*args):
    env = dict(os.environ)
    env.setdefault('DBUS_SESSION_BUS_ADDRESS', f'unix:path=/run/user/{os.getuid()}/bus')
    env['QT_QPA_PLATFORM'] = 'wayland'
    return subprocess.check_output(['kscreen-doctor', *args], env=env, text=True, timeout=3)


def output(name):
    outputs = json.loads(kscreen('-j'))['outputs']
    for item in outputs:
        if item['name'] == name and item['connected'] and item['enabled']:
            return item
    raise RuntimeError(f'Configured output {name} is unavailable')


def mode_for(display, width, height, fps):
    modes = [mode for mode in display['modes'] if mode['size']['width'] == width
             and mode['size']['height'] == height and abs(mode['refreshRate'] - fps) < 0.5]
    return min(modes, key=lambda mode: abs(mode['refreshRate'] - fps)) if modes else None


def current_mode(display):
    return next(mode for mode in display['modes'] if mode['id'] == display['currentModeId'])


def set_mode(name, mode, scale):
    kscreen(f'output.{name}.mode.{mode["id"]}', f'output.{name}.scale.{scale}')
    deadline = time.monotonic() + 2
    while True:
        display = output(name)
        current = current_mode(display)
        matches = current['size'] == mode['size'] and abs(current['refreshRate'] - mode['refreshRate']) < 0.5
        if matches and math.isclose(display['scale'], scale, abs_tol=0.01):
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('Display did not apply the requested mode and scale')
        time.sleep(0.05)


def main(request):
    session = request['session']
    if not re.fullmatch(r'[a-zA-Z0-9-]{1,80}', session):
        raise ValueError('Invalid session')
    options = request.get('options', {})
    if options.get('waylandDisplay'):
        os.environ['WAYLAND_DISPLAY'] = options['waylandDisplay']
    state_dir = Path(options.get('stateDirectory', f'/run/user/{os.getuid()}/moonlight-host-display'))
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    state = state_dir / (session + '.json')
    if request['action'] == 'restore':
        if not state.exists():
            return
        original = json.loads(state.read_text())
        display = output(original['output'])
        mode = mode_for(display, original['width'], original['height'], original['fps'])
        if not mode:
            raise RuntimeError('Original display mode is unavailable')
        set_mode(original['output'], mode, original['scale'])
        state.unlink()
        print(json.dumps({'action': 'restored', **original}))
        return
    if request['action'] != 'apply':
        raise ValueError('Unknown action')

    name = options['output']
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', name):
        raise ValueError('Invalid configured output')
    width, height, fps = (request[key] for key in ('width', 'height', 'fps'))
    if not all(isinstance(value, int) and value > 0 for value in (width, height, fps)):
        raise ValueError('Invalid mode')
    display = output(name)
    if not state.exists():
        current = current_mode(display)
        original = {'output': name, 'width': current['size']['width'], 'height': current['size']['height'],
                    'fps': current['refreshRate'], 'scale': display['scale']}
        temporary = state.with_suffix('.tmp')
        temporary.write_text(json.dumps(original))
        temporary.chmod(0o600)
        temporary.replace(state)
    mode = mode_for(display, width, height, fps)
    if not mode and options.get('allowCustomModes'):
        kscreen(f'output.{name}.addCustomMode.{width}.{height}.{fps * 1000}.reduced')
        display = output(name)
        mode = mode_for(display, width, height, fps)
    if not mode:
        raise RuntimeError(f'No configured {width}x{height}@{fps} mode')
    set_mode(name, mode, 1)
    print(json.dumps({'action': 'applied', 'output': name, 'width': width, 'height': height, 'fps': fps, 'scale': 1}))


if __name__ == '__main__':
    try:
        main(json.load(sys.stdin))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
