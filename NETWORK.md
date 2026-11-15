# Getting a smooth stream

The console is almost always on Wi-Fi, and that is where streams break up. Changing these
settings, in this order, has the most effect.

## PC

- **Use a cable.** Connect the PC to the router with Ethernet. Wi-Fi on both ends halves
  the airtime.
- **Pace the stream at high bitrates.** Sunshine sends each frame in bursts of up to 800
  Mbps. A wired PC delivers those bursts faster than Wi-Fi can carry them, and the console
  then loses 64 packets at a time. That shows as choppy 4K and 1440p. Limiting only the
  console's traffic to about 200 Mbps removes the loss. A typical 4K frame then takes
  about 4 ms to send, and a keyframe up to about 40 ms.
  - Linux, replacing `eth0` and the console's address with your own:
    ```sh
    sudo tc qdisc replace dev eth0 root handle 1: htb default 1
    sudo tc class add dev eth0 parent 1: classid 1:1 htb rate 2500mbit
    sudo tc class add dev eth0 parent 1: classid 1:10 htb rate 200mbit ceil 200mbit burst 15k cburst 15k
    sudo tc qdisc add dev eth0 parent 1:1 fq_codel
    sudo tc qdisc add dev eth0 parent 1:10 pfifo limit 4000
    sudo tc filter add dev eth0 parent 1: protocol ip prio 1 u32 \
        match ip dst 192.0.2.50/32 match ip protocol 17 0xff flowid 1:10
    ```
    `sudo tc qdisc replace dev eth0 root fq_codel` undoes it. It does not survive a reboot.
  - Windows: a Policy-based QoS rule (`gpedit.msc`, Computer Configuration → Windows
    Settings → Policy-based QoS) for `sunshine.exe` with an outbound throttle rate of
    200000 Kbps.
  - At 1080p and below, or with the PC on Wi-Fi, this is rarely needed.

## Router

- **5 GHz or 6 GHz, 80 MHz wide**, with the console close enough for a signal of -65 dBm or
  better. Keep 2.4 GHz for other devices.
- **Give the console a fixed address** (DHCP reservation), so a paced rule and the app's
  saved PC keep working.
- **DFS channels work**, but a radar event moves the router to another channel and drops
  the stream for up to a minute or more. If that happens often, pick a channel outside
  DFS. Not every channel is accepted by the console.
- **No band steering or mesh hand-off fights**: if the console keeps changing access point
  or band, pin it to one.

## Sunshine

- **Encoder**: AV1 if the GPU encodes it, otherwise H.264 (set it in the app's Settings).
- **Leave FEC at its default.** Wi-Fi losses come in large runs that extra FEC can't fill;
  pacing helps far more.
- **Resolution**: stream at the TV's resolution, or the handheld's 1080p. 4K needs a strong
  link even when paced.
- **AMD on Linux (VA-API) with H.264**: set `vaapi_strict_rc_buffer = enabled` in
  `sunshine.conf`. Without it, keyframes after a scene cut can grow far past the bitrate and
  come out blocky or frozen on the console until the next one.
- **4K and 120 fps cost latency on the console**: each frame takes longer to decode, so
  1080p60 or 1440p60 answers faster than 4K or 120 fps on the same link. 1440p on H.264 is
  offered at 60 fps only.

## In the app

- **Auto bitrate** steps down by itself when the network loses frames, and a warning says
  so. If it keeps stepping down, fix the network rather than raising it by hand.
- **Full stats**: if the frame rate shown keeps dropping below the stream's while decode
  times stay low, the network is the limit, not the console.
