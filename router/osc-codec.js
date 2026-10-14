'use strict';

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

module.exports = { buildOSCMessage, buildTypedOSCMessage, buildScalarBatchOsc, parseOSCMessage, parseOSCPacket };
