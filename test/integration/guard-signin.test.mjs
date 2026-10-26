import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { ready } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const RELAY = 'https://www.sliccy.ai/auth/callback';
const CLIENT = 'seven-sign-in-client';
const hits = [];
let SIGNING_IN = {};
const site = createHttp((req, res) => {
  hits.push(`${req.headers.host}${req.url}`);
  const url = new URL(req.url, 'http://x');
  const [, via, key] = url.pathname.split('/');
  const to = Object.values(SIGNING_IN)[Number(key)];
  if (via === 'go' && to) {
    res.writeHead(302, { location: to });
    return res.end();
  }
  if (via === 'framing' && to) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<title>framing</title><iframe src="${to}"></iframe>`);
  }
  if (via === 'clicking' && to) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      `<title>clicking</title><a id="go" href="${to}">sign in</a><script>document.getElementById('go').click()</script>`
    );
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<title>idp</title><h1>Sign in</h1>');
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const port = site.address().port;
after(() => site.close());

const debugging = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
const chrome = await launch({
  tools: false,
  args: [
    `--remote-debugging-port=${debugging}`,
    '--host-resolver-rules=MAP idp.test 127.0.0.1, MAP ordinary.test 127.0.0.1',
  ],
});
after(() => chrome.close());
const fakeExtension = extensionOver(await debuggerUrl(debugging));

const authorize = (params) =>
  `http://idp.test:${port}/ims/authorize/v2?${new URLSearchParams(params)}`;
SIGNING_IN = {
  'with seven’s callback': authorize({
    client_id: 'any',
    redirect_uri: RELAY,
    response_type: 'token',
  }),
  'with seven’s client id and no callback': authorize({ client_id: CLIENT, response_type: 'code' }),
  'as a form_post': authorize({
    client_id: CLIENT,
    redirect_uri: RELAY,
    response_mode: 'form_post',
  }),
  'with the callback encoded twice': `http://idp.test:${port}/ims/authorize/v2?client_id=any&redirect_uri=${encodeURIComponent(encodeURIComponent(RELAY))}`,
  'with a bad escape next to the encoded callback': `http://idp.test:${port}/ims/authorize/v2?client_id=any&redirect_uri=${encodeURIComponent(RELAY)}&x=%C3%28&y=%ZZ`,
  'nested in another URL': `http://idp.test:${port}/login?next=${encodeURIComponent(authorize({ client_id: CLIENT, response_type: 'token' }))}`,
};
const DRIVABLE = {
  'another client and callback': authorize({
    client_id: 'other',
    redirect_uri: 'https://other.test/cb',
    response_type: 'code',
  }),
  'the vault’s callback': authorize({
    client_id: 'other',
    redirect_uri: 'https://vault.sliccy.ai/oauth/mcp-callback',
  }),
};

async function rig({ transport, proxy, port, client, signing, drivable }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { proxyHost, extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const { authorizeUrl } = await import(new URL('adobe.js', location.href).href);
  authorizeUrl({ clientId: client, scopes: 'openid' }, 1, 'n');
  const raw =
    transport === 'proxy'
      ? await proxyHost(proxy)()
      : extensionConnection(globalThis.sliccExtension.cdp);
  const connection = guardProtected(raw, self.origin);
  const pending = new Map();
  let next = 0;
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      next += 1;
      const id = next;
      const timer = setTimeout(
        () => resolve({ error: { message: `${method} got no answer` } }),
        8000
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const frame = async (session) => {
    const found = (await send('Page.getFrameTree', {}, session)).result?.frameTree?.frame ?? {};
    seen.url = found.url ?? null;
    return found;
  };
  const seen = { url: null };
  const until = async (check) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return `timed out; the frame was at ${seen.url}`;
  };
  const start = `http://ordinary.test:${port}/start`;
  const out = { signing: {}, drivable: {}, indirect: {} };
  window.indirectly = async (name, key) => {
    const { targetId } = (await send('Target.createTarget', { url: start })).result ?? {};
    const session = (await send('Target.attachToTarget', { targetId, flatten: true })).result
      ?.sessionId;
    await send('Page.enable', {}, session);
    await until(async () => (await frame(session)).url === start);
    for (const via of ['go', 'framing', 'clicking']) {
      const url = `http://ordinary.test:${port}/${via}/${key}`;
      const answer = await send('Page.navigate', { url }, session);
      const settled = await until(async () => (await frame(session)).url !== start);
      out.indirect[`${name} via ${via}`] = {
        answer: answer.error?.message ?? 'navigated',
        settled,
      };
      await send('Page.navigate', { url: start }, session);
      await until(async () => (await frame(session)).url === start);
    }
    await send('Target.closeTarget', { targetId });
    return out.indirect;
  };
  for (const [name, url] of Object.entries({ ...signing, ...drivable })) {
    const row = {};
    row.created = (await send('Target.createTarget', { url })).error?.message ?? 'created';
    const { targetId } = (await send('Target.createTarget', { url: start })).result ?? {};
    const session = (await send('Target.attachToTarget', { targetId, flatten: true })).result
      ?.sessionId;
    await send('Page.enable', {}, session);
    row.started = await until(async () => (await frame(session)).url === start);
    row.navigated = (await send('Page.navigate', { url }, session)).error?.message ?? 'navigated';
    if (row.navigated === 'navigated') {
      row.loaded = await until(async () => (await frame(session)).url === url);
    } else {
      void send(
        'Runtime.evaluate',
        { expression: `location.href=${JSON.stringify(url)}` },
        session
      );
      row.left = await until(async () => (await frame(session)).url !== start);
      row.landed = (await frame(session)).url ?? null;
    }
    await send('Target.closeTarget', { targetId });
    out[name in signing ? 'signing' : 'drivable'][name] = row;
  }
  return out;
}

async function check(t, transport) {
  const page = await chrome.page(t);
  let proxy;
  if (transport === 'proxy') {
    proxy = await startProxy({
      port: 0,
      origins: [new URL(chrome.url).origin],
      cdp: `http://127.0.0.1:${debugging}`,
      kernelPort: null,
      log: () => {},
    });
    t.after(() => proxy.close());
  } else {
    const extension = await fakeExtension(page);
    t.after(() => extension.close());
  }
  await page.goto(proxy ? `/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}` : '/');
  await ready(page);
  hits.length = 0;
  const out = await page.evaluate(rig, {
    transport,
    proxy: proxy && { url: proxy.url, key: proxy.key },
    port,
    client: CLIENT,
    signing: SIGNING_IN,
    drivable: DRIVABLE,
  });
  for (const [key, name] of Object.keys(SIGNING_IN).entries()) {
    out.indirect = await page.evaluate(([n, k]) => window.indirectly(n, k), [name, key]);
  }
  for (const [name, row] of Object.entries(out.signing)) {
    assert.match(row.created, /^slicc: refused:/, `${name}: createTarget ${JSON.stringify(row)}`);
    assert.match(
      row.navigated,
      /^slicc: refused:/,
      `${name}: Page.navigate ${JSON.stringify(row)}`
    );
    assert.equal(row.started, true, `${name}: ${JSON.stringify(row)}`);
    assert.equal(
      row.left,
      true,
      `${name}: the page's own navigation ended somewhere ${JSON.stringify(row)}`
    );
    assert.notEqual(row.landed, SIGNING_IN[name], `${name}: the page reached the sign-in page`);
  }
  for (const [name, row] of Object.entries(out.drivable)) {
    assert.deepEqual(
      { created: row.created, navigated: row.navigated, loaded: row.loaded },
      { created: 'created', navigated: 'navigated', loaded: true },
      name
    );
  }
  for (const [name, row] of Object.entries(out.indirect)) {
    assert.equal(row.settled, true, `${name}: ${JSON.stringify(row)}`);
  }
  assert.equal(Object.keys(out.indirect).length, Object.keys(SIGNING_IN).length * 3);
  const served = new Set(Object.values(DRIVABLE).map((url) => url.replace(/^http:\/\//, '')));
  const reached = hits.filter(
    (hit) => /^idp\.test:\d+\/(?:ims|login)/.test(hit) && !served.has(hit)
  );
  assert.deepEqual(reached, [], 'no sign-in page was served to a guarded tab');
}

test(
  'seven’s own sign-in pages can’t be driven through the guard, on the proxy path',
  { timeout: 5 * 60 * 1000 },
  (t) => check(t, 'proxy')
);

test(
  'seven’s own sign-in pages can’t be driven through the guard, on the extension path',
  { timeout: 5 * 60 * 1000 },
  (t) => check(t, 'extension')
);

test('after a reload, seven’s last sign-in client id still makes its authorize page protected', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(() => extension.close());
  await page.goto('/');
  await ready(page);
  await page.evaluate(async (client) => {
    const { authorizeUrl } = await import(new URL('adobe.js', location.href).href);
    authorizeUrl({ clientId: client, scopes: 'openid' }, 1, 'n');
  }, CLIENT);
  await page.goto('/');
  await ready(page);
  const url = SIGNING_IN['with seven’s client id and no callback'];
  const answer = await page.evaluate(async (url) => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const connection = guardProtected(
      extensionConnection(globalThis.sliccExtension.cdp),
      self.origin
    );
    return new Promise((resolve) => {
      connection.onmessage = (text) => {
        const message = JSON.parse(text);
        if (message.id === 1) resolve(message);
      };
      connection.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url } }));
    });
  }, url);
  assert.match(answer.error?.message ?? '', /^slicc: refused:/, JSON.stringify(answer));
});

test('a fresh profile that has never signed in still treats seven’s built-in sign-in client as protected', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(() => extension.close());
  await page.goto('/');
  await ready(page);
  await page.evaluate(() => localStorage.removeItem('slicc-os.sign-in-clients'));
  await page.goto('/');
  await ready(page);
  const url = authorize({ client_id: 'experience-catalyst-prod', response_type: 'token' });
  const answer = await page.evaluate(async (url) => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const connection = guardProtected(
      extensionConnection(globalThis.sliccExtension.cdp),
      self.origin
    );
    return new Promise((resolve) => {
      connection.onmessage = (text) => {
        const message = JSON.parse(text);
        if (message.id === 1) resolve(message);
      };
      connection.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url } }));
    });
  }, url);
  assert.match(answer.error?.message ?? '', /^slicc: refused:/, JSON.stringify(answer));
});

test('a sign-in tab already open before the client connects is neither listed nor reachable through the guard', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(() => extension.close());
  await page.goto('/');
  await ready(page);
  const open = authorize({ client_id: 'experience-catalyst-prod', response_type: 'token' });
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url: open });
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  const out = await page.evaluate(
    async ({ targetId }) => {
      const { guardProtected } = await import(new URL('guard.js', location.href).href);
      const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
      const connection = guardProtected(
        extensionConnection(globalThis.sliccExtension.cdp),
        self.origin
      );
      const pending = new Map();
      const seen = [];
      let next = 0;
      connection.onmessage = (text) => {
        seen.push(text);
        const message = JSON.parse(text);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      };
      const send = (method, params = {}) =>
        new Promise((resolve) => {
          next += 1;
          const id = next;
          pending.set(id, resolve);
          connection.send(JSON.stringify({ id, method, params }));
        });
      const list = await send('Target.getTargets');
      return {
        listed: (list.result?.targetInfos ?? []).some((info) => info.targetId === targetId),
        info: (await send('Target.getTargetInfo', { targetId })).error?.message ?? 'answered',
        attach:
          (await send('Target.attachToTarget', { targetId, flatten: true })).error?.message ??
          'attached',
        close: (await send('Target.closeTarget', { targetId })).error?.message ?? 'closed',
        named: seen.some((text) => text.includes('experience-catalyst-prod')),
      };
    },
    { targetId }
  );
  assert.equal(out.listed, false, JSON.stringify(out));
  for (const name of ['info', 'attach', 'close']) {
    assert.match(out[name], /^slicc: refused:/, `${name}: ${JSON.stringify(out)}`);
  }
  assert.equal(out.named, false, JSON.stringify(out));
  assert.ok(
    (await chrome.cdp.send('Target.getTargets')).targetInfos.some(
      (info) => info.targetId === targetId
    ),
    'the sign-in tab is still open'
  );
});

test('a sign-in through the extension records its client id, so that id’s authorize page is protected after a reload', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(() => extension.close());
  await page.goto('/');
  await ready(page);
  const token = await page.evaluate(async () => {
    localStorage.removeItem('slicc-os.sign-in-clients');
    const { signIn } = await import('/os/adobe.js');
    const login = signIn({
      extension: { signIn: async () => 'extension-token' },
      open: () => null,
    });
    return login('adobe', () => ({ clientId: 'extension-path-client', scopes: 'openid' }));
  });
  assert.equal(token, 'extension-token');
  await page.goto('/');
  await ready(page);
  const url = authorize({ client_id: 'extension-path-client', response_type: 'token' });
  const answer = await page.evaluate(async (url) => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const connection = guardProtected(
      extensionConnection(globalThis.sliccExtension.cdp),
      self.origin
    );
    return new Promise((resolve) => {
      connection.onmessage = (text) => {
        const message = JSON.parse(text);
        if (message.id === 1) resolve(message);
      };
      connection.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url } }));
    });
  }, url);
  assert.match(answer.error?.message ?? '', /^slicc: refused:/, JSON.stringify(answer));
});
