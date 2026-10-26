import { crc32 } from 'node:zlib';

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

export function eventFrame(type, body) {
  const headers = Buffer.concat(
    Object.entries({
      ':event-type': type,
      ':message-type': 'event',
      ':content-type': 'application/json',
    }).map(([name, value]) => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(Buffer.byteLength(value));
      return Buffer.concat([
        Buffer.from([Buffer.byteLength(name)]),
        Buffer.from(name),
        Buffer.from([7]),
        length,
        Buffer.from(value),
      ]);
    })
  );
  const payload = Buffer.from(JSON.stringify(body));
  const prelude = Buffer.concat([
    uint32(16 + headers.length + payload.length),
    uint32(headers.length),
  ]);
  const head = Buffer.concat([prelude, uint32(crc32(prelude)), headers, payload]);
  return Buffer.concat([head, uint32(crc32(head))]);
}
