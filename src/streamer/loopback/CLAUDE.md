# src/streamer/loopback

Camera-free latency probe: the feeder presses D-pad Up on a timer (`HBL_PROBE_PRESS_MS`),
flip-window.py on the Sunshine PC flips a patch on each press, the helper samples that patch
in every raw unit (`HBL_PROBE_PATCH`), and join.py pairs the three logs per press.

- Both env vars unset means the feeder and helper behave exactly as without the probe.
- Pair by time, never by edge number: each tool counts its own edges.
- The pad's evdev time can be on its own clock (Sunshine's was, in loop1), so a press pairs
  with its flip by the swap time; A and B are kept only when evdevUs is on the wall clock.
- Quote `total` (both stamps on the host); AB and C split the PC-host NTP skew.
- The probe decode (`D`, `probe-stats`) is the host's own ffmpeg cost, not the console's.
