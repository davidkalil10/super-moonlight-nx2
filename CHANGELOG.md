# moonlight-nx2 1.0.0

Changes since 0.1.0-rc12. Needs kaiHEN release `20261114c` or later.

## Streaming
- While a stream runs, the app lowers the CPU, GPU and memory clocks to what the stream mode needs, which saves battery and heat. If the console starts showing fewer frames than the PC sends, or dropping them, it raises one clock at a time back toward the system's rates. Frames lost on the network don't raise clocks, since faster clocks can't bring them back.
- Opening the stream menu or the keyboard no longer raises clocks; time spent with them open doesn't count.
- The stream menu costs much less to draw over 4K video, which kept docked 4K60 below 60 fps while it was open.
- When the stream ends, the app loses focus or you dock or undock, the clocks go back to the system, so a docked 4K stream gets the full docked rates.
- Auto bitrate starts docked 4K60 at 42 Mbps (AV1) instead of 56, where it used to settle anyway. It can still step down from there.
- The C side of the app is now built for the Switch 2's CPU instead of the Switch 1's.

## Controls
- New **Joy-Con mouse** option (Off, Right, Left). Lay player 1's Joy-Con on a table and it moves the PC mouse; R/ZR (or L/ZL) click left and right, the stick click is middle and the stick scrolls. Those buttons leave the pad while it's the mouse; the other Joy-Con and other players are unchanged.
- New **Mouse sensitivity** option for the Joy-Con mouse, from 0.25× to 3×. Slow moves still count at low settings.
- The stream menu (hold + and −) has a Joy-Con mouse row that turns it off, or back on with the side you used last. While the mouse is on, a Mouse sensitivity row under it changes the speed with left and right. Both take effect at once and are saved.
- The stream menu's Bitrate now shows the stream's bitrate, the same figure as the stats, including after Auto steps it down. It used to show the bitrate measured over the last second, which drops on a still scene.

## Readme
- Says which kaiHEN release you need, thanks kurumuz for kaiHEN and the ounce SDK, and adds a Support link.

## Logs
- `clocks: set …` and `clocks: released …` lines show each clock change, why, and what the system reads back.
- `clocks: hold reason=overlay` is logged each time a menu or the keyboard opens during a stream.
- The input line shows `mouse_moves`, `joycon_mouse` and `mouse_sensitivity`, and a line is logged when the Joy-Con mouse side changes.
