# Continuous CWT voices over OSC

The existing `resident-live-controls.js` / `resident-live.js` sidecar now stays
connected to the router and analyzes without browser or OSC consumers. The router
keeps its local resident bridge connected and publishes the same tracked voices
through its existing unicast UDP destinations on port **9000**. No second analyzer
or tracker is created in the router. Raw scalar, batch, MIDI and PCM routing retain
their existing formats and behavior.

## Running

Run the router and resident sidecar together. The checked-in `router.service` now
Wants `resident.service`; the latter already Requires/starts after the router and
restarts on failure. Install both units, verify their WorkingDirectory paths match
the installation (the existing templates use `/home/pi/pi-projects/router` and
`/home/pi/electric-sea/router` respectively), then reload systemd and restart the
services. No Pi deployment was performed by this change. For manual operation,
start `node server.js` and `node resident-live-controls.js` in `router/`.
The sidecar listens only on loopback port 3001; it reconnects after two seconds.

## Standalone receiver

1. Bind a UDP OSC receiver to port **9000** on the receiving machine.
2. Send `/router/subscribe` with one OSC int32 argument `9000` to the router's
   LAN IPv4 address or Tailscale IPv4 address, UDP port **5005**.
3. Send `/router/heartbeat 9000` every ten seconds. Each valid subscribe or
   heartbeat creates/refreshes a 30-second lease and immediately replays cached
   voice state. Repeat subscriptions/heartbeats are safe.
4. Send `/router/unsubscribe 9000` to stop the native lease. Stopping heartbeats
   also expires it after 30 seconds.

The router uses the packet sender's IP, not a supplied IP or the sender's ephemeral
port. Only destination port 9000 is accepted. LAN and Tailscale use exactly the same
unicast path; permit router-bound UDP 5005 and receiver-bound UDP 9000 through the
applicable firewall/Tailscale policy. Use the same network route for registration
and heartbeat. This IPv4 UDP path is not available through a Cloudflare browser
proxy. There is no broadcast discovery or control-message authentication.

WebSocket discovery remains enabled for direct clients. Each browser socket and
the native lease own the destination independently: closing a browser cannot
remove a native lease, and unsubscribe cannot remove a browser-owned destination.
Multiple owners at the same address receive one copy per publication. Registration
receives existing sensor OSC traffic as well as voices. Controls are consumed on
input and never forwarded as sensor signals.

For a dependency-free Python example, run this on the receiving machine (replace
`ROUTER` with the router's LAN or Tailscale IPv4 address):

```python
import socket, struct, time
ROUTER = '192.168.0.10'
def osc_string(s):
    b = s.encode('ascii') + b'\0'
    return b + b'\0' * (-len(b) % 4)
def control(address):
    packet = osc_string(address) + osc_string(',i') + struct.pack('>i', 9000)
    sock.sendto(packet, (ROUTER, 5005))
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(('0.0.0.0', 9000))
sock.settimeout(1)
control('/router/subscribe')
next_heartbeat = time.monotonic() + 10
try:
    while True:
        if time.monotonic() >= next_heartbeat:
            control('/router/heartbeat')
            next_heartbeat = time.monotonic() + 10
        try:
            packet, sender = sock.recvfrom(65535)
            print(sender, packet)  # Replace with your OSC decoder/handler.
        except socket.timeout:
            pass
finally:
    control('/router/unsubscribe')
    sock.close()
```

## Wire format

These are concrete encoded test examples, not measurements of live weather. OSC
`d` is float64, `i` is int32, and `s` is a padded OSC string. Encoding uses the
router's shared existing codec, including its existing float64 support.

```text
/osc/indoor-sky/temperature/cwt/voice/7
,ddddidd  0.125  3.0  0.25  0.8  1  1791900000123456  1791900000123456
```

Arguments, in order:

| Position | Type | Meaning |
|---|---|---|
| 1 | d | Tracker frequencyHz, environmental Hz, without MIDI quantization |
| 2 | d | Tracker strength (smoothed CWT recent power) |
| 3 | d | Tracker phase, radians |
| 4 | d | Tracker confidence, 0–1 |
| 5 | i | Tracker active, 0 or 1 |
| 6 | d | Analysis window end timestampUs, source microseconds |
| 7 | d | Tracker lastTimestampUs, last matched source timestamp |

All tracked voices, including provisional/inactive voices, are sent. IDs come
directly from VoiceTracker (currently starting at 1), remain stable across matches,
and are not reused after readiness loss, staleness or sensor timestamp resets
within one sidecar process. A sidecar restart starts a new ID lifetime.

```text
/osc/indoor-sky/temperature/cwt/voices
,disdii  1791900000123456  1  ""  0.98  1  7
```

Stream state arguments are analysis timestampUs (`d`), ready (`i`), reason (`s`,
empty when ready), coverage (`d`), active count (`i`), then that many active tracker
IDs (`i` each). For two active IDs the tag string is `,disdiii`. The same hierarchy
applies to `/osc/indoor-sky/rms/cwt/...` and
`/osc/electric-sky/pressure/cwt/...`. Only existing `osc/<device>/<signal>` streams
are published as CWT OSC; other resident streams still work in the browser.

When a track disappears the router first sends its final voice packet with
`active=0` and `confidence=0`, retaining its environmental fields and last matched
timestamp. A track's own active=false state is also transmitted normally. Readiness
loss or stream unavailability clears all voices immediately when detected. Example:

```text
/osc/indoor-sky/temperature/cwt/voices
,disdi  1791900000123456  0  "stale"  0.0  0
```

Reasons include analyzer coverage/warm-up reasons, `idle` (explicit router
unavailability), `stale`, `timestamp-discontinuity`, `router-disconnected`, and
`analyzer-disconnected`. Silence expires using the existing 300-second receipt-time
threshold, checked each second; explicit unavailable/disconnect events act sooner.
A frozen source frame does not advance tracker attack/release or rerun CWT. After
an interruption the buffer refills until existing coverage requirements are met.

Treat every `/cwt/voices` active-ID list as authoritative: stop any previously
active ID absent from it, even if its final per-voice packet was lost. The router
repeats cached full state every five seconds and replays it on registration and
heartbeat. UDP cannot guarantee delivery or ordering; repetition repairs ordinary
loss, not a network outage. Receivers should time out if no stream state arrives
for 15 seconds, and regard a sidecar disconnect/restart as a new voice lifetime.
There is no event log or exactly-once delivery. Repeated timestamps are expected
for cached frames, terminations and readiness transitions; do not discard a state
change just because its source timestamp equals the previous frame.

## Timestamps, cadence and reconstruction limits

`timestampUs` is the end of the analyzed source window, not packet reception or
publication time. Batch sample timestamps and scalar `timeUs` are preserved.
Float64 exactly represents integer microseconds within JavaScript's safe integer
range, including present-day Unix timestamps. A missing timestamp is encoded as
-1. Sensor batch clocks may be device uptime, not UTC, and reset on reboot. Legacy
scalar/MIDI inputs without a source timestamp still use the sidecar's existing
millisecond-resolution receipt-clock fallback; no finer source precision exists.
The termination timestamp is the current/last available analysis timestamp, not a
claim about the exact physical time a voice stopped.

Default scheduling remains **one stream per 1000 ms**, round robin. With N streams,
each receives a frame about every N seconds, plus event-loop delays. The analyzer
uses 60 seconds of history, 20 Hz input resampling, four-sample low-pass decimation
to 5 Hz (300 CWT samples), 48 scales, periods 1–20 seconds, and 95% coverage. Recent
power/phase summarize the last quarter of the window (15 seconds). Phase is a
power-weighted circular summary, then tracker-smoothed, not instantaneous phase
at timestampUs. Confidence normally needs three matched frames to activate and
releases over multiple missing frames (maxMisses=6).

Consequently **sub-second voice onset/offset cannot be reconstructed from these
messages**, despite microsecond timestamp representation and the 200 ms internal
sample grid. Future work would need synchronized clock/epoch metadata, retained
source samples or time-indexed CWT coefficients, explicitly timed events/phase,
a measured finer analysis hop, and time-based tracker attack/release. Merely
increasing packet rate or extrapolating this summarized phase will not recover
those events. No weather-brain storage work is included here.

Benchmark the unchanged analysis on the Raspberry Pi before changing cadence:

```sh
cd router
node scripts/benchmark-resident.js
```

A local Apple M1 Pro/macOS run (50 frames, five warm-up frames, default analyzer,
120 seconds of synthetic 50 Hz sensor data) measured **1.21 ms wall and 1.52 ms CPU
per frame**. At one actual frame/second that is about **0.15% of one CPU core** for
analysis alone on that machine. This excludes ingestion, WebSocket/UDP handling,
and other router workloads. Pi cost has not been measured; the host result is not
a Pi estimate. If Pi CPU cost is C ms/frame, the current schedule consumes roughly
C/10 percent of one core. An all-stream H Hz schedule would multiply cost by N×H.
Always-on operation makes this cost continuous rather than browser-dependent.
