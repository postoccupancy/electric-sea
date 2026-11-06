# HTTPS dual-stack verification

HTTPS and its attached WebSocket server share an IPv6 wildcard listener with
`ipv6Only: false`. TLS certificate selection and `PORT` (default 3000) are unchanged.

Verified on the Pi with Node v20.19.2 on 2026-11-05 using an isolated HTTPS server,
existing TLS certificate selection, and an ephemeral port (41121): `ss` showed
one wildcard listener; HTTPS IPv4 loopback, IPv6 loopback, and scoped eth0
link-local requests passed. WebSocket echo passed over both loopback families.
The probe was removed and its listener closed; production port 3000 was untouched.

After reviewing/deploying the change and authorizing a router restart, run on Pi:

The application service is `rf-router.service`. Existing installations must first
follow the [coordinated cutover](../docs/rf-router-migration.md); do not start it
alongside the retired `router.service`.

```bash
sudo ss -ltnp 'sport = :3000'
curl --noproxy '*' -4 -kfsS https://127.0.0.1:3000/ -o /dev/null
curl --noproxy '*' -6 -kfsS 'https://[::1]:3000/' -o /dev/null
ip -6 -o addr show scope link
curl --noproxy '*' -6 -kfsS 'https://[fe80::30dd:351:325d:49b2%25eth0]:3000/' -o /dev/null
```

Expect one wildcard IPv6 listener (`[::]:3000` or `*:3000`); successful curls
establish actual IPv4 and IPv6 acceptance. The link-local example uses the Pi's
eth0 address observed on 2026-11-05; substitute its current address/interface.
`%25` encodes the scope separator in the URL. `-k` bypasses certificate-name/trust
checks for these address-based connectivity tests; certificates are unchanged.

From a LAN client also verify both names and the scoped link-local address:

```bash
curl --noproxy '*' -4 -kfsS https://adrian-pi:3000/ -o /dev/null
curl --noproxy '*' -6 -kfsS https://adrian-pi.local:3000/ -o /dev/null
curl --noproxy '*' -6 -kfsS 'https://[fe80::30dd:351:325d:49b2%25en0]:3000/' -o /dev/null
```

The remote link-local scope is the **client's LAN interface**, not the Pi's:
replace `en0` with the appropriate interface on macOS/Linux or numeric interface
index from `Get-NetIPInterface -AddressFamily IPv6` on Windows. In PowerShell use
`curl.exe` and replace `/dev/null` with `NUL`.

Finally open both dashboards over each working hostname and confirm live
WebSocket updates; check the existing Cloudflare URL and Tailscale URL as well.
These production checks remain pending until the authorized restart.
