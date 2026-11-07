# src/streamer/loopback

`flip-window.py` runs fullscreen on the Sunshine PC and flips a patch on each D-pad Up press of
Sunshine's virtual pad, for the 240 fps input-to-photon film (civ7/README.md, "Input to photon").

- Pair presses with flips by time, never by edge number.
- The pad's evdev time can be on its own clock (Sunshine's was, in loop1), so pair by the swap
  time.
