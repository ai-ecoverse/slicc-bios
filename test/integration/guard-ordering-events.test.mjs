import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-ordering-fixture.mjs';

const content = (wire, session) =>
  wire.request('Runtime.evaluate', { expression: 'document.title' }, session);
const consoleParams = (marker) => ({
  type: 'log',
  args: [
    { type: 'string', value: marker },
    { type: 'string', value: failed },
  ],
});
const domParams = (marker) => ({
  parentNodeId: 1,
  previousNodeId: 0,
  node: { nodeId: 2, nodeName: 'DIV', nodeValue: marker, attributes: ['data-failed', failed] },
});
const contains = (wire, method, marker) =>
  wire.delivered.some(
    (message) => message.method === method && JSON.stringify(message.params).includes(marker)
  );

async function block(wire, session, id, marker) {
  wire.target(id);
  wire.hold(
    (message) => message.method === 'Target.getTargetInfo' && message.params.targetId === id
  );
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      requestId: id,
      frameId: id,
      type: 'Other',
      request: { url: ordinary, postData: marker },
    },
  });
  await flush();
  const lookup = wire.held.find((message) => message.params?.targetId === id);
  assert.ok(lookup, 'the protocol is waiting for independent frame information');
  return lookup;
}

async function confirmedWhileBlocked(wire, session) {
  const read = content(wire, session);
  await flush();
  assert.ok(
    wire.clients().some((message) => message.id === read.id),
    'ordinary content was independently confirmed'
  );
  return read;
}

test('ordering frame policy', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  wire.target('policy');
  const session = await wire.attach('policy');
  await wire.send('Page.enable', {}, session);
  await content(wire, session).answer;
  wire.hold(
    (message) => message.sessionId === 'guard-policy' && message.method === 'Page.getFrameTree'
  );
  wire.emit({
    method: 'Page.frameAttached',
    sessionId: session,
    params: { frameId: 'policy-child', parentFrameId: 'policy' },
  });
  const reading = content(wire, session);
  await flush();
  const independent = wire.held.find((message) => message.method === 'Page.getFrameTree');
  assert.ok(independent);
  const frame = {
    id: 'policy-child',
    parentId: 'policy',
    url: `${protectedOrigin}/synthetic-page`,
    securityOrigin: protectedOrigin,
  };
  wire.emit({ method: 'Page.frameNavigated', sessionId: session, params: { frame } });
  await flush();
  const cut = wire.sent.some(
    (message) =>
      message.method === 'Target.detachFromTarget' && message.params.sessionId === session
  );
  const hidden = wire.request('Page.getFrameTree', {}, session);
  wire.release(independent);
  const [hiddenAnswer, refused] = await Promise.all([hidden.answer, reading.answer]);
  assert.equal(cut, true, 'the protected commit cuts the client without waiting for its tree');
  assert.match(hiddenAnswer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(hiddenAnswer.result, undefined);
  assert.match(refused.error?.message ?? '', /^slicc: refused:/);
  assert.equal(contains(wire, 'Page.frameNavigated', 'synthetic-page'), false);
});

for (const method of ['Runtime.consoleAPICalled', 'DOM.childNodeInserted']) {
  for (const admission of ['checked', 'unchecked']) {
    test(`ordering queued event ${method} ${admission}`, { timeout: 5000 }, async (t) => {
      const wire = protocol(t);
      const entry = wire.target('events');
      const session = await wire.attach('events');
      await wire.send('Runtime.enable', {}, session);
      if (admission === 'checked') await content(wire, session).answer;
      const lookup = await block(wire, session, 'blocked-frame', 'synthetic-blocker');
      const marker = `synthetic-queued-${admission}`;
      const params = method.startsWith('Runtime.') ? consoleParams(marker) : domParams(marker);
      wire.emit({ method, sessionId: session, params });
      if (admission === 'checked') {
        entry.tree = { frame: errorFrame('events') };
        wire.emit({
          method: 'Page.frameNavigated',
          sessionId: session,
          params: { frame: entry.tree.frame, type: 'BackForwardCacheRestore' },
        });
        entry.tree = { frame: plainFrame('events') };
        wire.emit({
          method: 'Page.frameNavigated',
          sessionId: 'guard-events',
          params: { frame: entry.tree.frame },
        });
      }
      const read = await confirmedWhileBlocked(wire, session);
      wire.release(lookup);
      assert.equal((await read.answer).error, undefined);
      await flush();
      const benign = `synthetic-current-${admission}`;
      wire.emit({
        method,
        sessionId: session,
        params: method.startsWith('Runtime.') ? consoleParams(benign) : domParams(benign),
      });
      await flush();
      assert.equal(contains(wire, method, marker), false, 'queued content is never published');
      assert.equal(
        contains(wire, method, benign),
        true,
        'current ordinary content still publishes'
      );
      assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
    });
  }
}

test('ordering in-flight event publication', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  wire.target('events');
  const session = await wire.attach('events');
  await content(wire, session).answer;
  const marker = 'synthetic-in-flight-event';
  const lookup = await block(wire, session, 'slow-frame', marker);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-events',
    params: { frame: plainFrame('events') },
  });
  const read = await confirmedWhileBlocked(wire, session);
  wire.release(lookup);
  assert.equal((await read.answer).error, undefined);
  await flush();
  const benign = 'synthetic-current-request';
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      requestId: 'current',
      frameId: 'events',
      request: { url: ordinary, postData: benign },
    },
  });
  await flush();
  assert.equal(
    contains(wire, 'Network.requestWillBeSent', marker),
    false,
    'the final publication checks its original generation'
  );
  assert.equal(contains(wire, 'Network.requestWillBeSent', benign), true);
});
