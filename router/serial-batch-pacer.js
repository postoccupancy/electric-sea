class SerialBatchPacer {
  constructor(deliver, options = {}) {
    this.deliver = deliver;
    this.startupBufferMs = options.startupBufferMs ?? 250;
    this.maxIntervalMs = options.maxIntervalMs ?? 250;
    this.maxQueue = options.maxQueue ?? 256;
    this.schedule = options.schedule ?? ((fn, delay) => setTimeout(fn, delay));
    this.cancel = options.cancel ?? clearTimeout;
    this.now = options.now ?? Date.now;
    this.queue = [];
    this.timer = null;
    this.lastQueuedTimeUs = null;
    this.lastDueMs = null;
    this.dueTimes = new WeakMap();
    this.counters = { received: 0, delivered: 0, dropped: 0, resets: 0, maxDepth: 0 };
  }

  push(batch) {
    this.counters.received++;
    if (this.lastQueuedTimeUs !== null && batch.sendTimeUs <= this.lastQueuedTimeUs) {
      this.counters.resets++;
      this.reset();
    }
    const intervalMs = this.lastQueuedTimeUs === null
      ? this.startupBufferMs
      : Math.max(1, Math.min(this.maxIntervalMs,
        (batch.sendTimeUs - this.lastQueuedTimeUs) / 1000));
    const dueMs = this.lastDueMs === null ? this.now() + intervalMs : this.lastDueMs + intervalMs;
    this.lastQueuedTimeUs = batch.sendTimeUs;
    this.lastDueMs = dueMs;
    this.dueTimes.set(batch, dueMs);
    this.queue.push(batch);
    if (this.queue.length > this.maxQueue) {
      const dropped = this.queue.length - this.maxQueue;
      this.queue.splice(0, dropped);
      this.counters.dropped += dropped;
    }
    this.counters.maxDepth = Math.max(this.counters.maxDepth, this.queue.length);
    if (this.timer === null) this.scheduleNext();
  }

  scheduleNext() {
    const next = this.queue[0];
    if (!next) return;
    const delay = Math.max(0, this.dueTimes.get(next) - this.now());
    this.timer = this.schedule(() => this.drain(), delay);
  }

  drain() {
    this.timer = null;
    const current = this.queue.shift();
    if (!current) return;
    this.deliver(current);
    this.counters.delivered++;
    this.scheduleNext();
  }

  reset() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.lastQueuedTimeUs = null;
    this.lastDueMs = null;
    this.dueTimes = new WeakMap();
  }

  status() {
    return { ...this.counters, queueDepth: this.queue.length };
  }
}

module.exports = { SerialBatchPacer };
