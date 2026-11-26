import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

export async function control(path, op, params = {}) {
  const socket = createConnection(path);
  socket.setTimeout(4000, () => socket.destroy(new Error('owner control did not answer')));
  try {
    await once(socket, 'connect');
    socket.write(`${JSON.stringify({ v: 1, op, ...params })}\n`);
    let json = '';
    for await (const bytes of socket) {
      json += bytes;
      if (json.includes('\n')) break;
    }
    const r = JSON.parse(json);
    assert.equal(r.ok, true, 'owner control refused the operation');
    return r;
  } finally {
    socket.destroy();
  }
}

export async function device(home, hub) {
  const config =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : join(home, 'config');
  await mkdir(join(config, 'slicc'), { recursive: true });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-nodes',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-subj',
      '/CN=synthetic-broker',
      '-days',
      '7',
      '-keyout',
      join(home, 'key'),
      '-out',
      join(home, 'cert'),
    ],
    { stdio: 'ignore' }
  );
  const cert = await readFile(join(home, 'cert'), 'utf8');
  const pem = cert + (await readFile(join(home, 'key'), 'utf8'));
  await writeFile(
    join(config, 'slicc', 'tray-certs.json.lease'),
    JSON.stringify({
      version: 1,
      hubs: [{ origin: hub, pem, createdAt: new Date().toISOString() }],
    }),
    { mode: 0o600 }
  );
  return new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
}
