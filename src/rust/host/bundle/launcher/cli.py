"""moonlight-nx2-pc: set up, start and keep the PC side of Moonlight for Switch 2 running."""
import argparse
import signal
import socket
import subprocess
import sys
import time

from . import civ7, console, host, paths, settings

RETRY_SECONDS = 5


def local_address(toward):
    """This computer's address on the network that leads to `toward`; nothing is sent."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        probe.connect((toward, 9))
        return probe.getsockname()[0]


def worker_mode(bundle, image):
    """native when this system has every library the worker loads, else the build image."""
    listing = subprocess.run(["ldd", str(bundle / host.WORKER)], capture_output=True, text=True)
    missing = [line.split()[0] for line in listing.stdout.splitlines() if "not found" in line]
    if listing.returncode == 0 and not missing:
        return "native", "worker: runs on this system's libraries"
    if subprocess.run(["podman", "image", "exists", image], capture_output=True).returncode == 0:
        return "container", f"worker: runs inside {image} (missing here: {', '.join(missing)})"
    raise SystemExit(f"The worker cannot run: this system lacks {', '.join(missing) or 'its libraries'} "
                     f"and the image {image} is not installed. See README.md, Install.")


def display_status(bundle):
    result = subprocess.run([str(bundle / host.HOST), "display", "status"],
                            capture_output=True, text=True)
    return result.stdout.strip(), result.returncode == 0 and "unavailable" not in result.stdout


def install_service(bundle):
    unit = (bundle / "moonlight-nx2-pc.service").read_text().replace("@BUNDLE@", str(bundle))
    directory = paths.unit_dir()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "moonlight-nx2-pc.service").write_text(unit)
    print(f"service: wrote {directory / 'moonlight-nx2-pc.service'}")
    print("service: start it now and at every login with")
    print("  systemctl --user daemon-reload && systemctl --user enable --now moonlight-nx2-pc")


def setup(args):
    bundle = paths.BUNDLE
    manifest = host.verify(bundle)
    print(f"bundle: {manifest['sourceRevision'][:7]}, {len(manifest['files'])} files match the manifest")
    try:
        chosen = settings.load()
    except settings.Invalid:
        chosen = {"version": settings.VERSION}
    for key in ("console", "sunshine", "address", "console_port"):
        if getattr(args, key) is not None:
            chosen[key] = getattr(args, key)
    if "console" not in chosen:
        raise SystemExit("Give the console's address: setup --console CONSOLE_IP")
    chosen.setdefault("address", local_address(chosen["console"]))
    chosen.setdefault("sunshine", chosen["address"])
    if args.worker:
        chosen["worker"] = args.worker
        print(f"worker: {args.worker}, as asked")
    else:
        chosen["worker"], note = worker_mode(bundle, manifest["image"]["name"])
        print(note)
    status, usable = display_status(bundle)
    print("display: " + status.replace("\n", "\ndisplay: "))
    if args.match_display is not None:
        chosen["match_display"] = args.match_display
    chosen.setdefault("match_display", usable)
    print("display: Optimise game settings " +
          ("switches this display" if chosen["match_display"] else "leaves this display alone"))
    if args.import_civ7:
        chosen["import_civ7"] = True
        paths.config_dir().mkdir(mode=0o700, parents=True, exist_ok=True)
        print("civ7: " + civ7.import_display(paths.config_dir(), chosen["sunshine"]))
        for note in civ7.console_files(paths.config_dir())[1]:
            print("civ7: " + note)
        print("civ7: files go to the console at the next start, where it has none of its own")
    try:
        chosen = settings.save(chosen)
    except settings.Invalid as error:
        raise SystemExit(f"Not saved: {error}") from None
    print(f"saved {paths.config_dir() / settings.FILE}: this PC {chosen['address']}, "
          f"Sunshine {chosen['sunshine']}, console {chosen['console']}:{chosen['console_port']}")
    if args.install_service:
        install_service(bundle)


def imports(chosen):
    return civ7.console_files(paths.config_dir())[0] if chosen["import_civ7"] else {}


def send_session(chosen, session, replace):
    target = console.FtpConsole(chosen["console"], chosen["console_port"])
    try:
        return console.stage(target, session, replace, imports(chosen))
    finally:
        target.close()


def start(args):
    chosen = settings.load()
    host.verify(paths.BUNDLE)
    previous = host.latest()
    if host.alive(previous):
        raise SystemExit(f"Host {previous['pid']} is still running; run `moonlight-nx2-pc stop` first")
    process, info, session = host.start(paths.BUNDLE, chosen, args.timeout)
    try:
        for note in send_session(chosen, session, args.replace):
            print(note)
    except (console.Unreachable, console.Refused) as error:
        host.stop(info)
        raise SystemExit(f"Not started: {error}") from None
    print(f"Ready on {chosen['address']}:{info['port']}, log {info['log']}")
    print("Start Moonlight on the console now. This host serves that one launch.")


def serve(_):
    chosen = settings.load()
    host.verify(paths.BUNDLE)
    stopping = False

    def end(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, end)
    signal.signal(signal.SIGINT, end)
    while not stopping:
        process, info, session = host.start(paths.BUNDLE, chosen)
        print(f"host {info['pid']} ready on port {info['port']}", flush=True)
        staged = False
        while process.poll() is None and not stopping:
            if not staged:
                try:
                    for note in send_session(chosen, session, True):
                        print(note, flush=True)
                    staged = True
                    print("session on the console; waiting for Moonlight to start", flush=True)
                except (console.Unreachable, console.Refused) as error:
                    print(f"console not ready: {error}", flush=True)
            try:
                process.wait(RETRY_SECONDS)
            except subprocess.TimeoutExpired:
                pass
        if process.poll() is None:
            host.stop(info)
        else:
            print(f"host {info['pid']} ended with {process.returncode}", flush=True)
            time.sleep(1)


def stop(_):
    info = host.latest()
    if not host.alive(info):
        print("No host is running")
    elif host.stop(info):
        print(f"Stopped host {info['pid']}")
    else:
        raise SystemExit(f"Host {info['pid']} did not stop; check it by hand")


def status(_):
    info = host.latest()
    if info:
        print(("RUNNING " if host.alive(info) else "EXITED ") + f"pid {info['pid']} port {info['port']}")
        print(open(info["log"], errors="replace").read(), end="")
    else:
        print("No run yet")
    print(display_status(paths.BUNDLE)[0])


def main(argv=None):
    parser = argparse.ArgumentParser(prog="moonlight-nx2-pc", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    command = commands.add_parser("setup", help="check the bundle and save this PC's settings")
    command.add_argument("--console", help="the console's IPv4 address")
    command.add_argument("--console-port", type=int, dest="console_port",
                         help=f"its FTP port (default {settings.DEFAULT_FTP_PORT})")
    command.add_argument("--address", help="this PC's LAN address (default: the one facing the console)")
    command.add_argument("--sunshine", help="the PC Sunshine runs on (default: this PC)")
    command.add_argument("--worker", choices=settings.WORKERS, help="how the worker runs (default: detected)")
    command.add_argument("--match-display", action=argparse.BooleanOptionalAction, default=None,
                         help="let Optimise game settings switch this PC's display")
    command.add_argument("--import-civ7", action="store_true",
                         help="take over the Civ7 host list, settings and display options")
    command.add_argument("--install-service", action="store_true",
                         help="write the systemd user unit")
    command.set_defaults(run=setup)

    command = commands.add_parser("start", help="start a host for one console launch")
    command.add_argument("--replace", action="store_true",
                         help="overwrite a session left on the console")
    command.add_argument("--timeout", type=int, help="end the host after this many seconds")
    command.set_defaults(run=start)

    commands.add_parser("serve", help="keep a host ready, launch after launch").set_defaults(run=serve)
    commands.add_parser("stop", help="stop the running host").set_defaults(run=stop)
    commands.add_parser("status", help="show the last run, its log and the display").set_defaults(run=status)

    args = parser.parse_args(argv)
    try:
        args.run(args)
    except (settings.Invalid, host.Failed) as error:
        raise SystemExit(str(error)) from None
    return 0
