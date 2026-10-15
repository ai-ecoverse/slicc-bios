import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { boot, ready, run } from './bios.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const chrome = await launch();
after(() => chrome.close());

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZha2Ugbm9kZSBob3N0IGtleSBmb3IgdGVzdHM=';

function fakeNode(key) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const frame = (type, id, payload = new Uint8Array(0)) => {
    const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
    const out = new Uint8Array(5 + bytes.length);
    out[0] = type;
    new DataView(out.buffer).setUint32(1, id);
    out.set(bytes, 5);
    return out;
  };
  const log = (globalThis.fakeNodeLog = []);
  const pc = new RTCPeerConnection();
  const answer = (channel, id, meta) => {
    log.push(meta);
    if (meta.kind === 'ws') {
      channel.send(frame(2, id, JSON.stringify({ protocol: '' })));
      const hello = encoder.encode(`ws hello ${meta.url}`);
      const record = new Uint8Array(5 + hello.length);
      record[0] = 1;
      new DataView(record.buffer).setUint32(1, hello.length);
      record.set(hello, 5);
      channel.send(frame(3, id, record));
      return (type, payload) => {
        if (type !== 3) return;
        const credit = new Uint8Array(4);
        new DataView(credit.buffer).setUint32(0, payload.length);
        channel.send(frame(6, id, credit));
        channel.send(frame(3, id, payload));
      };
    }
    if (meta.kind === 'resolve') {
      const addresses = meta.name === 'far.example' ? ['203.0.113.7'] : [];
      channel.send(frame(2, id, JSON.stringify({ addresses, ttl: 30 })));
      channel.send(frame(4, id));
      return null;
    }
    channel.send(
      frame(
        2,
        id,
        JSON.stringify({ localAddr: '10.9.8.7:4000', remoteAddr: `${meta.host}:${meta.port}` })
      )
    );
    const received = [];
    return (type, payload) => {
      if (type === 3) {
        received.push(...payload);
        const credit = new Uint8Array(4);
        new DataView(credit.buffer).setUint32(0, payload.length);
        channel.send(frame(6, id, credit));
      }
      const text = decoder.decode(new Uint8Array(received));
      const reply = (body) => {
        channel.send(frame(3, id, body));
        channel.send(frame(4, id));
      };
      if (meta.kind === 'tcp' && type === 3 && text.includes('\r\n\r\n')) {
        reply(
          `HTTP/1.0 200 OK\r\ncontent-type: text/plain\r\n\r\nraw ${meta.host}:${meta.port} ${text.split(' ')[1]}\n`
        );
      }
      if (meta.kind === 'http' && type === 4) {
        const size = new DataView(new Uint8Array(received).buffer).getUint32(0);
        const head = JSON.parse(decoder.decode(new Uint8Array(received.slice(4, 4 + size))));
        const body = encoder.encode(`http ${head.method} ${head.url}\n`);
        const top = encoder.encode(
          JSON.stringify({
            status: 200,
            statusText: 'OK',
            headers: [['content-type', 'text/plain']],
            url: head.url,
          })
        );
        const out = new Uint8Array(4 + top.length + body.length);
        new DataView(out.buffer).setUint32(0, top.length);
        out.set(top, 4);
        out.set(body, 4 + top.length);
        reply(out);
      }
    };
  };
  const serve = (channel) => {
    channel.binaryType = 'arraybuffer';
    const streams = new Map();
    channel.onmessage = ({ data }) => {
      if (typeof data === 'string') {
        log.push(JSON.parse(data));
        channel.send(
          JSON.stringify({
            v: 1,
            role: 'node',
            name: 'fake node',
            host: 'Fake-Node',
            mode: 'local',
            caps: ['net', 'http', 'ssh', 'ws'],
            routes: { prefixes: [], exit: true },
            sshHostKey: key,
          })
        );
        return;
      }
      const bytes = new Uint8Array(data);
      const id = new DataView(bytes.buffer).getUint32(1);
      const payload = bytes.subarray(5);
      if (bytes[0] === 1) streams.set(id, answer(channel, id, JSON.parse(decoder.decode(payload))));
      else streams.get(id)?.(bytes[0], payload.slice());
    };
  };
  pc.ondatachannel = ({ channel }) => serve(channel);
  const nonce = 'test-nonce';
  pc.onicecandidate = ({ candidate }) =>
    globalThis.sliccLinkReceive(
      JSON.stringify({ t: 'candidate', nonce, candidate: candidate?.toJSON() ?? null })
    );
  globalThis.sliccLinkSend = async (text) => {
    const message = JSON.parse(text);
    if (message.nonce !== nonce) return;
    if (message.t === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      globalThis.sliccLinkReceive(
        JSON.stringify({ t: 'answer', nonce, sdp: pc.localDescription.sdp })
      );
    } else if (message.t === 'candidate' && message.candidate) {
      await pc.addIceCandidate(message.candidate).catch(() => {});
    }
  };
  globalThis.sliccLinkReceive(JSON.stringify({ t: 'hello', v: 1, nonce }));
}

const kernelFile = (page, name) =>
  page.evaluate(async (name) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    const parts = name.split('/');
    let dir = home;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
  }, name);

const knownHosts = (page, name) =>
  shell(
    page,
    'for i in $(seq 1 50); do [ -s /etc/ssh/ssh_known_hosts ] && break; sleep 0.2; done; cat /etc/ssh/ssh_known_hosts',
    `known-${name}`
  );

async function shell(page, command, name) {
  await run(page, `${command} > /home/${name}.txt 2>&1; echo $? > /home/${name}.done`);
  await page.until(async (name) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return home.getFileHandle(`${name}.done`).then(
      async (handle) => (await handle.getFile()).size > 0,
      () => false
    );
  }, name);
  return {
    code: (await kernelFile(page, `${name}.done`)).trim(),
    out: (await kernelFile(page, `${name}.txt`)).trim(),
  };
}

test('a linked node over real WebRTC: its name, raw TCP and HTTP to its loopback, its host key, as the automatic exit until Directly, and as the chosen exit, held while it is gone', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  await page.evaluate(fakeNode, KEY);
  await page.until(() => globalThis.fakeNodeLog?.some((m) => m.role === 'page'));
  const hello = await page.evaluate(() => globalThis.fakeNodeLog.find((m) => m.role === 'page'));
  assert.deepEqual(
    { ...hello, name: hello.name.replace(/ on .*/, '') },
    {
      v: 1,
      role: 'page',
      name: 'seven',
      mode: 'local',
      caps: ['kernel-in', 'browsers', 'mounts', 'agent'],
    }
  );
  assert.match(hello.name, /^seven on (localhost|127\.0\.0\.1):\d+$/);
  assert.deepEqual(await knownHosts(page, 'fake'), {
    code: '0',
    out: `fake-node.slicc.internal,198.18.57.11 ${KEY}`,
  });

  const raw = await shell(
    page,
    "curl -s --noproxy '*' http://fake-node.slicc.internal:8080/raw",
    'link-raw'
  );
  assert.deepEqual(raw, { code: '0', out: 'raw 127.0.0.1:8080 /raw' });
  const http = await shell(page, 'curl -s http://fake-node.slicc.internal:8081/x', 'link-http');
  assert.deepEqual(http, { code: '0', out: 'http GET http://127.0.0.1:8081/x' });
  const kinds = await page.evaluate(() =>
    globalThis.fakeNodeLog.filter((m) => m.kind).map((m) => m.kind)
  );
  assert.ok(kinds.includes('tcp'), JSON.stringify(kinds));
  assert.ok(kinds.includes('http'), JSON.stringify(kinds));
  const network = () =>
    page.evaluate(() => {
      const { exit, links } = document.querySelector('slicc-app').model.network.status();
      return {
        exit,
        devices: links?.devices.map((d) => [d.id, d.host, d.state, d.exit, d.offers.join()]),
      };
    });
  assert.deepEqual(await network(), {
    exit: { kind: 'link', id: 'local' },
    devices: [['local', 'fake-node.slicc.internal', 'connected', true, 'net,http,ssh']],
  });
  const automatic = await shell(
    page,
    "curl -s --noproxy '*' --max-time 10 http://far.example/automatic",
    'link-automatic'
  );
  assert.deepEqual(automatic, { code: '0', out: 'raw 203.0.113.7:80 /automatic' });
  const upgraded = await shell(
    page,
    "curl -s -i -N --noproxy '' --max-time 4 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' http://far.example/ws | tr -d '\\000-\\010\\016-\\037\\200-\\377'",
    'link-ws'
  );
  assert.match(upgraded.out, /^HTTP\/1\.1 101 Switching Protocols/, upgraded.out);
  assert.match(upgraded.out, /ws hello ws:\/\/far\.example\/ws/, upgraded.out);
  assert.ok(
    await page.evaluate(() =>
      globalThis.fakeNodeLog.some((m) => m.kind === 'ws' && m.url === 'ws://far.example/ws')
    )
  );
  await page.evaluate(() => document.querySelector('slicc-app').model.network.setExit(null));
  assert.equal((await network()).exit, null);
  const before = await page.evaluate(() => globalThis.fakeNodeLog.length);
  const far = await shell(
    page,
    "curl -s --noproxy '*' --max-time 5 http://far.example/",
    'link-far'
  );
  assert.notEqual(far.code, '0');
  assert.equal(
    await page.evaluate(
      (from) =>
        globalThis.fakeNodeLog
          .slice(from)
          .some((m) => m.kind === 'resolve' || m.host === '203.0.113.7'),
      before
    ),
    false
  );
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.network.setExit({ kind: 'link', id: 'local' })
  );
  assert.deepEqual((await network()).exit, { kind: 'link', id: 'local' });
  const through = await shell(
    page,
    "curl -s --noproxy '*' --max-time 10 http://far.example/far",
    'link-exit'
  );
  assert.deepEqual(through, { code: '0', out: 'raw 203.0.113.7:80 /far' });
  await page.reload();
  await ready(page);
  assert.deepEqual(await network(), { exit: { kind: 'link', id: 'local' } });
  const heldBack = await shell(
    page,
    "curl -s --noproxy '*' --max-time 5 http://far.example/far",
    'link-held'
  );
  assert.notEqual(heldBack.code, '0');
  await page.evaluate(() => document.querySelector('slicc-app').model.network.setExit(null));
  assert.equal((await network()).exit, null);
});

const cli = process.env.SLICC_CLI;

test('links the real slicc CLI over stdio signaling, and kernel curl reaches its loopback over raw TCP and the http kind, also as host.slicc.internal', {
  skip: !cli,
}, async (t) => {
  const big = Buffer.alloc(1024 * 1024, 'x');
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/plain');
    if (request.url === '/upload') {
      let received = 0;
      request.on('data', (chunk) => {
        received += chunk.length;
      });
      request.on('end', () => response.end(`got ${request.method} ${received}\n`));
      return;
    }
    response.end(request.url === '/big' ? big : `cli ${request.method} ${request.url}\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  const node = spawn(cli, ['attach', '--signal', 'stdio', '--name', 'ref-node', '--no-kernel'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => node.kill());
  const seen = [];
  await page.expose('sliccLinkSend', (message) => {
    seen.push(message.t);
    node.stdin.write(`${JSON.stringify(message)}\n`);
  });
  for await (const line of createInterface({ input: node.stdout })) {
    const message = JSON.parse(line);
    seen.push(`node:${message.t}`);
    await page.evaluate((line) => globalThis.sliccLinkReceive(line), line);
    if (message.t === 'answer') break;
  }
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  const url = `http://ref-node.slicc.internal:${port}`;
  const raw = await shell(
    page,
    `for i in 1 2 3 4 5 6 7 8 9 10; do curl -s --noproxy '*' ${url}/raw && break; sleep 1; done`,
    'cli-raw'
  );
  assert.deepEqual(raw, { code: '0', out: 'cli GET /raw' });
  const size = await shell(page, `curl -s --noproxy '*' ${url}/big | wc -c`, 'cli-big');
  assert.deepEqual(size, { code: '0', out: String(big.length) });
  const http = await shell(page, `curl -s -X POST --data-binary hello ${url}/http`, 'cli-http');
  assert.deepEqual(http, { code: '0', out: 'cli POST /http' });
  const httpBig = await shell(page, `curl -s ${url}/big | wc -c`, 'cli-http-big');
  assert.deepEqual(httpBig, { code: '0', out: String(big.length) });
  const upload = await shell(
    page,
    `head -c 8388608 /dev/zero > /tmp/upload.bin && curl -s -T /tmp/upload.bin ${url}/upload`,
    'cli-http-upload'
  );
  assert.deepEqual(upload, { code: '0', out: 'got PUT 8388608' });
  const host = await shell(page, `curl -s http://host.slicc.internal:${port}/host`, 'cli-host');
  assert.deepEqual(host, { code: '0', out: 'cli GET /host' });
  assert.equal(seen[0], 'node:hello');
  for (const step of ['offer', 'candidate', 'node:answer']) assert.ok(seen.includes(step), step);
  assert.ok(seen.indexOf('offer') < seen.indexOf('node:answer'));
});

test('the real slicc CLI: ssh into it with its pinned host key, and as the exit, automatic for a local CLI, it resolves names from its hosts file, or refuses them under its policy', {
  skip: !cli,
}, async (t) => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { networkInterfaces, tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
  assert.ok(lan, 'a non-loopback IPv4 address for the hosts-file test');
  const dir = await mkdtemp(join(tmpdir(), 'link-hosts-'));
  const hosts = join(dir, 'hosts');
  await writeFile(hosts, `# test names\n${lan} ref.link.test\n`);
  const server = createServer((request, response) => response.end(`hosts ${request.url}\n`));
  await new Promise((resolve) => server.listen(0, lan, resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  let current = null;
  await page.expose('sliccLinkSend', (message) =>
    current?.stdin.write(`${JSON.stringify(message)}\n`)
  );
  const attach = async (extra) => {
    current?.kill();
    const node = spawn(
      cli,
      [
        'attach',
        '--signal',
        'stdio',
        '--name',
        'ref-node',
        '--no-kernel',
        '--hosts',
        hosts,
        ...extra,
      ],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
      }
    );
    t.after(() => node.kill());
    current = node;
    createInterface({ input: node.stdout }).on('line', (line) =>
      page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
    );
    await page.until(() =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links?.devices.some((d) => d.state === 'connected')
    );
  };
  await attach(['--runner', 'sh', '-c']);
  const devices = await page.evaluate(
    () => document.querySelector('slicc-app').model.network.status().links.devices
  );
  assert.deepEqual(devices[0].offers, ['net', 'http', 'ssh']);
  const known = await knownHosts(page, 'ref');
  assert.match(known.out, /^ref-node\.slicc\.internal,198\.18\.57\.11 ssh-ed25519 \S+$/);
  const added = await shell(page, 'pnpm add -g @ai-ecoverse/wasix-openssh@10.6.0-5', 'ssh-add');
  assert.equal(added.code, '0', added.out);
  const ssh = await shell(
    page,
    "ssh -o StrictHostKeyChecking=yes -o BatchMode=yes ref-node.slicc.internal 'echo ssh $((6 * 7))'",
    'ssh-exec'
  );
  assert.deepEqual(ssh, { code: '0', out: 'ssh 42' });

  const exitToConnected = () =>
    page.evaluate(() => {
      const network = document.querySelector('slicc-app').model.network;
      const device = network.status().links.devices.find((d) => d.state === 'connected');
      return network.setExit({ kind: 'link', id: device.id });
    });
  const automatic = await shell(
    page,
    `curl -s --noproxy '*' --max-time 10 http://ref.link.test:${port}/automatic`,
    'hosts-automatic'
  );
  assert.deepEqual(automatic, { code: '0', out: 'hosts /automatic' });
  await page.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
  });
  await shoot(page, 'network-linked-slicc', { show: 'network' });
  await shoot(page, 'network-whole-web', {
    show: 'network',
    before: () => {
      const walk = (root) => {
        for (const element of root.querySelectorAll('details')) {
          if (
            /Other ways to reach the whole web/.test(
              element.querySelector('summary')?.textContent ?? ''
            )
          )
            return element;
        }
        for (const element of root.querySelectorAll('*')) {
          const inner = element.shadowRoot && walk(element.shadowRoot);
          if (inner) return inner;
        }
        return null;
      };
      const details = walk(document);
      if (details) {
        details.open = true;
        details.scrollIntoView({ block: 'start' });
      }
    },
  });
  await page.evaluate(() => document.querySelector('slicc-app').show('terminal'));
  const shown = await page.evaluate(() => {
    const status = document.querySelector('slicc-app').model.network.status();
    return [status.exit, status.links.devices[0].id];
  });
  assert.deepEqual(shown[0], { kind: 'link', id: shown[1] });
  await page.evaluate(() => document.querySelector('slicc-app').model.network.setExit(null));
  const direct = await shell(
    page,
    `curl -s --noproxy '*' --max-time 10 http://ref.link.test:${port}/direct`,
    'hosts-direct'
  );
  assert.notEqual(direct.code, '0');
  assert.equal(
    await page.evaluate(
      () => document.querySelector('slicc-app').model.network.status().exit ?? null
    ),
    null
  );
  await exitToConnected();
  const named = await shell(
    page,
    `curl -s --noproxy '*' --max-time 10 http://ref.link.test:${port}/named`,
    'hosts-named'
  );
  assert.deepEqual(named, { code: '0', out: 'hosts /named' });
  await attach(['--deny', `${lan}/32`]);
  await page.until(
    () =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links.devices.filter((d) => d.state === 'connected').length === 1
  );
  await exitToConnected();
  const denied = await shell(
    page,
    `curl -s --noproxy '*' --max-time 10 http://ref.link.test:${port}/named`,
    'hosts-denied'
  );
  assert.notEqual(denied.code, '0');
  await page.evaluate(() => document.querySelector('slicc-app').model.network.setExit(null));
});

const fixture = new URL('fixtures/httptest/', import.meta.url);

async function installHttptest(page) {
  const { readFile } = await import('node:fs/promises');
  const files = {
    'node_modules/httptest/package.json': (
      await readFile(new URL('package.json', fixture))
    ).toString('base64'),
    'node_modules/httptest/bin/httptest.wasm': (
      await readFile(new URL('bin/httptest.wasm', fixture))
    ).toString('base64'),
  };
  await page.evaluate(async (files) => {
    for (const [path, data] of Object.entries(files)) {
      const names = path.split('/');
      const name = names.pop();
      let dir = await navigator.storage.getDirectory();
      for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      await writable.close();
    }
  }, files);
}

function kernelGet(port, host, path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve([res.statusCode, Buffer.concat(chunks).toString()]));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('the real slicc CLI carries <port>.kernel.localhost into the page, and the page refuses the CDP facade', {
  skip: !cli,
}, async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await installHttptest(page);
  await page.reload();
  await ready(page);
  await run(page, 'httptest 8400 &');
  await page.until(() => document.querySelector('slicc-app') && true);
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const kernelPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const node = spawn(
    cli,
    ['attach', '--signal', 'stdio', '--name', 'ref-node', '--kernel-port', String(kernelPort)],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
    }
  );
  t.after(() => node.kill());
  await page.expose('sliccLinkSend', (message) => node.stdin.write(`${JSON.stringify(message)}\n`));
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((d) => d.state === 'connected')
  );
  let served;
  for (let i = 0; i < 40; i += 1) {
    served = await kernelGet(kernelPort, '8400.kernel.localhost', '/x.js').catch((error) => [
      0,
      error.message,
    ]);
    if (served[0] === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(served[0], 200, served[1]);
  assert.match(served[1], /hello from the kernel/);
  const echoed = await kernelGet(kernelPort, '8400.kernel.localhost', '/echo', 'POST', 'posted');
  assert.deepEqual(echoed, [200, 'posted']);
  const nothing = await kernelGet(kernelPort, '8401.kernel.localhost', '/');
  assert.equal(nothing[0], 502);
  const facade = await kernelGet(kernelPort, '9222.kernel.localhost', '/json/version');
  assert.notEqual(facade[0], 200);
});

test('the real slicc CLI shares another browser over cdp: the 9222 facade reaches it as <device>/<browser>', {
  skip: !cli,
}, async (t) => {
  const { chromium } = await import('playwright-core');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const debugPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const profile = await mkdtemp(join(tmpdir(), 'link-cdp-'));
  const other = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  t.after(() => other.kill());
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    up = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(
      (r) => r.ok,
      () => false
    );
    if (!up) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(up, 'the second Chromium answers on its debugging port');
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  const node = spawn(
    cli,
    [
      'attach',
      '--signal',
      'stdio',
      '--name',
      'ref-node',
      '--no-kernel',
      '--cdp-extra',
      `http://127.0.0.1:${debugPort}`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );
  t.after(() => node.kill());
  await page.expose('sliccLinkSend', (message) => node.stdin.write(`${JSON.stringify(message)}\n`));
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((d) => d.state === 'connected')
  );
  const listed = await shell(
    page,
    "curl -s 'http://127.0.0.1:9222/json/list?runtime=nope'",
    'cdp-nope'
  );
  const runtime = /ref-node\/[A-Za-z0-9._-]+/.exec(listed.out)?.[0];
  assert.ok(runtime, listed.out);
  const pages = await shell(
    page,
    `curl -sf 'http://127.0.0.1:9222/json/list?runtime=${runtime}' | jq -r '.[].url'`,
    'cdp-list'
  );
  assert.equal(pages.code, '0', pages.out);
  assert.match(pages.out, /about:blank/);
  const driven = await shell(
    page,
    `{ playwright-cli --runtime ${runtime} open 'data:text/html,<title>linked-browser</title>' > /dev/null && playwright-cli --runtime ${runtime} eval 'document.title'; playwright-cli --runtime ${runtime} close > /dev/null; }`,
    'cdp-driven'
  );
  assert.match(driven.out, /linked-browser/);
  const own = new URL(chrome.url).origin;
  const opened = await shell(
    page,
    `playwright-cli --runtime ${runtime} open '${own}/' 2>&1; echo "open $?"`,
    'cdp-own-open'
  );
  assert.doesNotMatch(opened.out, /open 0$/, opened.out);
  const walked = await shell(
    page,
    `{ playwright-cli --runtime ${runtime} open 'data:text/html,<title>start</title>' > /dev/null; playwright-cli --runtime ${runtime} eval 'location.href = ${JSON.stringify(`${own}/`)}' > /dev/null 2>&1; sleep 2; playwright-cli --runtime ${runtime} eval 'location.origin' 2>&1; playwright-cli --runtime ${runtime} close > /dev/null 2>&1; }`,
    'cdp-own-walk'
  );
  assert.ok(!walked.out.includes(own), walked.out);
  const tabs = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
  assert.ok(
    tabs.some((tab) => tab.url.startsWith(own)),
    'the page did walk to seven’s origin in the other browser'
  );
  const hidden = await shell(
    page,
    `curl -s 'http://127.0.0.1:9222/json/list?runtime=${runtime}'`,
    'cdp-own-list'
  );
  assert.doesNotMatch(hidden.out, new RegExp(own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the real slicc CLI shares a folder: the kernel mounts <device>/<name> over the link, reads, writes, and sees host edits', {
  skip: !cli,
}, async (t) => {
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'link-fs-'));
  await writeFile(join(dir, 'hello.txt'), 'from the host\n');
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  const node = spawn(
    cli,
    ['attach', '--signal', 'stdio', '--name', 'ref-node', '--no-kernel', '--mount', `${dir}:proj`],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
    }
  );
  t.after(() => node.kill());
  await page.expose('sliccLinkSend', (message) => node.stdin.write(`${JSON.stringify(message)}\n`));
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((d) => d.state === 'connected')
  );
  const mounted = await shell(
    page,
    '{ mkdir -p /mnt/proj && mount -t hostfs ref-node/proj /mnt/proj && cat /mnt/proj/hello.txt && echo written > /mnt/proj/w.txt && ls /mnt/proj; }',
    'fs-mount'
  );
  assert.deepEqual(mounted, { code: '0', out: 'from the host\nhello.txt\nw.txt' });
  assert.equal(await readFile(join(dir, 'w.txt'), 'utf8'), 'written\n');
  await writeFile(join(dir, 'hello.txt'), 'edited on the host\n');
  let seen;
  for (let i = 0; i < 20; i += 1) {
    seen = await shell(page, 'cat /mnt/proj/hello.txt', `fs-edit-${i}`);
    if (seen.out === 'edited on the host') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(seen.out, 'edited on the host');
  const unknown = await shell(
    page,
    '{ mkdir -p /mnt/x && mount -t hostfs ref-node/nope /mnt/x; }',
    'fs-nope'
  );
  assert.notEqual(unknown.code, '0');
  const ro = await shell(
    page,
    'mkdir -p /mnt/ro && mount -t hostfs -o ro ref-node/proj /mnt/ro && { echo x > /mnt/ro/x.txt; echo "write $?"; }',
    'fs-ro'
  );
  assert.match(ro.out, /write [1-9]/);
});

test('a remembered linked folder mounted before its CLI links fills in when the CLI arrives', {
  skip: !cli,
}, async (t) => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'link-fs-later-'));
  await writeFile(join(dir, 'hello.txt'), 'remembered\n');
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  await page.evaluate(() =>
    localStorage.setItem(
      'slicc-os.mounts',
      JSON.stringify([
        { type: 'hostfs', source: 'ref-node/proj', target: '/mnt/proj', options: {} },
      ])
    )
  );
  await page.reload();
  await ready(page);
  const before = await shell(page, 'grep -c " /mnt/proj " /proc/mounts', 'fs-later-before');
  assert.equal(before.out, '1');
  const node = spawn(
    cli,
    ['attach', '--signal', 'stdio', '--name', 'ref-node', '--no-kernel', '--mount', `${dir}:proj`],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );
  t.after(() => node.kill());
  await page.expose('sliccLinkSend', (message) => node.stdin.write(`${JSON.stringify(message)}\n`));
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  let seen;
  for (let i = 0; i < 80; i += 1) {
    seen = await shell(page, 'cat /mnt/proj/hello.txt 2>&1', `fs-later-${i}`);
    if (seen.out === 'remembered') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(seen.out, 'remembered');
});

test('the real slicc CLI lists its folders on its device row, and Mount and Eject mount one at /mnt/<device>/<name>', {
  skip: !cli,
}, async (t) => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'link-row-'));
  await writeFile(join(dir, 'hello.txt'), 'from the row\n');
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  const node = spawn(
    cli,
    [
      'attach',
      '--signal',
      'stdio',
      '--name',
      'ref-node',
      '--no-kernel',
      '--mount',
      `${dir}:proj`,
      '--mount',
      `${dir}:archive:ro`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );
  t.after(() => node.kill());
  await page.expose('sliccLinkSend', (message) => node.stdin.write(`${JSON.stringify(message)}\n`));
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  const row = () =>
    page.evaluate(
      () =>
        document.querySelector('slicc-app').model.network.status().links?.devices[0]?.folders ??
        null
    );
  await page.until(
    () =>
      document.querySelector('slicc-app').model.network.status().links?.devices[0]?.folders
        ?.length === 2
  );
  assert.deepEqual(await row(), [
    { name: 'proj', source: 'ref-node/proj', readonly: false },
    { name: 'archive', source: 'ref-node/archive', readonly: true },
  ]);
  const target = await page.evaluate(() =>
    document.querySelector('slicc-app').model.network.mountFolder('ref-node/proj')
  );
  assert.equal(target, '/mnt/ref-node/proj');
  assert.deepEqual(await shell(page, 'cat /mnt/ref-node/proj/hello.txt', 'row-read'), {
    code: '0',
    out: 'from the row',
  });
  await page.until(
    () =>
      document.querySelector('slicc-app').model.network.status().links.devices[0].folders[0].mounted
  );
  assert.equal((await row())[0].mounted, '/mnt/ref-node/proj');
  assert.deepEqual(
    await page.evaluate(() => document.querySelector('slicc-app').model.files.mountInfo()),
    [{ target: '/mnt/ref-node/proj', source: 'ref-node/proj', type: 'hostfs' }]
  );
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.network.ejectFolder('ref-node/proj')
  );
  await page.until(
    () =>
      !document.querySelector('slicc-app').model.network.status().links.devices[0].folders[0]
        .mounted
  );
  await assert.rejects(
    page.evaluate(() =>
      document.querySelector('slicc-app').model.network.ejectFolder('ref-node/proj')
    ),
    /not mounted/
  );
});

const WS_SCRIPT = (port) =>
  [
    'exec 3<>/dev/tcp/127.0.0.1/3128',
    `printf 'GET http://ref-node.slicc.internal:${port}/ HTTP/1.1\\r\\nHost: ref-node.slicc.internal:${port}\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Protocol: echo\\r\\n\\r\\n' >&3`,
    'sleep 1',
    'printf "$1" >&3',
    'sleep 1',
    'printf "$2" >&3',
    'timeout 8 cat <&3 | od -An -tx1 -v | tr -d " \\n"',
  ].join('\n');

test('the real slicc CLI carries a program WebSocket over the link: text, binary, a close from each end, and its policy', {
  skip: !cli,
}, async (t) => {
  const { WebSocketServer } = await import('ws');
  const echo = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: (set) => (set.has('echo') ? 'echo' : false),
  });
  echo.on('connection', (socket) =>
    socket.on('message', (data, binary) => {
      if (!binary && String(data) === 'bye') socket.close(4001, 'far end done');
      else socket.send(data, { binary });
    })
  );
  await new Promise((resolve) => echo.once('listening', resolve));
  t.after(() => echo.close());
  const { port } = echo.address();
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  let current = null;
  await page.expose('sliccLinkSend', (message) =>
    current?.stdin.write(`${JSON.stringify(message)}\n`)
  );
  const attach = async (extra) => {
    current?.kill();
    const node = spawn(
      cli,
      ['attach', '--signal', 'stdio', '--name', 'ref-node', '--no-kernel', ...extra],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
      }
    );
    t.after(() => node.kill());
    current = node;
    createInterface({ input: node.stdout }).on('line', (line) =>
      page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
    );
    await page.until(() =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links?.devices.some((d) => d.state === 'connected')
    );
  };
  await attach([]);
  await page.evaluate(async (script) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    const writable = await (await home.getFileHandle('ws.sh', { create: true })).createWritable();
    await writable.write(script);
    await writable.close();
  }, WS_SCRIPT(port));
  const hex = (text) => Buffer.from(text).toString('hex');
  const echoed = await shell(
    page,
    String.raw`bash /home/ws.sh '\x81\x82\x00\x00\x00\x00hi\x82\x83\x00\x00\x00\x00\x01\x02\x03' '\x88\x82\x00\x00\x00\x00\x03\xe8'`,
    'ws-echo'
  );
  assert.ok(echoed.out.startsWith(hex('HTTP/1.1 101 Switching Protocols')), echoed.out);
  assert.ok(
    echoed.out.includes(hex('Sec-WebSocket-Protocol: echo').toLowerCase()) ||
      echoed.out.includes(hex('sec-websocket-protocol: echo')),
    echoed.out
  );
  assert.ok(echoed.out.includes(`8102${hex('hi')}`), echoed.out);
  assert.ok(echoed.out.includes('8203010203'), echoed.out);
  assert.ok(echoed.out.includes('880203e8'), echoed.out);
  const far = await shell(
    page,
    String.raw`bash /home/ws.sh '\x81\x83\x00\x00\x00\x00bye' ''`,
    'ws-far'
  );
  assert.ok(far.out.includes(`880e0fa1${hex('far end done')}`), far.out);
  await attach(['--deny', '127.0.0.1/32']);
  const denied = await shell(page, String.raw`bash /home/ws.sh '' ''`, 'ws-denied');
  assert.ok(denied.out.startsWith(hex('HTTP/1.1 502')), denied.out);
  assert.ok(
    denied.out.includes(hex('EACCES')) || denied.out.includes(hex('policy')),
    Buffer.from(denied.out, 'hex').toString()
  );
});

test('a connected kernel client learns the exit when a linked CLI comes up, and again when it goes', async (t) => {
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  await ready(page);
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  await page.evaluate(async () => {
    const client = await globalThis.sliccKernelClient();
    globalThis.traitsSeen = [client.transport.traits.exit ?? null];
    client.onTraits((traits) => globalThis.traitsSeen.push(traits.exit ?? null));
  });
  assert.deepEqual(await page.evaluate(() => globalThis.traitsSeen), [null]);
  await page.evaluate(fakeNode, KEY);
  await page.until(() => globalThis.traitsSeen.at(-1)?.kind === 'local');
  assert.deepEqual(await page.evaluate(() => globalThis.traitsSeen.at(-1)), {
    kind: 'local',
    caps: ['net', 'http', 'ssh', 'ws'],
  });
  await page.evaluate(() => document.querySelector('slicc-app').model.network.setExit(null));
  await page.until(() => globalThis.traitsSeen.at(-1) === null);
});
