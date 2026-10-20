import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { ready } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const free = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const marks = [];
const mark = () => {
  const value = `M${randomBytes(6).toString('hex')}`;
  marks.push(value);
  return value;
};
const hops = new Map();
const hits = new Map();
let port;
const site = createHttp((req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const url = new URL(req.url, `http://${req.headers.host}`);
  hits.set(`${host}${url.pathname}`, (hits.get(`${host}${url.pathname}`) ?? 0) + 1);
  const hop = hops.get(url.pathname.split('/').pop());
  if (url.pathname.startsWith('/hop/') && hop) {
    res.writeHead(302, { location: hop });
    return res.end(`<a href="${hop}">moved</a>`);
  }
  if (url.pathname.startsWith('/linked/') && hop) {
    res.writeHead(200, {
      'content-type': 'text/html',
      link: `<${hop}>; rel=preconnect`,
      refresh: `9999;url=${hop}`,
    });
    return res.end('<title>linked</title>linked');
  }
  if (url.pathname.startsWith('/talk/') && hop) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      `<title>talk</title><script>const u=${JSON.stringify(hop)};console.log("seen "+u);console.error(u);setTimeout(()=>{throw new Error("at "+u)});fetch(${JSON.stringify(`/hop/${url.pathname.split('/').pop()}`)}).catch(()=>{});</script>`
    );
  }
  if (url.pathname.startsWith('/framed/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      `<title>framed</title><iframe src="/hop/${url.pathname.split('/').pop()}"></iframe>`
    );
  }
  if (url.pathname === '/plain') {
    res.writeHead(302, { location: `http://other.test:${port}/landing?keep=${hops.get('plain')}` });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  return res.end(`<title>ordinary</title>${url.pathname}`);
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
port = site.address().port;
after(() => site.close());

const PROTECTED = {
  seven: (code, state, token) =>
    `http://seven.sliccy.ai:${port}/auth/callback?code=${code}&state=${state}#access_token=${token}`,
  vault: (code, state) =>
    `http://vault.sliccy.ai:${port}/oauth/mcp-callback?code=${code}&state=${state}`,
};
let counter = 0;
const hopTo = (kind) => {
  counter += 1;
  const key = String(counter);
  hops.set(key, PROTECTED[kind](mark(), mark(), mark()));
  return key;
};
const CONTROL = `K${randomBytes(6).toString('hex')}`;
hops.set('plain', CONTROL);

const debugging = await free();
const chrome = await launch({
  args: [
    `--remote-debugging-port=${debugging}`,
    `--host-resolver-rules=MAP seven.sliccy.ai 127.0.0.1, MAP vault.sliccy.ai 127.0.0.1, MAP ordinary.test 127.0.0.1, MAP other.test 127.0.0.1`,
  ],
});
after(() => chrome.close());
const browser = await debuggerUrl(debugging);
const fakeExtension = extensionOver(browser);

const plan = () => {
  const steps = [];
  for (const fetching of ['none', 'Request', 'Response']) {
    for (const kind of ['seven', 'vault']) {
      for (const how of ['navigate', 'location']) {
        steps.push({ fetching, kind, how, path: `/hop/${hopTo(kind)}` });
      }
    }
    steps.push({ fetching, kind: 'seven', how: 'navigate', path: `/linked/${hopTo('seven')}` });
    steps.push({ fetching, kind: 'seven', how: 'navigate', path: `/talk/${hopTo('seven')}` });
    steps.push({ fetching, kind: 'vault', how: 'navigate', path: `/framed/${hopTo('vault')}` });
  }
  return steps;
};

async function rig({ transport, proxy, port, override }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { proxyHost, extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const raw =
    transport === 'proxy'
      ? await proxyHost(proxy)()
      : extensionConnection(globalThis.sliccExtension.cdp);
  const connection = guardProtected(raw, self.origin);
  const pending = new Map();
  const seen = [];
  const paused = [];
  let next = 0;
  connection.onmessage = (text) => {
    seen.push(text);
    const message = JSON.parse(text);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else if (message.method === 'Fetch.requestPaused') paused.push(message);
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
  const wait = async (check, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  const answers = {
    bodies: [],
    replays: [],
    loads: [],
    overrides: [],
    resources: [],
    snapshots: [],
    stuck: [],
  };
  const origin = `http://ordinary.test:${port}`;
  const state = {};
  const frame = async () =>
    (await send('Page.getFrameTree', {}, state.session)).result?.frameTree?.frame ?? {};
  const pump = async () => {
    while (state.pumping) {
      for (const message of paused.splice(0)) {
        const { requestId, request, responseStatusCode } = message.params;
        if (responseStatusCode !== undefined) {
          answers.bodies.push({
            url: request.url,
            answer: await send('Fetch.getResponseBody', { requestId }, state.session),
          });
        } else if (request.url.endsWith('/override')) {
          answers.overrides.push(
            await send('Fetch.continueRequest', { requestId, url: override }, state.session)
          );
        }
        await send('Fetch.continueRequest', { requestId }, state.session);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await send('Target.setDiscoverTargets', { discover: true });
  window.rig = {
    async begin(fetching) {
      state.fetching = fetching;
      const created = await send('Target.createTarget', { url: `${origin}/start` });
      state.targetId = created.result?.targetId;
      state.session = (
        await send('Target.attachToTarget', { targetId: state.targetId, flatten: true })
      ).result?.sessionId;
      if (!state.session) return `attach: ${JSON.stringify(created)}`;
      for (const domain of ['Page', 'Network', 'Runtime', 'Log']) {
        await send(`${domain}.enable`, {}, state.session);
      }
      state.pumping = true;
      state.pumped = pump();
      if (fetching !== 'none') {
        await send(
          'Fetch.enable',
          { patterns: [{ urlPattern: '*', requestStage: fetching }] },
          state.session
        );
      }
      if (fetching === 'Request') {
        await send('Page.navigate', { url: `${origin}/override` }, state.session);
        await wait(async () => (await frame()).url?.includes('/override'), 8000);
      }
      return null;
    },
    async step(step) {
      if (state.targetId) {
        state.pumping = false;
        await state.pumped;
        await send('Target.closeTarget', { targetId: state.targetId });
      }
      const fresh = await window.rig.begin(state.fetching);
      if (fresh) return fresh;
      const { session, targetId } = state;
      await send('Page.navigate', { url: `${origin}/start` }, session);
      await wait(async () => (await frame()).url === `${origin}/start`, 8000);
      const before = seen.length;
      const url = `${origin}${step.path}`;
      if (step.how === 'navigate') void send('Page.navigate', { url }, session);
      else
        void send(
          'Runtime.evaluate',
          { expression: `location.href=${JSON.stringify(url)}` },
          session
        );
      const settled = await wait(async () => {
        const f = await frame();
        return Boolean(f.url) && f.url !== `${origin}/start`;
      }, 10000);
      if (!settled) answers.stuck.push({ step, frame: await frame() });
      await wait(async () => {
        const count = seen.length;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return seen.length === count;
      }, 4000);
      const hop = `${origin}/hop/${step.path.split('/').pop()}`;
      const requestIds = seen
        .slice(before)
        .map((text) => JSON.parse(text))
        .filter((m) => m.method === 'Network.requestWillBeSent' && m.params?.request?.url === hop)
        .map((m) => m.params.requestId);
      for (const requestId of new Set(requestIds)) {
        answers.bodies.push({
          url: hop,
          answer: await send('Network.getResponseBody', { requestId }, session),
        });
        answers.replays.push(await send('Network.replayXHR', { requestId }, session));
      }
      const top = await frame();
      answers.loads.push(
        await send(
          'Network.loadNetworkResource',
          { frameId: top.id, url: hop, options: { disableCache: true, includeCredentials: false } },
          session
        )
      );
      answers.resources.push(
        await send('Page.getResourceContent', { frameId: top.id, url: hop }, session)
      );
      answers.snapshots.push(await send('Page.captureSnapshot', {}, session));
      await send('Target.getTargetInfo', { targetId });
      await send('Target.getTargets');
      await send('Page.getNavigationHistory', {}, session);
      await send('Page.getResourceTree', {}, session);
      return requestIds.length;
    },
    async end(fetching) {
      await send('Page.navigate', { url: `${origin}/plain` }, state.session);
      await wait(async () => (await frame()).url?.includes('/landing'), 8000);
      state.pumping = false;
      await state.pumped;
      if (fetching !== 'none') await send('Fetch.disable', {}, state.session);
      await send('Target.closeTarget', { targetId: state.targetId });
    },
    collect: () => ({ seen: seen.splice(0), answers }),
  };
}

const refused = (answer) => /^slicc: refused:/.test(answer?.error?.message ?? '');
const leaks = (seen) => {
  const found = [];
  for (const value of marks) {
    for (const form of [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]) {
      for (const text of seen) if (text.includes(form)) found.push(text.slice(0, 400));
    }
  }
  for (const text of seen) {
    if (/auth\/callback|mcp-callback/.test(text)) found.push(text.slice(0, 400));
  }
  return [...new Set(found)];
};

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
  const steps = plan();
  await page.evaluate(rig, {
    transport,
    proxy: proxy && { url: proxy.url, key: proxy.key },
    port,
    override: PROTECTED.seven(mark(), mark(), mark()),
  });
  const seen = [];
  for (const fetching of ['none', 'Request', 'Response']) {
    assert.equal(await page.evaluate((f) => window.rig.begin(f), fetching), null);
    for (const step of steps.filter((s) => s.fetching === fetching)) {
      assert.equal(typeof (await page.evaluate((s) => window.rig.step(s), step)), 'number');
    }
    await page.evaluate((f) => window.rig.end(f), fetching);
    const out = await page.evaluate(() => window.rig.collect());
    seen.push(...out.seen);
  }
  const { answers } = await page.evaluate(() => window.rig.collect());
  assert.deepEqual(answers.stuck, [], 'every step committed');
  for (const step of steps) {
    assert.ok(hits.get(`ordinary.test${step.path}`), `the ordinary page ${step.path} was served`);
  }
  assert.ok(
    seen.some((text) => text.includes(`/landing?keep=${CONTROL}`) && text.includes('location')),
    'an ordinary redirect still shows its Location'
  );
  assert.deepEqual(leaks(seen), [], 'no protected URL past its origin reached the client');
  const bodies = answers.bodies.filter(
    ({ url, answer }) => url.includes('/hop/') && answer.result !== undefined
  );
  assert.deepEqual(bodies, [], 'no body of a hop to seven or the vault reaches the client');
  assert.ok(
    answers.bodies.some(({ url, answer }) => url.includes('/hop/') && refused(answer)),
    'a hop the guard saw name seven or the vault has its body refused'
  );
  assert.ok(answers.replays.every(refused), JSON.stringify(answers.replays));
  assert.ok(answers.loads.every(refused), JSON.stringify(answers.loads.slice(0, 2)));
  assert.ok(answers.overrides.length > 0 && answers.overrides.every(refused));
  for (const answer of [...answers.resources, ...answers.snapshots]) {
    assert.doesNotMatch(JSON.stringify(answer), /sliccy\.ai\/|M[0-9a-f]{12}/);
  }
}

test(
  'a redirect to seven or the vault shows the client only its origin, on the proxy path',
  {
    timeout: 10 * 60 * 1000,
  },
  (t) => check(t, 'proxy')
);

test(
  'a redirect to seven or the vault shows the client only its origin, on the extension path',
  {
    timeout: 10 * 60 * 1000,
  },
  (t) => check(t, 'extension')
);
