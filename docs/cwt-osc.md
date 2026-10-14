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

## Optional full-scale spectrum (schema version 1)

This additive endpoint does not change either `/cwt/voice/<id>` or `/cwt/voices`.
The resident sidecar attaches a compact spectrum to each existing analysis result;
the router selects updates for OSC. No second CWT is computed, and no oscillator
bank or SuperCollider instrument changes are included.

Enable it in the **router's** environment or `router/.env` (restart the router):

```dotenv
CWT_SPECTRUM_OSC_ENABLED=1
CWT_SPECTRUM_OSC_INTERVAL_MS=1000
```

Defaults are `0` (disabled) and `1000` ms. Enabled accepts exactly `0` or `1`;
interval must be finite and at least 1000 ms. A larger interval reduces publication
frequency **per stream**. These settings do not change the resident analysis
schedule, scale configuration, tracking, or voice OSC publication/replay timing.
Both the updated sidecar and router must be running; an older sidecar continues
to provide voices but cannot supply spectrum frames.

The router encodes spectra only when at least one existing OSC destination is
registered. It publishes at most one new valid result per stream per interval;
intermediate results are dropped, not queued. Cached resident frames are not
retransmitted. Invalidation, recovery and new analysis epochs bypass the interval
to communicate state changes promptly. Repeated identical invalid states are
suppressed. Subscribe and heartbeat retain their existing voice replay behavior;
spectra arrive on the next selected new analysis result, not in a heartbeat replay.
No spectrum output timer or new UDP port is added.

### Address and argument layout

```text
/osc/<device>/<signal>/cwt/spectrum
,isddisiii followed by fff for every scale in this packet
```

| Argument (1-based, excluding address) | OSC type | Meaning |
|---|---|---|
| 1 | i | Schema version: 1 |
| 2 | s | Opaque publication epoch UUID |
| 3 | d | Monotonically increasing integer publication frame number within epoch |
| 4 | d | Analysis window end `timestampUs`, same source clock as voices |
| 5 | i | Spectrum valid/ready: 1 or 0 |
| 6 | s | Empty when valid; otherwise invalidation reason |
| 7 | i | Total number of scales in the complete valid frame |
| 8 | i | Zero-based first scale index in this packet |
| 9 | i | Number of scale triples in this packet |
| 10 onward | f,f,f repeated | Environmental frequency Hz, normalized RMS magnitude, circular phase radians |

Order is the CWT's existing **increasing period / decreasing frequency** order.
The default 48 logarithmic scales have `period[i] = 20^(i/47)` seconds and
`frequency[i] = 1/period[i]` Hz, from 1 Hz to 0.05 Hz. The actual frequencies are
carried in every frame; consumers must not assume 48 or infer frequencies from an
index. OSC `f` rounds scale fields to float32, consistent with the router's scalar
sensor encoding; `d` preserves source timestamp precision and integer frame IDs.
No pitch mapping, MIDI quantization, confidence weighting or display log scaling
is applied to the scale triples.

For illustration, a complete three-scale fixture is:

```text
/osc/indoor-sky/temperature/cwt/spectrum
,isddisiiifffffffff
1 "cb75f8fe-a18c-46ec-bf9f-638d389edb07" 1 527348402711 1 "" 3 0 3
1.0 0.002 0.5   0.2236068 0.010 -1.2   0.05 0.003 2.1
```

The production 48-scale temperature frame is **856 bytes**. Packets are limited to
1200 bytes (UDP payload), leaving room for normal LAN/Tailscale overhead. Larger
spectra or longer stream addresses are split into consecutive ranges. All chunks
share version, address, epoch, frame number, timestamp, validity and total count.
A path whose header alone cannot fit the budget cannot be published.

Reassembly procedure:

1. Key pending frames by `(OSC address, epoch, frame number)`.
2. Check metadata agrees; place each triple at `offset + localIndex` and verify
   the range is within `0..totalCount-1`. Identical duplicate chunks are harmless;
   reject conflicting duplicates or metadata.
3. Apply only a complete frame with every scale present. Never mix frame numbers
   or epochs. Discard incomplete frames after a bounded timeout (for example five
   seconds); a subsequent complete update replaces the prior snapshot.
4. Ignore older frame numbers within the current epoch. On an epoch change, discard
   old pending data and treat it as a reset. Epoch UUIDs are opaque, not sortable.

UDP is best-effort, with no retransmission or history. A client joining midway
through a chunked frame waits for the next complete result. Apply a receiver
silence timeout appropriate to stream count and configured interval; spectra do
not have the voice endpoint's five-second replay guarantee.

### Magnitude and phase semantics

`router/cwt.js:computeCwt` computes complex Morlet coefficients `W = re + i*im`
on mean-subtracted, boxcar-decimated data. It stores per-time/per-scale:

```text
power[t] = (re[t]^2 + im[t]^2) / scaleSamples
phase[t] = atan2(im[t], re[t])
scaleSamples = periodSeconds * analysisSampleRate * w0 / (2*pi), w0 = 6
```

`ResidentAnalyzer` already uses `summarizeCwt` over the last quarter of the CWT
window, starting at `floor(sampleCount * 0.75)`. Version 1 preserves that reduction:

```text
magnitude = sqrt(mean(power[t]))
phase = atan2(sum(power[t] * sin(phase[t])), sum(power[t] * cos(phase[t])))
```

Both quantities come from the **same coefficients and same recent time interval**
of one analysis frame. Magnitude is the RMS modulus of the scale-normalized complex
coefficients, in the input signal's units under the existing CWT normalization.
It is **not raw unnormalized |W|**, not power, not an AR(1) excess ratio, and not a
tracker strength. Phase is the existing power-weighted circular summary, not a
tracked phase or an instantaneous coefficient's phase. This pair is not the complex
arithmetic mean of W. Default temporal support is 75 decimated samples (about
15 seconds), within the unchanged 60-second source window at 5 Hz analysis rate.

The timestamp names that source window's end, as it does for voices. Decimation
averages blocks; the final resampled endpoint can be discarded by the existing
floor-to-full-block rule. No instantaneous phase at the window-end timestamp or
sub-second event timing is implied. The CWT's existing finite-window/edge effects
and short-gap interpolation also remain unchanged.

### Invalidity and reset semantics

No unavailable phase is filled with zero. A circular phase is considered undefined
when power is zero or the circular resultant is at most machine epsilon times
summed power. If **any** scale lacks phase, has a non-finite value, overflows float32,
has invalid frequency/order, or has negative magnitude, the entire spectrum is
sent as invalid with no triples. Voice readiness and tracker behavior are unaffected
(e.g. a constant input can be voice-analysis-ready but spectrum-invalid).

Invalid packets have valid=0, total=offset=count=0 and a reason such as
`phase-unavailable`, `invalid-scale`, `missing-scales`, `coverage`, `stale`, `idle`,
`timestamp-discontinuity` or `analyzer-disconnected`. Example:

```text
/osc/indoor-sky/temperature/cwt/spectrum
,isddisiii
1 "cb75f8fe-a18c-46ec-bf9f-638d389edb07" 2 527348402711 0 "phase-unavailable" 0 0 0
```

The sidecar gives each stream-buffer lifetime a UUID and increments an internal
analysis-result counter only on new analyses or invalidation. Cached results retain
that identity. Buffer recreation (timestamp discontinuity, explicit removal,
staleness or sidecar restart) gets a new UUID. The router maps that identity to a
publication epoch UUID, also fresh after router restart, and numbers emitted frames
starting at 1. A readiness change without buffer recreation stays in the same epoch.
A bridge disconnect emits a new invalid publication frame with the last available
source timestamp; it does not fabricate a new source time. Invalid/missing source
time uses -1 and reason `invalid-timestamp`. Source device clocks may be uptime,
not UTC; epoch/frame identity disambiguates reset and repeated timestamps.

### Observe from a subscriber

Use the standalone registration procedure above: listen on 9000, subscribe on
5005, heartbeat every ten seconds. Any OSC monitor that displays float/double/string
arguments can inspect `/osc/*/*/cwt/spectrum`. For a native SuperCollider monitor
only (no synths, and do not run alongside another native client on this IP/port):

```supercollider
(
~spectrumRouter = NetAddr("192.168.0.41", 5005);
thisProcess.openUDPPort(9000);
~spectrumMonitor = { |msg, time, sender, port|
    if((port == 9000) and: { sender.ip == ~spectrumRouter.ip }
        and: { msg[0].asString.endsWith("/cwt/spectrum") }) { msg.postln };
};
thisProcess.addOSCRecvFunc(~spectrumMonitor);
~spectrumRouter.sendMsg('/router/subscribe', 9000);
~spectrumHeartbeat = Routine({ loop {
    10.wait; ~spectrumRouter.sendMsg('/router/heartbeat', 9000);
} }).play(SystemClock);
)
// Cleanup:
~spectrumHeartbeat.stop;
thisProcess.removeOSCRecvFunc(~spectrumMonitor);
~spectrumRouter.sendMsg('/router/unsubscribe', 9000);
```

No Pi analysis-frequency increase is made. At default scale count, the unchanged
one-analysis-per-second round robin adds at most about 856 bytes/second of spectrum
payload per receiver in steady state (plus transition packets and network headers).
A longer per-stream interval can lower this further. The extra work is 48 square
roots/compact triples per analysis, validation and OSC encoding at publication,
and a compact addition to the existing sidecar WebSocket frame. Disabled mode adds
no spectrum UDP packets or encoding; the compact sidecar metadata remains present.
No Pi CPU measurement or deployment is included in this change.
