import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const tailnetWanted = process.env.TAILSCALE_E2E
  ? process.env.TAILSCALE_E2E === '1'
  : Boolean(process.env.CI);

const RELEASES = {
  x64: {
    headscale: '212ed0a884c0d3541e094c4bebbe94397df6f4e01bd3d7f059c520cb55e0d757',
    tailscale: '108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528',
    arch: 'amd64',
  },
  arm64: {
    headscale: 'cbad8f02524cc6a94955a107a72e1d4cc652ae3f22e740d5c60884e7f384d60e',
    tailscale: 'f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806',
    arch: 'arm64',
  },
};
const HEADSCALE_VERSION = '0.29.4';
const TAILSCALE_VERSION = '1.104.1';

async function fetched(url, sha256, file) {
  if (existsSync(file)) return file;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== sha256) throw new Error(`${url}: sha256 ${got}, not the pinned ${sha256}`);
  await writeFile(`${file}.part`, body, { mode: 0o755 });
  await rename(`${file}.part`, file);
  return file;
}

async function downloaded() {
  const release = process.platform === 'linux' && RELEASES[process.arch];
  if (!release) return null;
  const dir = fileURLToPath(new URL('../../node_modules/.cache/tailnet/', import.meta.url));
  await mkdir(dir, { recursive: true });
  const headscale = await fetched(
    `https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/headscale_${HEADSCALE_VERSION}_linux_${release.arch}`,
    release.headscale,
    join(dir, `headscale-${HEADSCALE_VERSION}`)
  );
  const tgz = await fetched(
    `https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${release.arch}.tgz`,
    release.tailscale,
    join(dir, `tailscale-${TAILSCALE_VERSION}.tgz`)
  );
  const unpacked = join(dir, `tailscale-${TAILSCALE_VERSION}`);
  if (!existsSync(join(unpacked, 'tailscaled'))) {
    await mkdir(unpacked, { recursive: true });
    await run('tar', ['-xzf', tgz, '-C', unpacked, '--strip-components=1']);
  }
  return [headscale, join(unpacked, 'tailscaled'), join(unpacked, 'tailscale')];
}

const [HEADSCALE, TAILSCALED, TAILSCALE] =
  process.env.HEADSCALE || !tailnetWanted
    ? [process.env.HEADSCALE, process.env.TAILSCALED, process.env.TAILSCALE]
    : ((await downloaded()) ?? []);

export const tailnetAvailable = [HEADSCALE, TAILSCALED, TAILSCALE].every(
  (bin) => bin && existsSync(bin)
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve) => {
    const server = createTcpServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function corsProxy(target, port) {
  const server = createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'cross-origin-resource-policy': 'cross-origin',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const upstream = request(
      { host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode, { ...answer.headers, ...cors });
        answer.pipe(res);
      }
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    const upstream = connect(target, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function halfCloseServer(port) {
  const server = createTcpServer((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () =>
      socket.end(Buffer.concat([Buffer.from('got '), ...chunks, Buffer.from(' then EOF')]))
    );
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function gitServer(port, dir) {
  const work = join(dir, 'git-work');
  const bare = join(dir, 'git', 'repo.git');
  const git = (...args) =>
    run('git', args, {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'slicc',
        GIT_AUTHOR_EMAIL: 'slicc@test',
        GIT_COMMITTER_NAME: 'slicc',
        GIT_COMMITTER_EMAIL: 'slicc@test',
      },
    });
  await git('init', '--quiet', '--bare', '--initial-branch=main', bare);
  await git('init', '--quiet', '--initial-branch=main', work);
  await writeFile(join(work, 'README'), 'hello from git over the tailnet\n');
  await git('-C', work, 'add', 'README');
  await git('-C', work, 'commit', '--quiet', '-m', 'hello');
  await git('-C', work, 'push', '--quiet', bare, 'main');
  await git('-C', bare, 'update-server-info');
  const root = join(dir, 'git');
  const server = createServer(async (req, res) => {
    const path = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!path.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function wsEchoServer(port) {
  const { WebSocketServer } = await import('ws');
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port,
    handleProtocols: (set) => (set.has('echo') ? 'echo' : false),
  });
  server.seen = [];
  const close = server.close.bind(server);
  server.close = () => {
    for (const client of server.clients) client.terminate();
    return close();
  };
  server.on('connection', (socket, req) => {
    server.seen.push({ url: req.url, headers: req.headers });
    socket.on('message', (data, binary) => {
      if (!binary && String(data) === 'bye') socket.close(4001, 'far end done');
      else socket.send(data, { binary });
    });
  });
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

function silentServer(port) {
  const sockets = new Set();
  let total = 0;
  const server = createTcpServer((socket) => {
    total += 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.accepted = () => total;
  const close = server.close.bind(server);
  server.close = () => {
    for (const socket of sockets) socket.destroy();
    return close();
  };
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function webServer(port, body) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export async function startTailnet() {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-tailnet-'));
  const [
    hsPort,
    proxyPort,
    stunPort,
    metricsPort,
    grpcPort,
    webPort,
    echoPort,
    gitPort,
    wsPort,
    silentPort,
  ] = await Promise.all(Array.from({ length: 10 }, freePort));
  const config = join(dir, 'config.yaml');
  await writeFile(
    config,
    `server_url: http://127.0.0.1:${hsPort}
listen_addr: 127.0.0.1:${hsPort}
metrics_listen_addr: 127.0.0.1:${metricsPort}
grpc_listen_addr: 127.0.0.1:${grpcPort}
noise:
  private_key_path: ${dir}/noise.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: true
    region_id: 999
    region_code: local
    region_name: Local DERP
    verify_clients: true
    stun_listen_addr: 127.0.0.1:${stunPort}
    private_key_path: ${dir}/derp.key
    automatically_add_embedded_derp_region: true
    ipv4: 127.0.0.1
  urls: []
  paths: []
  auto_update_enabled: false
disable_check_updates: true
database:
  type: sqlite
  sqlite:
    path: ${dir}/db.sqlite
log:
  level: warn
policy:
  mode: file
  path: ""
dns:
  magic_dns: true
  base_domain: slicc.test
  override_local_dns: false
  nameservers:
    global: []
unix_socket: ${dir}/headscale.sock
unix_socket_permission: "0770"
`
  );
  const children = [];
  const servers = [];
  const hs = (...args) =>
    run(HEADSCALE, ['-c', config, ...args]).then(({ stdout }) => stdout.trim());
  children.push(spawn(HEADSCALE, ['serve', '-c', config], { stdio: 'ignore' }));
  for (let i = 0; i < 100; i++) {
    if (
      await hs('users', 'list').then(
        () => true,
        () => false
      )
    )
      break;
    await wait(100);
  }
  await hs('users', 'create', 'slicc');
  const users = JSON.parse(await hs('users', 'list', '-o', 'json'));
  const user = String(users.find((u) => u.name === 'slicc').id);
  const key = (
    await hs(
      'preauthkeys',
      'create',
      '--user',
      user,
      '--reusable',
      '--ephemeral',
      '--expiration',
      '1h'
    )
  )
    .split('\n')
    .at(-1);
  servers.push(await corsProxy(hsPort, proxyPort));
  servers.push(await webServer(webPort, `hello from the local tailnet ${Date.now()}`));
  servers.push(await halfCloseServer(echoPort));
  servers.push(await gitServer(gitPort, dir));
  const wsEcho = await wsEchoServer(wsPort);
  servers.push(wsEcho);
  const silent = await silentServer(silentPort);
  servers.push(silent);

  const env = { ...process.env, TS_DEBUG_USE_DERP_HTTP: '1' };
  const node = async (name, extra = []) => {
    const state = join(dir, name);
    const socket = join(dir, `${name}.sock`);
    children.push(
      spawn(
        TAILSCALED,
        [
          '--tun=userspace-networking',
          '--state=mem:',
          `--socket=${socket}`,
          `--statedir=${state}`,
          '--port=0',
        ],
        {
          env,
          stdio: 'ignore',
        }
      )
    );
    const cli = (...args) =>
      run(TAILSCALE, [`--socket=${socket}`, ...args], { env }).then(({ stdout }) => stdout.trim());
    for (let i = 0; i < 100; i++) {
      if (
        await cli('version').then(
          () => true,
          () => false
        )
      )
        break;
      await wait(100);
    }
    await cli(
      'up',
      `--login-server=http://127.0.0.1:${hsPort}`,
      `--auth-key=${key}`,
      `--hostname=${name}`,
      '--timeout=60s',
      ...extra
    );
    const ip = await cli('ip', '-4');
    return { name, ip, socket, cli: `${TAILSCALE} --socket=${socket}` };
  };
  const peer = await node('peer');
  const exit = await node('exit', ['--advertise-exit-node']);
  const nodes = JSON.parse(await hs('nodes', 'list', '-o', 'json'));
  const exitId = String(nodes.find((n) => n.given_name === 'exit' || n.name === 'exit').id);
  await hs('nodes', 'approve-routes', '--identifier', exitId, '--routes', '0.0.0.0/0,::/0');

  return {
    controlURL: `http://127.0.0.1:${proxyPort}`,
    key,
    peer: {
      ...peer,
      web: `http://${peer.ip}:${webPort}/`,
      echo: `${peer.ip}:${echoPort}`,
      git: `http://peer:${gitPort}/repo.git`,
      ws: `${peer.ip}:${wsPort}`,
      wsSeen: wsEcho.seen,
      silent: `${peer.ip}:${silentPort}`,
      silentAccepted: () => silent.accepted(),
    },
    exit,
    async close() {
      for (const server of servers) server.close();
      for (const child of children.reverse()) child.kill();
      await wait(300);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
