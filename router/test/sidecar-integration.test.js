'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { page: modulationSpectrumPage } = require('../modulation-spectrum-demo-v3');

test('modulation spectrum page uses the serving HTTPS origin and PCM subscription', () => {
  const html = modulationSpectrumPage();
  assert.match(html, /location\.protocol==='https:'\?'wss:\/\/':'ws:\/\/'/);
  assert.match(html, /type:'pcm_subscribe'/);
  assert.match(html, /pcm\/indoor-sky\/audio/);
  assert.match(html, /String\.fromCharCode\(data\.getUint8\(0\).*ESAU/);
  assert.match(html, /bits===4/);
  assert.match(html, /IMA_STEP/);
});

test('resident sidecar stays local and analyzes without browser clients', () => {
  const source = fs.readFileSync(path.join(__dirname, '../resident-live.js'), 'utf8');
  assert.doesNotMatch(source, /if \(wss\.clients\.size === 0\) return;/);
  assert.match(source, /if \(closed \|\| routerSocket\) return;/);
  assert.match(source, /server\.listen\(port, '127\.0\.0\.1'/);
});

test('main HTTPS server exposes and subscribes both analysis pages', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /app\.get\('\/voices\/'/);
  assert.match(source, /redirect\(308, '\/voices\/'\)/);
  assert.match(source, /type:'resident_subscribe',enabled:true/);
  assert.match(source, /new WebSocket\(`ws:\/\/127\.0\.0\.1:\$\{RESIDENT_PORT\}`\)/);
  assert.match(source, /app\.get\('\/modulation-spectrum\/'/);
});

test('OSC UDP output is automatic for direct clients and disabled through Cloudflare', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(server, /const viaCloudflare = Boolean/);
  assert.match(server, /if \(ws\.oscUdpAvailable\) oscReceiveClients\.add\(clientIp, ws\)/);
  assert.doesNotMatch(server, /data\.type === 'osc_toggle_receive'/);
  assert.match(page, /ALWAYS ON/);
  assert.match(page, /DISABLED/);
  assert.match(page, /\$\{location\.hostname\}:5005/);
  assert.match(page, /OSC senders → router/);
  assert.match(page, /router → OSC senders/);
  assert.match(page, /Connect on LAN or VPN to enable/);
  assert.doesNotMatch(page, /toggleOSCReceive/);
});

test('PCM source power is latched separately from browser delivery subscriptions', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const visualizer = fs.readFileSync(path.join(__dirname, '../../visualizer/index.html'), 'utf8');
  assert.match(server, /const pcmSourceEnabled = new Map\(\)/);
  assert.match(server, /data\.type === 'pcm_source_enable'/);
  assert.doesNotMatch(server, /pcmSourceSubscribed/);
  assert.doesNotMatch(server, /setTimeout\(\(\) => \{\s*const device = 'pcm\/indoor-sky\/audio'/);
  assert.doesNotMatch(server, /for \(const device of pcmDevices\) updatePcmSource/);
  assert.match(page, /togglePcmSource/);
  assert.match(visualizer, /type:'pcm_source_enable'/);
  assert.match(visualizer, /type:'pcm_subscribe'/);
});

test('PCM capability follows a named sensor when its DHCP address changes', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /knownIp !== ip && knownName === name/);
  assert.match(server, /namedCapability\.source = ip/);
  assert.match(server, /namedCapability\.available = false/);
  assert.match(server, /staleStream\?\.source !== ip/);
});

test('indoor USB scalar frames reject samples outside their packet time window', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /const timestampToleranceUs = 2e6/);
  assert.match(server, /sample timestamp outside packet window/);
});

test('MIDI CC assignments are not bypassed by raw local or moire pass-through', () => {
  const page = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const moire = fs.readFileSync(path.join(__dirname, '../../moire/index.html'), 'utf8');
  assert.match(page, /data\.raw && data\.msgType !== 'cc'/);
  assert.match(moire, /if \(data\.type === 'midi'\) return/);
});
