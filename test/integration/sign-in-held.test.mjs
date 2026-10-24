import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { boot, ready, run, screen, shows } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const MARK = 'FRAGMENT-MARK';
const certs = mkdtempSync(join(tmpdir(), 'slicc-held-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=ims-na1.adobelogin.com',
    '-keyout',
    join(certs, 'key.pem'),
    '-out',
    join(certs, 'cert.pem'),
  ],
  { stdio: 'ignore' }
);
const idp = { finish: false, authorized: 0 };
const ims = createHttps(
  { key: readFileSync(join(certs, 'key.pem')), cert: readFileSync(join(certs, 'cert.pem')) },
  (req, res) => {
    const url = new URL(req.url, 'https://ims-na1.adobelogin.com');
    if (url.pathname === '/ims/authorize/v2') {
      idp.authorized += 1;
      const state = JSON.parse(Buffer.from(url.searchParams.get('state'), 'base64').toString());
      const back = `${state.origin}/auth/callback?nonce=${state.nonce}#access_token=${MARK}-callback&token_type=bearer&expires_in=60`;
      const next = new URLSearchParams(idp.finish ? { back } : { child: '1' });
      res.writeHead(302, {
        location: `/landing?${next}#access_token=${MARK}-idp&token_type=bearer`,
      });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    const frame =
      url.pathname === '/landing'
        ? `<iframe src="http://localhost:${plain.address().port}/frame#access_token=${MARK}-frame"></iframe>`
        : '';
    res.end(`<!doctype html><title>Sign in to Adobe</title><h1>Sign in</h1>${frame}<script>
const asked = new URLSearchParams(location.search);
if (asked.get('child')) window.open('/idp-child?grand=1#access_token=${MARK}-child', 'idp-child', 'popup');
if (asked.get('grand')) window.open('/idp-grandchild#access_token=${MARK}-grandchild', 'idp-grandchild', 'popup');
if (asked.get('back')) setTimeout(() => location.replace(asked.get('back')), 3000);
</script>`);
  }
);
await new Promise((resolve) => ims.listen(0, '127.0.0.1', resolve));
const plain = createHttp((req, res) => {
  const url = new URL(req.url, 'http://x');
  const open = url.searchParams.get('open');
  const later = url.searchParams.get('later');
  const script = open
    ? `window.open(${JSON.stringify(`/${open}`)}, 'opened', 'popup');`
    : later
      ? `const w = window.open('about:blank', 'later', 'popup'); w.location = ${JSON.stringify(later)};`
      : '';
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>plain ${url.pathname}</title><script>${script}</script>`);
});
await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
const ordinary = (path) => `http://localhost:${plain.address().port}${path}`;

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
const chrome = await launch({
  args: [
    `--remote-debugging-port=${port}`,
    `--host-resolver-rules=MAP ims-na1.adobelogin.com:443 127.0.0.1:${ims.address().port}, MAP vault.sliccy.ai 127.0.0.1`,
    '--ignore-certificate-errors',
    '--disable-popup-blocking',
  ],
});
after(() => {
  chrome.close();
  ims.close();
  plain.close();
  rmSync(certs, { recursive: true, force: true });
});
const browser = await debuggerUrl(port);
const fakeExtension = extensionOver(browser);
const devtools = (path) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json());

function debugSignIn() {
  globalThis.sliccLoginDebug = true;
  globalThis.sliccKernelDebug = true;
  localStorage.setItem('slicc-os.sign-in', 'relay');
}

async function signIn(page) {
  await page.evaluate(() => {
    window.signInAnswer = null;
    void globalThis
      .sliccLogin('adobe', async () => ({
        clientId: 'test-client',
        scopes: 'openid',
        imsEnvironment: 'prod',
      }))
      .then(
        () => 'resolved',
        (error) => error.message
      )
      .then((answer) => {
        window.signInAnswer = answer;
      });
  });
  for (let n = 0; n < 150; n += 1) {
    const found = (await devtools('/json/list')).find((tab) =>
      tab.url.startsWith('https://ims-na1.adobelogin.com/landing')
    );
    if (found) return found.id;
    const answer = await page.evaluate(() => window.signInAnswer);
    if (answer) throw new Error(`the sign-in ended: ${answer}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the sign-in popup never reached the IdP');
}

async function navigate(targetId, url) {
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await chrome.cdp.send('Page.navigate', { url }, sessionId);
  await chrome.cdp.send('Target.detachFromTarget', { sessionId });
  for (let n = 0; n < 100; n += 1) {
    const tab = (await devtools('/json/list')).find((one) => one.id === targetId);
    if (tab?.url === url) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${targetId} never reached ${url}`);
}

async function guarded(page, via, name) {
  await page.evaluate(
    async ([via, name]) => {
      const connection = await globalThis.sliccBrowserHook({ runtime: via });
      const pending = new Map();
      const events = [];
      let next = 0;
      connection.onmessage = (text) => {
        const message = JSON.parse(text);
        if (message.id !== undefined) {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
          return;
        }
        events.push(text);
      };
      window.agents ??= {};
      window.agents[name] = {
        events,
        close: () => connection.close(),
        send: (method, params = {}, sessionId) =>
          new Promise((resolve) => {
            next += 1;
            const id = next;
            const timer = setTimeout(() => {
              pending.delete(id);
              resolve({ error: { message: `${method} got no answer` } });
            }, 20000);
            pending.set(id, (message) => {
              clearTimeout(timer);
              resolve(message);
            });
            connection.send(
              JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
            );
          }),
      };
    },
    [via, name]
  );
  const send = (method, params, sessionId) =>
    page.evaluate(
      ([n, m, p, s]) => window.agents[n].send(m, p, s),
      [name, method, params, sessionId]
    );
  const seen = () => page.evaluate((n) => window.agents[n].events.join('\n'), name);
  return { send, seen, close: () => page.evaluate((n) => window.agents[n].close(), name) };
}

async function tabWhere(match) {
  for (let n = 0; n < 150; n += 1) {
    const found = (await devtools('/json/list')).find(match);
    if (found) return found.id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `no tab matched ${match}: ${(await devtools('/json/list')).map((tab) => tab.url).join(' ')}`
  );
}

const close = (ids) =>
  Promise.all(ids.map((id) => fetch(`http://127.0.0.1:${port}/json/close/${id}`))).catch(() => {});

async function popupFrom(path, name) {
  const url = ordinary(`${path}?open=${name}`);
  const opener = (
    await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' }).then((r) => r.json())
  ).id;
  return [opener, await tabWhere((tab) => tab.url === ordinary(`/${name}`))];
}

async function drivable(agent, targetId, title) {
  const { result } = await agent.send('Target.getTargets');
  assert.ok(
    result.targetInfos.some((info) => info.targetId === targetId),
    `${title} is listed`
  );
  const attach = await agent.send('Target.attachToTarget', { targetId, flatten: true });
  assert.ok(attach.result?.sessionId, JSON.stringify(attach));
  const read = await agent.send(
    'Runtime.evaluate',
    { expression: 'document.title', returnByValue: true },
    attach.result.sessionId
  );
  assert.equal(read.result?.result?.value, title);
  await agent.send('Target.detachFromTarget', { sessionId: attach.result.sessionId });
}

async function unreachable(agent, ids) {
  const { result } = await agent.send('Target.getTargets');
  assert.ok(result, 'getTargets answered');
  const listed = result.targetInfos.map((info) => info.targetId);
  for (const [name, targetId] of Object.entries(ids)) {
    assert.ok(!listed.includes(targetId), `${name} is listed`);
    for (const method of [
      'Target.attachToTarget',
      'Target.getTargetInfo',
      'Target.activateTarget',
    ]) {
      const answer = await agent.send(method, { targetId, flatten: true });
      assert.ok(answer.error, `${method} on ${name} wasn't refused: ${JSON.stringify(answer)}`);
      assert.ok(!JSON.stringify(answer).includes(MARK));
    }
  }
  assert.ok(!JSON.stringify(result).includes(MARK));
  assert.ok(!(await agent.seen()).includes(MARK), 'an event carried the fragment');
}

async function rows(t, page, via) {
  const early = await guarded(page, via, 'early');
  t.after(() => early.close().catch(() => {}));
  await early.send('Target.setDiscoverTargets', { discover: true });
  await early.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  const popup = await signIn(page);
  const child = await tabWhere((tab) =>
    tab.url.startsWith('https://ims-na1.adobelogin.com/idp-child')
  );
  const { targetInfos: raw } = await chrome.cdp.send('Target.getTargets');
  const frame = raw.find((info) => info.type === 'iframe' && info.url.includes('/frame'))?.targetId;
  assert.ok(frame, 'the sign-in page’s cross-site iframe is its own target');
  const grandchild = await tabWhere((tab) =>
    tab.url.startsWith('https://ims-na1.adobelogin.com/idp-grandchild')
  );
  const noopener = ordinary(`/noopener-${via}`);
  await page.evaluate((url) => window.open(url, '_blank', 'noopener'), noopener);
  await page.evaluate(() => {
    const blob = new Blob(['<!doctype html><title>seven blob</title>'], { type: 'text/html' });
    window.blobTab = window.open(URL.createObjectURL(blob), '_blank');
  });
  const free = await tabWhere((tab) => tab.url === noopener);
  const blob = await tabWhere((tab) => tab.url.startsWith(`blob:${new URL(chrome.url).origin}`));
  const [plainHost, plainChild] = await popupFrom(`/opener-${via}`, `opened-${via}`);
  const known = new Set((await devtools('/json/list')).map((tab) => tab.id));
  const answered = await page.evaluate(async (MARK) => {
    const marker = `mcp${Math.random().toString(36).slice(2)}`;
    window.mcpTab = window.open(
      `about:blank#slicc-sign-in-${marker}`,
      'slicc-mcp-oauth',
      'popup,width=520,height=720'
    );
    const channel = new BroadcastChannel('slicc-held');
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 6000);
      channel.onmessage = ({ data }) => {
        if (data?.marker !== marker || data.type === 'hold') return;
        clearTimeout(timer);
        resolve(data.type);
      };
      channel.postMessage({ type: 'hold', marker });
    });
    channel.close();
    if (answer === 'held')
      window.mcpTab.location.href = `https://ims-na1.adobelogin.com/mcp#access_token=${MARK}-mcp`;
    return answer;
  }, MARK);
  assert.equal(answered, 'held');
  const mcp = await tabWhere(
    (tab) => tab.url.startsWith('https://ims-na1.adobelogin.com/mcp') && !known.has(tab.id)
  );
  let quick = null;
  if (via === 'proxy') {
    const before = new Set((await devtools('/json/list')).map((tab) => tab.id));
    await page.evaluate((MARK) => {
      const tab = window.open('about:blank', 'slicc-quick', 'popup,width=520,height=720');
      tab.location.href = `https://ims-na1.adobelogin.com/quick#access_token=${MARK}-quick`;
    }, MARK);
    quick = await tabWhere(
      (tab) => tab.url.startsWith('https://ims-na1.adobelogin.com/quick') && !before.has(tab.id)
    );
  }
  const idpLater = 'https://ims-na1.adobelogin.com/vault-idp';
  const vaultPage = `http://vault.sliccy.ai:${plain.address().port}/vault-${via}?later=${encodeURIComponent(idpLater)}`;
  const vaultHost = (
    await fetch(`http://127.0.0.1:${port}/json/new?${vaultPage}`, { method: 'PUT' }).then((r) =>
      r.json()
    )
  ).id;
  const vaultChild = await tabWhere((tab) => tab.url.startsWith(idpLater.split('#')[0]));
  await navigate(mcp, ordinary(`/mcp-elsewhere#access_token=${MARK}-mcp-elsewhere`));
  await navigate(vaultChild, ordinary(`/vault-elsewhere#access_token=${MARK}-vault-elsewhere`));
  t.after(() =>
    close(
      [
        popup,
        child,
        grandchild,
        free,
        blob,
        plainHost,
        plainChild,
        mcp,
        vaultHost,
        vaultChild,
        quick,
      ].filter(Boolean)
    )
  );
  await navigate(popup, `https://ims-na1.adobelogin.com/landing#access_token=${MARK}-again`);
  await navigate(popup, ordinary(`/elsewhere#access_token=${MARK}-elsewhere`));
  await navigate(child, ordinary(`/child-elsewhere#access_token=${MARK}-child-elsewhere`));
  const late = await guarded(page, via, 'late');
  t.after(() => late.close().catch(() => {}));

  for (const [order, agent] of [
    ['seen at creation', early],
    ['seen later', late],
  ]) {
    await t.test(
      `${via}, ${order}: the sign-in tab, the IdP’s popup, an MCP sign-in tab, the vault’s sign-in tab and seven’s blob tab are never listed, attached or read, on any origin`,
      () =>
        unreachable(agent, {
          'the sign-in tab': popup,
          'the IdP’s popup': child,
          'the IdP popup’s own popup': grandchild,
          'the sign-in page’s iframe': frame,
          'the blob tab': blob,
          'an MCP sign-in tab on the marker': mcp,
          'the vault’s sign-in tab': vaultChild,
          ...(quick ? { 'an unmarked popup that leaves about:blank at once': quick } : {}),
        })
    );
    await t.test(
      `${via}, ${order}: a tab seven opened noopener, and an ordinary page’s popup, are drivable`,
      async () => {
        await drivable(agent, free, `plain /noopener-${via}`);
        await drivable(agent, plainHost, `plain /opener-${via}`);
        await drivable(agent, plainChild, `plain /opened-${via}`);
      }
    );
  }

  await t.test(
    `${via}: a client polling and attaching through a whole sign-in, from the IdP to the callback, never sees the sign-in tab or its token`,
    async () => {
      idp.finish = true;
      t.after(() => {
        idp.finish = false;
      });
      const poller = await guarded(page, via, 'poller');
      t.after(() => poller.close().catch(() => {}));
      await poller.send('Target.setDiscoverTargets', { discover: true });
      await poller.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      const before = new Set((await devtools('/json/list')).map((tab) => tab.id));
      await page.evaluate(() => {
        window.signInAnswer = null;
        void globalThis
          .sliccLogin('adobe', async () => ({ clientId: 'test-client', scopes: 'openid' }))
          .then(
            (token) => `resolved ${typeof token}`,
            (error) => error.message
          )
          .then((answer) => {
            window.signInAnswer = answer;
          });
      });
      const replies = [];
      const opened = new Set();
      const listed = new Set();
      const attached = new Set();
      for (let n = 0; n < 300; n += 1) {
        for (const tab of await devtools('/json/list'))
          if (!before.has(tab.id) && tab.type === 'page') opened.add(tab.id);
        const listing = await poller.send('Target.getTargets');
        replies.push(JSON.stringify(listing));
        for (const info of listing.result?.targetInfos ?? []) listed.add(info.targetId);
        for (const targetId of opened) {
          const answer = await poller.send('Target.attachToTarget', { targetId, flatten: true });
          replies.push(JSON.stringify(answer));
          if (answer.result?.sessionId) attached.add(targetId);
        }
        if (await page.evaluate(() => window.signInAnswer)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(await page.evaluate(() => window.signInAnswer), 'resolved string');
      assert.ok(opened.size >= 1, 'the sign-in opened a tab');
      for (const id of opened) {
        assert.ok(!listed.has(id), 'the sign-in tab was listed');
        assert.ok(!attached.has(id), 'the sign-in tab was attached');
      }
      const all = `${replies.join('\n')}\n${await poller.seen()}`;
      assert.ok(!all.includes(MARK), 'a message carried the token');
    }
  );

  await t.test(`${via}: the kernel's 9222 lists no sign-in tab`, async () => {
    await page.send('Page.bringToFront');
    await run(
      page,
      `curl -sf http://127.0.0.1:9222/json/list | jq -r '.[].url' > /tmp/listed; echo "lis""ted-$?"`
    );
    await shows(page, 'listed-');
    assert.match(await screen(page), /listed-0/);
    const listed = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const tmp = await root.getDirectoryHandle('tmp');
      return (await (await tmp.getFileHandle('listed')).getFile()).text();
    });
    assert.ok(!listed.includes(MARK), listed);
    assert.ok(!listed.includes('/elsewhere'), listed);
    assert.ok(listed.includes(`/noopener-${via}`), listed);
    assert.deepEqual(page.errors, []);
  });
}

test('through slicc-extension, sign-in tabs and their lineage are held from creation on any origin, and other tabs stay drivable', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await page.init(debugSignIn);
  await boot(page);
  await rows(t, page, 'extension');
});

test('through slicc-node, sign-in tabs and their lineage are held from creation on any origin, and other tabs stay drivable', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const proxy = await startProxy({
    port: 0,
    origins: [new URL(chrome.url).origin],
    cdp: `http://127.0.0.1:${port}`,
    kernelPort: null,
    log: () => {},
  });
  t.after(() => proxy.close());
  const page = await chrome.page(t);
  await page.init(debugSignIn);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}`);
  await ready(page);
  await page.until(
    () => document.querySelector('slicc-app').model.network.status().browser?.via === 'proxy'
  );
  await rows(t, page, 'proxy');
});

test('through slicc-node, an unmarked popup seven opens before any client connects, and that leaves about:blank at once, is held, and the first client never sees it', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const proxy = await startProxy({
    port: 0,
    origins: [new URL(chrome.url).origin],
    cdp: `http://127.0.0.1:${port}`,
    kernelPort: null,
    log: () => {},
  });
  t.after(() => proxy.close());
  const page = await chrome.page(t);
  await page.init(debugSignIn);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}`);
  await ready(page);
  await page.until(
    () => document.querySelector('slicc-app').model.network.status().browser?.via === 'proxy'
  );
  const before = new Set((await devtools('/json/list')).map((tab) => tab.id));
  await page.evaluate((MARK) => {
    const tab = window.open('about:blank', 'slicc-mcp-oauth', 'popup,width=520,height=720');
    tab.location.href = `https://ims-na1.adobelogin.com/early#access_token=${MARK}-early`;
  }, MARK);
  const early = await tabWhere(
    (tab) => tab.url.startsWith('https://ims-na1.adobelogin.com/early') && !before.has(tab.id)
  );
  t.after(() => close([early]));
  await navigate(early, ordinary(`/early-elsewhere#access_token=${MARK}-early-elsewhere`));
  const first = await guarded(page, 'proxy', 'first');
  t.after(() => first.close().catch(() => {}));
  await first.send('Target.setDiscoverTargets', { discover: true });
  await unreachable(first, { 'the popup opened before any client': early });
  assert.deepEqual(page.errors, []);
});

const UNHELD =
  "Seven couldn't keep the sign-in window out of reach of browser automation, so it didn't open the sign-in. Try again.";

async function ended(page, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const answer = await page.evaluate(() => window.signInAnswer);
    if (answer) return answer;
    if (Date.now() > end) throw new Error('the sign-in never ended');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function startSignIn(page) {
  return page.evaluate(() => {
    window.signInAnswer = null;
    void globalThis
      .sliccLogin('adobe', async () => ({ clientId: 'test-client', scopes: 'openid' }))
      .then(
        (token) => `resolved ${typeof token}`,
        (error) => error.message
      )
      .then((answer) => {
        window.signInAnswer = answer;
      });
  });
}

test('with a browser host connected, a sign-in whose window seven can’t hold never goes to the IdP', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await page.init(debugSignIn);
  await boot(page);
  await page.evaluate(() => {
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (data) {
      if (data?.type === 'hold') return;
      return post.call(this, data);
    };
  });
  const asked = idp.authorized;
  const before = new Set((await devtools('/json/list')).map((tab) => tab.id));
  await startSignIn(page);
  assert.equal(await ended(page), UNHELD);
  assert.equal(idp.authorized, asked, 'the IdP was asked');
  const left = (await devtools('/json/list')).filter((tab) => !before.has(tab.id));
  assert.ok(
    left.every((tab) => !tab.url.includes('adobelogin') && !tab.url.includes(MARK)),
    JSON.stringify(left.map((tab) => tab.url))
  );
  assert.deepEqual(page.errors, []);
});

test('with no browser host at the start, a host that connects in the middle of a sign-in never sees the sign-in tab', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(debugSignIn);
  await boot(page);
  const before = new Set((await devtools('/json/list')).map((tab) => tab.id));
  await startSignIn(page);
  const popup = await tabWhere(
    (tab) => !before.has(tab.id) && tab.url.startsWith('https://ims-na1.adobelogin.com/landing')
  );
  t.after(() => close([popup]));
  assert.equal(await page.evaluate(() => window.signInAnswer), null);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await extension.install();
  const agent = await guarded(page, 'extension', 'midway');
  t.after(() => agent.close().catch(() => {}));
  await agent.send('Target.setDiscoverTargets', { discover: true });
  await unreachable(agent, { 'the sign-in tab': popup });
  await navigate(popup, ordinary(`/midway#access_token=${MARK}-midway`));
  await unreachable(agent, { 'the sign-in tab': popup });
  assert.deepEqual(page.errors, []);
});

test('with a browser host connected, a none answer to the hold does not send the sign-in to the IdP', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await page.init(debugSignIn);
  await boot(page);
  await page.evaluate(() => {
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (data) {
      if (data?.type !== 'hold') return post.call(this, data);
      const answer = new MessageEvent('message', { data: { type: 'none', marker: data.marker } });
      queueMicrotask(() => this.dispatchEvent(answer));
    };
  });
  const asked = idp.authorized;
  await startSignIn(page);
  assert.equal(await ended(page), UNHELD);
  assert.equal(idp.authorized, asked, 'the IdP was asked');
  assert.deepEqual(page.errors, []);
});
