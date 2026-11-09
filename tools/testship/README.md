# T3 testship control

This package prepares OunceHEN, hbmenu and the Moonlight compatibility NRO.
The Moonlight NRO is a diagnostic; streaming is being ported separately.

Use a new persistent directory on the T3. Do not use its `/tmp`, which is
cleared on reboot. The package includes the original BASIC bootstrap, RO/HEN
images, hbloader, hbmenu, programs, ARM64 Node.js and a static T3 controller.
The experimental Wi-Fi ZIP is recorded separately in the package manifest.

## Controller

Inspect the current gadget and processes before starting. Stop an existing
T3 typer normally before its gadget teardown. The controller shares its lock
and USB identity with the existing T3Switch tooling.

From the prepared package directory:

```sh
sudo sh controller/scripts/hid-gadget-up.sh
sudo python3 -B t3.py --socket /run/moonlight-t3.sock serve \
  --driver "$PWD/controller/t3control" --log "$PWD/state/controller.log"
```

Keep that process running. The local socket is accessible only to its owner;
it does not expose a TCP control port. In another terminal, use `t3.py`:

```sh
python3 -B t3.py --socket /run/moonlight-t3.sock request '{"op":"status"}'
python3 -B t3.py --socket /run/moonlight-t3.sock request '{"op":"type","text":"?1","enter":true}'
python3 -B t3.py --socket /run/moonlight-t3.sock request '{"op":"pad","buttons":["a"],"ms":200}'
python3 -B t3.py --socket /run/moonlight-t3.sock request '{"op":"pad","hat":"right","ms":100}'
python3 -B t3.py capture "$PWD/state/screen-01.jpg"
```

Inspect HDMI before and after each menu action. To launch an already selected
native game while holding R, use one controller sequence:

```sh
python3 -B t3.py --socket /run/moonlight-t3.sock request \
  '{"op":"sequence","steps":[{"buttons":["r"],"ms":200},{"buttons":["r","a"],"ms":300},{"buttons":["r"],"ms":10000}]}'
```

Each request releases keyboard and controller input afterward. R remains held
between steps within a sequence. The driver journals command start/completion,
releases idle input after five seconds and retires after an uncertain command.
It does not replay input after a disconnect. Check US keyboard punctuation and
Caps Lock with a harmless Direct-mode command before the exploit bootstrap.

## Testship startup

The saved SmileBASIC program must be `TXT:NS2`. Its BASIC source is included
as `ns2jb/bootstrap.bas`. `--arity 9` supports the earlier saved bootstrap;
use 5 for the supplied normal form. Do not issue REMOVE twice in one process.

To replace an older saved bootstrap, `bootstrap.py` transfers the exact supplied
ASCII source into Direct-mode `C$` through T3. It checks every chunk's length in
BASIC, captures each result, and verifies prefix checksums every ten chunks and
the complete source checksum on-screen. Start from a fresh Direct prompt with
Caps Lock off, and supply `--source ns2jb/bootstrap.bas`, `--socket`, a new
`--evidence` directory, `--capture-url` and `--tesseract`. It stops before saving.
Save the verified string with `SAVEV "TXT:NS2",C$`, observe any overwrite prompt,
then check `LOADV "TXT:NS2" OUT B$` and `B$==C$` before loading slot 0. This is
also the ZIP's documented save format for the demo. Use `--arity 5` afterward.
After inspecting a stopped transfer, `--resume-chunks N` first verifies the
retained prefix's checksum and length, then continues without replaying it.

The HEN starter stages its `testship/hbmenu.nro` to SD `/hbmenu.nro`, and each
regular file in `testship/programs/` to `/switch/`, through the acquisition RPC.
That RPC must still be alive during staging; HEN has no later file-transfer RPC.

The screen-verified launcher needs Python 3 and Tesseract on its host. For a
separate PC, forward its local UNIX socket to the T3 controller socket and use
the PC's Node.js with `--node /absolute/path/to/node`. Use that PC's reachable
LAN address for `--host` and the T3 capture URL for `--capture-url`.

```sh
python3 -B launch.py --socket /run/moonlight-t3.sock \
  --host HOST_LAN_IP --evidence "$PWD/state/launch-01" \
  --direct-text 'OK' --arity 5 --ocr-psm 6
```

Choose `--direct-text` and `--load-prompt` from the actual observed screen.
The launcher verifies package hashes, starts `hen.cjs`, types its exact START
command and waits for native HEN startup. Each screen check saves JPEG and OCR
evidence. It stays open until SmileBASIC closes. It never starts a second exploit
attempt; guarded retries belong to the Wi-Fi archive's own acquisition engine.

After HEN starts, close SmileBASIC normally through HOME. Observe the selected
native game, hold R while launching, and check HDMI. The first launch can
capture that game's policy and enter the stock game; close it normally and
repeat the R-held launch once that outcome is observed. Hbmenu should then
show the staged Moonlight compatibility NRO. Run it, inspect its report, and
press + to verify return to hbmenu.

The supplied testship HEN and hbloader have no outbound diagnostic/file RPC.
Use the acquisition logs and HDMI observations; do not start the older
`hen-diagnostic-server.cjs` expecting this HEN to connect.

Stop the controller with SIGTERM, then remove its gadget:

```sh
sudo sh controller/scripts/hid-gadget-down.sh
```

## Rebuild

Build the static Linux ARM64 controller on m4 using
`t3switch/Dockerfile` and `make OUTPUT=/out/t3control LDFLAGS=-static`.
`t3switch/SOURCE.json` records its MIT source provenance. The source retains
the original text/pico modes and adds the persistent command mode.

`prepare.py --help` lists the required input ZIP, controller, Node runtime,
Node license and native NRO build record. It creates a new package directory
with all file hashes. Build and run records belong under a distinct
`/media/storage2/builds/moonlight/BUILD_ID/` or a remote builder's matching
persistent run directory, then collect them afterward.

For OCR on the PC without a system install, build `OCR.Dockerfile` as
`localhost/moonlight-t3-ocr:20261109` and pass the executable `ocr.sh` wrapper
to the launcher's `--tesseract`. Its container has no network access at run time.
