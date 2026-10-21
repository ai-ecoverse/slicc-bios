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

const ordinary = (path) =>
  `<title>ordinary</title>${path}<script>void \`http://localhost:\${location.port}/x\`;</script><a href="https://www.sliccy.ai/7/">seven</a> <a href="https://ntfy.sliccy.ai/github">ntfy</a> curl -fsSL https://www.sliccy.ai/install.sh <a href="https://www.sliccy.ai/blog/post">blog</a>`;
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
  if (host.endsWith('sliccy.ai') && url.pathname.endsWith('.css')) {
    res.writeHead(200, { 'content-type': 'text/css', 'access-control-allow-origin': '*' });
    return res.end('body { color: rgb(1, 2, 3); }');
  }
  if (url.pathname.startsWith('/styled/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      `<title>styled</title><link rel="stylesheet" href="/hop/${url.pathname.split('/').pop()}">styled`
    );
  }
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
  if (url.pathname.startsWith('/meta/') && hop) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<title>meta</title><meta http-equiv="refresh" content="9999;url=${hop}">`);
  }
  if (url.pathname.startsWith('/entity/') && hop) {
    const encoded = hop.replace(/:/g, '&colon;').replace(/\//g, '&#x2f;').replace(/\?/g, '&#63;');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      `<title>entity</title><meta http-equiv="refresh" content="9999;url=${encoded}">`
    );
  }
  if (url.pathname.startsWith('/form/') && hop) {
    const target = new URL(hop);
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      [
        '<title>form</title>',
        `<form method="post" action="${target.origin}${target.pathname}">`,
        ...[...target.searchParams].map(
          ([name, value]) => `<input type="hidden" name="${name}" value="${value}">`
        ),
        '</form>',
      ].join('\n')
    );
  }
  if (url.pathname.startsWith('/capability/') && hop) {
    const m = hop;
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      [
        '<title>capability</title>',
        `<a href="https://www.sliccy.ai/join/J${m}">join</a>`,
        `<p>Payload URL https://www.sliccy.ai/webhook/W${m}</p>`,
        `<p>wss://www.sliccy.ai/controller/C${m}</p>`,
        `<a href="https://seven.sliccy.ai/#slicc-pair=1.P${m}.fp">pair</a>`,
        `<p>https://vault.sliccy.ai./V${m}</p>`,
        `<p>https://user:U${m}@vault.sliccy.ai/</p>`,
      ].join('\n')
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
  return res.end(ordinary(url.pathname));
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
port = site.address().port;
after(() => site.close());

const PROTECTED = {
  seven: (code, state, token) =>
    `http://seven.sliccy.ai:${port}/auth/callback?code=${code}&state=${state}#access_token=${token}`,
  sheet: (code, state) => `http://seven.sliccy.ai:${port}/style.css?code=${code}&state=${state}`,
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
    steps.push({ fetching, kind: 'seven', how: 'navigate', path: `/meta/${hopTo('seven')}` });
    steps.push({ fetching, kind: 'seven', how: 'navigate', path: `/entity/${hopTo('seven')}` });
    steps.push({ fetching, kind: 'sheet', how: 'navigate', path: `/styled/${hopTo('sheet')}` });
    counter += 1;
    hops.set(String(counter), mark());
    steps.push({ fetching, kind: 'capability', how: 'navigate', path: `/capability/${counter}` });
    steps.push({ fetching, kind: 'vault', how: 'navigate', path: `/form/${hopTo('vault')}` });
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
    caps: [],
    dom: [],
    searches: [],
    streams: [],
    doms: [],
    sheets: [],
    infos: [],
    reads: [],
    plain: [],
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
  const expect = async (what, check) => {
    if (await wait(check, 10000)) return;
    answers.stuck.push({
      what,
      frame: await frame(),
      last: seen.slice(-3).map((text) => text.slice(0, 200)),
    });
  };
  const pump = async () => {
    while (state.pumping) {
      for (const message of paused.splice(0)) {
        const { requestId, request, responseStatusCode } = message.params;
        if (responseStatusCode !== undefined && request.url.includes('/form/')) {
          answers.streams.push(
            await send('Fetch.takeResponseBodyAsStream', { requestId }, state.session)
          );
        }
        if (responseStatusCode !== undefined) {
          answers.bodies.push({
            url: request.url,
            answer: await send('Fetch.getResponseBody', { requestId }, state.session),
          });
        } else if (request.url.endsWith('/override')) {
          answers.overrides.push(
            await send('Fetch.continueRequest', { requestId, url: override }, state.session)
          );
        } else if (request.url.endsWith('/again') && state.hop) {
          answers.overrides.push(
            await send(
              'Fetch.continueRequest',
              { requestId, url: `${state.hop}?extra=1` },
              state.session
            )
          );
          const dotted = new URL(state.hop);
          dotted.hostname = `${dotted.hostname}.`;
          answers.overrides.push(
            await send(
              'Fetch.continueRequest',
              { requestId, url: `${dotted.href}?extra=2` },
              state.session
            )
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
      for (const domain of ['Page', 'Network', 'Runtime', 'Log', 'Console', 'DOM', 'CSS']) {
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
        await expect('override', async () => answers.overrides.length > 0);
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
      await expect('start', async () => (await frame()).url === `${origin}/start`);
      const before = seen.length;
      const url = `${origin}${step.path}`;
      if (step.how === 'navigate') void send('Page.navigate', { url }, session);
      else
        void send(
          'Runtime.evaluate',
          { expression: `location.href=${JSON.stringify(url)}` },
          session
        );
      await expect(`${step.path} commit`, async () => {
        const f = await frame();
        return Boolean(f.url) && f.url !== `${origin}/start`;
      });
      const since = () => seen.slice(before).map((text) => JSON.parse(text));
      const document = () =>
        since()
          .filter((m) => m.method === 'Network.requestWillBeSent' && m.params?.request?.url === url)
          .map((m) => m.params.requestId);
      const kind = step.path.split('/')[1];
      if (kind !== 'hop') {
        await expect(`${step.path} loaded`, async () =>
          since().some(
            (m) => m.method === 'Network.loadingFinished' && document().includes(m.params.requestId)
          )
        );
      }
      if (kind === 'talk') {
        const count = (method) => since().filter((m) => m.method === method).length;
        await expect(
          '/talk/ console, exception and log',
          async () =>
            count('Runtime.consoleAPICalled') >= 2 &&
            count('Console.messageAdded') >= 2 &&
            count('Runtime.exceptionThrown') >= 1
        );
      }
      if (kind === 'styled') {
        await expect('/styled/ sheet', async () =>
          since().some(
            (m) =>
              m.method === 'CSS.styleSheetAdded' && /sliccy\.ai/.test(m.params.header.sourceURL)
          )
        );
      }
      if (kind === 'framed') {
        await expect('/framed/ child frame', async () =>
          since().some((m) => m.method === 'Page.frameAttached')
        );
      }
      const hop = `${origin}/hop/${step.path.split('/').pop()}`;
      if (step.path.startsWith('/hop/')) state.hop = hop;
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
      const own = seen
        .slice(before)
        .map((text) => JSON.parse(text))
        .filter((m) => m.method === 'Network.requestWillBeSent' && m.params?.request?.url === url)
        .map((m) => m.params.requestId);
      if (kind === 'capability') {
        for (const requestId of new Set(own)) {
          answers.caps.push(await send('Network.getResponseBody', { requestId }, session));
        }
        answers.caps.push(await send('DOM.getDocument', { depth: -1 }, session));
        answers.caps.push(await send('Page.captureSnapshot', {}, session));
      }
      for (const requestId of new Set(own)) {
        answers.reads.push(await send('Network.getResponseBody', { requestId }, session));
        answers.reads.push(
          await send('Network.searchInResponseBody', { requestId, query: 'M' }, session)
        );
        answers.searches.push(
          await send('Network.searchInResponseBody', { requestId, query: 'name="code"' }, session)
        );
        answers.streams.push(await send('Network.streamResourceContent', { requestId }, session));
      }
      answers.reads.push(await send('Page.getResourceContent', { frameId: top.id, url }, session));
      answers.reads.push(
        await send('Page.searchInResource', { frameId: top.id, url, query: 'M' }, session)
      );
      answers.reads.push(await send('IO.read', { handle: 'not-handed-out' }, session));
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
      answers.doms.push({
        kind,
        answers: [
          await send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, session),
          await send('DOM.getDocument', { depth: -1, pierce: true }, session),
        ],
      });
      for (const added of seen
        .slice(before)
        .map((text) => JSON.parse(text))
        .filter((m) => m.method === 'CSS.styleSheetAdded')) {
        answers.sheets.push({
          url: added.params.header.sourceURL,
          answer: await send(
            'CSS.getStyleSheetText',
            { styleSheetId: added.params.header.styleSheetId },
            session
          ),
        });
      }
      answers.infos.push(await send('Target.getTargetInfo', { targetId }));
      await send('Target.getTargets');
      await send('Page.getNavigationHistory', {}, session);
      await send('Page.getResourceTree', {}, session);
      return requestIds.length;
    },
    async end(fetching) {
      if (fetching === 'Request' && state.hop) {
        const before = answers.overrides.length;
        await send('Page.navigate', { url: `${origin}/again` }, state.session);
        await expect('again', async () => answers.overrides.length > before);
      }
      const before = seen.length;
      await send('Page.navigate', { url: `${origin}/start` }, state.session);
      await expect('end start', async () =>
        seen.slice(before).some((text) => text.includes('"Network.loadingFinished"'))
      );
      const ids = seen
        .slice(before)
        .map((text) => JSON.parse(text))
        .filter(
          (m) =>
            m.method === 'Network.requestWillBeSent' && m.params?.request?.url === `${origin}/start`
        )
        .map((m) => m.params.requestId);
      for (const requestId of new Set(ids)) {
        answers.plain.push(await send('Network.getResponseBody', { requestId }, state.session));
      }
      answers.dom.push(await send('DOM.getDocument', { depth: -1 }, state.session));
      answers.dom.push(await send('Page.captureSnapshot', {}, state.session));
      await send('Page.navigate', { url: `${origin}/plain` }, state.session);
      await expect('landing', async () => (await frame()).url?.includes('/landing'));
      state.pumping = false;
      await state.pumped;
      if (fetching !== 'none') await send('Fetch.disable', {}, state.session);
      await send('Target.closeTarget', { targetId: state.targetId });
    },
    async own(targetIds) {
      const out = [];
      for (const targetId of targetIds) {
        out.push(await send('Target.getTargetInfo', { targetId }));
        out.push(await send('Target.attachToTarget', { targetId, flatten: true }));
      }
      out.push(await send('Target.getTargets'));
      return out.map((answer) => JSON.stringify(answer).slice(0, 300));
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
  if (proxy) marks.push(proxy.key);
  const own = [
    `${chrome.url}#tailscale=${mark()}&proxy=http://127.0.0.1:1&key=${mark()}`,
    `${chrome.url}#access_token=${mark()}&expires_in=3600`,
  ];
  const tabs = [];
  for (const url of own)
    tabs.push((await chrome.cdp.send('Target.createTarget', { url })).targetId);
  t.after(async () => {
    for (const targetId of tabs)
      await chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  });
  const answered = await page.evaluate((ids) => window.rig.own(ids), tabs);
  assert.ok(
    answered.filter((answer) => answer.includes('"error"')).length >= tabs.length,
    `seven's own tabs can't be attached: ${answered}`
  );
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
  const hopped = new Set(
    seen
      .map((text) => JSON.parse(text))
      .filter(
        (message) =>
          message.method === 'Network.requestWillBeSent' &&
          message.params?.redirectResponse &&
          /sliccy\.ai/.test(message.params.request?.url ?? '')
      )
      .map((message) => message.params.requestId)
  );
  const sized = seen
    .map((text) => JSON.parse(text))
    .filter(
      (message) =>
        message.method === 'Network.loadingFinished' && hopped.has(message.params.requestId)
    );
  assert.deepEqual(sized, [], 'no hop into seven or the vault reports its response size');
  const bodies = answers.bodies.filter(
    ({ url, answer }) => url.includes('/hop/') && answer.result !== undefined
  );
  assert.deepEqual(bodies, [], 'no body of a hop to seven or the vault reaches the client');
  assert.ok(
    answers.bodies.some(({ url, answer }) => url.includes('/hop/') && refused(answer)),
    'a hop the guard saw name seven or the vault has its body refused'
  );
  assert.ok(
    answers.reads.some(refused),
    'a body or resource that names seven or the vault is refused'
  );
  assert.ok(
    answers.caps.length > 0 && answers.caps.every(refused),
    `a page showing a join, webhook, controller or pairing capability, or a dotted or userinfo vault URL, is not readable: ${JSON.stringify(answers.caps.map((answer) => answer.error?.message ?? 'read'))}`
  );
  assert.ok(
    answers.dom.length > 0 && answers.dom.every((answer) => !answer.error),
    `an ordinary page that links into sliccy.ai stays readable: ${JSON.stringify(answers.dom.map((answer) => answer.error ?? 'ok'))}`
  );
  assert.ok(
    answers.plain.length > 0 &&
      answers.plain.every((answer) => answer.result?.body === ordinary('/start')),
    `an ordinary page's body reads unchanged: ${JSON.stringify(answers.plain).slice(0, 300)}`
  );
  const sheets = answers.sheets.filter(({ url }) => url.includes('sliccy.ai'));
  assert.ok(
    sheets.length > 0,
    `a stylesheet came through a hop: ${JSON.stringify(answers.sheets).slice(0, 300)}`
  );
  assert.ok(
    sheets.every(({ answer }) => refused(answer)),
    JSON.stringify(sheets).slice(0, 300)
  );
  for (const { result } of answers.infos) {
    const { url = '', title = '' } = result?.targetInfo ?? {};
    for (const shown of [url, title]) {
      if (!/sliccy\.ai/.test(shown)) continue;
      assert.match(
        shown,
        /^(?:https?:\/\/)?[a-z.]*sliccy\.ai(?::\d+)?$/,
        `tab info shows at most an origin: ${shown}`
      );
    }
  }
  assert.ok(
    answers.streams.length > 0 && answers.streams.every(refused),
    JSON.stringify(answers.streams).slice(0, 300)
  );
  assert.ok(answers.searches.length > 0);
  assert.ok(
    answers.searches.every((answer) => !JSON.stringify(answer).includes('value=')),
    JSON.stringify(answers.searches).slice(0, 300)
  );
  for (const kind of ['form']) {
    const doms = answers.doms.filter((dom) => dom.kind === kind).flatMap((dom) => dom.answers);
    assert.ok(
      doms.length > 0 && doms.some(refused),
      `${kind}: ${JSON.stringify(doms).slice(0, 300)}`
    );
  }
  assert.ok(
    answers.replays.every((answer) => answer.error),
    JSON.stringify(answers.replays)
  );
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
