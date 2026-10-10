import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { boot, ready, run } from './bios.mjs';
import { launch } from './chrome.mjs';

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
            caps: ['net', 'http', 'ssh'],
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

test('a linked node over real WebRTC: its name, raw TCP and HTTP to its loopback, its host key, and as the chosen exit, held while it is gone', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  await page.evaluate(fakeNode, KEY);
  await page.until(() => globalThis.fakeNodeLog?.some((m) => m.role === 'page'));
  const hello = await page.evaluate(() => globalThis.fakeNodeLog.find((m) => m.role === 'page'));
  assert.deepEqual(
    { ...hello, name: hello.name.replace(/ on .*/, '') },
    { v: 1, role: 'page', name: 'seven', mode: 'local', caps: ['kernel-in'] }
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
  const far = await shell(
    page,
    "curl -s --noproxy '*' --max-time 5 http://far.example/",
    'link-far'
  );
  assert.notEqual(far.code, '0');
  assert.equal(
    await page.evaluate(() =>
      globalThis.fakeNodeLog.some((m) => m.kind === 'resolve' || m.host === '203.0.113.7')
    ),
    false
  );
  const network = () =>
    page.evaluate(() => {
      const { exit, links } = document.querySelector('slicc-app').model.network.status();
      return {
        exit,
        devices: links?.devices.map((d) => [d.id, d.host, d.state, d.exit, d.offers.join()]),
      };
    });
  assert.deepEqual(await network(), {
    exit: null,
    devices: [['local', 'fake-node.slicc.internal', 'connected', true, 'net,http,ssh']],
  });
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

test('links the real slicc CLI over stdio signaling, and kernel curl reaches its loopback over raw TCP and the http kind', {
  skip: !cli,
}, async (t) => {
  const big = Buffer.alloc(1024 * 1024, 'x');
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/plain');
    response.end(request.url === '/big' ? big : `cli ${request.method} ${request.url}\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  const node = spawn(cli, ['attach', '--signal', 'stdio', '--name', 'ref-node'], {
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
  assert.equal(seen[0], 'node:hello');
  for (const step of ['offer', 'candidate', 'node:answer']) assert.ok(seen.includes(step), step);
  assert.ok(seen.indexOf('offer') < seen.indexOf('node:answer'));
});

test('the real slicc CLI: ssh into it with its pinned host key, and as the exit it resolves names from its hosts file, or refuses them under its policy', {
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
      ['attach', '--signal', 'stdio', '--name', 'ref-node', '--hosts', hosts, ...extra],
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

  await page.evaluate(() =>
    document.querySelector('slicc-app').model.network.setExit({ kind: 'link', id: 'local' })
  );
  const named = await shell(
    page,
    `curl -s --noproxy '*' --max-time 10 http://ref.link.test:${port}/named`,
    'hosts-named'
  );
  assert.deepEqual(named, { code: '0', out: 'hosts /named' });
  await attach(['--deny', `${lan}/32`]);
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
