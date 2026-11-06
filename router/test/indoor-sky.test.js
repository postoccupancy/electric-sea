'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { createAdmin } = require('../admin-session');
const { installIndoorRoutes, writeUsbCommand, isIndoorPcm } = require('../indoor-sky');

test('local dashboard and authenticated restart work without any device HTTP dependency', async t => {
  const app = express(); app.use(express.json());
  const admin = createAdmin({ ELECTRIC_SEA_ADMIN_PASSWORD: 'test-owner' });
  admin.install(app);
  let connected = true, receivedAt = 9000, commandOk = true;
  const commands = [];
  installIndoorRoutes(app, { requireAdmin: admin.requireAdmin, now: () => 10000,
    getUsb: () => ({ connected, receivedAt, status: { healthy: true, uptime_ms: 42 }, diagnostics: { packets_missing: 0 } }),
    sendCommand: command => { commands.push(command); return commandOk; } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + '/indoor-sky/')).text();
  assert.match(html, /id="wb-deployment"/);
  assert.match(html, /id="pcmToggle"/);
  assert.doesNotMatch(html, /192\.168\.0\.32|wss:\/\/adrian-pi/);
  assert.equal((await fetch(base + '/indoor-sky', { redirect: 'manual' })).status, 308);
  assert.equal((await fetch(base + '/indoor-sky/status')).status, 200);
  receivedAt = 5000;
  const stale = await fetch(base + '/indoor-sky/status');
  assert.equal(stale.status, 503);
  assert.equal(stale.headers.get('cache-control'), 'no-store');
  assert.equal((await stale.json()).healthy, false);
  connected = false;
  assert.equal((await fetch(base + '/indoor-sky/')).status, 200);
  assert.equal((await fetch(base + '/indoor-sky/status')).status, 503);
  assert.equal((await fetch(base + '/indoor-sky/restart', { method: 'POST' })).status, 401);
  assert.equal(commands.length, 0);
  const login = await fetch(base + '/api/admin/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Electric-Sea-Admin': '1' },
    body: JSON.stringify({ password: 'test-owner' }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-Electric-Sea-Admin': '1' };
  commandOk = false;
  assert.equal((await fetch(base + '/indoor-sky/restart', { method: 'POST', headers })).status, 503);
  connected = true; receivedAt = 9999; commandOk = true;
  assert.equal((await fetch(base + '/indoor-sky/restart', { method: 'POST', headers })).status, 200);
  assert.deepEqual(commands, ['INRS', 'INRS']);
  assert.equal((await fetch(base + '/indoor-sky/restart')).status, 404);
});

test('USB commands use only an existing descriptor, complete short writes and reject stalled/disconnected writes', () => {
  let writes = 0;
  const write = (fd, command) => { writes++; assert.equal(fd, 7); return Buffer.byteLength(command); };
  assert.equal(writeUsbCommand(null, 'INRS', write), false);
  assert.equal(writeUsbCommand({ fd: -1 }, 'INRS', write), false);
  assert.equal(writeUsbCommand({ fd: 7 }, 'BAD!', write), false);
  for (const command of ['INRS', 'INP1', 'INP0']) assert.equal(writeUsbCommand({ fd: 7 }, command, write), true);
  assert.equal(writes, 3);
  const chunks = [];
  assert.equal(writeUsbCommand({ fd: 7 }, 'INRS', (fd, chunk) => { chunks.push(chunk); return 2; }), true);
  assert.deepEqual(chunks, ['INRS', 'RS']);
  assert.equal(writeUsbCommand({ fd: 7 }, 'INRS', () => 0), false);
  assert.equal(writeUsbCommand({ fd: 7 }, 'INRS', () => { throw Error('closed'); }), false);
});

test('Indoor PCM never falls through to HTTP when disconnected; network PCM remains intact', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const fn = source.slice(source.indexOf('function updatePcmSource('), source.indexOf('function setPcmSourceEnabled('));
  const commands = [], requests = [], unavailable = [];
  const context = { pcmSourceIp: device => device.includes('indoor') ? '192.168.0.32' : '192.168.0.44',
    pcmSourceEnabled: new Map([['pcm/indoor-sky/audio', true]]),
    sourceNames: new Map([['192.168.0.32', 'indoor-sky']]), isIndoorPcm,
    sendIndoorUsbCommand: c => { commands.push(c); return false; }, console: { warn() {} },
    markPcmDerivedUnavailable: d => unavailable.push(d),
    http: { get(options) { requests.push(options); return { on() {} }; } } };
  vm.createContext(context); vm.runInContext(fn, context);
  context.updatePcmSource('pcm/indoor-sky/audio');
  context.pcmSourceEnabled.set('pcm/indoor-sky/audio', false);
  context.updatePcmSource('pcm/indoor-sky/audio');
  assert.deepEqual(commands, ['INP1', 'INP0']); assert.equal(requests.length, 0);
  assert.equal(unavailable.length, 1);
  context.updatePcmSource('pcm/electric-sky/audio');
  assert.equal(requests[0].host, '192.168.0.44');
  assert.equal(requests[0].path, '/audio/raw?enabled=0');
});
