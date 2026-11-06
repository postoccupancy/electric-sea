# rf-router and USB dashboard migration: approval plan

2026-11-06 amendment: user approved repository implementation and requested full
retirement of the GPIO distance service. Remove pi-setup/systemd/distance.service,
pi-setup/scripts/distance-log, sensors/distance/main.py and sensors/requirements.txt
(dedicated GPIO/OSC dependencies), distance monitoring, setup/troubleshooting,
and HC-SR04 example references. Remove unused router distance/rate state only;
retain generic OSC ingestion and unrelated mathematical peak/matching distances.
Live cutover must back up, disable/stop and retire distance.service and distance-log;
rollback must restore their exact prior state if the whole rollout is reverted.
No live retirement, restart, commit or push is authorized yet.

Original audit: 2026-11-05. Repository implementation approved 2026-11-06, including
distance-service removal. Live cutover/configuration/flash/reboot and commit/push
remain unauthorized until separately reviewed and requested.

## Findings and fixed boundaries

- Repository remains postoccupancy/electric-sea, checkout /home/pi/electric-sea,
  Node project directory router/. Application/package/service become rf-router.
  Resident Frequency remains the interface; rf.postoccupancy.com is unchanged.
- Live router.service is enabled, Restart=always/5s, running from the correct
  checkout. HTTPS is already dual-stack on 3000. It has no drop-ins and no Wants
  for resident, unlike the checked-in router.service.
- resident.service is enabled but inactive; Requires/After reference router.service.
  Do not silently start it during this migration. Record and restore its actual
  active/enabled state, and change its dependency in the coordinated unit update.
- distance.service is enabled and repeatedly fails with status 200/CHDIR at the
  obsolete /home/pi/signal-router/sensors/distance directory. controllers.service
  is disabled/inactive with the same stale checkout prefix. These predate the
  proposed work. Retire distance code/unit at user request; correct only the optional controller
  template, without enabling or restarting controllers.
- cloudflared is active and independent of router.service. Keep tunnel settings,
  TLS certificates, HTTPS dual-stack, Tailscale and all network configuration.
- Indoor HTML currently comes from firmware /dashboard or a persistent cache in
  ~/.cache/signal-router. Stale status and failed restart fall back to HTTP at
  192.168.0.32. PCM USB selection also uses that IP and can fall through to HTTP.
- Firmware Dashboard.h already parses rf-router sample_batch messages, but has
  hardcoded WebSocket/status paths and an obsolete GET restart handler. The
  injected deployment-control.js currently replaces restart with authenticated POST.
- Weather Brain README has a current architecture note followed by contradictory
  cloud-hosted database/Cloud Run/current AM2320 claims. Dated research notes are
  historical and should be labelled, not rewritten as current deployment facts.

## Exact proposed repository changes

### Electric Sea

| File | Change |
| --- | --- |
| router/package.json | name=rf-router, correct main=server.js and application description; add start script. |
| router/package-lock.json | Update root package metadata only; do not upgrade dependencies. |
| router/server.js | rf-router process/log identity; install local Indoor routes, remove Indoor HTTP/cache/refresh logic; distinguish USB PCM by transport identity rather than IP/network availability. Keep Electric Sky proxy intact. |
| router/indoor-sky.js (new) | Small route installer with injected USB status/command functions and freshness clock for isolated tests. |
| router/pages/indoor-sky.html (new) | Canonical checked-in dashboard, derived from current Dashboard.h HTML; same plots/diagnostics/delay controls, relative status URL and same-origin ws/wss. Display unavailable/stale USB status clearly. |
| router/deployment-controls.js | Keep deployment injection/admin behavior; use Resident Frequency as browser breadcrumb label. |
| router/test/deployment-controls.test.js | Adjust breadcrumb expectation; preserve deployment/correction/auth assertions. |
| router/test/indoor-sky.test.js (new) | Dashboard/USB route/PCM tests, including disconnected/stale/error cases and absence of Indoor Wi-Fi calls. |
| router/test/indoor-sky-browser.test.js (new) | Exercise actual served HTML/control handlers with browser fixtures or existing DOM test approach; require a real-browser review before live cutover. |
| pi-setup/systemd/router.service -> rf-router.service | Rename template; Description/SyslogIdentifier rf-router, same User/WorkingDirectory/ExecStart/restart policy and install target; Conflicts=router.service and After=router.service for ordered exclusion. No old-name alias. |
| pi-setup/systemd/resident.service | Requires/After rf-router.service, preserving sidecar execution settings. |
| pi-setup/systemd/distance.service, pi-setup/scripts/distance-log, sensors/distance/main.py, sensors/requirements.txt | Delete retired GPIO publisher/unit/helper/dependencies; retire live copies only during authorized cutover. |
| pi-setup/systemd/controllers.service | Correct checkout path; keep disabled/optional status in documentation. |
| pi-setup/scripts/rf-status | Query rf-router's systemd state/MainPID instead of generic node server.js process matching; preserve status utility name. |
| pi-setup/scripts/router-log | Follow rf-router.service; retain router-log command for operator compatibility. |
| router/test/service-migration.test.js (new) | Check unit references, exclusion/ordering/restart policy, script/service-name consistency and optional-service handling. |
| README.md | Consistent names, clone postoccupancy/electric-sea, correct checkout paths, fresh install vs migration instructions, current credentials/architecture, no undocumented local deploy script as an installed feature. |
| docs/rf-router-migration.md (new) | Reviewed cutover, backups, rollback, health checks and reboot procedure based on this plan. |
| docs/cwt-osc.md | rf-router service commands and explicit optional sidecar state/recovery. |
| docs/deployments.md | Canonical local dashboard/USB status dependency; terminology only, API examples unchanged. |
| recorder/README.md | rf-router WebSocket naming; no recording format changes. |
| router/ARCHIVAL.md | Local dashboard/USB control flow and rf-router operational names. |
| router/HTTPS.md | rf-router service naming; retain dual-stack verification. |

No changes planned to Cloudflare/Tailscale/network configs, OSC ports/endpoints,
WebSocket message formats, browser storage keys, admin cookie/header names,
PCM stream keys, node IDs or archival API/schema. Other signal-router mentions
are reviewed by meaning, not globally replaced. The old dashboard cache becomes
unused; do not delete it on the live Pi, because it may help rollback.

The new unit will match the live graph and not add Wants=resident.service merely
because the old tracked template has it. Sidecar Requires/After moves together;
active sidecars must be explicitly restored after an operation that stops their
required router. Preserve the sidecar's existing enablement for reboot.

### Indoor Sky

| File | Change |
| --- | --- |
| scripts/deploy_usb_via_pi.sh and scripts/flash_usb_on_pi.sh (new helper) | Add optional ROUTER_SERVICE override; otherwise select the single active router/rf-router unit, or single enabled unit. Reject ambiguity, masked/invalid units and absent candidates before stopping anything. Carry selected unit through stop/recovery trap. Preserve Windows native SSH, Mac paths and MSYS_NO_PATHCONV. Record/restore an active resident sidecar if dependency stop takes it down. Report recovery failure instead of suppressing it. |
| tests/test_deploy_usb.py (new) | Mock service/SSH/SCP/flasher operations: old/new/rollback states, both-active/both-enabled rejection, explicit override, POSIX remote paths, flash failure restoration and recovery failure propagation. Never flash real hardware. |
| README.md | Electric Sea hosts canonical dashboard; describe coordinated service transition and unchanged firmware identity. |
| docs/deployment.md | rf-router commands, transitional selection/override, recovery/preflight checks, no concurrent deployment during cutover. |
| docs/usb-protocol.md | Remove description of HTTP fallback; same protocol fields and commands. |
| src/main.cpp | Only obsolete response text 'Dashboard moved to signal-router' becomes 'Dashboard moved to rf-router'; preserve redirect URL and all firmware behavior. No flash needed for router migration. |

Keep include/Dashboard.h and firmware HTTP endpoints available for older router
rollback, but the new router never fetches them. Their removal is a later firmware
cleanup, not a prerequisite for Wi-Fi-independent operation.

### Weather Brain

| File | Change |
| --- | --- |
| README.md | Current Windows FastAPI/local PostgreSQL/Ollama architecture and Electric Sea/Indoor/Electric Sky roles first; move AM2320/Cloud Run/cloud database narrative under explicit history. Update service references without API changes. |
| docs/agent-policy.md | Replace stale esp32_api interpreter/workspace paths with this checkout's root .venv (Windows .venv/Scripts/python.exe) and server/ application; keep policy and context distinct. |
| docs/agent-context.md | Current rf-router implementation/rollout state and cross-repo dependencies; retain dated old service/build history as history. |
| docs/archive-pathways.md | Current local PostgreSQL and rf-router archival forwarding; distinguish historical hosting migration from archive source. |
| docs/2025-12-17-open-source-agent-stack.md | Add dated historical configuration banner linking current README. |
| docs/2026-01-27-rag-setup-and-next-steps.md | Same historical banner; preserve original research notes. |
| docs/indoor-sky-extraction-plan.md | Append current local-dashboard/new-service note; don't rewrite original reviewed extraction history. |

Keep server/app/api/timeseries_router.py hosting-neutral explanation and all
routes/ingestion/schema untouched. Supabase references in ignored-folder rules
and historical correction evidence are not active hosting configuration.

Searches of esp32_ui/weather-music found no affected service calls. The website
postoccupancy.com contains old signal-router source-provenance comments and README
paths, not service-management calls or renamed endpoints. Optional documentation
follow-up: update its README source paths to electric-sea; preserve historical
attribution comments, with no functional website change required for this cutover.

## USB equivalence gate before removing fallbacks

1. Serve local HTML with deployment controls even if USB/device Wi-Fi is offline.
   Keep /indoor-sky -> /indoor-sky/ redirect and current URLs.
2. /indoor-sky/status serves existing INJS schema plus usb_router diagnostics
   while fresh (same five-second threshold). Return explicit 503/no-store when
   disconnected or stale; never report cached healthy state or try HTTP.
3. Authenticated POST /indoor-sky/restart writes exactly INRS to the existing
   serial descriptor. Return failure if no open USB session/full four-byte write;
   no new temporary TTY open and no Wi-Fi fallback. Verify reboot via subsequent
   uptime/boot/status progression; a successful write is not a reboot ACK.
4. Existing PCM controls write INP1/INP0 using the same descriptor and stable
   pcm/indoor-sky/audio identity. Keep enable/disable/availability messages and
   IMA/PCM decoding. Handle disconnected/reconnected USB without routing Indoor
   commands to HTTP. Existing network PCM/Electric Sky handling stays intact.
5. Prove plot updates, timing/delay controls, status freshness, admin unlock,
   deployment start/change/end/history correction, restart errors and PCM controls
   with fixture-backed integration/browser tests. Assert no request to the Indoor
   Wi-Fi address even on errors. Remove old fetch/cache functions only in this
   tested repository change, never by live cache deletion.

## Controlled cutover and rollback (NOT executed)

The exact reviewed command sequence, private backup policy, old-unit exclusion,
distance retirement, serial/HTTPS guards, optional resident restoration, health
checks, reboot authorization gate and full rollback now live in
[rf-router-migration.md](rf-router-migration.md). That is the canonical runbook;
do not execute earlier draft commands from the original audit. Rollout requires
the compatible Indoor Sky host script and its remote helper on all operator hosts.

## Tests and remaining approvals

Audit baseline: Electric Sea 121 tests passed; Indoor Sky four identity tests and
Bash deployment-script syntax passed. Live metadata inspection was read-only.
Implementation/test results are recorded in [rf-router-validation.md](rf-router-validation.md).
The reviewed validation checklist is:

- Run full router suite, new USB route/PCM/browser tests, admin/deployment tests.
- Run Indoor Sky identity + mocked deployment tests, Bash syntax on Windows and
  actual Mac when available, and build-only USB/OTA if firmware response text changes.
- Run staged unit verification and migration/rollback fixture tests; no live unit
  installation. Check consistency of all service names and package lock metadata.
- Review diffs and final exact runbook. No commit/push until reviewed, and no live
  deployment/restart/config/flash/reboot without explicit authorization.

Implementation also adds .gitattributes for shell/unit LF checkouts. Generic OSC
input and existing WebSocket state message type remain; obsolete distance/rate
state fields and HC-SR04 examples are removed. Mathematical octave distances are
unrelated signal analysis and remain unchanged.
