import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { launch } from './chrome.mjs';

const run = promisify(execFile);

const release = (version, sha256) => ({
  version,
  url: `https://github.com/ai-ecoverse/slicc-extension/releases/download/v${version}/slicc-extension.zip`,
  sha256,
});
export const EXTENSIONS = [
  release('7.5.1', 'bdcd08b945cf69baa554cf01072d88436c3f8b97b05376cd369746598cf84a75'),
  release('7.6.2', '0871897fe03e96bddb16ab1c2712437e99835d01ca4566049a61ae888277c20e'),
];
export const [EXTENSION] = EXTENSIONS;
export const SEVEN = 'https://seven.sliccy.ai/';

async function unpacked(extension) {
  const dir = join(process.cwd(), 'node_modules', '.cache', `slicc-extension-${extension.version}`);
  const root = join(dir, 'unpacked');
  if (existsSync(join(root, 'manifest.json'))) return root;
  const response = await fetch(extension.url);
  if (!response.ok) throw new Error(`${extension.url}: HTTP ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  const sum = createHash('sha256').update(zip).digest('hex');
  if (sum !== extension.sha256)
    throw new Error(`${extension.url}: sha256 ${sum}, want ${extension.sha256}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(dir, 'slicc-extension.zip'), zip);
  await run('unzip', ['-q', join(dir, 'slicc-extension.zip'), '-d', root]);
  return root;
}

async function certificate() {
  const dir = await mkdtemp(join(tmpdir(), 'seven-front-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=seven.sliccy.ai',
    '-keyout',
    key,
    '-out',
    cert,
  ]);
  const pair = { key: await readFile(key), cert: await readFile(cert) };
  await rm(dir, { recursive: true, force: true });
  return pair;
}

async function front(upstream) {
  const server = createServer(await certificate(), (req, res) => {
    const up = request(
      {
        host: upstream.url.hostname,
        port: upstream.url.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstream.url.host },
      },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      }
    );
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

export async function realExtension({ rules = [], args = [], extension = EXTENSION } = {}) {
  const root = await unpacked(extension);
  const upstream = { url: null };
  const tls = await front(upstream);
  const chrome = await launch({
    extensions: [root],
    args: [
      ...args,
      '--ignore-certificate-errors',
      `--host-resolver-rules=${[`MAP seven.sliccy.ai 127.0.0.1:${tls.port}`, ...rules].join(', ')}`,
    ],
  });
  upstream.url = new URL(chrome.url);
  const close = chrome.close;
  chrome.close = (...rest) => {
    tls.close();
    return close.apply(chrome, rest);
  };
  return chrome;
}
