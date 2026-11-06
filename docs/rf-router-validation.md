# rf-router migration validation, 2026-11-06

Validation was completed before publication; the user authorized commit/push on
2026-11-06. No live services, units or production configuration were changed.
No firmware uploaded, device restarted or Pi rebooted. Production rollout remains
separately authorized and must use approved source pulled from the remote.

## Results

| Check | Result |
| --- | --- |
| rf-router Node suite | 128 passed, including existing archival/protocol, auth/deployment tests and new Indoor/PCM/unit tests. |
| Indoor Sky Python suite | 17 passed: four build-identity tests and 13 mocked deployment/service-recovery tests. |
| Firmware build-only | USB and OTA PlatformIO environments passed with espressif32 7.1.3; no upload target. |
| Real browser | Headless Edge against an isolated local HTTPS/WebSocket fixture passed actual canvas updates, presentation delay, PCM enable, admin unlock, failed-restart handling and disconnected USB state; no request to device Wi-Fi. |
| HTTPS fixture | IPv4 and IPv6 requests passed on the temporary dual-stack local listener. Production TLS/bind settings were not changed. |
| systemd definitions | Pi systemd-analyze verify passed for staged rf-router/resident/controllers files under /tmp; no installation or daemon-reload. Temporary files removed. |
| Shell scripts | Host deploy helper, remote flash helper, rf-status and router-log parse with Bash. Edited shell/unit files use LF; attributes preserve LF on checkout. |
| Repository checks | Diff whitespace checks passed; package-lock dependency versions unchanged. |
| Live non-interference | router.service PID 9813/start 2026-11-05 16:28:36 PST remained unchanged before/after staged unit validation. |

Tests mock service stop/start and flashing; they do not establish actual physical
ESP32 restart, new-unit ownership/recovery or reboot persistence. Real macOS host
execution is still pending; Unix paths and Windows native SSH/MSYS behavior are
retained and covered by host-script assertions. The firmware response text change
does not require a flash to migrate the Pi application.

## Changed files and dependencies

Electric Sea:

- `.gitattributes`, `router/package.json`, `router/package-lock.json`: application
  metadata/start entry and Unix checkout policy; no dependency upgrades.
- `router/server.js`, new `router/indoor-sky.js`, new
  `router/pages/indoor-sky.html`: local canonical page, fresh USB status,
  authenticated USB restart and transport-based PCM control. The old HTML cache
  and device HTTP fallback are removed from the router. The synthetic .32 source
  key remains for existing stream compatibility, not as an Indoor HTTP target.
- `router/deployment-controls.js`: Resident Frequency breadcrumb; existing admin
  headers, deployment routes and credentials unchanged.
- New `pi-setup/systemd/rf-router.service` replaces `router.service`;
  `resident.service` changes dependencies; `controllers.service` fixes only its
  checkout path. Controller enablement/configuration is not changed live.
- `pi-setup/scripts/rf-status`, `router-log`: new service and systemd MainPID;
  `router-log` command name remains compatible.
- Removed `pi-setup/systemd/distance.service`, `pi-setup/scripts/distance-log`,
  `sensors/distance/main.py`, `sensors/requirements.txt`. Generic OSC remains.
- `router/public/index.html`, `moire/index.html`: replace retired HC-SR04 examples.
  `router/server.js` removes unused distance/rate initial state values while retaining
  the state message type.
- Updated `router/test/admin-session.test.js`, `deployment-controls.test.js`;
  new `indoor-sky.test.js`, `indoor-sky-browser.test.js`, `service-migration.test.js`.
- Updated README, docs/cwt-osc.md, docs/deployments.md, recorder/README.md,
  router/ARCHIVAL.md and router/HTTPS.md. Added migration plan/runbook and this validation record.

Indoor Sky:

- `scripts/deploy_usb_via_pi.sh` plus new `scripts/flash_usb_on_pi.sh`: single active
  or enabled old/new service selection, optional ROUTER_SERVICE override, ambiguous
  states rejected before stopping, exclusive serial check, recovery with original
  flash failure preserved and explicit recovery errors. Previously active resident
  is restored; inactive resident stays inactive. Deploy both files together.
- New `tests/test_deploy_usb.py` covers old/new/rollback service states, ambiguity,
  transitional/mismatched boot state, override, missing/busy serial, failure recovery,
  previously active sidecar and POSIX/Windows invocation conventions.
- README, docs/deployment.md, docs/usb-protocol.md describe canonical rf-router/USB
  ownership and transitional deployment behavior. src/main.cpp changes only obsolete
  redirect response text; firmware Dashboard.h/HTTP routes stay for older-router
  rollback compatibility, not as a dependency of the new router.

Weather Brain:

- README, docs/archive-pathways.md: current Windows FastAPI/local PostgreSQL/Ollama
  and rf-router role; historical Cloud Run/AM2320/hosted database clearly labelled.
- Historical banners in docs/2025-12-17-open-source-agent-stack.md and
  docs/2026-01-27-rag-setup-and-next-steps.md.
- docs/agent-policy.md corrects stale backend interpreter paths;
  docs/agent-context.md and docs/indoor-sky-extraction-plan.md record current state.
  No API implementation, schema, ingestion behavior or persisted data changes.

Outdoor Electric Sky firmware, Cloudflare/Tailscale/network configuration and
website runtime code are unchanged. Website signal-router provenance comments
are historical source attribution, not active service calls.

## Remaining review and manual operations

1. Repository changes are approved for publication. Review the exact
   [cutover/rollback commands](rf-router-migration.md) before separate deployment authorization.
2. Before a separately authorized Pi deployment, update both Indoor Sky deployment
   scripts on operator hosts, including Macs, and audit private deploy helpers.
3. Run the controlled new-unit cutover, with distance retirement, only when
   authorized. The old live distance service is still untouched at this stage.
4. Verify actual new-unit HTTPS/WebSockets, exclusive USB ownership, real PCM,
   deployment controls, requested device restart/reconnection, existing Electric
   Sky Wi-Fi proxy and advancing Weather Brain archive timestamps.
5. Verify real service recovery and reboot persistence only during explicitly
   authorized restart/failure/reboot tests; preserve private rollback backups.
