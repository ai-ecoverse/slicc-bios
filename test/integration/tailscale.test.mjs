import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, test } from 'node:test';
import { ready, run } from './bios.mjs';
import { launch } from './chrome.mjs';

const dist = process.env.TAILSCALE_DIST;
const usable = dist && existsSync(`${dist}/main.wasm`);

const chrome = usable
  ? await launch({
      roots: [
        ['/tailscale-dist/', dist],
        ['/', 'src/'],
      ],
      timeout: 180000,
    })
  : null;
after(() => chrome?.close());

const view = (page) =>
  page.evaluate(() => {
    const notice = document.querySelector('.tailscale');
    const [output, link] = notice.children;
    return {
      hidden: notice.hidden,
      state: notice.dataset.state,
      text: output.value,
      login: link.hidden ? null : link.href,
      backend: document.documentElement.dataset.tailscale,
    };
  });

const install = (page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const opt = await root.getDirectoryHandle('opt', { create: true });
    const dir = await opt.getDirectoryHandle('tailscale', { create: true });
    for (const name of ['main.wasm', 'wasm_exec.js']) {
      const body = await (await fetch(`/tailscale-dist/${name}`)).arrayBuffer();
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(body);
      await writable.close();
    }
  });

test('tailscale joins from the wasm in /opt/tailscale and asks to sign in', {
  skip: !usable,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  await install(page);
  await page.goto('/#tailscale=on');
  await ready(page);
  await page.until(() => {
    const backend = document.documentElement.dataset.tailscale;
    const link = document.querySelector('.tailscale a');
    return backend === 'failed' || backend === 'Running' || (link && !link.hidden);
  });
  const shown = await view(page);
  console.log(JSON.stringify(shown));
  assert.notEqual(shown.backend, 'failed', shown.text);
  assert.match(shown.login ?? '', /^https:\/\/login\.tailscale\.com\//);
  assert.equal(shown.state, 'login');
});

const curled = async (page, url, name) => {
  await run(page, `curl -s -o /home/${name}.txt ${url}; echo $? > /home/${name}.done`);
  await page.until(async (name) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return home.getFileHandle(`${name}.done`).then(
      () => true,
      () => false
    );
  }, name);
  return page.evaluate(async (name) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    const read = async (file) => (await (await home.getFileHandle(file)).getFile()).text();
    return { code: (await read(`${name}.done`)).trim(), body: (await read(`${name}.txt`)).trim() };
  }, name);
};

const authKey = process.env.TS_AUTHKEY;

test('joins the tailnet with an auth key and reaches the web through it', {
  skip: !usable || !authKey,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  await page.evaluate(
    (exitNode) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('slicc-os', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('transport');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('transport', 'readwrite');
          tx.objectStore('transport').put(
            { enabled: true, exitNode, ephemeral: true },
            'tailscale'
          );
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
    process.env.TS_EXIT_NODE ?? 'auto:any'
  );
  await page.init(`() => { globalThis.sliccTailscaleAuthKey = ${JSON.stringify(authKey)}; }`);
  await install(page);
  await page.reload();
  await ready(page);
  await page.until(() => {
    const backend = document.documentElement.dataset.tailscale;
    return (
      backend === 'failed' ||
      (backend === 'Running' && globalThis.sliccTailscale?.view.status?.self?.addresses?.length)
    );
  });
  await page.until(() => globalThis.sliccTailscale.view.status.exitNode).catch(() => {});
  assert.equal(await page.evaluate(() => 'sliccTailscaleAuthKey' in globalThis), false);
  const failed = await page.evaluate(() => document.querySelector('.tailscale output').value);
  assert.notEqual(
    await page.evaluate(() => document.documentElement.dataset.tailscale),
    'failed',
    failed
  );
  const status = await page.evaluate(() => globalThis.sliccTailscale.view.status);
  console.log(
    JSON.stringify({
      self: status.self.addresses,
      exitNode: status.exitNode?.dnsName ?? null,
      exitOptions: status.peers.filter((p) => p.exitNodeOption).map((p) => p.dnsName),
      peers: status.peers.length,
    })
  );
  assert.ok(status.self.addresses[0].startsWith('100.'));
  const through = (url) =>
    page.evaluate(async (url) => {
      const response = await globalThis.sliccTailscale.fetch({
        url,
        method: 'GET',
        headers: [['user-agent', 'curl/8']],
        signal: new AbortController().signal,
      });
      const chunks = [];
      for await (const chunk of response.body) chunks.push(...chunk);
      return { status: response.status, body: new TextDecoder().decode(new Uint8Array(chunks)) };
    }, url);
  const routed = (url) => page.evaluate((url) => globalThis.sliccTailscale.routes(url), url);
  const peer = process.env.TS_PEER_URL;
  if (peer) {
    assert.equal(await routed(peer), true);
    const answer = await through(peer);
    console.log(JSON.stringify({ peer: answer.status, body: answer.body.slice(0, 80) }));
    assert.ok(answer.status < 500);
    const viaKernel = await curled(page, peer, 'ts-peer');
    console.log(JSON.stringify({ peerViaKernel: viaKernel }));
    assert.equal(viaKernel.code, '0');
    assert.equal(viaKernel.body, answer.body.trim());
    const host = new URL(peer).hostname;
    const port = new URL(peer).port || '80';
    const raw = await page.evaluate(
      async (addr, host) => {
        const conn = await globalThis.sliccTailscale.dial('tcp', addr);
        await conn.write(new TextEncoder().encode(`GET / HTTP/1.0\r\nHost: ${host}\r\n\r\n`));
        const bytes = [];
        for (let chunk = await conn.read(); chunk; chunk = await conn.read()) bytes.push(...chunk);
        conn.close();
        return new TextDecoder().decode(new Uint8Array(bytes));
      },
      `${host}:${port}`,
      host
    );
    console.log(JSON.stringify({ dial: raw.split('\r\n')[0] }));
    assert.match(raw, /^HTTP\/1\.[01] 200/);
    assert.ok(raw.endsWith(answer.body));
  }
  const cli = process.env.TS_PEER_CLI;
  if (cli) {
    assert.equal(status.shieldsUp, true);
    const [bin, ...base] = cli.split(' ');
    const knock = (addr, port) =>
      new Promise((resolve) => {
        const child = execFile(
          bin,
          [...base, 'nc', addr, String(port)],
          { timeout: 15000 },
          (error, out, err) =>
            resolve({
              answered: out.length > 0,
              connected: !error,
              timedOut: Boolean(error?.killed),
              err: err.trim().split('\n').at(-1),
            })
        );
        child.stdin.write('GET / HTTP/1.0\r\n\r\n');
        setTimeout(() => child.stdin.end(), 5000);
      });
    if (peer) {
      const control = await knock(new URL(peer).hostname, new URL(peer).port || '80');
      assert.equal(control.answered, true, 'the peer reaches its own server over the tailnet');
    }
    const self = status.self.addresses[0];
    const attempts = {};
    for (const port of [80, 5710, 9222]) attempts[port] = await knock(self, port);
    console.log(JSON.stringify({ inbound: attempts }));
    for (const attempt of Object.values(attempts)) {
      assert.equal(attempt.answered, false);
      assert.equal(attempt.connected, false);
    }
  }
  if (!status.exitNode) {
    assert.equal(await routed('https://ifconfig.me/ip'), false);
  } else {
    const home = process.env.TS_HOST_IP;
    assert.equal(await routed('https://ifconfig.me/ip'), true);
    const direct = await through('https://ifconfig.me/ip');
    console.log(JSON.stringify({ exitIp: direct.body.trim(), hostIp: home ?? null }));
    assert.equal(direct.status, 200);
    const viaKernel = await curled(page, 'https://ifconfig.me/ip', 'ts-ip');
    console.log(JSON.stringify({ viaKernel }));
    assert.equal(viaKernel.code, '0');
    assert.equal(viaKernel.body, direct.body.trim());
    const raw = await page.evaluate(async () => {
      const conn = await globalThis.sliccTailscale.dial('tcp', 'ifconfig.me:80');
      await conn.write(
        new TextEncoder().encode(
          'GET /ip HTTP/1.0\r\nHost: ifconfig.me\r\nUser-Agent: curl/8\r\n\r\n'
        )
      );
      const bytes = [];
      for (let chunk = await conn.read(); chunk; chunk = await conn.read()) bytes.push(...chunk);
      conn.close();
      return new TextDecoder().decode(new Uint8Array(bytes));
    });
    const dialled = raw.split('\r\n\r\n').at(-1).trim();
    console.log(JSON.stringify({ dial: raw.split('\r\n')[0], ip: dialled }));
    assert.equal(dialled, direct.body.trim());
    await page.evaluate(() => globalThis.sliccTailscale.setExitNode(''));
    await page.until(() => !globalThis.sliccTailscale.view.status.exitNode);
    assert.equal(await routed('https://ifconfig.me/ip'), false);
    const without = await through('https://ifconfig.me/ip').then(
      () => 'reached',
      (error) => error.message
    );
    console.log(JSON.stringify({ withoutExitNode: without.slice(0, 120) }));
    assert.notEqual(without, 'reached');
  }
  console.log(
    `indicator: ${await page.evaluate(() => document.querySelector('.tailscale output').value)}`
  );
});
