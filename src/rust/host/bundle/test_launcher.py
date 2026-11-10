"""Tests for the bundle launcher. Run: python3 -m unittest -v test_launcher (from this directory)."""
import contextlib
import io
import json
import os
import socket
import socketserver
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from launcher import civ7, cli, console, host, paths, settings

CIV7_HOSTS = json.dumps({"hosts": [{"name": "Sunshine", "address": "192.0.2.20", "uniqueid": "ABCDEF"}],
                         "removed": []}).encode()
CIV7_SETTINGS = json.dumps({"size": "1920x1080", "fps": 60, "bitrate": 20, "codec": "h264",
                            "audio": "stereo", "quitOnReturn": False, "optimise": False,
                            "presentHz": 120}, indent=2).encode()
CIV7_DISPLAY = json.dumps({"version": 1, "hosts": {"192.0.2.20": {
    "command": ["/usr/bin/python3", "/opt/bundle/runtime/src/streamer/payload/host-display/kscreen.py"],
    "options": {"output": "DP-2", "waylandDisplay": "wayland-1", "allowCustomModes": True}}}}).encode()


class Scratch(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        environment = mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.root / "config"),
                                                   "XDG_STATE_HOME": str(self.root / "state")})
        environment.start()
        self.addCleanup(environment.stop)
        self.config = paths.config_dir()
        self.config.mkdir(parents=True)


class Civ7Hosts(unittest.TestCase):
    def test_takes_the_civ7_file_and_the_older_plain_list(self):
        self.assertEqual(civ7.check_hosts(CIV7_HOSTS), 1)
        self.assertEqual(civ7.check_hosts(b'[{"address":"192.0.2.20"},{"address":"pc.lan","mac":"00:11:22:33:44:55"}]'), 2)
        self.assertEqual(civ7.check_hosts(b'{"hosts":[],"removed":[{"address":"192.0.2.9"}]}'), 0)

    def test_refuses_what_the_console_would_drop_or_misread(self):
        long = "a" * 64
        for bad in (b"", b"not json", b"\xff\xfe", b"7", b'{"hosts":{}}', b'{"hosts":[7]}',
                    b'{"hosts":[{"name":"PC"}]}', b'{"hosts":[{"address":"  "}]}',
                    b'{"hosts":[{"address":7}]}', b'{"hosts":[{"address":"a"},{"address":"a"}]}',
                    b'{"hosts":[{"address":"a","mac":"00:11"}]}', b'{"hosts":[{"address":"a","name":7}]}',
                    b'{"hosts":[],"removed":{}}', b'{"hosts":[],"removed":[{"uniqueid":"x"}]}',
                    json.dumps({"hosts": [{"address": long}]}).encode(),
                    json.dumps({"hosts": [{"address": "a", "uniqueid": long}]}).encode(),
                    json.dumps([{"address": f"10.0.0.{n}"} for n in range(65)]).encode(),
                    json.dumps({"hosts": [{"address": "a", "name": "n" * 60}] , "pad": "x" * 4096}).encode()):
            with self.assertRaises(civ7.Invalid, msg=bad[:60]):
                civ7.check_hosts(bad)


class Civ7Settings(unittest.TestCase):
    def test_takes_the_civ7_file_with_keys_it_does_not_know(self):
        civ7.check_settings(CIV7_SETTINGS)
        civ7.check_settings(b'{"version":8,"size":"3840x2160","fps":60,"fpsBefore4k":120,"bitrate":12.5,"later":"x"}')
        civ7.check_settings(b"{}")

    def test_refuses_wrong_shapes_and_types(self):
        for bad in (b"[]", b"not json", b'{"fps":"60"}', b'{"fps":true}', b'{"optimise":1}',
                    b'{"size":1080}', b'{"size":"big"}', b'{"codec":["h264"]}', b'{"later":{"a":1}}',
                    b'{"bitrate":"20"}', json.dumps({"pad": "x" * 4096}).encode()):
            with self.assertRaises(civ7.Invalid, msg=bad[:60]):
                civ7.check_settings(bad)


class Civ7Files(Scratch):
    def test_offers_only_valid_files_and_says_why_not(self):
        (self.config / "hosts.json").write_bytes(CIV7_HOSTS)
        (self.config / "settings.json").write_bytes(b'{"fps":"sixty"}')
        files, notes = civ7.console_files(self.config)
        self.assertEqual(files, {"hosts.json": CIV7_HOSTS})
        self.assertEqual(notes, ["hosts.json: ready for the console",
                                 "settings.json: left out, fps has the wrong type"])

    def test_missing_and_empty_files_are_not_offered(self):
        (self.config / "hosts.json").write_bytes(b'{"hosts":[],"removed":[]}')
        files, notes = civ7.console_files(self.config)
        self.assertEqual(files, {})
        self.assertEqual(notes, ["hosts.json: left out, it lists no PC", "settings.json: no Civ7 file"])

    def test_display_options_come_from_the_kscreen_hook(self):
        wanted = {"version": 1, "output": "DP-2", "wayland_display": "wayland-1", "custom_modes": True}
        self.assertEqual(civ7.display_options(CIV7_DISPLAY, "192.0.2.20"), wanted)
        self.assertEqual(civ7.display_options(CIV7_DISPLAY, "192.0.2.99"), wanted)
        bare = json.dumps({"version": 1, "hosts": {"a": {"command": ["/x/kscreen.py"]}}}).encode()
        self.assertEqual(civ7.display_options(bare, "a"), {"version": 1, "custom_modes": False})

    def test_display_options_refuse_other_hooks_and_unsafe_names(self):
        def hook(command=("/x/kscreen.py",), **options):
            return json.dumps({"version": 1, "hosts": {"a": {"command": list(command), "options": options}}}).encode()

        two = json.dumps({"version": 1, "hosts": {"a": {"command": ["/x/kscreen.py"]},
                                                  "b": {"command": ["/x/kscreen.py"]}}}).encode()
        for bad in (b"[]", b'{"version":2,"hosts":{}}', hook(command=("/usr/bin/my-adapter",)),
                    hook(command=()), hook(output="DP-2; reboot"), hook(waylandDisplay="../x"),
                    hook(allowCustomModes="yes")):
            with self.assertRaises(civ7.Invalid, msg=bad[:80]):
                civ7.display_options(bad, "a")
        with self.assertRaises(civ7.Invalid):
            civ7.display_options(two, "c")

    def test_display_json_is_written_once_and_never_replaced(self):
        self.assertEqual(civ7.import_display(self.config, "192.0.2.20"),
                         "display.json: no Civ7 host-display.json")
        (self.config / "host-display.json").write_bytes(CIV7_DISPLAY)
        self.assertIn("written", civ7.import_display(self.config, "192.0.2.20"))
        written = (self.config / "display.json").read_text()
        self.assertEqual(json.loads(written)["output"], "DP-2")

        (self.config / "display.json").write_text('{"version": 1, "output": "HDMI-A-1"}\n')
        self.assertIn("kept", civ7.import_display(self.config, "192.0.2.20"))
        self.assertEqual(json.loads((self.config / "display.json").read_text())["output"], "HDMI-A-1")
        self.assertEqual((self.config / "host-display.json").read_bytes(), CIV7_DISPLAY)


class FakeConsole:
    def __init__(self, files=None, corrupt=False):
        self.files = dict(files or {})
        self.corrupt = corrupt

    def names(self):
        return set(self.files)

    def store(self, name, data):
        self.files[name] = data

    def fetch(self, name):
        return b"other" if self.corrupt else self.files[name]


class Staging(unittest.TestCase):
    imports = {"hosts.json": CIV7_HOSTS, "settings.json": CIV7_SETTINGS}

    def test_empty_console_gets_the_session_and_both_files(self):
        target = FakeConsole()
        notes = console.stage(target, b"session", False, self.imports)
        self.assertEqual(target.files, {"auth-session": b"session", **self.imports})
        self.assertEqual(notes, ["import: hosts.json copied", "import: settings.json copied"])

    def test_console_files_are_never_overwritten(self):
        for blocking in ("settings.json", "settings-0.json", "settings-1.json"):
            target = FakeConsole({"hosts.json": b"console hosts", blocking: b"console settings"})
            notes = console.stage(target, b"session", False, self.imports)
            self.assertEqual(target.files, {"hosts.json": b"console hosts", blocking: b"console settings",
                                            "auth-session": b"session"})
            self.assertEqual(notes, ["import: hosts.json kept, the console has its own",
                                     "import: settings.json kept, the console has its own"])

    def test_each_file_is_decided_on_its_own(self):
        target = FakeConsole({"settings-1.json": b"console settings"})
        console.stage(target, b"session", False, self.imports)
        self.assertEqual(target.files["hosts.json"], CIV7_HOSTS)
        self.assertNotIn("settings.json", target.files)

    def test_a_left_over_session_needs_replace_and_nothing_is_copied_without_it(self):
        target = FakeConsole({"auth-session": b"old"})
        with self.assertRaises(console.Refused):
            console.stage(target, b"new", False, self.imports)
        self.assertEqual(target.files, {"auth-session": b"old"})
        console.stage(target, b"new", True, {})
        self.assertEqual(target.files, {"auth-session": b"new"})

    def test_a_session_that_reads_back_wrong_is_refused(self):
        with self.assertRaises(console.Refused):
            console.stage(FakeConsole(corrupt=True), b"session", False, {})


class FtpHandler(socketserver.StreamRequestHandler):
    """Enough of an FTP server for ftplib: passive transfers into the server's `files`."""

    def reply(self, line):
        self.wfile.write(line.encode() + b"\r\n")

    def data(self):
        connection, _ = self.passive.accept()
        self.passive.close()
        return connection

    def handle(self):
        files = self.server.files
        self.reply("220 ready")
        for raw in self.rfile:
            verb, _, argument = raw.decode().strip().partition(" ")
            if verb in ("USER", "PASS", "TYPE"):
                self.reply("230 ok" if verb != "TYPE" else "200 ok")
            elif verb == "MKD":
                self.reply("550 exists" if argument in self.server.directories else "257 made")
                self.server.directories.add(argument)
            elif verb == "PASV":
                self.passive = socket.create_server(("127.0.0.1", 0))
                port = self.passive.getsockname()[1]
                self.reply(f"227 entering passive mode (127,0,0,1,{port >> 8},{port & 255})")
            elif verb == "NLST":
                self.reply("150 listing")
                with self.data() as connection:
                    connection.sendall("".join(f"{argument}/{name}\r\n" for name in files).encode())
                self.reply("226 done")
            elif verb == "STOR":
                self.reply("150 send")
                with self.data() as connection, connection.makefile("rb") as stream:
                    files[argument.rsplit("/", 1)[-1]] = stream.read()
                self.reply("226 stored")
            elif verb == "RETR":
                self.reply("150 sending")
                with self.data() as connection:
                    connection.sendall(files[argument.rsplit("/", 1)[-1]])
                self.reply("226 sent")
            elif verb == "QUIT":
                self.reply("221 bye")
                return
            else:
                self.reply("502 not implemented")


class OverFtp(unittest.TestCase):
    def setUp(self):
        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), FtpHandler)
        self.server.daemon_threads = True
        self.server.files, self.server.directories = {}, set()
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]

    def test_stages_into_rust_client_and_leaves_console_files_alone(self):
        self.server.files["settings-0.json"] = b"console settings"
        target = console.FtpConsole("127.0.0.1", self.port)
        try:
            notes = console.stage(target, b"address=192.0.2.2\n", False,
                                  {"hosts.json": CIV7_HOSTS, "settings.json": CIV7_SETTINGS})
        finally:
            target.close()
        self.assertEqual(self.server.directories, {"/switch/moonlight-nx2", "/switch/moonlight-nx2/rust-client"})
        self.assertEqual(self.server.files, {"settings-0.json": b"console settings", "hosts.json": CIV7_HOSTS,
                                             "auth-session": b"address=192.0.2.2\n"})
        self.assertEqual(notes, ["import: hosts.json copied", "import: settings.json kept, the console has its own"])

    def test_a_console_without_ftp_is_reported_as_unreachable(self):
        self.server.shutdown()
        self.server.server_close()
        with self.assertRaises(console.Unreachable):
            console.FtpConsole("127.0.0.1", self.port, timeout=2)


class Settings(Scratch):
    chosen = {"version": 1, "address": "192.0.2.2", "sunshine": "192.0.2.2", "console": "192.0.2.10"}

    def test_saves_and_loads_with_defaults_filled_in(self):
        settings.save(self.chosen)
        self.assertEqual(settings.load(), {**self.chosen, "console_port": 5000, "match_display": False,
                                           "import_civ7": False, "worker": "native"})

    def test_refuses_bad_values_and_a_missing_file(self):
        with self.assertRaises(settings.Invalid):
            settings.load()
        for change in ({"console": "switch.lan"}, {"address": None}, {"console_port": 70000},
                       {"console_port": True}, {"worker": "docker"}, {"match_display": "yes"}, {"version": 2}):
            with self.assertRaises(settings.Invalid, msg=change):
                settings.check({**self.chosen, **change})


FAKE_HOST = """#!/bin/sh
if [ "$1" = display ]; then echo "backend: fake"; echo "current: DP-2 1920x1080@60.000 scale 1"; exit 0; fi
if [ "$1" = serve ]; then echo "$@" > "$(dirname "$0")/../arguments"; echo "READY 39381"; exit 0; fi
if [ "$1" = consoles ]; then echo "c1c1 192.0.2.10 1"; echo ok; exit 0; fi
if [ "$1" = pair ]; then echo "$@" > "$(dirname "$0")/../arguments"; echo "the code did not match" >&2; exit 1; fi
head -c 64 > "$(dirname "$0")/../token"
echo "$@" > "$(dirname "$0")/../arguments"
echo "$MOONLIGHT_NX2_WORKER" > "$(dirname "$0")/../worker-mode"
echo "READY 4242"
exec sleep 30
"""


class Bundle(Scratch):
    def setUp(self):
        super().setUp()
        self.bundle = self.root / "bundle"
        (self.bundle / "bin").mkdir(parents=True)
        for name, text in ((host.HOST, FAKE_HOST), (host.WORKER, "#!/bin/sh\n"), ("worker", "#!/bin/sh\n")):
            path = self.bundle / name
            path.write_text(text)
            path.chmod(path.stat().st_mode | stat.S_IXUSR)
        (self.bundle / "moonlight-nx2-pc.service").write_text(
            (paths.BUNDLE / "moonlight-nx2-pc.service").read_text())
        files = [{"path": str(path.relative_to(self.bundle)), "sha256": host.sha256(path)}
                 for path in sorted(self.bundle.rglob("*")) if path.is_file()]
        (self.bundle / "manifest.json").write_text(json.dumps({
            "sourceRevision": "0123456789abcdef", "image": {"name": "localhost/none:none"}, "files": files}))
        patch = mock.patch.object(paths, "BUNDLE", self.bundle)
        patch.start()
        self.addCleanup(patch.stop)

    def run_cli(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            cli.main(list(arguments))
        return output.getvalue()

    def test_a_changed_binary_is_caught_against_the_manifest(self):
        host.verify(self.bundle)
        (self.bundle / host.WORKER).write_text("#!/bin/sh\nexit 1\n")
        with self.assertRaisesRegex(host.Failed, "upstream-worker is missing or differs"):
            host.verify(self.bundle)

    def test_host_start_hands_over_a_fresh_session_and_stops_cleanly(self):
        chosen = settings.check({"version": 1, "address": "127.0.0.1", "sunshine": "192.0.2.20",
                                 "console": "192.0.2.10", "match_display": True, "worker": "container"})
        process, info, session = host.start(self.bundle, chosen)
        self.addCleanup(process.kill)
        token = (self.bundle / "token").read_text()
        self.assertRegex(token, "^[0-9a-f]{64}$")
        self.assertEqual(session.decode(), f"address=127.0.0.1\nport=4242\ntoken={token}\nhost=192.0.2.20\n")
        self.assertEqual((self.bundle / "arguments").read_text().split(),
                         ["127.0.0.1:0", str(self.bundle / "worker"), "--match-display"])
        self.assertEqual((self.bundle / "worker-mode").read_text().strip(), "container")
        self.assertTrue(host.alive(host.latest()))
        self.assertEqual(stat.S_IMODE(os.stat(info["log"]).st_mode), 0o600)
        self.assertTrue(host.stop(info))
        process.wait(5)
        self.assertFalse(host.alive(host.latest()))

    def test_setup_saves_settings_imports_civ7_and_writes_the_unit(self):
        (self.config / "hosts.json").write_bytes(CIV7_HOSTS)
        (self.config / "settings.json").write_bytes(CIV7_SETTINGS)
        (self.config / "host-display.json").write_bytes(CIV7_DISPLAY)
        output = self.run_cli("setup", "--console", "192.0.2.10", "--address", "192.0.2.2",
                              "--sunshine", "192.0.2.20", "--worker", "native", "--import-civ7",
                              "--install-service")
        self.assertEqual(settings.load(), {
            "version": 1, "address": "192.0.2.2", "sunshine": "192.0.2.20", "console": "192.0.2.10",
            "console_port": 5000, "match_display": True, "import_civ7": True, "worker": "native"})
        self.assertEqual(json.loads((self.config / "display.json").read_text()),
                         {"version": 1, "output": "DP-2", "wayland_display": "wayland-1", "custom_modes": True})
        self.assertIn("civ7: hosts.json: ready for the console", output)
        self.assertEqual(cli.imports(settings.load()), {"hosts.json": CIV7_HOSTS, "settings.json": CIV7_SETTINGS})
        unit = (paths.unit_dir() / "moonlight-nx2-pc.service").read_text()
        self.assertIn(f"ExecStart={self.bundle}/moonlight-nx2-pc serve", unit)
        self.assertIn(f"ExecStopPost={self.bundle}/bin/moonlight-nx2-host display restore", unit)
        self.assertNotIn("@BUNDLE@", unit)

    def test_setup_needs_no_console_and_serve_runs_the_service_on_the_fixed_port(self):
        self.run_cli("setup", "--address", "192.0.2.2", "--worker", "native", "--match-display")
        self.assertIsNone(settings.load()["console"])
        with self.assertRaisesRegex(SystemExit, "needs the console's address"):
            self.run_cli("start")
        self.run_cli("serve")
        self.assertEqual((self.bundle / "arguments").read_text().split(),
                         ["serve", "--listen", "0.0.0.0:39381", "--state", str(self.config / "helper"),
                          "--match-display", str(self.bundle / "worker")])

    def test_pairing_commands_go_to_the_host_and_report_its_refusal(self):
        self.run_cli("setup", "--address", "192.0.2.2", "--worker", "native")
        self.assertEqual(self.run_cli("consoles"), "c1c1 192.0.2.10 1\nok\n")
        with self.assertRaisesRegex(SystemExit, "the code did not match"):
            self.run_cli("pair", "12345678")
        self.assertEqual((self.bundle / "arguments").read_text().split(),
                         ["pair", "--state", str(self.config / "helper"), "12345678"])

    def test_setup_again_keeps_earlier_choices_and_imports_nothing_unasked(self):
        self.run_cli("setup", "--console", "192.0.2.10", "--address", "192.0.2.2", "--worker", "native",
                     "--no-match-display")
        (self.config / "hosts.json").write_bytes(CIV7_HOSTS)
        self.run_cli("setup", "--worker", "native", "--console-port", "5001")
        chosen = settings.load()
        self.assertEqual((chosen["console"], chosen["console_port"], chosen["match_display"]),
                         ("192.0.2.10", 5001, False))
        self.assertEqual(cli.imports(chosen), {})
        self.assertFalse((self.config / "display.json").exists())


if __name__ == "__main__":
    unittest.main()
