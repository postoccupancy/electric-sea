# Weather Brain archival forwarding

## Deployment controls

Both router-served node dashboards display current deployment state immediately
on load, without login. Weather Brain remains the sole owner of deployment state.
Public `GET /api/deployments/:node` uses the router's server-held status token;
the browser never supplies or receives either Weather Brain credential.

Set the following in the router environment or `.env`, then restart Electric Sea:

```dotenv
# Electric Sea administrator
ELECTRIC_SEA_ADMIN_PASSWORD=YOUR_ADMIN_PASSWORD

# Electric Sea -> Weather Brain
WEATHER_BRAIN_URL=https://api.postoccupancy.com
WEATHER_BRAIN_STATUS_TOKEN=YOUR_WEATHER_BRAIN_STATUS_TOKEN
WEATHER_BRAIN_INGEST_TOKEN=YOUR_WEATHER_BRAIN_INGEST_TOKEN
```

The admin password authenticates the human to Electric Sea only. Weather Brain
status/ingestion tokens authenticate Electric Sea's server-to-server reads/writes.
They must remain server-side; do not use them as the admin password. No changes to
Weather Brain's API or configuration are needed for this revision.

Start/Edit/End and Restart device request a small admin unlock prompt when needed,
then continue the requested action. Subsequent actions use the session cookie;
public deployment display never depends on admin status. Lock admin logs out.

`POST /api/admin/login` accepts `{ "password": "..." }`; `GET /api/admin/status`
reports authentication; `POST /api/admin/logout` invalidates the session. Login,
logout and administrative writes require `X-Electric-Sea-Admin: 1`; supplied Origin
must match the router Host. No cross-origin admin access is enabled. Password
comparison is timing-safe, and login is limited to ten attempts per minute across
this single-administrator process. A missing admin password disables login.

An opaque, cryptographically random session ID is issued in an HttpOnly,
SameSite=Strict cookie, Secure on HTTPS, scoped to `/`, with a 30-day absolute
lifetime. The server retains only session hashes and expirations, at most eight
sessions; oldest sessions are evicted. Logout, expiration, password changes and
router restart invalidate sessions. Reloads and navigation between the two node
dashboards keep the session. Password fields are cleared after submission; no
password or Weather Brain token is stored in browser storage or session cookies.

The router already serves HTTPS, so production cookies are Secure without trusting
forwarded headers. No Cloudflare or proxy-trust configuration changes are made.
SameSite=Strict is intended for normal same-origin dashboard requests.

Deployment POSTs use reusable `requireAdmin` middleware before forwarding with
the server-held ingestion token. Both `POST /electric-sky/restart` and
`POST /indoor-sky/restart` use that same middleware. Old GET restart URLs no longer
execute a restart. The existing USB/device HTTP restart commands are unchanged.
The Pi never caches or owns deployment state. Public deployment responses contain
the existing deployment fields, including coordinates and notes; treat this as
public dashboard metadata.

Use current location requests browser coordinates once; edit or clear them to
match the sensor. Change closes the old deployment and opens a new one atomically;
history and existing bucket associations remain intact. Historical NULL records
require Weather Brain's explicit dry-run/`--apply` backfill command.

## Archival configuration

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

Sample batches use each `[sequence, timeUs, value]` timestamp. Indoor USB batches
are observed for archival immediately on arrival, before the separate dashboard
presentation pacer. The existing
firmware uses microseconds since boot, not UTC. The first packet's `sendTimeUs`
is anchored to router wall time per node/source; subsequent samples retain that
mapping so sample spacing is preserved. Indoor USB clock drift is corrected by
at most 50 milliseconds per packet against its local arrival time; this prevents
long-running device drift from exceeding the lateness gate without allowing
dashboard pacing or an isolated arrival delay to abruptly retimestamp a stream.
Wall-clock accuracy is limited by initial transport delay and clock correction.
Keep the Pi clock synchronized. Unix microsecond timestamps, when present, are used directly.
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
