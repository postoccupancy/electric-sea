'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('actual dashboard script plots USB batches, polls freshness and sends PCM control on its serving origin', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../pages/indoor-sky.html'), 'utf8');
  const elements = new Map();
  const painter = new Proxy({}, { get: () => () => {}, set: () => true });
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, {
    textContent: '', dataset: {}, value: id === 'delay' ? '6' : '',
    getBoundingClientRect: () => ({ width: 400, height: 170 }), getContext: () => painter
  });
  const sockets = [], sent = [], polls = [];
  let available = true;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
    send(message) { sent.push(JSON.parse(message)); }
    close() {}
  }
  const context = { ...Object.fromEntries(elements), document: { getElementById: id => elements.get(id) },
    WebSocket: Socket, location: { protocol: 'https:', host: 'rf.postoccupancy.com' },
    performance: { now: () => 1000 }, devicePixelRatio: 1, requestAnimationFrame() {},
    setInterval() {}, setTimeout() {},
    fetch: async url => { polls.push(url); return { ok: available, json: async () => ({
      bme_actual_hz: 100, audio_actual_hz: 250, bme_overruns: 0, audio_overruns: 0,
      usb_pcm_stream_enabled: false, transport_drops: 0, uptime_ms: 1000,
      wifi_rssi_dbm: -40, wifi_reconnects: 0, osc_send_failures: 0, osc_send_avg_us: 0,
      osc_send_max_us: 0, osc_send_stalls: 0 }) }; } };
  vm.createContext(context);
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets[0].url, 'wss://rf.postoccupancy.com');
  assert.deepEqual(polls, ['/indoor-sky/status']);
  assert.equal(elements.get('usbHealth').textContent, 'USB live');
  sockets[0].onmessage({ data: JSON.stringify({ type: 'sample_batch', packetSequence: 1,
    streams: [{ name: 'indoor-sky', param: 'temperature', samples: [[1, 1000000, 22.5]] }] }) });
  vm.runInContext("draw('temp','#66ddff','C',1,1000000)", context);
  assert.equal(elements.get('tempValue').textContent, '22.5 C');
  elements.get('pcmToggle').onclick();
  assert.deepEqual(sent[0], { type: 'pcm_source_enable', device: 'pcm/indoor-sky/audio', enabled: true });
  available = false;
  await vm.runInContext('pollStatus()', context);
  assert.equal(elements.get('usbHealth').textContent, 'USB disconnected or stale');
  assert.equal(elements.get('pcmToggle').disabled, true);
  assert.doesNotMatch(html, /fetch\('\/restart'/);
});
