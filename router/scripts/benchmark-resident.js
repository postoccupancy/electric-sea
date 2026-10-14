'use strict';
const os = require('node:os');
const { ResidentStreamRegistry } = require('../ResidentStreamRegistry');
const registry = new ResidentStreamRegistry();
let end = 120e6;
const value = t => 20 + Math.sin(2 * Math.PI * t / 5e6);
for (let t = 0; t <= end; t += 20000) registry.ingest('osc/benchmark/temperature', t, value(t));
function frame() {
  end += 20000;
  registry.ingest('osc/benchmark/temperature', end, value(end));
  registry.analyzeNext();
}
for (let i = 0; i < 5; i++) frame();
const cpu = process.cpuUsage();
const start = performance.now();
for (let i = 0; i < 50; i++) frame();
console.log(JSON.stringify({
  host: os.cpus()[0].model, platform: process.platform, frames: 50,
  wallMsPerFrame: (performance.now() - start) / 50,
  cpuMsPerFrame: Object.values(process.cpuUsage(cpu)).reduce((a, b) => a + b, 0) / 50000,
}, null, 2));
