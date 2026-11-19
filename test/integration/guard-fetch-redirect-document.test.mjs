import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as createHttp } from 'node:http';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const hex = () => randomBytes(6).toString('hex');
const landings = new Map();
const bounces = new Map();
const hits = [];
let port;
const site = createHttp((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const url = new URL(req.url, 'http://ordinary.test');
    const [, kind, key] = url.pathname.split('/');
    if (key)
      hits.push({
        key,
        kind,
        host: req.headers.host ?? '',
        method: req.method,
        cookie: req.headers.cookie ?? '',
        authorization: req.headers.authorization ?? '',
        body: Buffer.concat(chunks).toString('latin1'),
      });
    if (kind === 'bounce' && bounces.has(key)) {
      res.writeHead(307, { location: bounces.get(key) });
      return res.end();
    }
    if (kind === 'go' && bounces.has(key)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(
        `<title>go</title><script>location.href = ${JSON.stringify(bounces.get(key))};</script>`
      );
    }
    if (kind === 'landing') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<title>landing</title><p>${landings.get(key) ?? 'none'}</p>`);
    }
    res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    return res.end(`<title>ordinary</title><p>${kind ?? 'start'}</p>`);
  });
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
port = site.address().port;
after(() => site.close());

const ORDINARY = `http://ordinary.test:${port}`;
const START = `${ORDINARY}/start`;
const at = (host, key) => `http://${host}.sliccy.ai:${port}/landing/${key}`;
const relative = (host, key) => `//${host}.sliccy.ai:${port}/landing/${key}`;
const binary = (text) => Buffer.from(text, 'latin1').toString('base64');
const PROTECTED_HOST = /^(?:seven|vault)\.sliccy\.ai(?::\d+)?$/;
const PROTECTED_URL = /^https?:\/\/(?:seven|vault)\.sliccy\.ai(?::\d+)?\//;

const chrome = await launch({
  tools: false,
  args: [
    '--remote-allow-origins=*',
    '--host-resolver-rules=MAP seven.sliccy.ai 127.0.0.1, MAP vault.sliccy.ai 127.0.0.1, MAP ordinary.test 127.0.0.1',
  ],
});
const { port: debugging } = await devtools(chrome);
after(() => chrome.close());
const browser = await debuggerUrl(debugging);
const fakeExtension = extensionOver(browser);

async function rig({ browser }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { devtoolsConnection, extensionConnection } = await import(
    new URL('cdp.js', location.href).href
  );
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const parse = (text) => JSON.parse(text);
  const state = {};
  const open = async (route) => {
    const raw =
      route === 'devtools'
        ? await devtoolsConnection(browser)
        : extensionConnection(globalThis.sliccExtension.cdp);
    const extension = globalThis.sliccExtension;
    const connection = guardProtected(
      raw,
      self.origin,
      new Map(),
      route === 'devtools' ? undefined : { kind: 'extension', version: extension.version },
      route !== 'devtools' && typeof extension.frames === 'function'
        ? (targetId) => extension.frames(Number(targetId))
        : undefined
    );
    const pending = new Map();
    const seen = [];
    const listeners = new Set();
    let next = 0;
    connection.onmessage = (text) => {
      seen.push(text);
      const message = JSON.parse(text);
      if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      } else for (const listener of listeners) void listener(message);
    };
    const send = (method, params = {}, sessionId, ms = 3000) =>
      new Promise((resolve) => {
        next += 1;
        const id = next;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ error: { message: `${method} got no answer` } });
        }, ms);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        connection.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      });
    return { connection, send, seen, listeners };
  };
  const said = (answer) => answer.error?.message?.slice(0, 120) ?? 'ok';
  window.probe = {
    async begin(row) {
      const client = await open(row.route);
      const { send, listeners } = client;
      const out = { answers: {}, protectedPauses: [], writes: [] };
      state.client = client;
      state.out = out;
      state.row = row;
      let targetId = row.targetId;
      if (!targetId) {
        const created = await send('Target.createTarget', { url: row.start }, undefined, 6000);
        out.answers.create = said(created);
        targetId = created.result?.targetId;
      }
      out.targetId = targetId;
      const attaching = Date.now();
      const attached = await send(
        'Target.attachToTarget',
        { targetId, flatten: true },
        undefined,
        6000
      );
      out.attachMs = Date.now() - attaching;
      out.answers.attach = said(attached);
      const session = attached.result?.sessionId;
      state.session = session;
      if (!session) return out;
      await Promise.all(
        ['Page', 'Network', 'Runtime'].map((domain) => send(`${domain}.enable`, {}, session))
      );
      const frame = async () =>
        (await send('Page.getFrameTree', {}, session)).result?.frameTree?.frame ?? {};
      state.frame = frame;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && (await frame()).url !== row.start) await sleep(100);
      out.startUrl = (await frame()).url;
      let handled = false;
      listeners.add(async (message) => {
        if (message.sessionId !== session || message.method !== 'Fetch.requestPaused') return;
        const { requestId, request, responseStatusCode, responseErrorReason } = message.params;
        const response = responseStatusCode !== undefined || responseErrorReason !== undefined;
        if (/sliccy\.ai/.test(request.url)) out.protectedPauses.push(request.url.slice(0, 120));
        if (!handled && request.url === row.target && (row.stage === 'Response') === response) {
          handled = true;
          const answer = await send(row.write.method, { requestId, ...row.write.params }, session);
          out.writes.push(said(answer));
          if (!answer.error) return;
        }
        await send(
          response ? 'Fetch.continueResponse' : 'Fetch.continueRequest',
          { requestId },
          session
        );
      });
      if (row.write) {
        const enabled = await send(
          'Fetch.enable',
          { patterns: [{ urlPattern: row.pattern, requestStage: row.stage }] },
          session
        );
        out.answers.fetch = said(enabled);
      }
      return out;
    },
    async act() {
      const { client, out, row, session } = state;
      if (!session) return out;
      state.before = client.seen.length;
      if (row.how === 'fetch') {
        const evaluated = await client.send(
          'Runtime.evaluate',
          {
            expression: `fetch(${JSON.stringify(row.target)}).then((r) => String(r.status), (e) => String(e))`,
            awaitPromise: true,
            returnByValue: true,
          },
          session,
          12000
        );
        out.answers.fetched = evaluated.result?.result?.value ?? said(evaluated);
        const settled = (text) => {
          const message = parse(text);
          return (
            message.sessionId === session &&
            ['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)
          );
        };
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !client.seen.slice(state.before).some(settled))
          await sleep(50);
      } else {
        const navigated = await client.send('Page.navigate', { url: row.target }, session, 12000);
        out.answers.navigate = navigated.result?.errorText ?? said(navigated);
      }
      return out;
    },
    async collect() {
      const { client, out, row, session } = state;
      if (session) {
        out.frameUrl = (await state.frame()).url;
        const events = client.seen.slice(state.before ?? 0).map(parse);
        const ids = new Set(
          events
            .filter((m) => m.sessionId === session && m.method === 'Network.requestWillBeSent')
            .map((m) => m.params.requestId)
        );
        const reads = [
          await client.send(
            'Runtime.evaluate',
            { expression: 'document.documentElement.outerHTML', returnByValue: true },
            session
          ),
          await client.send('DOM.getDocument', { depth: -1, pierce: true }, session),
          await client.send('Page.captureSnapshot', {}, session),
        ];
        for (const requestId of [...ids].slice(0, 4))
          reads.push(await client.send('Network.getResponseBody', { requestId }, session));
        out.reads = reads.map(said);
        out.failed = events
          .filter((m) => m.method === 'Network.loadingFailed')
          .map((m) => `${m.params.type ?? ''} ${m.params.errorText ?? ''}`.trim());
        if (row.write) await client.send('Fetch.disable', {}, session);
      }
      out.leaks = client.seen
        .filter((text) => text.includes(row.marker))
        .map((t) => t.slice(0, 300));
      client.connection.close();
      state.session = undefined;
      return out;
    },
  };
}

async function setup(t) {
  const opened = await chrome.page(t);
  const extension = await fakeExtension(opened);
  t.after(() => extension.close());
  await opened.goto('/');
  await ready(opened);
  await opened.evaluate(rig, { browser });
  return opened;
}

async function tabUrl(targetId) {
  const infos = (await chrome.cdp.send('Target.getTargets')).targetInfos;
  return infos.find((info) => info.targetId === targetId)?.url ?? 'closed';
}

async function tabLeft(targetId, left, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (left(await tabUrl(targetId))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function probe(seven, spec) {
  const key = hex();
  const marker = `L${hex()}`;
  landings.set(key, marker);
  const row = { ...spec.build(key), route: spec.route, marker, start: START };
  if (row.bounce) bounces.set(key, row.bounce);
  if (spec.tab === 'attached') {
    row.targetId = (await chrome.cdp.send('Target.createTarget', { url: START })).targetId;
  }
  const begun = await seven.evaluate((row) => window.probe.begin(row), row);
  await seven.evaluate(() => window.probe.act());
  if (row.how === 'navigate')
    await tabLeft(begun.targetId, (url) => url !== START && !(row.leaves && url === row.target));
  const out = await seven.evaluate(() => window.probe.collect());
  const finalUrl = await tabUrl(out.targetId);
  if (out.targetId)
    await chrome.cdp.send('Target.closeTarget', { targetId: out.targetId }).catch(() => false);
  const seen = hits
    .filter((hit) => hit.key === key)
    .map(({ kind, host, method, cookie, authorization, body }) => ({
      kind,
      host,
      method,
      cookie,
      authorization,
      body: body.slice(0, 60),
    }));
  return { key, row, out, finalUrl, seen };
}

const report = (name, result, verdict, note = {}) => {
  console.log(`ROW-NOTE ${JSON.stringify({ name, attachMs: result.out.attachMs, ...note })}`);
  console.log(
    `ROW-OBSERVED ${JSON.stringify({
      name,
      verdict,
      finalUrl: result.finalUrl,
      frameUrl: result.out.frameUrl,
      answers: result.out.answers,
      writes: result.out.writes,
      protectedPauses: result.out.protectedPauses,
      failed: result.out.failed,
      reads: result.out.reads,
      leaks: result.out.leaks?.length,
      server: result.seen,
    })}`
  );
};

const location = (value) => ({ responseHeaders: [{ name: 'Location', value }] });
const fulfil = (code, headers) => ({
  method: 'Fetch.fulfillRequest',
  params: { responseCode: code, ...headers, body: '' },
});
const SHAPES = [
  [
    'fulfillRequest 302, absolute Location to seven',
    'Request',
    (key) => fulfil(302, location(at('seven', key))),
  ],
  [
    'fulfillRequest 301, protocol-relative Location to the vault',
    'Request',
    (key) => fulfil(301, location(relative('vault', key))),
  ],
  [
    'fulfillRequest 307, binary Location to seven',
    'Request',
    (key) => fulfil(307, { binaryResponseHeaders: binary(`Location: ${at('seven', key)}`) }),
  ],
  [
    'continueResponse 302, absolute Location to the vault',
    'Response',
    (key) => ({
      method: 'Fetch.continueResponse',
      params: { responseCode: 302, ...location(at('vault', key)) },
    }),
  ],
  [
    'fulfillRequest 303 at the response stage, protocol-relative Location to seven',
    'Response',
    (key) => fulfil(303, location(relative('seven', key))),
  ],
];

const CHOSEN = `C${hex()}`;
const chosen = (names) => ({
  headers: [
    ['Cookie', `probe=${CHOSEN}`],
    ['Authorization', `Bearer ${CHOSEN}`],
    ['Host', `seven.sliccy.ai:${port}`],
  ]
    .filter(([name]) => names.includes(name))
    .map(([name, value]) => ({ name, value })),
});
const OVERRIDES = [
  [
    'url to seven with Cookie and Authorization',
    'wide',
    (key) => ({ url: at('seven', key), ...chosen(['Cookie', 'Authorization']) }),
  ],
  [
    'url to an ordinary 307 into seven with Cookie, Authorization, POST and postData',
    'wide',
    (key) => ({
      url: `${ORDINARY}/bounce/${key}`,
      method: 'POST',
      postData: binary(CHOSEN),
      ...chosen(['Cookie', 'Authorization']),
    }),
    true,
  ],
  [
    'url to an ordinary 307 into seven with Cookie, Authorization, POST and postData, hop not matched',
    'narrow',
    (key) => ({
      url: `${ORDINARY}/bounce/${key}`,
      method: 'POST',
      postData: binary(CHOSEN),
      ...chosen(['Cookie', 'Authorization']),
    }),
    true,
  ],
  ['a Host header naming seven with Cookie', 'wide', () => ({ ...chosen(['Host', 'Cookie']) })],
  [
    'url to the vault with POST and postData',
    'wide',
    (key) => ({ url: at('vault', key), method: 'POST', postData: binary(CHOSEN) }),
  ],
];

const ROUTES = ['devtools', 'extension'];
const TABS = ['created', 'attached'];

test('request-stage redirects and hop headers into seven or the vault', {
  timeout: 40 * 60 * 1000,
}, async (t) => {
  const seven = await setup(t);
  for (const route of ROUTES) {
    for (const tab of TABS) {
      for (const [shape, stage, write] of SHAPES) {
        for (const pattern of ['wide', 'narrow']) {
          const name = `document redirect: ${shape}, ${pattern} pattern, ${tab} tab, ${route} route`;
          await t.test(name, async () => {
            const result = await probe(seven, {
              route,
              tab,
              build: (key) => ({
                how: 'navigate',
                target: `${ORDINARY}/doc/${key}`,
                stage,
                pattern: pattern === 'wide' ? '*' : `${ORDINARY}/doc/${key}`,
                write: write(key),
              }),
            });
            const committed = PROTECTED_URL.test(result.finalUrl);
            const leaked = (result.out.leaks?.length ?? 0) > 0;
            const shown = result.out.protectedPauses.length > 0;
            report(name, result, committed || leaked || shown ? 'RED' : 'GREEN');
            assert.equal(result.out.startUrl, START, 'the tab starts on the ordinary page');
            assert.deepEqual(result.out.protectedPauses, [], 'no protected pause is shown');
            assert.equal(
              committed,
              false,
              `the tab commits no protected document: ${result.finalUrl}`
            );
            assert.equal(leaked, false, 'the protected document does not reach the client');
          });
        }
      }
      const baseline = `baseline: the ordinary page's own script navigates into seven, ${tab} tab, ${route} route`;
      await t.test(baseline, async () => {
        const result = await probe(seven, {
          route,
          tab,
          build: (key) => ({
            how: 'navigate',
            target: `${ORDINARY}/go/${key}`,
            bounce: at('seven', key),
            leaves: true,
          }),
        });
        const committed = PROTECTED_URL.test(result.finalUrl);
        const leaked = (result.out.leaks?.length ?? 0) > 0;
        report(baseline, result, committed || leaked ? 'COMMITTED' : 'NOT-COMMITTED');
        assert.equal(leaked, false, 'the protected document does not reach the client');
      });
    }
    for (const how of ['navigate', 'fetch']) {
      for (const [shape, pattern, override, redirected] of OVERRIDES) {
        const followed = redirected === true && how === 'fetch';
        const name = followed
          ? `hop headers: a page fetch redirected into seven carries no chosen Cookie or Authorization, ${pattern} pattern, ${route} route`
          : `hop headers: continueRequest ${shape}, ${how === 'fetch' ? 'page fetch' : 'document'}, ${pattern} pattern, ${route} route`;
        await t.test(name, async () => {
          const result = await probe(seven, {
            route,
            tab: 'created',
            build: (key) => ({
              how,
              target: `${ORDINARY}/echo/${key}`,
              bounce: at('seven', key),
              stage: 'Request',
              pattern: pattern === 'wide' ? '*' : `${ORDINARY}/echo/${key}`,
              write: { method: 'Fetch.continueRequest', params: override(key) },
            }),
          });
          const carried = result.seen.filter(
            (hit) =>
              PROTECTED_HOST.test(hit.host) &&
              (followed
                ? [hit.cookie, hit.authorization]
                : [hit.cookie, hit.authorization, hit.body]
              ).some((value) => value.includes(CHOSEN))
          );
          if (followed) {
            const leaked = (result.out.leaks?.length ?? 0) > 0;
            const read = /^\d+$/.test(String(result.out.answers.fetched));
            const landed = result.seen
              .filter((hit) => hit.kind === 'landing' && PROTECTED_HOST.test(hit.host))
              .map((hit) => ({ method: hit.method, body: hit.body.length > 0 }));
            report(name, result, carried.length || leaked || read ? 'RED' : 'GREEN', { landed });
            assert.equal(result.out.startUrl, START, 'the tab starts on the ordinary page');
            assert.deepEqual(result.out.protectedPauses, [], 'no protected pause is shown');
            const bounced = result.seen.filter((hit) => hit.kind === 'bounce');
            assert.ok(
              bounced.some(
                (hit) =>
                  hit.method === 'POST' &&
                  hit.body.includes(CHOSEN) &&
                  hit.cookie.includes(CHOSEN) &&
                  hit.authorization.includes(CHOSEN)
              ),
              `the ordinary hop receives the chosen method, body, Cookie and Authorization: ${JSON.stringify(bounced)}`
            );
            assert.deepEqual(carried, [], 'no chosen Cookie or Authorization reaches seven');
            assert.equal(read, false, `the page reads no response: ${result.out.answers.fetched}`);
            assert.ok(
              result.out.failed.some((reason) => reason.includes('ERR_BLOCKED_BY_CLIENT')),
              `the response is failed: ${JSON.stringify(result.out.failed)}`
            );
            assert.equal(leaked, false, 'the protected response does not reach the client');
            return;
          }
          const leaked = (result.out.leaks?.length ?? 0) > 0;
          const shown = result.out.protectedPauses.length > 0;
          report(name, result, carried.length || leaked || shown ? 'RED' : 'GREEN');
          assert.equal(result.out.startUrl, START, 'the tab starts on the ordinary page');
          assert.deepEqual(result.out.protectedPauses, [], 'no protected pause is shown');
          assert.deepEqual(carried, [], 'no protected origin sees a client-chosen header or body');
          assert.equal(leaked, false, 'the protected response does not reach the client');
        });
      }
    }
  }
});
