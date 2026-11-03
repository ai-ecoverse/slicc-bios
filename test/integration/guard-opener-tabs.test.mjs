import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';
import { devtools, launch } from './chrome.mjs';

assert.ok(process.env.CI, 'opener browser rows run in CI');

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  response.end('<!doctype html><title>opener fixture</title><p>ordinary fixture</p>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const origin = (host) => `http://${host}:${server.address().port}`;
const seven = origin('seven.sliccy.ai');
const ordinary = origin('ordinary.example.test');
const second = origin('second.example.test');
const chrome = await launch({
  tools: false,
  args: ['--host-resolver-rules=MAP *.sliccy.ai 127.0.0.1, MAP *.example.test 127.0.0.1'],
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

for (const variant of ['ordinary destination', 'noopener', 'closed opener', 'second origin']) {
  test(`opener tab: ${variant}`, { timeout: 90000 }, async (t) => {
    const ids = [];
    let raw;
    t.after(async () => {
      if (raw) for (const targetId of ids) await raw.send('Target.closeTarget', { targetId });
    });
    raw = await client(t);
    result(await raw.send('Target.setDiscoverTargets', { discover: true }));
    const guard = await client(t, true);
    const openerUrl = `${seven}/${encodeURIComponent(variant)}`;
    const { targetId: openerId } = result(
      await raw.send('Target.createTarget', { url: openerUrl })
    );
    ids.push(openerId);
    const openerSession = await settled(raw, openerId, openerUrl);
    const protectedAnswer = await observe(t, raw, guard, openerId, `${variant}: opener`);
    assert.equal(protectedAnswer.error?.message, PROTECTED);
    assert.equal(protectedAnswer.result, undefined);
    const url = `${ordinary}/${encodeURIComponent(variant)}`;
    const mark = raw.events.length;
    const opened = result(
      await raw.send(
        'Runtime.evaluate',
        {
          expression: `window.open(${JSON.stringify(url)}, '_blank', ${JSON.stringify(variant === 'noopener' ? 'noopener' : '')}); void 0`,
          userGesture: true,
        },
        openerSession
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
    ids.push(targetId);
    const sessionId = await settled(raw, targetId, url);
    const firstInfo = result(await raw.send('Target.getTargetInfo', { targetId })).targetInfo;
    assert.equal(
      firstInfo.browserContextId,
      result(await raw.send('Target.getTargetInfo', { targetId: openerId })).targetInfo
        .browserContextId
    );
    if (variant !== 'noopener') {
      assert.equal(firstInfo.openerId, openerId);
      assert.equal(firstInfo.canAccessOpener, true);
    } else assert.equal(firstInfo.canAccessOpener, false);
    let answer = await observe(t, raw, guard, targetId, `${variant}: opened`);
    if (variant === 'closed opener') {
      const before = raw.events.length;
      assert.equal(
        result(await raw.send('Target.closeTarget', { targetId: openerId })).success,
        true
      );
      await raw.waitEvent(
        (message) =>
          message.method === 'Target.targetDestroyed' && message.params.targetId === openerId,
        before
      );
      answer = await observe(t, raw, guard, targetId, `${variant}: after close`);
    }
    if (variant === 'second origin') {
      const destination = `${second}/next`;
      const before = raw.events.length;
      result(await raw.send('Page.navigate', { url: destination }, sessionId));
      await raw.waitEvent(
        (message) =>
          message.method === 'Target.targetInfoChanged' &&
          message.params.targetInfo.targetId === targetId &&
          message.params.targetInfo.url === destination,
        before
      );
      await settled(raw, targetId, destination);
      answer = await observe(t, raw, guard, targetId, `${variant}: after navigation`);
    }
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    assert.ok(answer.result?.sessionId);
  });
}
