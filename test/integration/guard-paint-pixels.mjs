import { inflateSync } from 'node:zlib';

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function markerPixels(base64) {
  const png = Buffer.from(base64, 'base64');
  const chunks = [];
  let width = 0;
  let height = 0;
  let channels = 0;
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const kind = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('an unexpected PNG format');
    }
    if (kind === 'IDAT') chunks.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const corner = x >= channels ? previous[x - channels] : 0;
      const base = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter];
      row[x] = (line[x] + base) & 255;
    }
    if (channels >= 3) {
      for (let x = 0; x < stride; x += channels) {
        if (row[x] > 200 && row[x + 1] < 80 && row[x + 2] > 200) count += 1;
      }
    }
    previous = row;
  }
  return count;
}
