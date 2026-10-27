# Deployment controls and archive pathways

Both proxied sensor pages provide current deployment controls and the secondary
**Correct deployment history** action. Unlock the existing Electric Sea admin
session, select an adjacent transition, enter the actual timestamp with `Z` (UTC)
or an explicit offset such as `-07:00`, and provide a short reason. Preview shows
the resulting UTC timestamp, history, proposed boundaries, eligible bucket counts,
and snapshot rebuild scope. Apply is a separate action after review. Changing any
input clears the preview. Refresh rebuild status to distinguish pending/failed
snapshots from complete archive/vector replacement.

`WEATHER_BRAIN_URL`, `WEATHER_BRAIN_STATUS_TOKEN`, and
`WEATHER_BRAIN_INGEST_TOKEN` remain server-side. `ELECTRIC_SEA_ADMIN_PASSWORD`
unlocks the existing HttpOnly, SameSite session cookie. Same-origin checks and the
admin header protect POSTs. The browser never sends Weather Brain tokens.
Descriptions of an operator-entered status token are obsolete.

The narrow proxy exposes history and correction status with GET, and preview/apply
with authenticated POST. Preview uses Weather Brain status authorization; apply
uses ingest authorization. There is no deployment database or new queue on the Pi.

Weather Brain `/latest` and default `/timeseries` read legacy readings. The
current Electric Sea archive is `/timeseries?table=signal_buckets`, requiring
`device_id` and `signal_id`; `/timeseries?table=snapshots` returns hourly documents.
Deployment IDs reference separate historical records. Supabase-to-local-PostgreSQL
hosting migration is separate from the archive-source transition. Snapshot
generation, archive storage, vector indexing, retrieval, and scheduling must each
be checked independently.

The Weather Brain repository contains [PowerShell archive examples](../../weather-brain/docs/archive-pathways.md),
[ordinary changes and NULL-only backfill](../../weather-brain/docs/deployments.md),
[historical correction/API/CLI](../../weather-brain/docs/deployment-corrections.md),
and [snapshot generation and indexing](../../weather-brain/docs/electric-sea-snapshots.md).
Deploy the Weather Brain migration and service update before enabling the Pi
correction UI. Neither installation is restarted by these repository changes.
