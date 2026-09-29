const express    = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const os         = require('os');
const dgram      = require('dgram');
const net        = require('net');
const { execSync } = require('child_process');
const { PcmAnalyzer } = require('./audio-analysis');
const { decodeImaAdpcm } = require('./ima-adpcm');
const { SerialBatchPacer } = require('./serial-batch-pacer');
const { createArchive } = require('./weather-brain-archive');
const { injectDeploymentControl, installDeploymentProxy } = require('./deployment-controls');
const { page: modulationSpectrumPage } = require('./modulation-spectrum-demo-v3');

// ─── SSL ─────────────────────────────────────────────────────────────────────

const certBase = '/var/lib/tailscale/certs/adrian-pi.tailc1f637.ts.net';

let sslOptions;
try {
  sslOptions = {
    key:  fs.readFileSync(`${certBase}.key`),
    cert: fs.readFileSync(`${certBase}.crt`)
  };
  console.log('Using Tailscale HTTPS certificate');
} catch (e) {
  sslOptions = {
    key:  fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
  };
  console.log('Using self-signed certificate');
}

// ─── Express + WebSocket ──────────────────────────────────────────────────────

const app    = express();
const server = https.createServer(sslOptions, app);
const wss    = new WebSocketServer({ server });

app.use(express.static('public'));
app.use(express.json());
app.get('/mic.html', (req, res) => res.redirect(308, '/mic/'));
app.get('/visualizer.html', (req, res) => res.redirect(308, `/visualizer/?${req.url.split('?')[1] || ''}`));
app.use('/mic',   express.static('../mic'));
app.use('/moire', express.static('../moire'));
app.use('/visualizer', express.static('../visualizer'));
app.use('/pcm', express.static('../pcm'));

function fetchIndoor(path, res, transform) {
  const request = http.get({ host: '192.168.0.32', port: 80, path, timeout: 8000 }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      let body = Buffer.concat(chunks);
      if (transform) body = Buffer.from(transform(body.toString('utf8')));
      res.status(response.statusCode || 200)
        .type(response.headers['content-type'] || 'text/plain').send(body);
    });
  });
  request.on('timeout', () => request.destroy(new Error('indoor-sky timeout')));
  request.on('error', error => res.status(502).type('text/plain')
    .send(`indoor-sky unavailable: ${error.message}`));
}
const INDOOR_DASHBOARD_CACHE = `${os.homedir()}/.cache/signal-router/indoor-sky.html`;
function transformIndoorDashboard(html) {
  return html
    .replace("'wss://adrian-pi:3000'", "'wss://'+location.host")
    .replace("fetch('/status'", "fetch('/indoor-sky/status'")
    .replace("fetch('/restart'", "fetch('/indoor-sky/restart'");
}
function refreshIndoorDashboard(callback = () => {}) {
  const request = http.get({ host: '192.168.0.32', port: 80, path: '/dashboard', timeout: 8000 }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      if (response.statusCode !== 200) return callback(new Error(`dashboard HTTP ${response.statusCode}`));
      const html = transformIndoorDashboard(Buffer.concat(chunks).toString('utf8'));
      try {
        fs.mkdirSync(`${os.homedir()}/.cache/signal-router`, { recursive: true });
        fs.writeFileSync(INDOOR_DASHBOARD_CACHE, html);
      } catch (error) { return callback(error); }
      callback(null, html);
    });
  });
  request.on('timeout', () => request.destroy(new Error('indoor-sky dashboard timeout')));
  request.on('error', callback);
}
app.get(/^\/indoor-sky$/, (req, res) => res.redirect(308, '/indoor-sky/'));
app.get('/indoor-sky/', (req, res) => {
  if (fs.existsSync(INDOOR_DASHBOARD_CACHE)) {
    res.type('text/html').send(injectDeploymentControl(fs.readFileSync(INDOOR_DASHBOARD_CACHE, 'utf8'), 'indoor-sky'));
    refreshIndoorDashboard(error => { if (error) console.warn(`Indoor dashboard refresh: ${error.message}`); });
    return;
  }
  refreshIndoorDashboard((error, html) => error
    ? res.status(502).type('text/plain').send(`indoor-sky dashboard unavailable: ${error.message}`)
    : res.type('text/html').send(injectDeploymentControl(html, 'indoor-sky')));
});
app.get('/indoor-sky/status', (req, res) => {
  if (indoorUsbStatus && Date.now() - indoorUsbStatusAt < 5000) return res.json(indoorUsbStatus);
  fetchIndoor('/status', res);
});
app.get('/indoor-sky/restart', (req, res) => {
  if (sendIndoorUsbCommand('INRS')) return res.type('text/plain').send('restarting over USB');
  fetchIndoor('/restart', res);
});

function fetchElectric(path, res, transform) {
  const request = http.get({ host: 'electric-sky.local', port: 80, path, timeout: 15000 }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      let body = Buffer.concat(chunks);
      if (transform) body = Buffer.from(transform(body.toString('utf8')));
      res.status(response.statusCode || 200)
        .type(response.headers['content-type'] || 'application/octet-stream').send(body);
    });
  });
  request.on('timeout', () => request.destroy(new Error('electric-sky timeout')));
  request.on('error', error => res.status(502).type('text/plain')
    .send(`electric-sky unavailable: ${error.message}`));
}

function transformElectricDashboard(html) {
  const routerBatch = `function parseRouterBatch(message,bytes){
    if(message.type!=='sample_batch'||!Array.isArray(message.streams)||!message.streams.some(s=>s.name==='electric-sky'))return;
    const seq=message.packetSequence;if(Number.isFinite(seq)){if(packetLast!==null&&seq!==packetLast+1){const missing=Math.max(0,seq-packetLast-1);if(missing){packetGaps+=missing;packetGapEvents++}}packetLast=seq}packetCount++;bytesReceived+=bytes;
    const now=performance.now();if(!observationStarted)observationStarted=now;if(lastArrival){const delta=now-lastArrival;if(delta>longestSilence)longestSilence=delta;intervalEma=intervalEma*.95+delta*.05;jitterEma=jitterEma*.9+Math.abs(delta-intervalEma)*.1}lastArrival=now;
    const map={temperature:['temp',1],humidity:['humidity',1],pressure:['pressure',1],power:['power',.001],'solar-power':['solar',.001],rms:['audio',1]};for(const stream of message.streams){if(stream.name!=='electric-sky')continue;if(stream.param==='solar-voltage'){const latest=stream.samples?.at(-1);if(latest)solarVolts=latest[2];continue}if(stream.param==='solar-current'){const latest=stream.samples?.at(-1);if(latest)solarCurrent=latest[2];continue}if(!map[stream.param])continue;const [name,scale]=map[stream.param];for(const sample of stream.samples||[])rings[name].push({seq:sample[0],t:sample[1],v:sample[2]*scale})}
  }
  async function pollStatus(){try{const s=await fetch('/electric-sky/status',{cache:'no-store'}).then(r=>r.json());bmeHz.textContent=s.bme_actual_hz.toFixed(1)+' Hz';powerHz.textContent=s.power_actual_hz.toFixed(1)+' Hz';audioHz.textContent=s.audio_actual_hz.toFixed(1)+' Hz';bmeDetail.textContent='overruns '+s.bme_overruns;powerDetail.textContent='overruns '+s.power_overruns;audioDetail.textContent='overruns '+s.audio_overruns;transportQueued=0;transportDropped=s.transport_drops;scheduledHz=15.8;firmwareUptimeMs=s.uptime_ms;networkRssi=s.wifi_rssi_dbm;wifiReconnects=s.wifi_reconnects;oscFailures=s.osc_send_failures;oscSendAvgUs=s.osc_send_avg_us;oscSendMaxUs=s.osc_send_max_us;oscSendStalls=s.osc_send_stalls;if(baselineDrops===null){baselineDrops=transportDropped;baselineUptimeMs=firmwareUptimeMs}}catch{}}
  `;
  return html
    .replace("cameraImage.src='/camera.jpg", "cameraImage.src='/electric-sky/camera.jpg")
    .replace("fetch('/status'", "fetch('/electric-sky/status'")
    .replace("fetch('/restart'", "fetch('/electric-sky/restart'")
    .replace("function connect(){", routerBatch + "function connect(){")
    .replace(/ws=new WebSocket\('ws:\/\/[^']+:81\/'\);ws\.binaryType='arraybuffer';/, "ws=new WebSocket('wss://'+location.host);")
    .replace("ws.onopen=()=>{connection.textContent='● live'", "ws.onopen=()=>{connection.textContent='● router live'")
    .replace("ws.onmessage=e=>{if(e.data instanceof ArrayBuffer)parsePacket(e.data)};", "ws.onmessage=e=>{if(typeof e.data==='string'){try{parseRouterBatch(JSON.parse(e.data),e.data.length)}catch{}}};")
    .replace("captureCamera();connect();requestAnimationFrame(render);", "captureCamera();connect();pollStatus();setInterval(pollStatus,1000);requestAnimationFrame(render);");
}

app.get(/^\/electric-sky$/, (req, res) => res.redirect(308, '/electric-sky/'));
app.get('/electric-sky/', (req, res) => fetchElectric('/', res, html => injectDeploymentControl(transformElectricDashboard(html), 'electric-sky')));
app.get('/electric-sky/status', (req, res) => fetchElectric('/status', res));
app.get('/electric-sky/camera.jpg', (req, res) => fetchElectric('/camera.jpg', res));
app.get('/electric-sky/restart', (req, res) => fetchElectric('/restart', res));

require('dotenv').config();
const weatherBrainArchive = createArchive();
installDeploymentProxy(app);

// ─── State ────────────────────────────────────────────────────────────────────

const state = { distance: 0, rate: 0 };
const sourceNames = new Map();
const audioCapabilities = new Map();
let lastIndoorUsbScalarAt = 0;
const indoorSerialPacer = new SerialBatchPacer(batch =>
  broadcastSampleBatch(batch, buildScalarBatchOsc(batch)));

// ─── OSC encoding helpers ─────────────────────────────────────────────────────

function encodeOSCString(str) {
  const buf = Buffer.alloc(Math.ceil((str.length + 1) / 4) * 4);
  buf.write(str, 0, 'ascii');
  return buf;
}
function encodeOSCFloat(f) {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(f, 0);
  return buf;
}
function encodeOSCInt(i) {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(i, 0);
  return buf;
}
function encodeOSCDouble(value) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(value, 0);
  return buf;
}

function buildOSCMessage(address, ...args) {
  const addrBuf = encodeOSCString(address);
  let typeTags  = ',';
  const argBufs = [];
  for (const arg of args) {
    if (typeof arg === 'number' && Number.isInteger(arg)) {
      typeTags += 'i'; argBufs.push(encodeOSCInt(arg));
    } else if (typeof arg === 'number') {
      typeTags += 'f'; argBufs.push(encodeOSCFloat(arg));
    } else if (typeof arg === 'string') {
      typeTags += 's'; argBufs.push(encodeOSCString(arg));
    }
  }
  return Buffer.concat([addrBuf, encodeOSCString(typeTags), ...argBufs]);
}

function buildTypedOSCMessage(address, types, args) {
  const encoded = args.map((arg, index) => {
    const type = types[index];
    if (type === 'i') return encodeOSCInt(arg | 0);
    if (type === 'f') return encodeOSCFloat(arg);
    if (type === 'd') return encodeOSCDouble(arg);
    if (type === 's') return encodeOSCString(arg);
    throw new Error(`Unsupported OSC type: ${type}`);
  });
  return Buffer.concat([encodeOSCString(address), encodeOSCString(`,${types}`), ...encoded]);
}

function buildScalarBatchOsc(batch) {
  const marker = Buffer.alloc(16);
  marker.write('#bundle\0', 0, 'ascii');
  marker.writeUInt32BE(1, 12);
  const elements = [marker];
  for (const stream of batch.streams) {
    const types = ['i', 'd', 's'];
    const args = [batch.packetSequence, batch.sendTimeUs, stream.unit || ''];
    for (const sample of stream.samples) {
      types.push('i', 'i', 'f');
      args.push(sample[0], Math.trunc(sample[1] - batch.sendTimeUs), sample[2]);
    }
    const message = buildTypedOSCMessage(`/batch/${stream.name}/${stream.param}`, types.join(''), args);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(message.length);
    elements.push(size, message);
  }
  return Buffer.concat(elements);
}

function parseOSCMessage(buf) {
  try {
    let offset = 0;
    function readString() {
      const end = buf.indexOf(0, offset);
      const str = buf.slice(offset, end).toString('ascii');
      offset = Math.ceil((end + 1) / 4) * 4;
      return str;
    }
    const address  = readString();
    const typeTags = readString();
    const args     = [];
    for (let i = 1; i < typeTags.length; i++) {
      const tag = typeTags[i];
      if      (tag === 'f') { args.push(buf.readFloatBE(offset));  offset += 4; }
      else if (tag === 'i') { args.push(buf.readInt32BE(offset));   offset += 4; }
      else if (tag === 's') { args.push(readString()); }
      else if (tag === 'd') { args.push(buf.readDoubleBE(offset));  offset += 8; }
    }
    return { address, args };
  } catch (e) { return null; }
}

function parseOSCPacket(buf) {
  if (buf.length < 8 || buf.toString('ascii', 0, 8) !== '#bundle\0') {
    const message = parseOSCMessage(buf);
    return message ? [message] : [];
  }

  const messages = [];
  let offset = 16; // bundle marker plus 8-byte timetag
  while (offset + 4 <= buf.length) {
    const size = buf.readInt32BE(offset);
    offset += 4;
    if (size <= 0 || offset + size > buf.length) return [];
    messages.push(...parseOSCPacket(buf.subarray(offset, offset + size)));
    offset += size;
  }
  return offset === buf.length ? messages : [];
}

// ─── SuperCollider OSC sender ─────────────────────────────────────────────────

const scSocket = dgram.createSocket('udp4');

function sendToSC(address, ...args) {
  try { scSocket.send(buildOSCMessage(address, ...args), 57110, '127.0.0.1'); } catch (e) {}
}

// ─── OSC client registry ──────────────────────────────────────────────────────

const OSC_OUT_PORT = 9000;
const OSC_IN_PORT  = 5005;
const PCM_IN_PORT  = 5007;
const PCM_TCP_PORT = 5008;
const PCM_USB_DEVICE = process.env.PCM_USB_DEVICE ||
  '/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_24:EC:4A:0E:B1:DC-if00';

const oscReceiveClients = new Set();

const oscOutSocket = dgram.createSocket('udp4');

function sendOSCToClient(ip, address, ...args) {
  try { oscOutSocket.send(buildOSCMessage(address, ...args), OSC_OUT_PORT, ip); } catch (e) {}
}

function sendOSCPacketToClients(packet) {
  for (const ip of oscReceiveClients) {
    try { oscOutSocket.send(packet, OSC_OUT_PORT, ip); } catch (e) {}
  }
}

function broadcastOSC(data) {
  if (oscReceiveClients.size === 0) return;

  if (data.type === 'osc' || data.type === 'json') {
    const addr = `/${data.device}`;
    const norm = (data.min != null && data.max != null && data.max !== data.min)
      ? Math.max(0, Math.min(1, (data.value - data.min) / (data.max - data.min)))
      : Math.max(0, Math.min(1, data.value ?? 0));
    for (const ip of oscReceiveClients) sendOSCToClient(ip, addr, parseFloat(data.value), parseFloat(norm));

  } else if (data.type === 'midi') {
    const dev = (data.device || 'midi').replace(/\W+/g, '_');
    if (data.msgType === 'cc') {
      const norm = data.value / 127;
      const addr = `/midi/${dev}/ch${data.channel}/cc${data.cc}`;
      for (const ip of oscReceiveClients) sendOSCToClient(ip, addr, parseFloat(norm), parseInt(data.value));
    } else if (data.msgType === 'noteon') {
      const addr = `/midi/${dev}/ch${data.channel}/n${data.note}`;
      for (const ip of oscReceiveClients) sendOSCToClient(ip, addr, parseInt(data.velocity));
    }
  }
}

// ─── WebSocket broadcast ──────────────────────────────────────────────────────

const SCALAR_MAX_WS_BACKLOG = 512 * 1024;

function sendBrowserMessage(client, json, applyBackpressure = false) {
  if (client.readyState !== 1) return false;
  if (applyBackpressure && client.bufferedAmount > SCALAR_MAX_WS_BACKLOG) {
    client.scalarBackpressureDrops = (client.scalarBackpressureDrops || 0) + 1;
    return false;
  }
  client.send(json);
  return true;
}

function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach(client => {
    sendBrowserMessage(client, json);
  });
  broadcastOSC(data);
  weatherBrainArchive.observe(data);
}

function broadcastSignalBatch(signals) {
  const json = JSON.stringify({ type: 'signal_batch', signals });
  wss.clients.forEach(client => {
    sendBrowserMessage(client, json, true);
  });
  for (const signal of signals) broadcastOSC(signal);
  weatherBrainArchive.observe({ type: 'signal_batch', signals });
}

function broadcastSampleBatch(batch, oscPacket) {
  const json = JSON.stringify(batch);
  wss.clients.forEach(client => {
    sendBrowserMessage(client, json, true);
  });
  if (oscReceiveClients.size > 0) sendOSCPacketToClients(oscPacket);
  try { scSocket.send(oscPacket, 57110, '127.0.0.1'); } catch (e) {}
  weatherBrainArchive.observe(batch);
}

function decodeScalarBatch(messages, senderIp) {
  const streams = [];
  let packetSequence = null;
  let sendTimeUs = null;
  for (const msg of messages) {
    const parts = msg.address.split('/').filter(Boolean);
    if (parts[0] !== 'batch' || parts.length < 3 || msg.args.length < 6) continue;
    const name = parts[1];
    const param = parts.slice(2).join('/');
    const messagePacketSequence = msg.args[0];
    const messageSendTimeUs = msg.args[1];
    const unit = typeof msg.args[2] === 'string' ? msg.args[2] : '';
    if (!Number.isFinite(messagePacketSequence) || !Number.isFinite(messageSendTimeUs) ||
        (msg.args.length - 3) % 3 !== 0) continue;
    packetSequence ??= messagePacketSequence;
    sendTimeUs ??= messageSendTimeUs;

    const samples = [];
    for (let i = 3; i < msg.args.length; i += 3) {
      const sequence = msg.args[i];
      const timeUs = messageSendTimeUs + msg.args[i + 1];
      const value = msg.args[i + 2];
      if (Number.isFinite(sequence) && Number.isFinite(timeUs) && Number.isFinite(value)) {
        samples.push([sequence, timeUs, value]);
      }
    }
    if (samples.length > 0) {
      registerSource(senderIp, name);
      streams.push({ device: `osc/${name}/${param}`, name, param, unit, samples });
    }
  }

  if (streams.length === 0) return null;
  return {
    type: 'sample_batch', source: senderIp,
    packetSequence, sendTimeUs, streams
  };
}

function sourceInfo(ip, name) {
  return { type: 'source_info', ip, name, dashboard: `/${encodeURIComponent(name)}/` };
}

function registerSource(ip, name) {
  if (!ip || typeof name !== 'string' || !name) return;
  const previous = sourceNames.get(ip);
  // A named device may receive a new DHCP address. Treat the newest scalar
  // sender as authoritative so its separately controlled PCM endpoint follows
  // the device instead of remaining pinned to a stale address.
  for (const [knownIp, knownName] of sourceNames) {
    if (knownIp !== ip && knownName === name) sourceNames.delete(knownIp);
  }
  sourceNames.set(ip, name);
  const oldDevice = `pcm/${ip}/audio`;
  const newDevice = `pcm/${name}/audio`;
  if (oldDevice !== newDevice) {
    const oldCapability = audioCapabilities.get(oldDevice);
    if (oldCapability && !audioCapabilities.has(newDevice)) {
      audioCapabilities.delete(oldDevice);
      oldCapability.device = newDevice;
      oldCapability.name = name;
      audioCapabilities.set(newDevice, oldCapability);
    } else {
      audioCapabilities.delete(oldDevice);
    }
    if (pcmStreams.has(oldDevice) && !pcmStreams.has(newDevice)) {
      const stream = pcmStreams.get(oldDevice);
      pcmStreams.delete(oldDevice);
      stream.device = newDevice;
      pcmStreams.set(newDevice, stream);
    }
    if (pcmAnalyzers.has(oldDevice) && !pcmAnalyzers.has(newDevice)) {
      pcmAnalyzers.set(newDevice, pcmAnalyzers.get(oldDevice));
      pcmAnalyzers.delete(oldDevice);
    }
  }
  const namedCapability = audioCapabilities.get(newDevice);
  if (namedCapability && namedCapability.source !== ip) {
    namedCapability.source = ip;
    namedCapability.name = name;
    namedCapability.available = false;
    const staleStream = pcmStreams.get(newDevice);
    if (staleStream?.source !== ip) pcmStreams.delete(newDevice);
    broadcast({ ...namedCapability });
  }
  if (previous !== name) broadcast(sourceInfo(ip, name));
}

// ─── OSC inbound listener ─────────────────────────────────────────────────────

const oscInSocket = dgram.createSocket('udp4');

oscInSocket.on('message', (buf, rinfo) => {
  const rawIp    = rinfo.address.replace(/^::ffff:/, '');
  const senderIp = (rawIp === '127.0.0.1' || rawIp === '::1') ? os.hostname() : rawIp;
  const messages = parseOSCPacket(buf);
  const scalarBatch = decodeScalarBatch(messages, senderIp);
  if (scalarBatch) {
    if (scalarBatch.streams.some(stream => stream.name === 'indoor-sky') &&
        Date.now() - lastIndoorUsbScalarAt < 5000) return;
    broadcastSampleBatch(scalarBatch, buf);
    for (const stream of scalarBatch.streams) {
      if (stream.param === 'rms') registerAudioCapability(scalarBatch.source, stream.name);
    }
    return;
  }

  const signals = messages
    .map(msg => routeOSCMessage(msg, senderIp))
    .filter(Boolean);

  if (signals.length === 1) broadcast(signals[0]);
  else if (signals.length > 1) broadcastSignalBatch(signals);
});

function routeOSCMessage(msg, senderIp) {
  const parts = msg.address.split('/').filter(Boolean);

  if (parts[0] === 'sensor' && parts.length >= 3) {
    const name  = parts[1];
    const param = parts[2];
    const value = msg.args[0];
    const min   = msg.args[1] ?? undefined;
    const max   = msg.args[2] ?? undefined;
    const key   = `osc/${name}/${param}`;
    registerSource(senderIp, name);

    const signal = {
      type: 'osc',
      device: key,
      name, param, value,
      source: senderIp,
      enabled: true,
      ...(min !== undefined && { min }),
      ...(max !== undefined && { max })
    };
    sendToSC(msg.address, ...msg.args);
    return signal;

  } else {
    const value = msg.args[0];
    const min   = msg.args[1] ?? undefined;
    const max   = msg.args[2] ?? undefined;
    const key   = `osc/${senderIp}${msg.address}`;

    const signal = {
      type: 'osc',
      device: key,
      value: typeof value === 'number' ? value : 0,
      source: senderIp,
      enabled: true,
      ...(min !== undefined && { min }),
      ...(max !== undefined && { max })
    };
    sendToSC(msg.address, ...msg.args);
    return signal;
  }
}

oscInSocket.bind(OSC_IN_PORT, '0.0.0.0', () => {
  console.log(`OSC inbound listening on port ${OSC_IN_PORT}`);
});

// ─── MIDI UDP receiver — from controllers/main.py on port 5006 ───────────────

const midiSocket = dgram.createSocket('udp4');

midiSocket.on('message', (msg, rinfo) => {
  const separator = msg.indexOf('|'.charCodeAt(0));
  if (separator === -1) return;

  const device    = msg.slice(0, separator).toString();
  const midiBytes = [...msg.slice(separator + 1)];
  if (midiBytes.length < 3) return;

  const status  = midiBytes[0];
  const msgType = status & 0xF0;
  const channel = (status & 0x0F) + 1;

  let decoded = { type: 'midi', device: `midi/${device}`, channel, raw: midiBytes, source: os.hostname() };

  if      (msgType === 0xB0) { decoded.msgType = 'cc';        decoded.cc   = midiBytes[1]; decoded.value    = midiBytes[2]; }
  else if (msgType === 0x90) { decoded.msgType = 'noteon';    decoded.note = midiBytes[1]; decoded.velocity = midiBytes[2]; }
  else if (msgType === 0x80) { decoded.msgType = 'noteoff';   decoded.note = midiBytes[1]; decoded.velocity = midiBytes[2]; }
  else if (msgType === 0xE0) { decoded.msgType = 'pitchbend'; decoded.value = (midiBytes[2] << 7) | midiBytes[1]; }

  broadcast(decoded);
});

midiSocket.bind(5006, '127.0.0.1', () => {
  console.log('MIDI UDP listening on port 5006');
});

// ─── Raw PCM UDP receiver — subscription-only WebSocket forwarding ──────────

const pcmSocket = dgram.createSocket('udp4');
const pcmStreams = new Map();
const pcmAnalyzers = new Map();
const pcmSourceEnabled = new Map();
const PCM_MAX_WS_BACKLOG = 256 * 1024;

function pcmSourceIp(device) {
  const capability = audioCapabilities.get(device);
  if (capability?.source) return capability.source;
  const match = /^pcm\/([^/]+)\/audio$/.exec(device);
  if (!match) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(match[1])) return match[1];
  for (const [ip, name] of sourceNames) if (name === match[1]) return ip;
  return null;
}

function updatePcmSource(device) {
  const ip = pcmSourceIp(device);
  if (!ip) return;
  const enabled = pcmSourceEnabled.get(device) === true;
  const usb = ip === '192.168.0.32' && fs.existsSync(PCM_USB_DEVICE);
  if (usb) {
    sendIndoorUsbCommand(enabled ? 'INP1' : 'INP0');
    if (!enabled) markPcmDerivedUnavailable(device);
    return;
  }
  const request = http.get({ host: ip, port: 80,
    path: `/audio/${usb ? 'usb' : 'raw'}?enabled=${enabled ? 1 : 0}`, timeout: 3000 }, response => response.resume());
  request.on('timeout', () => request.destroy());
  request.on('error', error => console.warn(`PCM control ${ip}: ${error.message}`));
}

function setPcmSourceEnabled(device, enabled) {
  enabled = enabled === true;
  pcmSourceEnabled.set(device, enabled);
  const capability = audioCapabilities.get(device);
  if (capability) {
    capability.enabled = enabled;
    broadcast({ ...capability });
  }
  updatePcmSource(device);
}

function markPcmDerivedUnavailable(device) {
  const match = /^pcm\/([^/]+)\/audio$/.exec(device);
  if (!match) return;
  broadcast({
    type: 'streams_unavailable',
    devices: ['bass', 'mid', 'high', 'centroid'].map(param => `osc/${match[1]}/${param}`)
  });
}

function pcmDeviceFor(ip) {
  return `pcm/${sourceNames.get(ip) || ip}/audio`;
}

function registerAudioCapability(source, name = sourceNames.get(source) || source) {
  const device = pcmDeviceFor(source);
  let capability = audioCapabilities.get(device);
  if (!capability) {
    capability = {
      type: 'audio', device, source, name, param: 'audio',
      sampleRate: 16000, available: false, enabled: pcmSourceEnabled.get(device) === true
    };
    audioCapabilities.set(device, capability);
    broadcast(capability);
  } else if (name !== source && capability.name !== name) {
    capability.name = name;
  }
  return capability;
}

function handlePcmPacket(packet, sourceIp) {
  if (packet.length < 32 || packet.toString('ascii', 0, 4) !== 'ESAU') return;
  const version = packet.readUInt8(4);
  const channels = packet.readUInt8(5);
  const bitsPerSample = packet.readUInt8(6);
  const sequence = packet.readUInt32LE(8);
  const sampleRate = packet.readUInt32LE(20);
  const sampleCount = packet.readUInt16LE(24);
  const headerBytes = packet.readUInt16LE(26);
  const payloadBytes = bitsPerSample === 16 ? sampleCount * 2
    : bitsPerSample === 4 ? Math.ceil((sampleCount - 1) / 2) : -1;
  if (version !== 1 || channels !== 1 || payloadBytes < 0 || headerBytes < 32 ||
      headerBytes + payloadBytes !== packet.length) return;
  const wirePacket = packet;
  if (bitsPerSample === 4) {
    if (headerBytes < 36) return;
    const decoded = Buffer.alloc(32 + sampleCount * 2);
    packet.copy(decoded, 0, 0, 32);
    decoded.writeUInt8(16, 6);
    decoded.writeUInt16LE(32, 26);
    decodeImaAdpcm(packet, sampleCount, headerBytes).copy(decoded, 32);
    packet = decoded;
  }

  const ip = sourceIp.replace(/^::ffff:/, '');
  const device = pcmDeviceFor(ip);
  const previous = pcmStreams.get(device);
  const missing = previous && sequence > previous.sequence + 1
    ? previous.missing + sequence - previous.sequence - 1
    : previous?.missing || 0;
  const now = Date.now();
  const stream = {
    device, source: ip, sequence, missing, sampleRate, sampleCount,
    packets: (previous?.packets || 0) + 1, lastSeen: now,
    announcedAt: previous?.announcedAt || 0
  };
  const capability = registerAudioCapability(ip);
  capability.available = true;
  capability.sampleRate = sampleRate;
  if (!previous || now - stream.announcedAt >= 1000) {
    stream.announcedAt = now;
    broadcast({ ...capability, available: true, packets: stream.packets, missing, value: sampleRate });
  }
  pcmStreams.set(device, stream);

  let analyzer = pcmAnalyzers.get(device);
  if (!analyzer) {
    analyzer = new PcmAnalyzer();
    pcmAnalyzers.set(device, analyzer);
  }
  const analysis = analyzer.pushInt16LE(packet.subarray(headerBytes), sampleRate);
  const name = sourceNames.get(ip);
  if (analysis && name) {
    const signals = ['bass', 'mid', 'high', 'centroid'].map(param => ({
      type: 'osc', device: `osc/${name}/${param}`,
      name, param, source: ip, value: analysis[param],
      min: 0, max: 1, unit: param === 'centroid' ? 'normalized-frequency' : 'normalized-energy',
      ...(param === 'centroid' && { centroidHz: analysis.centroidHz }),
      enabled: true
    }));
    broadcastSignalBatch(signals);
  }

  for (const client of wss.clients) {
    if (client.readyState !== 1 || !client.pcmSubscriptions?.has(device)) continue;
    if (client.bufferedAmount > PCM_MAX_WS_BACKLOG) {
      client.pcmBackpressureDrops = (client.pcmBackpressureDrops || 0) + 1;
      continue;
    }
    client.send(wirePacket, { binary: true });
  }
}

function handleIndoorScalarPacket(packet, source) {
  if (packet.length < 76 || packet.toString('ascii', 0, 4) !== 'INSK') return;
  const headerBytes = packet.readUInt16LE(6);
  const packetSequence = packet.readUInt32LE(8);
  const sendTimeUs = Number(packet.readBigUInt64LE(12));
  const bmeCount = packet.readUInt16LE(20);
  const audioCount = packet.readUInt16LE(22);
  const streams = [
    { device: 'osc/indoor-sky/temperature', name: 'indoor-sky', param: 'temperature', unit: 'celsius', samples: [] },
    { device: 'osc/indoor-sky/humidity', name: 'indoor-sky', param: 'humidity', unit: 'percent', samples: [] },
    { device: 'osc/indoor-sky/pressure', name: 'indoor-sky', param: 'pressure', unit: 'hpa', samples: [] },
    { device: 'osc/indoor-sky/rms', name: 'indoor-sky', param: 'rms', unit: 'dbfs', samples: [] }
  ];
  let offset = headerBytes;
  for (let i = 0; i < bmeCount; i++, offset += 24) {
    const sequence = packet.readUInt32LE(offset);
    const timeUs = Number(packet.readBigUInt64LE(offset + 4));
    streams[0].samples.push([sequence, timeUs, packet.readFloatLE(offset + 12)]);
    streams[1].samples.push([sequence, timeUs, packet.readFloatLE(offset + 16)]);
    streams[2].samples.push([sequence, timeUs, packet.readFloatLE(offset + 20)]);
  }
  for (let i = 0; i < audioCount; i++, offset += 16) {
    streams[3].samples.push([
      packet.readUInt32LE(offset), Number(packet.readBigUInt64LE(offset + 4)),
      packet.readFloatLE(offset + 12)
    ]);
  }
  const timestampToleranceUs = 2e6;
  if (streams.some(stream => stream.samples.some(sample =>
    Math.abs(Number(sample[1]) - sendTimeUs) > timestampToleranceUs))) {
    console.warn('Indoor USB scalar frame rejected: sample timestamp outside packet window');
    return;
  }
  const populated = streams.filter(stream => stream.samples.length);
  if (!populated.length) return;
  lastIndoorUsbScalarAt = Date.now();
  registerSource(source, 'indoor-sky');
  const batch = { type: 'sample_batch', transport: 'usb', source, packetSequence, sendTimeUs, streams: populated };
  indoorSerialPacer.push(batch);
  if (audioCount) registerAudioCapability(source, 'indoor-sky');
}

pcmSocket.on('message', (packet, rinfo) => handlePcmPacket(packet, rinfo.address));

pcmSocket.bind(PCM_IN_PORT, '0.0.0.0', () => {
  console.log(`PCM UDP listening on port ${PCM_IN_PORT}`);
});

const pcmTcpServer = net.createServer(socket => {
  const ip = socket.remoteAddress.replace(/^::ffff:/, '');
  let pending = Buffer.alloc(0);
  socket.setNoDelay(true);
  socket.on('data', chunk => {
    pending = consumePcmBytes(pending, chunk, ip);
  });
  socket.on('error', error => console.warn(`PCM TCP ${ip}: ${error.message}`));
});
pcmTcpServer.listen(PCM_TCP_PORT, '0.0.0.0', () => {
  console.log(`PCM TCP listening on port ${PCM_TCP_PORT}`);
});

function consumePcmBytes(pending, chunk, source) {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 32) {
    const magic = pending.indexOf('ESAU');
    if (magic < 0) return pending.subarray(Math.max(0, pending.length - 3));
    if (magic) pending = pending.subarray(magic);
    if (pending.length < 32) return pending;
    const sampleCount = pending.readUInt16LE(24);
    const headerBytes = pending.readUInt16LE(26);
    const bitsPerSample = pending.readUInt8(6);
    const payloadBytes = bitsPerSample === 16 ? sampleCount * 2
      : bitsPerSample === 4 ? Math.ceil((sampleCount - 1) / 2) : -1;
    const packetBytes = headerBytes + payloadBytes;
    if (headerBytes < 32 || sampleCount < 1 || sampleCount > 4096 ||
        payloadBytes < 0 || packetBytes > 16384) {
      pending = pending.subarray(4);
      continue;
    }
    if (pending.length < packetBytes) return pending;
    handlePcmPacket(pending.subarray(0, packetBytes), source);
    pending = pending.subarray(packetBytes);
  }
  return pending.length > 65536 ? Buffer.alloc(0) : pending;
}

let pcmUsbStream = null;
let pcmUsbPending = Buffer.alloc(0);
let pendingPcmUsbCommand = null;
let indoorUsbStatus = null;
let indoorUsbStatusAt = 0;

function sendIndoorUsbCommand(command) {
  if (!fs.existsSync(PCM_USB_DEVICE) || Buffer.byteLength(command) !== 4) return false;
  if (pcmUsbStream) {
    pendingPcmUsbCommand = command;
    pcmUsbStream.destroy();
    return true;
  }
  try {
    const descriptor = fs.openSync(PCM_USB_DEVICE, 'w');
    fs.writeSync(descriptor, command);
    fs.closeSync(descriptor);
    setTimeout(openPcmUsb, 100);
    return true;
  } catch (error) {
    console.warn(`Indoor USB command: ${error.message}`);
    return false;
  }
}

function consumeUsbBytes(pending, chunk, source) {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const audioAt = pending.indexOf('ESAU');
    const scalarAt = pending.indexOf('INSK');
    const statusAt = pending.indexOf('INJS');
    const positions = [audioAt, scalarAt, statusAt].filter(position => position >= 0);
    if (!positions.length) return pending.subarray(Math.max(0, pending.length - 3));
    const frameAt = Math.min(...positions);
    if (frameAt) pending = pending.subarray(frameAt);
    if (pending.length < 4) break;
    const magic = pending.toString('ascii', 0, 4);
    if (magic === 'INJS') {
      if (pending.length < 8) break;
      const length = pending.readUInt32LE(4);
      if (length < 2 || length > 16384) { pending = pending.subarray(4); continue; }
      if (pending.length < 8 + length) break;
      try {
        indoorUsbStatus = JSON.parse(pending.toString('utf8', 8, 8 + length));
        indoorUsbStatusAt = Date.now();
        const indoorPcmDevice = 'pcm/indoor-sky/audio';
        const shouldStreamPcm = pcmSourceEnabled.get(indoorPcmDevice) === true;
        if (Boolean(indoorUsbStatus.usb_pcm_stream_enabled) !== shouldStreamPcm) {
          sendIndoorUsbCommand(shouldStreamPcm ? 'INP1' : 'INP0');
          if (!shouldStreamPcm) markPcmDerivedUnavailable(indoorPcmDevice);
        }
      } catch (error) {
        console.warn(`Indoor USB status: ${error.message}`);
      }
      pending = pending.subarray(8 + length);
      continue;
    }
    if (magic === 'ESAU') {
      if (pending.length < 32) break;
      const count = pending.readUInt16LE(24), header = pending.readUInt16LE(26), bits = pending.readUInt8(6);
      const payload = bits === 16 ? count * 2 : bits === 4 ? Math.ceil((count - 1) / 2) : -1;
      const length = header + payload;
      if (header < 32 || count < 1 || count > 4096 || payload < 0 || length > 16384) {
        pending = pending.subarray(4); continue;
      }
      if (pending.length < length) break;
      handlePcmPacket(pending.subarray(0, length), source);
      pending = pending.subarray(length);
      continue;
    }
    if (pending.length < 76) break;
    const header = pending.readUInt16LE(6), bmeCount = pending.readUInt16LE(20), audioCount = pending.readUInt16LE(22);
    const length = header + bmeCount * 24 + audioCount * 16;
    if (header < 76 || header > 256 || bmeCount > 64 || audioCount > 128 || length > 16384) {
      pending = pending.subarray(4); continue;
    }
    if (pending.length < length) break;
    handleIndoorScalarPacket(pending.subarray(0, length), source);
    pending = pending.subarray(length);
  }
  return pending.length > 65536 ? Buffer.alloc(0) : pending;
}

function openPcmUsb() {
  if (pcmUsbStream || !fs.existsSync(PCM_USB_DEVICE)) return;
  try {
    execSync(`stty -F '${PCM_USB_DEVICE}' 921600 raw -echo`);
    pcmUsbStream = fs.createReadStream(PCM_USB_DEVICE);
    pcmUsbStream.on('data', chunk => {
      pcmUsbPending = consumeUsbBytes(pcmUsbPending, chunk, '192.168.0.32');
    });
    pcmUsbStream.on('error', error => console.warn(`PCM USB: ${error.message}`));
    pcmUsbStream.on('close', () => {
      pcmUsbStream = null;
      pcmUsbPending = Buffer.alloc(0);
      const command = pendingPcmUsbCommand;
      pendingPcmUsbCommand = null;
      if (command) sendIndoorUsbCommand(command);
    });
    console.log(`PCM USB listening on ${PCM_USB_DEVICE}`);
  } catch (error) {
    console.warn(`PCM USB open: ${error.message}`);
  }
}
openPcmUsb();
setInterval(openPcmUsb, 3000);

setInterval(() => {
  const now = Date.now();
  for (const capability of audioCapabilities.values()) {
    const stream = pcmStreams.get(capability.device);
    if (capability.available && (!stream || now - stream.lastSeen > 1500)) {
      capability.available = false;
      broadcast({ ...capability, available: false, value: 0 });
      markPcmDerivedUnavailable(capability.device);
    }
  }
}, 1000);

// ─── Connection tracking ──────────────────────────────────────────────────────

const connectionsByIp = new Map();
const clientMeta      = new Map();
let residentBridge = null;
let residentBridgeRetry = null;
const RESIDENT_PORT = Number(process.env.RESIDENT_PORT || 3001);

function residentSubscriberCount() {
  let count = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.residentSubscribed) count++;
  }
  return count;
}

function updateResidentBridge() {
  const needed = residentSubscriberCount() > 0;
  if (!needed) {
    clearTimeout(residentBridgeRetry);
    residentBridgeRetry = null;
    if (residentBridge) {
      const bridge = residentBridge;
      residentBridge = null;
      bridge.close();
    }
    return;
  }
  if (residentBridge &&
      (residentBridge.readyState === WebSocket.OPEN ||
       residentBridge.readyState === WebSocket.CONNECTING)) return;

  residentBridge = new WebSocket(`ws://127.0.0.1:${RESIDENT_PORT}`);
  residentBridge.on('message', raw => {
    const message = raw.toString();
    for (const client of wss.clients) {
      if (client.residentSubscribed) sendBrowserMessage(client, message, true);
    }
  });
  residentBridge.on('close', () => {
    residentBridge = null;
    if (residentSubscriberCount() > 0) {
      residentBridgeRetry = setTimeout(updateResidentBridge, 2000);
    }
  });
  residentBridge.on('error', () => {});
}

wss.on('connection', (ws, req) => {
  const rawIp    = (req.headers['x-forwarded-for'] || req.socket.remoteAddress).replace(/^::ffff:/, '');
  const clientIp = (rawIp === '127.0.0.1' || rawIp === '::1') ? os.hostname() : rawIp;
  const viaCloudflare = Boolean(req.headers['cf-ray'] || req.headers['cf-connecting-ip']);
  ws.oscUdpAvailable = !viaCloudflare;

  if (!connectionsByIp.has(clientIp)) connectionsByIp.set(clientIp, new Set());
  connectionsByIp.get(clientIp).add(ws);
  if (ws.oscUdpAvailable) oscReceiveClients.add(clientIp);
  ws.pcmSubscriptions = new Set();
  ws.pcmAnalysisSubscriptions = new Set();
  ws.residentSubscribed = false;

  const net = getNetworkMode();
  ws.send(JSON.stringify({
    type: 'server_info',
    hostname: os.hostname(),
    platform: os.platform(),
    networkMode: net.mode,
    networkSsid: net.ssid
  }));
  ws.send(JSON.stringify({ type: 'state', state }));
  for (const [ip, name] of sourceNames) ws.send(JSON.stringify(sourceInfo(ip, name)));
  for (const capability of audioCapabilities.values()) ws.send(JSON.stringify(capability));
  ws.send(JSON.stringify({
    type: 'client_info',
    ip: clientIp,
    tabCount: connectionsByIp.get(clientIp).size,
    oscOutPort:      OSC_OUT_PORT,
    oscInPort:       OSC_IN_PORT,
    oscReceive:      oscReceiveClients.has(clientIp),
    oscUdpAvailable: ws.oscUdpAvailable,
    oscUdpReason:    ws.oscUdpAvailable
      ? 'router → OSC senders'
      : 'Connect on LAN or VPN to enable',
    isServerMachine: rawIp === '127.0.0.1' || rawIp === '::1' ||
      Object.values(os.networkInterfaces()).flat().some(i => i?.address === rawIp)
  }));
  broadcastClientStats();

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'resident_subscribe') {
        ws.residentSubscribed = data.enabled !== false;
        updateResidentBridge();
        return;
      }

      if (data.type === 'pcm_subscribe' && typeof data.device === 'string') {
        console.log(`PCM subscription ${data.enabled === false ? 'off' : 'on'} ${data.device}` +
          ` from ${clientIp} (${req.headers.referer || 'no referrer'})`);
        data.enabled === false
          ? ws.pcmSubscriptions.delete(data.device)
          : ws.pcmSubscriptions.add(data.device);
        const stream = pcmStreams.get(data.device);
        ws.send(JSON.stringify({
          type: 'pcm_stream', device: data.device,
          available: Boolean(stream),
          ...(stream || {}),
          backpressureDrops: ws.pcmBackpressureDrops || 0
        }));
        return;
      }

      if (data.type === 'pcm_analysis_subscribe' && typeof data.device === 'string') {
        console.log(`PCM analysis subscription ${data.enabled === false ? 'off' : 'on'} ${data.device}` +
          ` from ${clientIp} (${req.headers.referer || 'no referrer'})`);
        data.enabled === false
          ? ws.pcmAnalysisSubscriptions.delete(data.device)
          : ws.pcmAnalysisSubscriptions.add(data.device);
        return;
      }

      if (data.type === 'pcm_source_enable' && typeof data.device === 'string') {
        console.log(`PCM source ${data.enabled === true ? 'on' : 'off'} ${data.device}` +
          ` from ${clientIp} (${data.page || req.headers.referer || 'no page'})`);
        setPcmSourceEnabled(data.device, data.enabled === true);
        return;
      }

      if (data.type === 'midi') {
        // attach source IP so client can group by section
        data.source = clientIp;
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) client.send(JSON.stringify(data));
        });
        broadcastOSC(data);
        return;
      }

      if (data.type === 'json') {
        // attach source IP so client can group by section
        data.source = clientIp;
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) client.send(JSON.stringify(data));
        });
        broadcastOSC(data);
        return;
      }

      if (data.type === 'client_meta') {
        clientMeta.set(clientIp, { os: data.os, connType: data.connType });
        broadcastClientStats();
      }

    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  });

  ws.on('close', () => {
    ws.pcmSubscriptions.clear();
    ws.pcmAnalysisSubscriptions.clear();
    connectionsByIp.get(clientIp)?.delete(ws);
    if (connectionsByIp.get(clientIp)?.size === 0) {
      connectionsByIp.delete(clientIp);
      oscReceiveClients.delete(clientIp);
    }
    updateResidentBridge();
    broadcastClientStats();
  });
});

function broadcastClientStats() {
  for (const [ip, conns] of connectionsByIp) {
    for (const conn of conns) {
      if (conn.readyState !== 1) conns.delete(conn);
    }
    if (conns.size === 0) connectionsByIp.delete(ip);
  }

  const uniqueIps = [...connectionsByIp.keys()].map(ip => ({
    ip,
    tabCount:   connectionsByIp.get(ip).size,
    oscReceive: oscReceiveClients.has(ip),
    ...( clientMeta.get(ip) || {} )
  }));

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      for (const [ip, conns] of connectionsByIp) {
        if (conns.has(client)) {
          client.send(JSON.stringify({
            type:       'client_count',
            count:      uniqueIps.length,
            tabCount:   conns.size,
            allClients: uniqueIps
          }));
          break;
        }
      }
    }
  });
}

// ─── Network mode detection ───────────────────────────────────────────────────

function getNetworkMode() {
  try {
    execSync("nmcli -t -f active,ssid dev wifi 2>/dev/null").toString();
    const result = execSync('systemctl is-active hostapd 2>/dev/null').toString().trim();
    if (result === 'active') {
      const ssid = execSync("grep '^ssid=' /etc/hostapd/hostapd.conf 2>/dev/null")
        .toString().trim().replace('ssid=', '');
      return { mode: 'ap', ssid };
    }
  } catch {}
  try {
    const ssid = execSync("nmcli -t -f active,ssid dev wifi 2>/dev/null | grep '^yes' | cut -d: -f2")
      .toString().trim();
    return { mode: 'wifi', ssid: ssid || 'unknown' };
  } catch {}
  return { mode: 'unknown', ssid: '' };
}

// ─── HTTP routes ──────────────────────────────────────────────────────────────

app.use(express.json());
app.get('/api/status', (req, res) => res.json({ ok: true, hostname: os.hostname() }));
app.get(/^\/resident\/?$/, (req, res) => res.redirect(308, '/voices/'));
app.get(/^\/voices$/, (req, res) => res.redirect(308, '/voices/'));
app.get('/voices/', (req, res) => {
  const request = http.get({
    host: '127.0.0.1', port: RESIDENT_PORT, path: '/resident/', timeout: 5000
  }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      const html = Buffer.concat(chunks).toString('utf8').replace(
        "const ws=new WebSocket('ws://'+location.host);ws.onopen=()=>status.textContent='live · '+location.host;",
        "const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);ws.onopen=()=>{ws.send(JSON.stringify({type:'resident_subscribe',enabled:true}));status.textContent='live · '+location.host};"
      );
      res.status(response.statusCode || 200).type('text/html').send(html);
    });
  });
  request.on('timeout', () => request.destroy(new Error('resident sidecar timeout')));
  request.on('error', error => res.status(503).type('text/plain')
    .send(`resident analysis unavailable: ${error.message}`));
});
app.get(/^\/modulation-spectrum$/, (req, res) =>
  res.redirect(308, '/modulation-spectrum/'));
app.get('/modulation-spectrum/', (req, res) =>
  res.type('text/html').send(modulationSpectrumPage()));

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Router running on port ${PORT}`);
  console.log(`OSC inbound on port ${OSC_IN_PORT} (all reachable senders)`);
  console.log(`OSC outbound on port ${OSC_OUT_PORT} (registered receive clients)`);
});
