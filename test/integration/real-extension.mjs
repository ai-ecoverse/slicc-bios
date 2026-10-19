import { execFile, spawn } from 'node:child_process';
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
  release('7.6.3', '17f0e53dd5d11465ea60d7ae4409cfbb9f48859501119d62dd5e5d4673a79426'),
  release('7.6.4', 'd3523ce49e61b8db4c84d4470c5a1248b5765b3a9967b91c2a4e0f60a7f578f5'),
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

async function display() {
  if (process.platform !== 'linux' || process.env.DISPLAY) return () => {};
  for (let n = 90; n < 120; n += 1) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    const child = spawn('Xvfb', [`:${n}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });
    let failed = null;
    child.once('error', (error) => {
      failed = error;
    });
    child.once('exit', (code) => {
      failed ??= new Error(`Xvfb :${n} exited with ${code}`);
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(`/tmp/.X11-unix/X${n}`)) {
      if (failed) throw new Error(`headed Chrome needs Xvfb on Linux: ${failed.message}`);
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(`Xvfb :${n} made no socket within 15 s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    process.env.DISPLAY = `:${n}`;
    return () => {
      delete process.env.DISPLAY;
      child.kill();
    };
  }
  throw new Error('no free X display between :90 and :119');
}

export async function realExtension({
  rules = [],
  args = [],
  extension = EXTENSION,
  realistic = false,
} = {}) {
  const root = await unpacked(extension);
  const undisplay = realistic ? await display() : () => {};
  const upstream = { url: null };
  const tls = await front(upstream);
  const chrome = await launch({
    realistic,
    extensions: [root],
    args: [
      ...args,
      '--ignore-certificate-errors',
      `--host-resolver-rules=${[`MAP seven.sliccy.ai 127.0.0.1:${tls.port}`, ...rules].join(', ')}`,
    ],
  });
  upstream.url = new URL(chrome.url);
  const close = chrome.close;
  chrome.close = async (...rest) => {
    tls.close();
    try {
      return await close.apply(chrome, rest);
    } finally {
      undisplay();
    }
  };
  return chrome;
}
