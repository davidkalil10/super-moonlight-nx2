#!/usr/bin/env python3
"""One-shot, peer-pinned, authenticated read-only list test server."""

import argparse
import datetime
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import secrets
import selectors
import signal
import socket
import struct
import subprocess
import tempfile
import time

HELPER = Path('/media/storage2/builds/moonlight/20261109T102740Z-ae67243-worker2-typed-real-list/legacy-helper')
HELPER_HASH = 'd3dc5ad10efa11f73ea5f2c4c8677cddacc3c89f99b8aa9e4d27c932855c0241'
NRO = Path('/media/storage2/builds/moonlight/20261109T091119Z-ae67243-rust-runtime/nro/moonlight-nx2-rust.nro')
NRO_HASH = '6be32b93e7dcbf8f73a413e2ffcf66bd8ab9ebe1e7bffb7f46e3773acc435932'
HEADER = struct.Struct('<IHHII')
MAGIC = 0x31434e4d
MAX_RESPONSE = 65536


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_new(path, data, mode=0o600):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode), 'wb') as out:
        out.write(data)


def write_json(path, obj):
    write_new(path, (json.dumps(obj, sort_keys=True, indent=2) + '\n').encode())


def read_config():
    base = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config')
    raw = json.loads((base / 'moonlight-nx2' / 'hosts.json').read_text())
    hosts = raw['hosts'] if isinstance(raw, dict) else raw
    target = str(ipaddress.IPv4Address(next(item['address'] for item in hosts if item.get('address'))))
    keys = base / 'moonlight-nx2'
    if not keys.exists():
        keys = base / 'hblauncher' / 'moonlight'
    return target, keys


def isolated_list(target, keys, root, timeout):
    with tempfile.TemporaryDirectory(prefix='keys-', dir=root) as temporary:
        config = Path(temporary) / 'moonlight-nx2'
        config.mkdir(mode=0o700)
        for name in ('client.pem', 'key.pem', 'uniqueid.dat'):
            fd = os.open(keys / name, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as source:
                data = source.read(1_048_577)
            if not data or len(data) > 1_048_576 or (name == 'uniqueid.dat' and len(data) != 16):
                raise ValueError('invalid existing paired identity')
            write_new(config / name, data)
        env = dict(os.environ, XDG_CONFIG_HOME=temporary)
        proc = subprocess.Popen([str(HELPER), 'list', target], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                                start_new_session=True)
        try:
            deadline = time.monotonic() + timeout
            buffers = {proc.stdout: bytearray(), proc.stderr: bytearray()}
            with selectors.DefaultSelector() as selector:
                for stream in buffers:
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError('helper deadline')
                    for key, _ in selector.select(remaining):
                        chunk = os.read(key.fileobj.fileno(), 4096)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        else:
                            buffer = buffers[key.fileobj]
                            if len(buffer) + len(chunk) > MAX_RESPONSE:
                                raise ValueError('helper output exceeded bound')
                            buffer.extend(chunk)
            proc.wait(timeout=max(.01, deadline - time.monotonic()))
            if proc.returncode != 0:
                raise ValueError('helper list failed')
            value = json.loads(buffers[proc.stdout], object_pairs_hook=unique_object)
            apps = value['apps']
            if not isinstance(apps, list) or not 1 <= len(apps) <= 256:
                raise ValueError('unsupported app count')
            ids = [item['id'] for item in apps]
            if any(type(item) is not int or not 0 < item <= 0xffffffff for item in ids) or len(set(ids)) != len(ids):
                raise ValueError('invalid app IDs')
            return value, ids
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=3)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON member')
        result[key] = value
    return result


def recv_exact(conn, size, deadline):
    data = bytearray()
    while len(data) < size:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('control deadline')
        conn.settimeout(remaining)
        chunk = conn.recv(size - len(data))
        if not chunk:
            raise EOFError('control EOF')
        data.extend(chunk)
    return bytes(data)


def recv_frame(conn, deadline, limit):
    magic, version, kind, request_id, length = HEADER.unpack(recv_exact(conn, HEADER.size, deadline))
    if magic != MAGIC or version != 1 or not 0 < length <= limit:
        raise ValueError('invalid control frame')
    return kind, request_id, recv_exact(conn, length, deadline)


def send_frame(conn, kind, request_id, obj):
    data = json.dumps(obj, separators=(',', ':'), ensure_ascii=False).encode()
    if not 0 < len(data) <= MAX_RESPONSE:
        raise ValueError('response too large')
    conn.sendall(HEADER.pack(MAGIC, 1, kind, request_id, len(data)) + data)


def private_root(path):
    if not path.is_absolute() or path.exists():
        raise ValueError('fresh absolute directory required')
    path.mkdir(mode=0o700)
    os.chmod(path, 0o700)


def verify_artifacts():
    if sha(HELPER) != HELPER_HASH or sha(NRO) != NRO_HASH:
        raise ValueError('artifact hash mismatch')


def baseline(args):
    verify_artifacts()
    private_root(args.directory)
    target, keys = read_config()
    _, ids = isolated_list(target, keys, args.directory, 12)
    write_json(args.directory / 'baseline.private.json', {'target': target, 'ids': ids})
    write_json(args.directory / 'BASELINE.json', {'status': 'passed', 'count': len(ids), 'ids': ids,
                                                 'helper_sha256': HELPER_HASH, 'nro_sha256': NRO_HASH})
    print(json.dumps({'status': 'passed', 'count': len(ids), 'ids': ids}), flush=True)


def process_start(pid):
    text = Path(f'/proc/{pid}/stat').read_text()
    return int(text[text.rfind(')') + 2:].split()[19])


def guard(args):
    verify_artifacts()
    ready = json.loads((args.directory / 'READY.json').read_bytes(), object_pairs_hook=unique_object)
    pid = ready['pid']
    now = time.monotonic()
    age = (datetime.datetime.now(datetime.timezone.utc) -
           datetime.datetime.fromisoformat(ready['ready_utc'])).total_seconds()
    if (ready['status'] != 'ready' or not 0 <= age <= 60 or now >= ready['deadline_monotonic'] or
            process_start(pid) != ready['process_start_ticks'] or
            ready['launcher_sha256'] != sha(Path(__file__)) or
            (args.directory / 'RESULT.json').exists()):
        raise ValueError('readiness expired or process changed')
    inodes = set()
    for fd in Path(f'/proc/{pid}/fd').iterdir():
        try:
            link = os.readlink(fd)
        except OSError:
            continue
        if link.startswith('socket:[') and link.endswith(']'):
            inodes.add(link[8:-1])
    address = int.from_bytes(ipaddress.IPv4Address(ready['bind']).packed, 'little')
    expected = f'{address:08X}:{ready["port"]:04X}'
    lines = Path('/proc/net/tcp').read_text().splitlines()[1:]
    if not any((parts := line.split())[1] == expected and parts[3] == '0A' and parts[9] in inodes
               for line in lines):
        raise ValueError('listener unavailable or changed')
    print(json.dumps({'status': 'ready', 'age_seconds': round(age, 2), 'pid': pid,
                      'port': ready['port']}), flush=True)


def serve(args):
    verify_artifacts()
    if sha(args.baseline) != args.baseline_sha256:
        raise ValueError('baseline hash mismatch')
    reference = json.loads(args.baseline.read_bytes(), object_pairs_hook=unique_object)
    target, keys = read_config()
    if reference['target'] != target:
        raise ValueError('paired target changed')
    bind = str(ipaddress.IPv4Address(args.bind))
    peer = str(ipaddress.IPv4Address(args.peer))
    if bind == '0.0.0.0' or peer == '0.0.0.0' or not 35 <= args.lifetime <= 180:
        raise ValueError('explicit addresses and bounded lifetime required')
    private_root(args.directory)
    started = time.monotonic()
    token = secrets.token_hex(32).encode('ascii')
    result = {'status': 'failed', 'scope': 'one authenticated read-only list', 'helper_sha256': HELPER_HASH,
              'nro_sha256': NRO_HASH, 'requests': 0, 'response_sent': False, 'clean_eof': False,
              'helper_reaped': False}
    listener = None
    conn = None
    try:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind((bind, 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        session = f'address={bind}\nport={port}\ntoken='.encode() + token + f'\nhost={target}\n'.encode()
        write_new(args.directory / 'client-session', session)
        ready = {'status': 'ready', 'pid': os.getpid(), 'process_start_ticks': process_start(os.getpid()),
                 'ready_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                 'deadline_monotonic': started + args.lifetime, 'port': port, 'bind': bind, 'peer': peer,
                 'baseline_sha256': args.baseline_sha256, 'helper_sha256': HELPER_HASH, 'nro_sha256': NRO_HASH,
                 'launcher_sha256': sha(Path(__file__)), 'expected_count': len(reference['ids'])}
        write_json(args.directory / 'READY.json', ready)
        print(json.dumps({'status': 'ready', 'record': str(args.directory / 'READY.json')}), flush=True)
        listener.settimeout(max(0.01, started + args.lifetime - time.monotonic()))
        conn, remote = listener.accept()
        listener.close()
        listener = None
        if remote[0] != peer:
            raise ValueError('peer rejected')
        deadline = min(started + args.lifetime, time.monotonic() + 35)
        kind, ident, authentication = recv_frame(conn, deadline, 64)
        if (kind, ident) != (1, 0) or not hmac.compare_digest(authentication, token):
            raise ValueError('authentication rejected')
        send_frame(conn, 2, 0, {'version': 1, 'ready': True})
        kind, ident, payload = recv_frame(conn, deadline, 4096)
        request = json.loads(payload, object_pairs_hook=unique_object)
        if (kind, ident) != (3, 1) or request != {'op': 'list', 'host': target}:
            raise ValueError('request rejected')
        result['requests'] = 1
        value, ids = isolated_list(target, keys, args.directory, min(12, max(.01, deadline - time.monotonic())))
        result['helper_reaped'] = True
        if ids != reference['ids']:
            raise ValueError('app IDs changed from independent baseline')
        send_frame(conn, 4, 1, {'event': 'result', 'op': 'list', 'ok': True, 'value': value})
        result['response_sent'] = True
        conn.settimeout(max(.01, deadline - time.monotonic()))
        if conn.recv(1) != b'':
            raise ValueError('second request rejected')
        result.update(status='passed', clean_eof=True, count=len(ids), ids=ids)
    except BaseException as error:
        result['failure'] = type(error).__name__
    finally:
        if conn is not None:
            conn.close()
        if listener is not None:
            listener.close()
        (args.directory / 'client-session').unlink(missing_ok=True)
        result['elapsed_ms'] = int((time.monotonic() - started) * 1000)
        write_json(args.directory / 'RESULT.json', result)
    print(json.dumps({'status': result['status'], 'record': str(args.directory / 'RESULT.json')}), flush=True)
    return result['status'] == 'passed'


def main():
    def terminate(_signal, _frame):
        raise SystemExit(1)

    signal.signal(signal.SIGTERM, terminate)
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='mode', required=True)
    first = sub.add_parser('baseline')
    first.add_argument('--directory', type=Path, required=True)
    launch = sub.add_parser('serve')
    launch.add_argument('--directory', type=Path, required=True)
    launch.add_argument('--baseline', type=Path, required=True)
    launch.add_argument('--baseline-sha256', required=True)
    launch.add_argument('--bind', required=True)
    launch.add_argument('--peer', required=True)
    launch.add_argument('--lifetime', type=int, default=180)
    check = sub.add_parser('guard')
    check.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.mode == 'baseline':
            baseline(args)
            return 0
        if args.mode == 'guard':
            guard(args)
            return 0
        return 0 if serve(args) else 1
    except (OSError, ValueError, KeyError, TypeError, StopIteration, subprocess.SubprocessError):
        print(json.dumps({'status': 'failed', 'reason': 'prerequisite or execution error'}), flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
