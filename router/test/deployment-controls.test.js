const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { injectDeploymentControl, installDeploymentProxy } = require('../deployment-controls');

test('both node dashboards gain one control without altering existing scripts', () => {
  const html = '<html><head></head><body><header>Sensor</header><main>Scopes</main><script>live()</script></body></html>';
  for (const node of ['electric-sky', 'indoor-sky']) {
    const result = injectDeploymentControl(html, node);
    assert.ok(result.includes(`data-node="${node}"`));
    assert.ok(result.includes('<script>live()</script>'));
    assert.ok(result.includes('src="/deployment-control.js"'));
    assert.equal(injectDeploymentControl(result, node), result);
  }
  assert.equal(injectDeploymentControl(html, 'unknown'), html);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.ok(server.includes("injectDeploymentControl(fs.readFileSync(INDOOR_DASHBOARD_CACHE, 'utf8'), 'indoor-sky')"));
  assert.ok(server.includes("injectDeploymentControl(html, 'indoor-sky')"));
  assert.ok(server.includes("injectDeploymentControl(transformElectricDashboard(html), 'electric-sky')"));
});

test('proxy requires existing status token and keeps ingestion credentials server-side', async t => {
  const sent = [];
  const app = express(); app.use(express.json());
  installDeploymentProxy(app, {
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
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { headers: { 'X-Status-Token': 'wrong' } })).status, 401);
  assert.equal(sent.length, 0);
  const headers = { 'X-Status-Token': 'operator-test', 'Content-Type': 'application/json' };
  assert.equal((await fetch(endpoint, { headers })).status, 200);
  assert.equal(sent[0].url, 'http://weather-brain:8000/nodes/electric-sky/deployment');
  assert.equal(sent[0].options.headers['X-Status-Token'], 'operator-test');
  assert.equal(sent[0].options.headers['X-Ingest-Token'], undefined);
  const body = { name: 'Home Office', latitude: 47.6 };
  const response = await fetch(endpoint + '/start', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal(sent[1].options.headers['X-Ingest-Token'], 'ingest-secret');
  assert.deepEqual(JSON.parse(sent[1].options.body), body);
  assert.equal((await response.text()).includes('ingest-secret'), false);
  assert.equal((await fetch(endpoint + '/end', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint + '/delete', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/api/deployments/unknown`, { headers })).status, 404);
  assert.equal(sent.length, 2);
});

test('proxy fails closed without credentials and handles upstream errors', async t => {
  const env = {};
  const app = express(); app.use(express.json());
  installDeploymentProxy(app, env, async () => { throw new Error('private host detail'); });
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
  for (const name of ['auth', 'editor', 'name', 'state', 'location', 'since', 'edit', 'end', 'message', 'refresh', 'disconnect', 'cancel', 'locate']) elements.set(name, el());
  const auth = elements.get('auth'), editor = elements.get('editor');
  auth.elements = { token: el() };
  editor.elements = Object.fromEntries(['name', 'location_label', 'latitude', 'longitude', 'altitude_m', 'notes'].map(key => [key, el()]));
  const root = { dataset: { node: 'electric-sky' }, innerHTML: '',
    querySelector: selector => elements.get(selector.slice(6, -1)), querySelectorAll: () => [] };
  let active = null, locateCount = 0;
  const requests = [];
  const context = {
    document: { getElementById: () => root },
    navigator: { geolocation: { getCurrentPosition(success) { locateCount++; success({ coords: { latitude: 1, longitude: 2, altitude: null } }); } } },
    window: { confirm: () => true },
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      requests.push({ url, options, body });
      if (url.endsWith('/start')) active = { ...body, id: 'first', started_at: '2026-01-01T00:00:00Z' };
      if (url.endsWith('/change')) active = { ...body, id: 'second', started_at: '2026-01-02T00:00:00Z' };
      if (url.endsWith('/end')) active = null;
      return { ok: true, json: async () => ({ deployment: active }) };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/deployment-control.js'), 'utf8'), context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  auth.elements.token.value = 'operator-test'; auth.submit({ preventDefault() {} }); await settle();
  assert.equal(elements.get('name').textContent, 'No active deployment');
  assert.equal(auth.elements.token.value, '');
  assert.equal(locateCount, 0);
  elements.get('edit').onclick();
  elements.get('locate').onclick();
  assert.equal(locateCount, 1);
  assert.equal(editor.elements.latitude.value, 1);
  editor.elements.latitude.value = ''; editor.elements.longitude.value = '';
  editor.elements.name.value = '<img src=x onerror=bad()>';
  editor.submit({ preventDefault() {} }); await settle();
  assert.equal(requests[1].body.latitude, null);
  assert.equal(elements.get('name').textContent, '<img src=x onerror=bad()>');
  elements.get('edit').onclick(); editor.elements.name.value = 'Studio';
  editor.submit({ preventDefault() {} }); await settle();
  assert.equal(requests[2].body.expected_deployment_id, 'first');
  elements.get('end').onclick(); await settle();
  assert.equal(requests[3].body.expected_deployment_id, 'second');
  assert.equal(elements.get('name').textContent, 'No active deployment');
  assert.equal(locateCount, 1);
  assert.ok(requests.every(r => !('X-Ingest-Token' in r.options.headers)));
});
