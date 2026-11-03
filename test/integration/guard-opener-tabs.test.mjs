import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';
import { devtools, launch } from './chrome.mjs';

assert.ok(process.env.CI, 'opener browser rows run in CI');

const cache = fileURLToPath(new URL('../../node_modules/.cache/', import.meta.url));
mkdirSync(cache, { recursive: true });
const certificates = mkdtempSync(join(cache, 'opener-'));
after(() => rmSync(certificates, { recursive: true, force: true }));
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
    '/CN=seven.sliccy.ai',
    '-keyout',
    join(certificates, 'key.pem'),
    '-out',
    join(certificates, 'cert.pem'),
  ],
  { stdio: 'ignore' }
);
const productionHeaders = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "frame-ancestors 'self'",
  'x-frame-options': 'SAMEORIGIN',
};
const server = createServer(
  {
    key: readFileSync(join(certificates, 'key.pem')),
    cert: readFileSync(join(certificates, 'cert.pem')),
  },
  (request, response) => {
    const url = new URL(request.url, `https://${request.headers.host}`);
    const headers =
      url.hostname === 'seven.sliccy.ai' && url.pathname.startsWith('/production/')
        ? productionHeaders
        : {};
    response.writeHead(200, {
      'content-type': 'text/html',
      'cache-control': 'no-store',
      ...headers,
    });
    response.end('<!doctype html><title>opener fixture</title><p>ordinary fixture</p>');
  }
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const origin = (host) => `https://${host}:${server.address().port}`;
const seven = origin('seven.sliccy.ai');
const ordinary = origin('ordinary.example.test');
const second = origin('second.example.test');
const chrome = await launch({
  tools: false,
  args: [
    '--ignore-certificate-errors',
    '--host-resolver-rules=MAP *.sliccy.ai 127.0.0.1, MAP *.example.test 127.0.0.1',
  ],
});
after(() => chrome.close());
const { browser } = await devtools(chrome);

async function client(t, guarded = false) {
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const wire = {
    send: (text) => socket.send(text),
    close: () => socket.close(),
  };
  socket.onmessage = ({ data }) => wire.onmessage?.(String(data));
  const connection = guarded ? guardProtected(wire, seven) : wire;
  t.after(() => connection.close());
  const pending = new Map();
  const events = [];
  const listeners = new Set();
  let next = 0;
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      return;
    }
    events.push(message);
    for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} did not answer within 20000 ms`));
      }, 20000);
      pending.set(id, (answer) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(answer);
      });
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const waitEvent = (predicate, since = events.length) =>
    new Promise((resolve, reject) => {
      const found = events.slice(since).find(predicate);
      if (found) return resolve(found);
      const listener = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message);
      };
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(
          new Error(
            `target event did not arrive within 20000 ms: ${JSON.stringify(events.slice(since))}`
          )
        );
      }, 20000);
      listeners.add(listener);
    });
  return { send, events, waitEvent };
}

function result(answer) {
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  assert.ok(answer.result);
  return answer.result;
}

async function settled(raw, targetId, url) {
  const { sessionId } = result(
    await raw.send('Target.attachToTarget', { targetId, flatten: true })
  );
  const mark = raw.events.length;
  result(await raw.send('Page.enable', {}, sessionId));
  const { frameTree } = result(await raw.send('Page.getFrameTree', {}, sessionId));
  if (frameTree.frame.url !== url)
    await raw.waitEvent(
      (message) =>
        message.method === 'Page.frameNavigated' &&
        message.sessionId === sessionId &&
        !message.params.frame.parentId &&
        message.params.frame.url === url,
      mark
    );
  const loaded = result(
    await raw.send(
      'Runtime.evaluate',
      {
        expression: `new Promise(resolve => { const done = () => resolve(location.href); if (document.readyState === 'complete') done(); else addEventListener('load', done, {once:true}); })`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId
    )
  );
  assert.equal(loaded.exceptionDetails, undefined);
  assert.equal(loaded.result.value, url);
  return sessionId;
}

async function observe(t, raw, guard, targetId, stage) {
  const targetInfo = result(await raw.send('Target.getTargetInfo', { targetId })).targetInfo;
  const answer = await guard.send('Target.attachToTarget', { targetId, flatten: true });
  let document = null;
  if (answer.result?.sessionId)
    document = result(
      await guard.send(
        'Runtime.evaluate',
        {
          expression: '({href:location.href, hasOpener:window.opener !== null})',
          returnByValue: true,
        },
        answer.result.sessionId
      )
    ).result.value;
  t.diagnostic(JSON.stringify({ stage, targetInfo, answer, document }));
  if (answer.error) assert.equal(answer.error.message, PROTECTED);
  return answer;
}

async function popup(raw, sessionId, url, noopener = false) {
  const mark = raw.events.length;
  const opened = result(
    await raw.send(
      'Runtime.evaluate',
      {
        expression: `window.open(${JSON.stringify(url)}, '_blank', ${JSON.stringify(noopener ? 'noopener' : '')}); void 0`,
        userGesture: true,
      },
      sessionId
    )
  );
  assert.equal(opened.exceptionDetails, undefined);
  const created = await raw.waitEvent(
    (message) =>
      ['Target.targetCreated', 'Target.targetInfoChanged'].includes(message.method) &&
      message.params.targetInfo.url === url,
    mark
  );
  const targetId = created.params.targetInfo.targetId;
  return { targetId, sessionId: await settled(raw, targetId, url) };
}

async function fixture(t, mode, variant) {
  const ids = [];
  let raw;
  t.after(async () => {
    if (raw) for (const targetId of ids) await raw.send('Target.closeTarget', { targetId });
  });
  raw = await client(t);
  result(await raw.send('Target.setDiscoverTargets', { discover: true }));
  const guard = await client(t, true);
  const openerUrl = `${seven}/${mode}/${encodeURIComponent(variant)}`;
  const { targetId: openerId } = result(await raw.send('Target.createTarget', { url: openerUrl }));
  ids.push(openerId);
  const openerSession = await settled(raw, openerId, openerUrl);
  const state = result(
    await raw.send(
      'Runtime.evaluate',
      {
        expression: `fetch(location.href).then(response => ({isolated:crossOriginIsolated,coop:response.headers.get('cross-origin-opener-policy'),coep:response.headers.get('cross-origin-embedder-policy')}))`,
        awaitPromise: true,
        returnByValue: true,
      },
      openerSession
    )
  ).result.value;
  assert.deepEqual(
    state,
    mode === 'production'
      ? { isolated: true, coop: 'same-origin', coep: 'require-corp' }
      : { isolated: false, coop: null, coep: null }
  );
  t.diagnostic(JSON.stringify({ mode, variant, headers: state }));
  const answer = await observe(t, raw, guard, openerId, `${mode}/${variant}: opener`);
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(answer.result, undefined);
  return { raw, guard, ids, openerId, openerSession };
}

for (const mode of ['production', 'no-coop']) {
  for (const variant of ['ordinary destination', 'noopener', 'closed opener', 'second origin']) {
    test(`opener tab ${mode}: ${variant}`, { timeout: 90000 }, async (t) => {
      const { raw, guard, ids, openerId, openerSession } = await fixture(t, mode, variant);
      const url = `${ordinary}/${mode}/${encodeURIComponent(variant)}`;
      const { targetId, sessionId } = await popup(raw, openerSession, url, variant === 'noopener');
      ids.push(targetId);
      const firstInfo = result(await raw.send('Target.getTargetInfo', { targetId })).targetInfo;
      const accessible = mode === 'no-coop' && variant !== 'noopener';
      t.diagnostic(JSON.stringify({ mode, variant, targetInfo: firstInfo }));
      assert.equal(
        firstInfo.browserContextId,
        result(await raw.send('Target.getTargetInfo', { targetId: openerId })).targetInfo
          .browserContextId
      );
      assert.equal(firstInfo.canAccessOpener, accessible);
      if (accessible) assert.equal(firstInfo.openerId, openerId);
      assert.equal(
        result(
          await raw.send(
            'Runtime.evaluate',
            { expression: 'window.opener !== null', returnByValue: true },
            sessionId
          )
        ).result.value,
        accessible
      );
      let answer = await observe(t, raw, guard, targetId, `${mode}/${variant}: opened`);
      assert.equal(answer.error, undefined, JSON.stringify(answer));
      if (variant === 'closed opener') {
        const mark = raw.events.length;
        assert.equal(
          result(await raw.send('Target.closeTarget', { targetId: openerId })).success,
          true
        );
        await raw.waitEvent(
          (message) =>
            message.method === 'Target.targetDestroyed' && message.params.targetId === openerId,
          mark
        );
        answer = await observe(t, raw, guard, targetId, `${mode}/${variant}: after close`);
      }
      if (variant === 'second origin') {
        const destination = `${second}/next`;
        result(await raw.send('Page.navigate', { url: destination }, sessionId));
        await settled(raw, targetId, destination);
        answer = await observe(t, raw, guard, targetId, `${mode}/${variant}: after navigation`);
      }
      assert.equal(answer.error, undefined, JSON.stringify(answer));
      assert.ok(answer.result.sessionId);
    });
  }
  for (const same of [false, true]) {
    test(`opener tab ${mode}: child of a held page, same origin ${same}`, {
      timeout: 90000,
    }, async (t) => {
      const { raw, guard, ids, openerSession } = await fixture(t, mode, `held-${same}`);
      const parent = await popup(raw, openerSession, `about:blank#${mode}-${same}`);
      ids.push(parent.targetId);
      assert.equal(
        (await observe(t, raw, guard, parent.targetId, `${mode}/held-${same}: inherited parent`))
          .error?.message,
        PROTECTED
      );
      const parentUrl = `${ordinary}/${mode}/held-parent-${same}`;
      result(await raw.send('Page.navigate', { url: parentUrl }, parent.sessionId));
      await settled(raw, parent.targetId, parentUrl);
      assert.equal(
        (
          await observe(
            t,
            raw,
            guard,
            parent.targetId,
            `${mode}/held-${same}: parent after navigation`
          )
        ).error?.message,
        PROTECTED
      );
      const childUrl = `${same ? ordinary : second}/${mode}/held-child-${same}`;
      const child = await popup(raw, parent.sessionId, childUrl);
      ids.push(child.targetId);
      const answer = await observe(t, raw, guard, child.targetId, `${mode}/held-${same}: child`);
      if (same) assert.equal(answer.error?.message, PROTECTED);
      else {
        assert.equal(answer.error, undefined, JSON.stringify(answer));
        assert.ok(answer.result.sessionId);
      }
    });
  }
  test(`opener tab ${mode}: same-origin child`, { timeout: 90000 }, async (t) => {
    const { raw, guard, ids, openerSession } = await fixture(t, mode, 'same-origin');
    const child = await popup(raw, openerSession, `${seven}/${mode}/same-origin-child`);
    ids.push(child.targetId);
    assert.equal(
      (await observe(t, raw, guard, child.targetId, `${mode}/same-origin: child`)).error?.message,
      PROTECTED
    );
  });
}
