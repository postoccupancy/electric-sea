'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('new router unit excludes old unit and all dependencies use the correct checkout', () => {
  const router = read('pi-setup/systemd/rf-router.service');
  assert.match(router, /^Conflicts=router\.service$/m);
  assert.match(router, /^After=.*router\.service/m);
  assert.match(router, /^WorkingDirectory=\/home\/pi\/electric-sea\/router$/m);
  assert.match(router, /^Restart=always$/m);
  assert.match(router, /^RestartSec=5$/m);
  assert.match(router, /^WantedBy=multi-user.target$/m);
  assert.doesNotMatch(router, /Wants=resident/);
  const resident = read('pi-setup/systemd/resident.service');
  assert.match(resident, /^Requires=rf-router\.service$/m);
  assert.match(resident, /^After=.*rf-router\.service/m);
  assert.doesNotMatch(read('pi-setup/systemd/controllers.service'), /signal-router/);
});

test('distance publisher and service are retired without removing generic OSC transport', () => {
  for (const file of ['pi-setup/systemd/distance.service', 'pi-setup/scripts/distance-log',
    'sensors/distance/main.py', 'sensors/requirements.txt', 'pi-setup/systemd/router.service']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
  const server = read('router/server.js');
  assert.doesNotMatch(server, /distance: 0/);
  assert.match(server, /oscInSocket\.bind\(OSC_IN_PORT/);
  assert.match(server, /host: 'electric-sky\.local'/);
  assert.doesNotMatch(server, /function fetchIndoor|INDOOR_DASHBOARD_CACHE|refreshIndoorDashboard/);
  assert.match(server, /host: '::', ipv6Only: false/);
});

test('application metadata and installed monitoring agree on rf-router', () => {
  const pkg = JSON.parse(read('router/package.json'));
  const lock = JSON.parse(read('router/package-lock.json'));
  assert.equal(pkg.name, 'rf-router'); assert.equal(pkg.main, 'server.js');
  assert.equal(lock.name, pkg.name); assert.equal(lock.packages[''].name, pkg.name);
  assert.match(read('pi-setup/scripts/router-log'), /-u rf-router\.service/);
  const status = read('pi-setup/scripts/rf-status');
  assert.match(status, /systemctl show rf-router\.service -p MainPID/);
  assert.doesNotMatch(status, /distance|pgrep -f "node server.js"/);
});
