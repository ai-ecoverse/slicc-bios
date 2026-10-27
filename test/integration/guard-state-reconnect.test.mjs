import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionConnection } from '../../src/seed/cdp.js';
import { BLANKED, INHERITED, PROTECTED } from '../../src/seed/guard.js';
import { errorFrame, flush, guardProtected, ordinary, plainFrame } from './guard-state-fixture.mjs';

function catalogProtocol(t) {
  const sessions = new Map();
  const observers = new Set();
  const calls = [];
  const events = [];
  const connections = new Set();
  const targetId = '37';
  let serial = 0;
  let frame = plainFrame('physical-catalog-root');
  let info = { targetId, type: 'page', url: ordinary, title: 'ordinary' };
  let wipeHeld = false;
  const emit = (message) => {
    events.push(message);
    for (const observer of observers) observer(message);
  };
  const commit = (url) => {
    frame = { ...plainFrame('physical-catalog-root'), url, securityOrigin: new URL(url).origin };
    info = { ...info, url, title: url === BLANKED ? 'blocked' : 'recovered' };
    for (const sessionId of sessions.keys())
      emit({ method: 'Page.frameNavigated', sessionId, params: { frame } });
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: info } });
  };
  const cdp = {
    on(observer) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.getTargets') return { targetInfos: [info] };
      if (method === 'Target.getTargetInfo') return { targetInfo: info };
      if (method === 'Target.attachToTarget') {
        const attached = `catalog-session-${++serial}`;
        sessions.set(attached, targetId);
        return { sessionId: attached };
      }
      if (method === 'Target.detachFromTarget') sessions.delete(params.sessionId);
      if (method === 'Page.getFrameTree') return { frameTree: { frame } };
      if (method === 'Page.navigate') {
        if (!(wipeHeld && params.url === BLANKED)) commit(params.url);
        return { frameId: frame.id };
      }
      if (method === 'Runtime.evaluate')
        return { result: { type: 'string', value: `${info.url} ${info.title}` } };
      if (method === 'Accessibility.getFullAXTree')
        return {
          nodes: [{ nodeId: '1', role: { value: 'heading' }, name: { value: info.title } }],
        };
      return {};
    },
  };
  function connect() {
    const connection = guardProtected(extensionConnection(cdp), 'https://protected.invalid');
    connections.add(connection);
    const pending = new Map();
    let next = 0;
    connection.onmessage = (text) => {
      const message = JSON.parse(text);
      pending.get(message.id)?.(message);
    };
    return {
      close() {
        connection.close();
        connections.delete(connection);
      },
      send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
          const id = ++next;
          const timer = setTimeout(
            () => reject(new Error(`${method} has no protocol answer`)),
            1000
          );
          pending.set(id, (message) => {
            clearTimeout(timer);
            pending.delete(id);
            resolve(message);
          });
          connection.send(JSON.stringify({ id, method, params, sessionId }));
        });
      },
    };
  }
  t.after(() => {
    for (const connection of connections) connection.close();
  });
  return {
    connect,
    calls,
    events,
    commit,
    targetId,
    block(held = false) {
      wipeHeld = held;
      frame = errorFrame('physical-catalog-root');
      info = { ...info, url: frame.url, title: '' };
      emit({ method: 'Target.targetInfoChanged', params: { targetInfo: info } });
    },
  };
}

test('state catalog reconnect after an internally blocked hop retains ordinary recovery', async (t) => {
  const wire = catalogProtocol(t);
  const original = wire.connect();
  assert.equal(
    (await original.send('Target.attachToTarget', { targetId: wire.targetId, flatten: true }))
      .error,
    undefined
  );
  original.close();
  await flush();
  wire.block();
  const hopped = wire.connect();
  const listed = (await hopped.send('Target.getTargets')).result.targetInfos[0];
  assert.deepEqual(
    { type: listed.type, url: listed.url, origin: new URL(listed.url).origin, title: listed.title },
    { type: 'page', url: 'chrome-error://chromewebdata/', origin: 'null', title: '' }
  );
  const attachment = await hopped.send('Target.attachToTarget', {
    targetId: wire.targetId,
    flatten: true,
  });
  if (attachment.error) assert.equal(attachment.error.message, PROTECTED);
  hopped.close();
  await flush();
  const recovered = wire.connect();
  const attached = await recovered.send('Target.attachToTarget', {
    targetId: wire.targetId,
    flatten: true,
  });
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  const sessionId = attached.result.sessionId;
  assert.equal(
    (await recovered.send('Page.navigate', { url: 'about:blank' }, sessionId)).error.message,
    INHERITED
  );
  assert.equal(
    (await recovered.send('Page.navigate', { url: ' about:blank' }, sessionId)).error.message,
    INHERITED
  );
  const destination = `${ordinary}?recovered`;
  assert.equal(
    (await recovered.send('Page.navigate', { url: destination }, sessionId)).error,
    undefined
  );
  const reading = await recovered.send(
    'Runtime.evaluate',
    { expression: 'location.href' },
    sessionId
  );
  assert.equal(reading.error, undefined);
  assert.equal(reading.result.result.value, `${destination} recovered`);
  const snapshot = await recovered.send('Accessibility.getFullAXTree', {}, sessionId);
  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.result.nodes[0].name.value, 'recovered');
  const current = (await recovered.send('Target.getTargets')).result.targetInfos[0];
  assert.deepEqual(current, {
    targetId: wire.targetId,
    type: 'page',
    url: destination,
    title: 'recovered',
  });
  if (
    wire.calls.some(({ method, params }) => method === 'Page.navigate' && params.url === BLANKED)
  ) {
    assert.ok(
      wire.events.some(
        ({ method, params }) =>
          method === 'Target.targetInfoChanged' && params.targetInfo.url === BLANKED
      )
    );
  }
});

test('state catalog error reads remain refused until the private wipe commits', async (t) => {
  const wire = catalogProtocol(t);
  wire.block(true);
  const connection = wire.connect();
  const attachment = await connection.send('Target.attachToTarget', {
    targetId: wire.targetId,
    flatten: true,
  });
  assert.equal(attachment.error.message, PROTECTED);
  const wipes = wire.calls.filter(
    ({ method, params }) => method === 'Page.navigate' && params.url === BLANKED
  );
  assert.equal(wipes.length, 1);
  const client = wire.calls.filter(({ method }) => method === 'Target.attachToTarget')[1];
  assert.ok(client);
  const read = await connection.send('Runtime.evaluate', {}, 'catalog-session-2');
  assert.equal(read.error.message, PROTECTED);
  assert.equal(
    wire.calls.some(({ method }) => method === 'Runtime.evaluate'),
    false
  );
  wire.commit(BLANKED);
  await flush();
  const listing = await connection.send('Target.getTargets');
  assert.equal(listing.result.targetInfos[0].url, BLANKED);
  assert.equal(listing.result.targetInfos[0].title, 'blocked');
});
