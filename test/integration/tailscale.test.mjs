import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { ready, run } from './bios.mjs';
import { launch } from './chrome.mjs';

const dist = process.env.TAILSCALE_DIST;
const usable = dist && existsSync(`${dist}/main.wasm`);
const online = process.env.TAILSCALE_E2E === '1';

const chrome =
  usable || online
    ? await launch({
        roots: [...(usable ? [['/tailscale-dist/', dist]] : []), ['/', 'src/']],
        timeout: 300000,
      })
    : null;
after(() => chrome?.close());

const tailnet = (page) =>
  page.evaluate(() => document.querySelector('slicc-app').model.network.status().tailnet ?? null);

const section = (page) =>
  page.evaluate(() => {
    const find = (root) => {
      const hit = root.querySelector('section[data-tailnet]');
      if (hit) return hit;
      for (const host of root.querySelectorAll('*')) {
        const found = host.shadowRoot && find(host.shadowRoot);
        if (found) return found;
      }
      return null;
    };
    const hit = find(document);
    const link =
      hit && find(hit.getRootNode()) && hit.querySelector('[data-action="tailnet-sign-in"]');
    return hit
      ? {
          state: hit.dataset.tailnet,
          signIn: link?.href ?? link?.getAttribute?.('href') ?? null,
          keyField: Boolean(hit.querySelector('[data-form="auth-key"]')),
        }
      : null;
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

test('turning Tailscale on installs the package with pnpm and asks to sign in', {
  skip: !online,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/#tailscale=on');
  await ready(page);
  await page.until(() => {
    const tailnet = document.querySelector('slicc-app').model.network?.status().tailnet;
    return (
      tailnet?.state === 'failed' ||
      tailnet?.state === 'running' ||
      (tailnet?.state === 'needs-login' && tailnet.loginUrl)
    );
  });
  const shown = await tailnet(page);
  console.log(
    JSON.stringify({ state: shown.state, detail: shown.detail, loginUrl: Boolean(shown.loginUrl) })
  );
  assert.equal(shown.state, 'needs-login', shown.detail);
  const installed = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = async (path) => {
      let at = root;
      for (const name of path.split('/')) at = await at.getDirectoryHandle(name);
      return at;
    };
    const dist = await dir('opt/tailscale/node_modules/@ai-ecoverse/wasm-tailscale/dist');
    const receipt = await (await dir('var/lib/slicc/tailscale')).getFileHandle('pnpm-lock.yaml');
    return {
      wasm: (await (await dist.getFileHandle('main.wasm')).getFile()).size,
      receipt: Boolean(receipt),
    };
  });
  console.log(JSON.stringify({ installed }));
  assert.ok(installed.wasm > 20e6);
  assert.equal(installed.receipt, true);
  assert.match(shown.loginUrl ?? '', /^https:\/\/login\.tailscale\.com\//);
  assert.equal(await page.evaluate(() => 'sliccTailscale' in globalThis), false);
  await page.evaluate(() => document.querySelector('slicc-app').show('network'));
  await page.until(() => {
    const find = (root) =>
      root.querySelector('section[data-tailnet]') ??
      [...root.querySelectorAll('*')]
        .map((el) => el.shadowRoot && find(el.shadowRoot))
        .find(Boolean);
    return find(document);
  });
  const panel = await section(page);
  console.log(JSON.stringify({ panel }));
  assert.equal(panel.state, 'needs-login');
  assert.equal(panel.keyField, true);
  await assert.rejects(
    page.evaluate(() =>
      document.querySelector('slicc-app').model.network.submitAuthKey('not-a-key')
    ),
    /not a Tailscale auth key/
  );
  await page.evaluate(() => document.querySelector('slicc-app').model.network.setTailnet(false));
  assert.deepEqual(await tailnet(page), { state: 'off' });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.tailscale), 'off');
  await page.evaluate(() => document.querySelector('slicc-app').model.network.setTailnet(true));
  await page.until(
    () => document.querySelector('slicc-app').model.network.status().tailnet.loginUrl
  );
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
  await page.init(
    `() => { globalThis.sliccTailscaleAuthKey = ${JSON.stringify(authKey)}; globalThis.sliccTailscaleDebug = true; }`
  );
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
  const failed = (await tailnet(page))?.detail;
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
  console.log(`panel: ${JSON.stringify(await tailnet(page))}`);
});

const interactive = process.env.TS_INTERACTIVE === '1';
const signInFile = process.env.TS_SIGN_IN_FILE ?? '/tmp/tailscale-sign-in.txt';
const shots = process.env.TS_SHOTS;

const knockFrom = (cli, addr, port) =>
  new Promise((resolve) => {
    const [bin, ...base] = cli.split(' ');
    const child = execFile(
      bin,
      [...base, 'nc', addr, String(port)],
      { timeout: 15000 },
      (error, out) => resolve({ answered: out.length > 0, connected: !error })
    );
    child.stdin.write('GET / HTTP/1.0\r\n\r\n');
    setTimeout(() => child.stdin.end(), 5000);
  });

test('stage B: programs reach the tailnet and the exit node over raw TCP', {
  skip: !(online && interactive),
}, async (t) => {
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccTailscaleDebug = true; }');
  await page.goto('/#tailscale=on');
  await ready(page);
  const model = () => document.querySelector('slicc-app').model.network.status().tailnet;
  await page.until((m) => {
    const tailnet = document.querySelector('slicc-app').model.network.status().tailnet;
    return tailnet?.loginUrl || tailnet?.state === 'running' || tailnet?.state === 'failed';
  }, model.toString());
  const first = await page.evaluate(model);
  if (first.loginUrl) {
    writeFileSync(signInFile, `${first.loginUrl}\n`);
    console.log(`sign in at ${first.loginUrl}`);
  }
  await page.until(() => {
    const tailnet = document.querySelector('slicc-app').model.network.status().tailnet;
    return tailnet?.state === 'running' && tailnet.node?.addresses?.length;
  });
  const running = await page.evaluate(model);
  console.log(
    JSON.stringify({
      node: running.node,
      exitNodes: running.exitNodes,
      shieldsUp: running.shieldsUp,
    })
  );
  assert.equal(running.shieldsUp, true);

  const peer = process.env.TS_PEER_URL;
  if (peer) {
    const raw = await curled(page, `--noproxy '*' ${peer}`, 'raw-peer');
    console.log(JSON.stringify({ rawPeer: raw }));
    assert.equal(raw.code, '0');
    assert.match(raw.body, /hello from the tailnet/);
    const name = process.env.TS_PEER_NAME;
    if (name) {
      const byName = new URL(peer);
      byName.hostname = name;
      const named = await curled(page, `--noproxy '*' ${byName}`, 'raw-peer-name');
      console.log(JSON.stringify({ rawPeerByName: named }));
      assert.equal(named.code, '0');
      assert.match(named.body, /hello from the tailnet/);
    }
  }

  const host = await curled(page, `--noproxy '*' --max-time 10 http://10.0.2.2:5711/`, 'raw-host');
  console.log(JSON.stringify({ rawHost: host.code }));
  assert.notEqual(host.code, '0', 'host.slicc.internal never reaches the uplink');

  const cli = process.env.TS_PEER_CLI;
  if (cli) {
    const self = running.node.addresses[0];
    for (const port of [80, 5710, 9222]) {
      const attempt = await knockFrom(cli, self, port);
      console.log(JSON.stringify({ inbound: port, ...attempt }));
      assert.equal(attempt.connected, false);
      assert.equal(attempt.answered, false);
    }
  }

  const exit = process.env.TS_EXIT_NODE;
  if (exit) {
    const choice = running.exitNodes.find((node) => node.name === exit);
    assert.ok(choice, `exit node ${exit} is offered`);
    await page.evaluate(
      (id) => document.querySelector('slicc-app').model.network.setExitNode(id),
      choice.id
    );
    await page.until(
      (name) =>
        document.querySelector('slicc-app').model.network.status().tailnet.exitNode === name,
      exit
    );
    const trace = await curled(
      page,
      `--noproxy '*' --max-time 20 http://1.1.1.1/cdn-cgi/trace`,
      'raw-exit'
    );
    const ip = /^ip=(.*)$/m.exec(trace.body)?.[1];
    console.log(JSON.stringify({ rawExit: trace.code, ip }));
    assert.equal(trace.code, '0');
    assert.ok(ip);
    if (shots) {
      await page.evaluate(() => document.querySelector('slicc-app').show('network'));
      await page.screenshot(`${shots}/network-panel.png`);
      await page.evaluate(() => document.querySelector('slicc-app').show('updates'));
      await page.screenshot(`${shots}/install-update.png`);
    }
    await page.evaluate(() => document.querySelector('slicc-app').model.network.setExitNode(null));
    await page.until(
      () => !document.querySelector('slicc-app').model.network.status().tailnet.exitNode
    );
    const without = await curled(
      page,
      `--noproxy '*' --max-time 10 http://1.1.1.1/cdn-cgi/trace`,
      'raw-noexit'
    );
    console.log(JSON.stringify({ rawWithoutExit: without.code }));
    assert.notEqual(
      without.code,
      '0',
      'without an exit node, public addresses are unreachable over raw TCP'
    );
  }
  await page.evaluate(() => document.querySelector('slicc-app').model.network.logoutTailnet());
});
