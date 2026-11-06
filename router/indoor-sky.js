'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { injectDeploymentControl } = require('./deployment-controls');

function writeUsbCommand(stream, command, write = fs.writeSync) {
  if (!stream || !Number.isInteger(stream.fd) || stream.fd < 0 ||
      !['INRS', 'INP1', 'INP0'].includes(command)) return false;
  try {
    let offset = 0;
    while (offset < 4) {
      const written = write(stream.fd, command.slice(offset));
      if (!Number.isInteger(written) || written <= 0 || written > 4 - offset) return false;
      offset += written;
    }
    return true;
  }
  catch { return false; }
}

function isIndoorPcm(device, sourceName) {
  return device === 'pcm/indoor-sky/audio' || sourceName === 'indoor-sky';
}

function installIndoorRoutes(app, { requireAdmin, getUsb, sendCommand, now = Date.now }) {
  const html = injectDeploymentControl(
    fs.readFileSync(path.join(__dirname, 'pages/indoor-sky.html'), 'utf8'), 'indoor-sky');
  app.get(/^\/indoor-sky$/, (req, res) => res.redirect(308, '/indoor-sky/'));
  app.get('/indoor-sky/', (req, res) => res.type('html').send(html));
  app.get('/indoor-sky/status', (req, res) => {
    const usb = getUsb();
    res.set('Cache-Control', 'no-store');
    if (!usb.connected || !usb.status || now() - usb.receivedAt >= 5000) {
      return res.status(503).json({ healthy: false, detail: 'Indoor Sky USB status unavailable',
        usb_router: usb.diagnostics });
    }
    res.json({ ...usb.status, usb_router: usb.diagnostics });
  });
  app.post('/indoor-sky/restart', requireAdmin, (req, res) => {
    if (!sendCommand('INRS')) return res.status(503).json({ detail: 'Indoor Sky USB unavailable' });
    res.type('text').send('restarting over USB');
  });
}

module.exports = { installIndoorRoutes, writeUsbCommand, isIndoorPcm };
