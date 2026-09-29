# Weather Brain archival forwarding

The router optionally archives normalized numeric OSC scalar streams. Live sends
run first and are unchanged. The archive observes sample batches, signal batches
(including derived bass/mid/high/centroid features), and individual OSC signals.
PCM buffers, capabilities, MIDI and nonnumeric values are excluded.

Set these in the router process environment or its existing `.env` (never commit
the token), then restart the router:

```dotenv
WEATHER_BRAIN_URL=http://WEATHER_BRAIN_LAN_HOST:8000
WEATHER_BRAIN_INGEST_TOKEN=YOUR_WEATHER_BRAIN_INGEST_TOKEN
```

The token must match Weather Brain's `INGEST_TOKEN`. Both settings are required;
absent configuration disables forwarding. Invalid configuration logs a warning
and disables only forwarding. HTTP uses `X-Ingest-Token` and the existing
`POST /ingest/signal-buckets` contract:

```json
{"node_id":"electric-sky","buckets":[{"signal_id":"temperature","unit":"celsius","bucket_start":"2026-09-28T12:00:00.000Z","mean":5,"min":2,"max":9,"stddev":2,"sample_count":8}]}
```

One request contains only one node, as required by Weather Brain, and at most
5,000 one-second records. Every approximately ten seconds, completed records
are flushed in separate requests per node. Ten seconds is not an aggregation
resolution. Weather Brain alone associates deployments; there is no database
connection, location state, raw sample array, or PCM payload here.

## Statistics and time

Welford's online algorithm calculates mean, extrema, actual count and population
standard deviation `sqrt(M2 / count)`. No sample-rate assumption is made. Missing
seconds are omitted, and single-sample standard deviation is zero. These are
sufficient statistics for Weather Brain's weighted mean and pooled population
variance. Received repeated observations count again; this is not packet deduplication.

Sample batches use each `[sequence, timeUs, value]` timestamp. The existing
firmware uses microseconds since boot, not UTC. The first packet's `sendTimeUs`
is anchored to router wall time per node/source; subsequent samples retain that
fixed offset so network jitter does not retimestamp them. Wall-clock accuracy
is limited by initial transport/pacer delay and sensor clock drift. Keep the Pi
clock synchronized. Unix microsecond timestamps, when present, are used directly.
Individual OSC/derived signals currently have no timestamp and use observation
time; a supplied `timeUs` is respected with the same clock convention.

Seconds align to UTC millisecond multiples of 1,000. A two-second lateness window
allows recent out-of-order samples. Finalized intervals never reopen, including
during retries; old/future samples are dropped. A device-clock regression larger
than two seconds is rejected until 30 seconds without a forward-moving device
timestamp, then the clock is reanchored. This conservative reboot handling can
lose the first 30 seconds after restart. A router restart loses in-memory state;
Weather Brain's conflict key preserves already archived records on retry.

Unit changes within a node/signal/second are dropped and logged: the first unit
wins. Weather Brain's unique key lacks unit, so sending two different units for
the same identity would silently discard one. Producers should keep each signal's
unit stable (use distinct signal names when necessary).

## Failure and resource bounds

Active summaries plus queued/in-flight records are bounded at 5,000; clock state
is bounded at 256 node/source pairs. New records are dropped when capacity is
full, preserving frozen retries. Per-second sample count is capped at the API's
100,000 limit. Drop counts/reasons are logged at most once per scheduler tick.
No raw observations are retained and no disk queue is used.

Only one HTTP request runs at a time, with a five-second timeout and a bounded
response body. Failures retry the identical frozen payload after 1, 2, 4, 8, 16,
32, then at most 60 seconds; this includes authentication errors, which require
configuration repair. Successful replies must confirm accepted/inserted/duplicate
counts. Requests are asynchronous; aggregation performs constant work per sample.
In-memory records are lost on process exit. Forwarding is not enabled or deployed
by adding this code; configure the Pi environment to activate it.

Run `node --test test/weather-brain-archive.test.js` from `router` for focused
tests, or `npm test` for the router suite. Tests use fake clocks/transports and a
loopback HTTP server; they do not write to Weather Brain.
