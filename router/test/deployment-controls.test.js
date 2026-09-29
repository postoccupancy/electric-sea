const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { injectDeploymentControl, installDeploymentProxy } = require('../deployment-controls');
const { createAdmin } = require('../admin-session');

test('both node dashboards gain one control without altering existing scripts', () => {
  const html = '<html><head></head><body><header><h1>Sensor</h1></header><main>Scopes</main><script>live()</script></body></html>';
  for (const node of ['electric-sky', 'indoor-sky']) {
    const result = injectDeploymentControl(html, node);
    assert.ok(result.includes(`data-node="${node}"`));
    assert.ok(result.includes('<script>live()</script>'));
    assert.ok(result.includes('src="/deployment-control.js"'));
    assert.ok(result.includes(`<a href="/">ELECTRIC SEA</a> &middot; ${node === 'electric-sky' ? 'ELECTRIC SKY' : 'INDOOR SKY'}`));
    assert.equal((result.match(/id="es-admin-toggle"/g) || []).length, 1);
    assert.ok(result.indexOf('id="es-admin-toggle"') < result.indexOf('</header>'));
    assert.ok(result.includes('<dialog id="es-admin-dialog"'));
    assert.equal(injectDeploymentControl(result, node), result);
  }
  assert.equal(injectDeploymentControl(html, 'unknown'), html);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.ok(server.includes("injectDeploymentControl(fs.readFileSync(INDOOR_DASHBOARD_CACHE, 'utf8'), 'indoor-sky')"));
  assert.ok(server.includes("injectDeploymentControl(html, 'indoor-sky')"));
  assert.ok(server.includes("injectDeploymentControl(transformElectricDashboard(html), 'electric-sky')"));
});

test('public reads use server credentials; session protects writes and logout revokes access', async t => {
  const sent = [];
  const app = express(); app.use(express.json());
  const admin = createAdmin({ ELECTRIC_SEA_ADMIN_PASSWORD: 'owner-password' });
  admin.install(app);
  installDeploymentProxy(app, admin.requireAdmin, {
    WEATHER_BRAIN_URL: 'http://weather-brain:8000', WEATHER_BRAIN_STATUS_TOKEN: 'operator-test',
    WEATHER_BRAIN_INGEST_TOKEN: 'ingest-secret'
  }, async (url, options) => {
    sent.push({ url: url.href, options });
    return new Response(JSON.stringify({ ok: true, node_id: 'electric-sky', deployment: null }), { status: 200 });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/deployments/electric-sky`;
  const publicRead = await fetch(endpoint);
  assert.equal(publicRead.status, 200);
  assert.equal((await publicRead.text()).includes('operator-test'), false);
  const headers = { 'X-Electric-Sea-Admin': '1', 'Content-Type': 'application/json' };
  assert.equal(sent[0].url, 'http://weather-brain:8000/nodes/electric-sky/deployment');
  assert.equal(sent[0].options.headers['X-Status-Token'], 'operator-test');
  assert.equal(sent[0].options.headers['X-Ingest-Token'], undefined);
  const body = { name: 'Home Office', latitude: 47.6 };
  assert.equal((await fetch(endpoint + '/start', { method: 'POST', headers, body: JSON.stringify(body) })).status, 401);
  assert.equal((await fetch(base + '/api/admin/login', { method: 'POST', headers, body: JSON.stringify({ password: 'wrong' }) })).status, 401);
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers, body: JSON.stringify({ password: 'owner-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Max-Age=2592000/);
  assert.equal(cookie.includes('owner-password'), false);
  headers.Cookie = cookie.split(';')[0];
  assert.equal((await (await fetch(base + '/api/admin/status', { headers })).json()).authenticated, true);
  const response = await fetch(endpoint + '/start', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal(sent[1].options.headers['X-Ingest-Token'], 'ingest-secret');
  assert.deepEqual(JSON.parse(sent[1].options.body), body);
  assert.equal((await response.text()).includes('ingest-secret'), false);
  assert.equal((await fetch(endpoint + '/end', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint + '/delete', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/api/deployments/unknown`, { headers })).status, 404);
  assert.equal(sent.length, 2);
  await fetch(base + '/api/admin/logout', { method: 'POST', headers, body: '{}' });
  assert.equal((await (await fetch(base + '/api/admin/status', { headers })).json()).authenticated, false);
  assert.equal((await fetch(endpoint + '/start', { method: 'POST', headers, body: '{}' })).status, 401);
});

test('proxy fails closed without credentials and handles upstream errors', async t => {
  const env = {};
  const app = express(); app.use(express.json());
  installDeploymentProxy(app, createAdmin({}).requireAdmin, env, async () => { throw new Error('private host detail'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/deployments/indoor-sky`;
  assert.equal((await fetch(endpoint)).status, 503);
  Object.assign(env, { WEATHER_BRAIN_STATUS_TOKEN: 'operator-test', WEATHER_BRAIN_URL: 'http://localhost:8000' });
  const result = await fetch(endpoint, { headers: { 'X-Status-Token': 'operator-test' } });
  assert.equal(result.status, 502);
  assert.equal((await result.text()).includes('private host'), false);
});

test('control starts, changes and ends using observed IDs; location is one-shot and editable', async () => {
  const elements = new Map();
  const el = () => ({ hidden: false, value: '', textContent: '', disabled: false,
    addEventListener(event, handler) { this[event] = handler; }, focus() {}, reset() {} });
  for (const name of ['auth', 'auth-cancel', 'editor', 'name', 'state', 'location', 'since', 'edit', 'end', 'message', 'refresh', 'lock', 'cancel', 'locate']) elements.set(name, el());
  const auth = elements.get('auth'), editor = elements.get('editor');
  auth.querySelectorAll = () => [];
  const adminButton = el();
  const authMessage = el();
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; this.onclose?.(); },
    addEventListener(event, fn) { this['on' + event] = fn; },
    querySelector: selector => selector === '[data-auth]' ? auth : selector === '[data-auth-message]' ? authMessage : elements.get('auth-cancel') };
  auth.elements = { password: el() };
  editor.elements = Object.fromEntries(['name', 'location_label', 'latitude', 'longitude', 'altitude_m', 'notes'].map(key => [key, el()]));
  const root = { dataset: { node: 'electric-sky' }, innerHTML: '',
    querySelector: selector => elements.get(selector.slice(6, -1)), querySelectorAll: () => [] };
  let active = null, locateCount = 0, authenticated = false;
  const requests = [];
  const context = {
    document: { getElementById: id => ({ 'wb-deployment': root, 'es-admin-dialog': dialog, 'es-admin-toggle': adminButton }[id] || null) },
    navigator: { geolocation: { getCurrentPosition(success) { locateCount++; success({ coords: { latitude: 1, longitude: 2, altitude: null } }); } } },
    window: { confirm: () => true },
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      if (url.startsWith('/api/admin/')) {
        if (url.endsWith('/login')) { assert.equal(body.password, 'owner-password'); authenticated = true; }
        if (url.endsWith('/logout')) authenticated = false;
        return { ok: true, json: async () => ({ authenticated }) };
      }
      requests.push({ url, options, body });
      if (url.endsWith('/start')) active = { ...body, id: 'first', started_at: '2026-01-01T00:00:00Z' };
      if (url.endsWith('/change')) active = { ...body, id: 'second', started_at: '2026-01-02T00:00:00Z' };
      if (url.endsWith('/end')) active = null;
      return { ok: true, json: async () => ({ deployment: active }) };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/deployment-control.js'), 'utf8'), context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  assert.equal(elements.get('name').textContent, 'No active deployment');
  assert.equal(locateCount, 0);
  await elements.get('edit').onclick();
  assert.equal(dialog.open, true);
  auth.elements.password.value = 'owner-password'; auth.submit({ preventDefault() {} }); await settle();
  assert.equal(auth.elements.password.value, '');
  assert.equal(dialog.open, false);
  assert.equal(adminButton.textContent, 'Lock admin');
  elements.get('locate').onclick();
  assert.equal(locateCount, 1);
  assert.equal(editor.elements.latitude.value, 1);
  editor.elements.latitude.value = ''; editor.elements.longitude.value = '';
  editor.elements.name.value = '<img src=x onerror=bad()>';
  editor.submit({ preventDefault() {} }); await settle();
  assert.equal(requests[1].body.latitude, null);
  assert.equal(elements.get('name').textContent, '<img src=x onerror=bad()>');
  await elements.get('edit').onclick(); editor.elements.name.value = 'Studio';
  editor.submit({ preventDefault() {} }); await settle();
  assert.equal(requests[2].body.expected_deployment_id, 'first');
  elements.get('end').onclick(); await settle();
  assert.equal(requests[3].body.expected_deployment_id, 'second');
  assert.equal(elements.get('name').textContent, 'No active deployment');
  assert.equal(locateCount, 1);
  assert.ok(requests.every(r => !('X-Ingest-Token' in r.options.headers) && !('X-Status-Token' in r.options.headers)));
  await adminButton.onclick();
  assert.equal(elements.get('state').hidden, false);
  assert.equal(adminButton.textContent, 'Unlock admin');
  adminButton.onclick();
  assert.equal(dialog.open, true);
  auth.elements.password.value = 'unsent';
  elements.get('auth-cancel').onclick();
  assert.equal(dialog.open, false);
  assert.equal(auth.elements.password.value, '');
});
