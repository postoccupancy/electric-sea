'use strict';

// One destination per IP, with independent WebSocket and OSC ownership.
class OscClients {
  constructor({ timeoutMs = 30000, now = Date.now } = {}) {
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.websockets = new Map();
    this.native = new Map();
  }
  add(ip, owner) {
    if (!this.websockets.has(ip)) this.websockets.set(ip, new Set());
    this.websockets.get(ip).add(owner);
  }
  delete(ip, owner) {
    const owners = this.websockets.get(ip);
    owners?.delete(owner);
    if (owners?.size === 0) this.websockets.delete(ip);
  }
  expire() {
    for (const [ip, until] of this.native) if (until <= this.now()) this.native.delete(ip);
  }
  control(message, ip) {
    if (!['/router/subscribe', '/router/heartbeat', '/router/unsubscribe'].includes(message.address)) return false;
    // This router has exactly one output port. Reject other destinations.
    if (message.args.length !== 1 || message.args[0] !== 9000) return true;
    if (message.address === '/router/unsubscribe') this.native.delete(ip);
    else this.native.set(ip, this.now() + this.timeoutMs);
    return true;
  }
  has(ip) { this.expire(); return this.websockets.has(ip) || this.native.has(ip); }
  [Symbol.iterator]() {
    this.expire();
    return new Set([...this.websockets.keys(), ...this.native.keys()])[Symbol.iterator]();
  }
  get size() { return [...this].length; }
}
module.exports = { OscClients };
