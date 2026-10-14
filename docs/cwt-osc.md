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

## Optional full-scale spectrum (schema version 3)

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
Run both the updated sidecar and router for v3 background data. A sidecar predating
the spectrum feature continues to provide voices but cannot supply spectrum frames;
a v2-era sidecar supplies magnitudes with unavailable background during upgrade.

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
,isddisiii followed by fffifi for every scale in this packet
```

| Argument (1-based, excluding address) | OSC type | Meaning |
|---|---|---|
| 1 | i | Schema version: 3 |
| 2 | s | Opaque publication epoch UUID |
| 3 | d | Monotonically increasing integer publication frame number within epoch |
| 4 | d | Analysis window end `timestampUs`, same source clock as voices |
| 5 | i | Magnitude spectrum valid/ready: 1 or 0 (independent of phase/background availability) |
| 6 | s | Empty when valid; otherwise invalidation reason |
| 7 | i | Total number of scales in the complete valid frame |
| 8 | i | Zero-based first scale index in this packet |
| 9 | i | Number of scale records in this packet |
| 10 onward | f,f,f,i,f,i repeated | frequencyHz, magnitude, phase, phaseValid, backgroundPower, backgroundValid |

Order is the CWT's existing **increasing period / decreasing frequency** order.
The default 48 logarithmic scales have `period[i] = 20^(i/47)` seconds and
`frequency[i] = 1/period[i]` Hz, from 1 Hz to 0.05 Hz. The actual frequencies are
carried in every frame; consumers must not assume 48 or infer frequencies from an
index. OSC `f` rounds scale fields to float32, consistent with the router's scalar
sensor encoding; `d` preserves source timestamp precision and integer frame IDs.
No pitch mapping, MIDI quantization, confidence weighting or display log scaling
is applied to the scale records.

For each record `(frequencyHz, magnitude, phase, phaseValid, backgroundPower, backgroundValid)`,
use phase **only when phaseValid=1**. When phaseValid=0, the phase field is a finite zero placeholder with
no phase meaning; frequency and magnitude remain usable. A measured phase of zero
radians is distinguished by phaseValid=1. All phases can be unavailable while the
magnitude spectrum remains valid (header argument 5 is still 1). Magnitude-only
consumers may ignore both phase fields.

Use backgroundPower as a normalization denominator **only when backgroundValid=1**.
The flag is 1 only for strictly positive finite background power that remains
strictly positive and finite after float32 rounding. Otherwise backgroundPower=0
is a placeholder and backgroundValid=0. Zero, negative, missing, non-finite,
float32-overflowing and float32-underflowing background estimates are unavailable;
no small positive floor is substituted. A valid zero magnitude remains valid even
when no usable denominator exists. The two validity flags are independent; neither
changes the magnitude-valid header or publication schedule.

Version 3 appends backgroundPower and backgroundValid to v2's four-field record.
The nine-field header retains its layout and meaning. Consumers must check
version=3 and use a six-argument stride; v2-only decoders must reject v3. This
endpoint emits v3 only, with no additional fields hidden in v2 packets. Tracked
voice endpoints and `live-cwt.scd` remain unchanged. The sidecar now appends its
existing background value to each internal `(frequency, magnitude, phase)` array.
A new router can accept older sidecar triples during upgrade, but those publish
backgroundValid=0 until the sidecar is updated.

With the address at index 0 (SuperCollider), record `i` starts at
`msg[10 + 6*i]`. An address-free JavaScript `args` array uses `args[9 + 6*i]`.
Offsets 0..5 are frequency, magnitude, phase, phaseValid, backgroundPower,
backgroundValid. A magnitude-driven consumer needs only offsets 0, 1, 4 and 5.

For illustration, a complete three-scale fixture is:

```text
/osc/indoor-sky/temperature/cwt/spectrum
,isddisiiifffififffififffifi
3 "cb75f8fe-a18c-46ec-bf9f-638d389edb07" 1 527348402711 1 "" 3 0 3
1.0 0.002 0.5 1 0.000001 1
0.2236068 0.010 0.0 0 0.000025 1
0.05 0.0 0.0 0 0.0 0
```

Here the second and third scales have unavailable phase; the third scale also has
zero magnitude and unusable background. All three frequency/magnitude pairs are
valid. For the first two records, magnitude/sqrt(backgroundPower) is approximately 2.

The default 48-scale temperature frame now requires **two packets**: 35 records
(offset 0, 1,188 bytes) and 13 records (offset 35, 528 bytes), totaling **1,716 bytes**
of OSC payload. A single unchunked frame would be 1,576 bytes. The existing
1,200-byte UDP payload budget is unchanged; longer addresses or more scales may
produce different chunk boundaries. All chunks share version, address, epoch, frame number, timestamp, validity and total count.
A path whose header alone cannot fit the budget cannot be published.

Reassembly procedure:

1. Key pending frames by `(OSC address, epoch, frame number)`.
2. Check metadata agrees; place each six-field record at `offset + localIndex` and verify
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
window, starting at `floor(sampleCount * 0.75)`. Version 3 preserves the same temporal reduction as v1/v2:

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

A circular phase is considered undefined when power is zero or the circular
resultant is at most machine epsilon times summed power (the existing analyzer
rule). The sidecar represents this as null. The OSC publisher independently marks
null/undefined, non-finite numeric, or out-of-range numeric phases as unavailable.
A phase is available only if finite and within [-pi, pi] before float32 rounding.
Unavailable phase gets phaseValid=0 and the explicitly flagged zero placeholder;
no NaN/Infinity is sent and no phase is synthesized. This does **not** invalidate
frequency/magnitude data, even for a zero-magnitude scale or when every phase is
unavailable. Changes in phase availability obey the existing rate limit, rather
than triggering a frame-level validity transition.

Frequencies must remain positive, finite, representable as positive float32 values,
and strictly decreasing. Magnitudes must remain finite, nonnegative and finite in
float32. Invalid frequency or magnitude data, malformed arrays (other than the
optional phase value), and nonnumeric phase/background values such as strings/objects still
invalidate the entire frame. Missing/empty scales and analysis-not-ready states
also remain invalid. Voice readiness and tracker behavior are unaffected.

Invalid packets have valid=0, total=offset=count=0 and a reason such as
`invalid-scale`, `missing-scales`, `coverage`, `stale`, `idle`,
`timestamp-discontinuity` or `analyzer-disconnected`. `phase-unavailable` is no
longer a frame invalidation reason since v2. Example:

```text
/osc/indoor-sky/temperature/cwt/spectrum
,isddisiii
3 "cb75f8fe-a18c-46ec-bf9f-638d389edb07" 2 527348402711 0 "invalid-scale" 0 0 0
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

### Background model and historical compatibility

The source reference is `esp32_ui/src/pages/dashboard/wavelet.tsx`, inspected at
commit `b4e0c47`: `morletFreq`, `computeCWT`, and `synthesize`. Its historical input
is a gap-filled hourly series; its 50 periods span 6–240 hours. Electric Sea uses
48 periods spanning 1–20 seconds, a 60-second input window resampled at 20 Hz and
boxcar-decimated to 5 Hz (300 analysis samples, zero-padded to 512 FFT bins).
Historical short gaps (up to six hours) are interpolated and longer ones mean-filled;
Electric Sea retains its stricter coverage checks and existing short-gap fill.
These different temporal supports and preprocessing affect the fitted background.

Both implementations subtract the full analysis-series mean (no additional linear
detrend), use a one-sided Morlet with w0=6 and
`H(omega,s) = pi^(-1/4) * exp(-(s*omega-6)^2/2) * sqrt(2*pi*s)` for omega>0,
and an unnormalized forward FFT with inverse divided by Nfft. Both define power
as `|W|^2/s`. Historical periods in hours are numerically periods in samples because
there is one sample per hour. Electric Sea correctly uses
`s = periodSeconds * sampleRate * 6/(2*pi)` and
`f = 1/(periodSeconds * sampleRate)` cycles/sample, rather than using Hz in the
AR factor. The historical arrays store float32 power/background; Electric Sea
retains float64 internally and rounds only the OSC scale fields to float32.
The physical values in the existing magnitude field do not change.

`router/cwt.js:estimateAr1` already evaluates, on the same full decimated/gap-filled
analysis series used for the CWT:

```text
x[t] = input[t] - mean(input)
c0 = sum(x[t]^2)
c1 = sum(x[t] * x[t+1])
c2 = sum(x[t] * x[t+2])
variance = c0/N
alpha = clamp((c1/c0 + sqrt(max(0, c2/c0)))/2, 0, 0.99)
```

As in the historical implementation, lag sums use the common c0 denominator,
without lag-dependent sample-count correction. Electric Sea already guards
`c0 <= Number.EPSILON` by returning variance=alpha=0. Constant and numerically tiny
signals therefore yield zero background; that is transmitted as unavailable for
normalization, while any valid zero or tiny magnitude is preserved. The existing
analyzer rejects windows with fewer than eight decimated samples before CWT.

`computeCwt` already computes the following per scale and `summarizeCwt` retains it:

```text
R(f) = (1-alpha^2) / (1+alpha^2-2*alpha*cos(2*pi*f))
B_s = variance * N/(Nfft*s) * R(f)
```

The existing alpha<0.01 white-noise shortcut uses R=1. The N/Nfft factor preserves
the historical padding convention, and the 1/s factor matches the existing CWT
power definition. Background has the **same units as power / magnitude squared**
(signal units squared under this wavelet normalization). It is one modeled reference
value per scale per analysis window, not a measured extra sensor stream and not a
recent-window average. Magnitude still summarizes the final approximately 15 seconds
of the same full analysis window used to estimate background.

The formula is reused unchanged, since it already drives peak excess ratios.
There is no duplicate fit/transform even when spectrum OSC is enabled. Disabling
spectrum OSC does not skip the existing background calculation needed for tracked
voices, and adds no new background-estimation work.

### Background-normalized amplitude and its limits

After reassembling a valid magnitude frame, for each backgroundValid=1 record:

```text
A_s = magnitude / sqrt(backgroundPower)
    = sqrt(mean_recent(power_s[t]) / backgroundPower)
```

For backgroundValid=0, this ratio is unavailable; do not divide by the placeholder,
substitute epsilon, or interpret 0/0 as zero. Magnitude-only synthesis remains
possible. There is **no per-frame or dataset amplitude normalization** in the feed.
Historical `synthesize` further divided by a maximum amplitude over its entire
scale/time dataset, then normalized audio peaks; neither operation is added here.
The live ratio is RMS significance over a recent interval, not the mean of the
historical instantaneous `sqrt(power/background)` amplitudes.

Physical CWT magnitude retains input-signal amplitude and its units. The ratio A
is dimensionless spectral strength relative to that stream's fitted noise model.
Rescaling a signal rescales both power and background quadratically, approximately
cancelling from the ratio. Thus normalized significance does **not** preserve raw
physical amplitude ratios across temperature, pressure, RMS or other sensor types;
each has its own variance, autocorrelation, units and preprocessing. A is not an
absolute loudness measurement or a calibrated probability of significance.

Mathematical assumptions remain those of the existing model: stationarity within
the window, an AR(1) approximation, evaluation at each wavelet's central frequency,
and the historical N/Nfft padding correction. The background is not an exact
integration of the AR spectrum over the discrete wavelet response, nor a validated
finite-window/edge correction. Changing that model could affect peak extraction
and is outside this compatibility extension. In particular, this change makes no
claim that white-noise normalized power has mean exactly one at every time/scale.

Numerical validation includes hand-counted ramp autocorrelations and an independent
Fourier-series evaluation of the AR autocovariance at all 48 scales. A separate
analytic fixture uses `x[n]=cos(pi*n/2)+0.25*(-1)^n`, n=0..15. Its known DFT bins,
variance 9/16, and clamped alpha=0 give, at period four samples:

```text
recent mean power = 0.8862269254527579
background power  = 0.14726215563702155
normalized RMS    = 2.453165755612409
```

The direct CWT power-array reduction agrees within 1e-12; the OSC float32 magnitude
and background recover the normalized RMS within 2e-7. This checks unit/scale and
serialization consistency against an analytical reference, not against a second
copy of the production computation.

### Deploying v3

Deploy the updated `router/ResidentStreamRegistry.js` and `router/spectrum-osc.js`
with the rest of this commit, then restart both resident and router services.
For the checked-in Pi layout, after updating `/home/pi/electric-sea`:

```sh
sudo systemctl restart router.service resident.service
```

Existing `.env` settings remain sufficient: `CWT_SPECTRUM_OSC_ENABLED=1` and the
existing `CWT_SPECTRUM_OSC_INTERVAL_MS`. The router reads these; no new setting or
service-unit change is needed. Default remains disabled. Update spectrum receivers
to v3 and six-field, multi-packet decoding before use. Voice-only receivers continue
to work unchanged. Check the existing OSC monitor below for version=3, total=48,
and the complete offset ranges. This change has not been deployed to the Pi.

### Future work: phase-faithful reconstruction

These temporally summarized values are suitable for spectral-energy visualization
and magnitude-driven synthesis, but not for phase-faithful reconstruction of the
measured environmental waveform. In particular, do not extrapolate instantaneous
phase from the approximately 15-second circular phase summaries.

A separate future implementation may need:

- Time-indexed complex CWT coefficients, or instantaneous complex coefficients at
  explicitly defined analysis times.
- A consistent phase reference and timestamp semantics.
- Sufficient analysis cadence to track phase evolution.
- Careful treatment of finite-window and edge effects in the CWT.
- A defined reconstruction or resynthesis method that preserves measured phase
  relationships.

None of those capabilities are implemented by this protocol correction.

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
one-analysis-per-second round robin adds at most about 1,716 bytes/second of spectrum
payload per receiver in steady state (plus transition packets and network headers).
A longer per-stream interval can lower this further. The pre-existing magnitude/phase
path performs 48 square roots/compact records per analysis. V3 appends 48 already-computed background values, with validation
and two extra OSC fields per scale. No additional transform or AR fit is run.
This adds at most 384 bytes of numeric values to the per-frame JS arrays (excluding
array overhead), plus their JSON representation on the existing sidecar connection.
Disabled mode adds no spectrum UDP packets or encoding; the compact sidecar metadata remains present.
No Pi CPU measurement or deployment is included in this change.
