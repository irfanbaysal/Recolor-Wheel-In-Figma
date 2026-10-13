// Usage: import { apng } from './apng.mjs'; apng(arrayOfPngBuffers, delayNum = 1, delayDen = 12) -> APNG Buffer (frames share one IHDR)
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function readChunks(buf) {
  const chunks = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    chunks.push({ type: buf.toString('ascii', at + 4, at + 8), data: buf.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
  }
  return chunks;
}

function u32(...values) {
  const b = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => b.writeUInt32BE(v, 4 * i));
  return b;
}

export function apng(frames, delayNum = 1, delayDen = 12) {
  const first = readChunks(frames[0]);
  const ihdr = first.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const parts = [frames[0].subarray(0, 8), chunk('IHDR', ihdr), chunk('acTL', u32(frames.length, 0))];
  let seq = 0;
  frames.forEach((frame, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(height, 8);
    fctl.writeUInt16BE(delayNum, 20);
    fctl.writeUInt16BE(delayDen, 22);
    parts.push(chunk('fcTL', fctl));
    for (const c of readChunks(frame).filter((c) => c.type === 'IDAT')) {
      parts.push(i === 0 ? chunk('IDAT', c.data) : chunk('fdAT', Buffer.concat([u32(seq++), c.data])));
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
