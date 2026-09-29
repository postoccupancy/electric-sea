const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createAdmin } = require('../admin-session');
const { installDeploymentProxy } = require('../deployment-controls');

test('bounded expiring sessions, same-origin protection, HTTPS cookie and shared restart authorization', async t => {
  let now = 1000, restarts = 0;
  const env = { ELECTRIC_SEA_ADMIN_PASSWORD: 'owner' };
  const admin = createAdmin(env, () => now);
  const app = express(); app.use(express.json());
  // Emulate the actual server's TLS property without adding production proxy trust.
  app.use((req, res, next) => { Object.defineProperty(req, 'secure', { value: true }); next(); });
  admin.install(app);
  app.post('/indoor-sky/restart', admin.requireAdmin, (req, res) => { restarts++; res.send('restarting'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Electric-Sea-Admin': '1' };
  const login = () => fetch(base + '/api/admin/login', { method: 'POST', headers, body: '{"password":"owner"}' });
  assert.equal((await fetch(base + '/indoor-sky/restart', { method: 'POST', headers })).status, 401);
  const first = await login();
  assert.match(first.headers.get('set-cookie'), /; Secure/);
  const cookie = first.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/indoor-sky/restart', { method: 'POST', headers: { ...headers, Cookie: cookie } })).status, 200);
  assert.equal(restarts, 1);
  assert.equal((await fetch(base + '/indoor-sky/restart', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(base + '/api/admin/login', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{"password":"owner"}' })).status, 403);
  for (let i = 0; i < 8; i++) await login();
  assert.equal((await (await fetch(base + '/api/admin/status', { headers: { Cookie: cookie } })).json()).authenticated, false);
  const last = await login();
  const lastCookie = last.headers.get('set-cookie').split(';')[0];
  assert.equal((await login()).status, 429);
  now += 31 * 86400000;
  assert.equal((await (await fetch(base + '/api/admin/status', { headers: { Cookie: lastCookie } })).json()).authenticated, false);
  const fresh = await login();
  env.ELECTRIC_SEA_ADMIN_PASSWORD = 'changed';
  assert.equal((await (await fetch(base + '/api/admin/status', { headers: { Cookie: fresh.headers.get('set-cookie').split(';')[0] } })).json()).authenticated, false);
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  for (const node of ['indoor-sky', 'electric-sky']) {
    assert.ok(source.includes(`app.post('/${node}/restart', admin.requireAdmin,`));
    assert.ok(!source.includes(`app.get('/${node}/restart'`));
  }
});

test('upstream errors and credential echoes never reach public responses', async t => {
  const app = express();
  let status = 500;
  installDeploymentProxy(app, createAdmin({}).requireAdmin, {
    WEATHER_BRAIN_URL: 'https://example.invalid', WEATHER_BRAIN_STATUS_TOKEN: 'private-status', WEATHER_BRAIN_INGEST_TOKEN: 'private-ingest'
  }, async () => new Response(JSON.stringify({ detail: 'private-status private-ingest' }), { status }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const value of [500, 200]) {
    status = value;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/deployments/electric-sky`);
    assert.ok(!(await response.text()).includes('private-'));
  }
});
