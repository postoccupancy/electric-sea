# rf-router cutover and rollback

Production source must come from the approved remote revision pulled on the Pi,
not SCP/rsync of this development workspace. Likewise, operator firmware tools and
images must come from a separate clean build checkout fetched from Indoor Sky's
remote, with secrets provisioned separately. A commit/push is not deployment or
restart authorization. Local test builds are not production deployment artifacts.

Repository implementation is validated and approved for publication. **Do not execute these commands
without explicit production deployment authorization.** No live unit, config,
firmware or service was changed while preparing this migration. Supply the
reviewed, published commit below only after production deployment authorization.

Electric Sea remains /home/pi/electric-sea; rf-router remains in router/server.js.
Resident Frequency, rf.postoccupancy.com, TLS, dual-stack 3000, WebSocket/OSC/USB
protocols and Weather Brain integrations are unchanged. The distance publisher,
unit and log helper are retired. No network/Tailscale/Cloudflare change is needed.

## Before the maintenance window

1. Distribute the reviewed Indoor Sky host script **and flash_usb_on_pi.sh helper**
   on every Windows/Mac operator host before retiring router.service. Its service
   selection supports both names and rollback; never flash during cutover.
2. Inspect installed unit drop-ins and custom deploy/monitor scripts, including
   private ~/bin/deploy helpers not in this repository. Reconcile unexpected
   configuration before continuing. Require a clean Pi checkout; never overwrite
   local production edits. Record desired resident/controller enablement and state.
3. On Pi, stage units in a private temporary directory and run
   `systemd-analyze verify /path/to/staged/rf-router.service /path/to/staged/resident.service`.
   Do not install units to test them. Stop if dependency/config errors remain.
4. Existing live baseline at audit: router enabled/active; resident enabled/inactive;
   controllers disabled/inactive; distance enabled but failing at an obsolete path.
   Re-read actual states at rollout, rather than assuming this snapshot still holds.

## Private backup (on Pi)

The archive can contain .env/TLS material. Keep the backup private and never commit
or upload it publicly. Save the printed directory path for recovery.

```bash
set -eu
backup=/home/pi/rf-router-migration-$(date +%Y%m%d-%H%M%S)
sudo install -d -m 700 "$backup"
printf 'Rollback directory: %s\n' "$backup"
test -z "$(git -C /home/pi/electric-sea status --porcelain)"
test -f /etc/systemd/system/router.service
test ! -e /etc/systemd/system/rf-router.service
test ! -L /etc/systemd/system/rf-router.service
git -C /home/pi/electric-sea rev-parse HEAD | sudo tee "$backup/old-head" >/dev/null
for unit in router resident distance; do
  systemctl is-enabled "$unit.service" 2>/dev/null | sudo tee "$backup/$unit.enabled" >/dev/null || true
  systemctl show "$unit.service" -p ActiveState --value | sudo tee "$backup/$unit.active" >/dev/null
  sudo cp -a "/etc/systemd/system/$unit.service" "$backup/$unit.service"
  if test -d "/etc/systemd/system/$unit.service.d"; then
    sudo cp -a "/etc/systemd/system/$unit.service.d" "$backup/"
    echo "Reconcile $unit drop-ins before continuing" >&2
    exit 1
  fi
done
paths=(router)
test ! -d /home/pi/electric-sea/sensors || paths+=(sensors)
sudo tar -C /home/pi/electric-sea -czf "$backup/app-before.tgz" "${paths[@]}"
for helper in rf-status router-log distance-log; do
  if test -f "/usr/local/bin/$helper"; then sudo cp -a "/usr/local/bin/$helper" "$backup/"; fi
done
```

These commands intentionally abort on unknown drop-ins or an existing new unit.
For a retry or customized installation, reconcile the saved state and revise the
reviewed procedure; don't remove guards to force the migration through.

## Controlled migration (same shell)

Replace REVIEWED_COMMIT with the explicitly approved published revision. No npm
dependency upgrade is included; package/lock changes are metadata-only.

```bash
git -C /home/pi/electric-sea fetch origin
sudo systemctl disable --now distance.service
sudo systemctl stop resident.service
sudo systemctl disable --now router.service
test "$(systemctl show router.service -p MainPID --value)" = 0
if sudo fuser /dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_24:EC:4A:0E:B1:DC-if00 >/dev/null 2>&1; then
  echo 'USB still owned; abort and roll back' >&2; exit 1
fi
if ss -H -ltn 'sport = :3000' | grep -q .; then
  echo 'HTTPS still owned; abort and roll back' >&2; exit 1
fi
git -C /home/pi/electric-sea merge --ff-only REVIEWED_COMMIT
sudo mv /etc/systemd/system/router.service "$backup/router.service.retired"
sudo mv /etc/systemd/system/distance.service "$backup/distance.service.retired"
sudo systemctl mask router.service distance.service
if test -f /usr/local/bin/distance-log; then sudo mv /usr/local/bin/distance-log "$backup/distance-log.retired"; fi
sudo install -m 644 /home/pi/electric-sea/pi-setup/systemd/rf-router.service /etc/systemd/system/
sudo install -m 644 /home/pi/electric-sea/pi-setup/systemd/resident.service /etc/systemd/system/
sudo install -m 755 /home/pi/electric-sea/pi-setup/scripts/rf-status /usr/local/bin/rf-status
sudo install -m 755 /home/pi/electric-sea/pi-setup/scripts/router-log /usr/local/bin/router-log
sudo systemctl daemon-reload
sudo systemctl enable --now rf-router.service
sudo systemctl is-active --quiet rf-router.service
case "$(sudo cat "$backup/resident.active")" in active|activating|reloading) sudo systemctl start resident.service;; esac
```

The new unit Conflicts/After the old unit; the old unit is also masked. No alias
allows both services to start. Do not install/start controllers or restart
cloudflared, Tailscale, networking, Windows Weather Brain, or ESP32 firmware here.
The old GPIO source was tracked and is removed by the approved repository update;
leave any unrelated/untracked files for separate review. Old dashboard caches are
unused but retained for rollback. If any command fails, use rollback immediately.

## Verify before ending the window

```bash
systemctl is-enabled rf-router.service
systemctl is-enabled router.service distance.service || true
systemctl show rf-router.service -p MainPID -p ActiveState -p NRestarts
sudo journalctl -u rf-router.service -n 60 --no-pager
sudo ss -ltnp 'sport = :3000'
sudo fuser -v /dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_24:EC:4A:0E:B1:DC-if00
curl --noproxy '*' -4 -kfsS https://127.0.0.1:3000/api/status
curl --noproxy '*' -6 -kfsS 'https://[::1]:3000/api/status'
curl --noproxy '*' -kfsS https://127.0.0.1:3000/indoor-sky/status
```

Expect rf-router enabled/active, router and distance masked/inactive; exactly one
Node PID owns the USB TTY and it matches rf-router MainPID. Check repeated status
samples for progressing counters and no new failures/drops. Follow [HTTPS checks](../router/HTTPS.md)
for scoped link-local IPv6 and clients on LAN/Tailscale/public URL.

Open the real browser interface and /indoor-sky/ on LAN and rf.postoccupancy.com.
Verify plots, delay control, USB stale indication, admin unlock, deployment/history
controls, same-origin WebSocket and PCM enable/disable. Device restart, unplug/replug,
live crash/recovery injection or ESP32 flashing require their own authorization.
Check Electric Sky dashboard/camera/status and OSC remain intact. Read-only check
Weather Brain bucket timestamps advance under unchanged node/deployment IDs.

Enabled status proves configured startup, not an observed reboot. Only with
explicit reboot authorization, reboot Pi and repeat all health/USB/archive checks;
verify new boot ID, rf-router active/enabled, old units masked, desired sidecar
state and no duplicate serial owner. Until then report reboot persistence untested.

## Rollback (same saved backup, no simultaneous services)

Set backup to the saved absolute directory if using a new shell. Stop new first.
Restore the exact old files, including the legacy distance service only as part
of a full rollback. That may restore its pre-existing CHDIR failure; do not treat
rollback as authorization to repair/reconfigure the retired sensor.

```bash
sudo systemctl stop resident.service
sudo systemctl disable --now rf-router.service || true
new_pid=$(systemctl show rf-router.service -p MainPID --value 2>/dev/null || true)
test "${new_pid:-0}" = 0
if test -f /etc/systemd/system/rf-router.service && ! test -L /etc/systemd/system/rf-router.service; then
  sudo mv /etc/systemd/system/rf-router.service "$backup/rf-router.service.failed"
fi
sudo systemctl mask rf-router.service
sudo systemctl unmask router.service distance.service
for unit in router resident distance; do
  sudo cp -a "$backup/$unit.service" "/etc/systemd/system/$unit.service"
done
sudo tar -C /home/pi/electric-sea -xzf "$backup/app-before.tgz"
for helper in rf-status router-log distance-log; do
  if sudo test -f "$backup/$helper"; then sudo cp -a "$backup/$helper" "/usr/local/bin/$helper"; fi
done
sudo systemctl daemon-reload
for unit in router resident distance; do
  case "$(sudo cat "$backup/$unit.enabled")" in
    enabled) sudo systemctl enable "$unit.service";;
    enabled-runtime) sudo systemctl enable --runtime "$unit.service";;
    disabled) sudo systemctl disable "$unit.service";;
    masked) sudo systemctl mask "$unit.service";;
  esac
done
sudo systemctl start router.service
for unit in resident distance; do
  case "$(sudo cat "$backup/$unit.active")" in active|activating|reloading) sudo systemctl start "$unit.service";; esac
done
```

If router originally was inactive, stop it again after recovery checks; restore
the captured active/enablement state rather than assuming defaults. Drop-ins were
an abort condition above; customized rollbacks must restore their saved originals
before daemon-reload. New-only app files can remain unused after archive restore;
reconcile the checkout against saved old-head before any later pull (never run a
blind reset or delete private config). Compatible Indoor Sky scripts select the
active old router and ignore the masked new service. Repeat HTTPS/WS/USB/archive
checks, preserve private backups, and record the rollback outcome.
