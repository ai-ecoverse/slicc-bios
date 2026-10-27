import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionConnection } from '../../src/seed/cdp.js';
import { BLANKED, guardProtected, PROTECTED } from '../../src/seed/guard.js';
import { flush, ordinary, plainFrame, protectedOrigin, protocol } from './guard-state-fixture.mjs';

for (const method of ['Input.dispatchKeyEvent', 'Runtime.evaluate']) {
  test(`restored boundary a different frame cannot settle the pending main restore ${method}`, async (t) => {
    const wire = protocol(t);
    wire.target('restore-owner');
    const session = await wire.attach('restore-owner');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: plainFrame('restore-owner') },
    });
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: session,
      params: {
        frameId: 'restore-owner',
        url: `${protectedOrigin}/private`,
        navigationType: 'backForward',
      },
    });
    wire.emit({
      method: 'Page.navigatedWithinDocument',
      sessionId: session,
      params: { frameId: 'other-frame', url: ordinary },
    });
    await flush();
    const mark = wire.sent.length;
    const params = method.startsWith('Input.')
      ? { type: 'keyDown', key: 'a' }
      : { expression: 'document.title' };
    assert.equal((await wire.send(method, params, session)).error?.message, PROTECTED);
    assert.equal(wire.clients(mark).length, 0);
    wire.emit({
      method: 'Page.navigatedWithinDocument',
      sessionId: session,
      params: { frameId: 'restore-owner', url: ordinary },
    });
    await flush();
    assert.equal((await wire.send(method, params, session)).error, undefined);
  });
}

for (const kind of ['origin', 'target', 'both']) {
  test(`restored boundary a protected ${kind} is not a blank screenshot`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('blank-origin');
    const session = await wire.attach('blank-origin');
    entry.info.url = kind === 'origin' ? 'about:blank' : `${protectedOrigin}/private`;
    entry.tree.frame = {
      id: 'blank-origin',
      url: 'about:blank',
      securityOrigin: kind === 'target' ? 'null' : protectedOrigin,
    };
    entry.history = { currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] };
    const mark = wire.sent.length;
    assert.equal(
      (await wire.send('Page.captureScreenshot', {}, session)).error?.message,
      PROTECTED
    );
    assert.equal(wire.clients(mark).length, 0);
  });
}

test('restored boundary a blanked document with only a typed hint keeps its blank screenshot', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('blank-typed');
  const session = await wire.attach('blank-typed');
  entry.info.url = BLANKED;
  entry.tree.frame = { id: 'blank-typed', url: BLANKED, securityOrigin: 'null' };
  entry.history = {
    currentIndex: 0,
    entries: [{ id: 1, url: BLANKED, userTypedURL: `${protectedOrigin}/private` }],
  };
  const answer = await wire.send('Page.captureScreenshot', {}, session);
  assert.equal(answer.error, undefined);
  assert.equal(answer.result.data, 'c3ludGhldGlj');
});

test('restored boundary a protected default world arriving during a probe receives no command', async (t) => {
  const wire = protocol(t);
  wire.target('world-race');
  const session = await wire.attach('world-race');
  await wire.send('Runtime.enable', {}, session);
  wire.hold((message) => message.method === 'Page.getFrameTree');
  const mark = wire.sent.length;
  const pending = wire.request('Runtime.evaluate', { expression: 'document.title' }, session);
  await flush();
  wire.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id: 17,
        uniqueId: 'protected-default',
        name: '',
        origin: protectedOrigin,
        auxData: { isDefault: true, frameId: 'world-race' },
      },
    },
  });
  await flush();
  wire.release(wire.held[0]);
  assert.equal((await pending.answer).error?.message, PROTECTED);
  assert.equal(
    wire.clients(mark).some((message) => message.method === 'Runtime.evaluate'),
    false
  );
});

test('restored boundary equal screenshot ids in two sessions cannot share blank admission', async (t) => {
  const wire = protocol(t);
  const blank = wire.target('shot-blank');
  const other = wire.target('shot-other');
  const first = await wire.attach('shot-blank');
  const second = await wire.attach('shot-other');
  blank.info.url = 'about:blank';
  blank.tree.frame = { id: 'shot-blank', url: 'about:blank', securityOrigin: 'null' };
  blank.history = { currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] };
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.captureScreenshot');
  const one = wire.request('Page.captureScreenshot', {}, first, 77);
  await flush();
  const two = wire.request('Page.captureScreenshot', {}, second, 77);
  await flush();
  other.info.url = BLANKED;
  other.tree.frame = { id: 'shot-other', url: BLANKED, securityOrigin: 'null' };
  other.history = {
    currentIndex: 0,
    entries: [{ id: 1, url: BLANKED, userTypedURL: `${protectedOrigin}/private` }],
  };
  wire.release(wire.held.find((message) => message.sessionId === second));
  assert.equal((await two.answer).error?.message, PROTECTED);
  wire.release(wire.held.find((message) => message.sessionId === first));
  assert.equal((await one.answer).error, undefined);
});

test('restored boundary equal history and read ids in two sessions remain independent', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('moving-tab');
  wire.target('reading-tab');
  entry.history = {
    currentIndex: 0,
    entries: [
      { id: 1, url: ordinary },
      { id: 2, url: `${ordinary}?next` },
    ],
  };
  const moving = await wire.attach('moving-tab');
  const reading = await wire.attach('reading-tab');
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.navigateToHistoryEntry');
  const pending = wire.request('Page.navigateToHistoryEntry', { entryId: 2 }, moving, 78);
  await flush();
  const answer = await wire.request('Runtime.evaluate', { expression: '1' }, reading, 78).answer;
  assert.equal(answer.error, undefined);
  entry.info.url = `${ordinary}?next`;
  entry.tree.frame.url = entry.info.url;
  entry.history.currentIndex = 1;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: moving,
    params: { frame: entry.tree.frame },
  });
  wire.release(wire.held.find((message) => message.sessionId === moving));
  assert.equal((await pending.answer).error, undefined);
});

test('restored boundary an ordinary same-document history commit releases input on its own root', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('same-document-history');
  entry.history = {
    currentIndex: 0,
    entries: [
      { id: 1, url: ordinary },
      { id: 2, url: `${ordinary}#next` },
    ],
  };
  const session = await wire.attach('same-document-history');
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.navigateToHistoryEntry');
  const pending = wire.request('Page.navigateToHistoryEntry', { entryId: 2 }, session);
  await flush();
  entry.info.url = `${ordinary}#next`;
  entry.tree.frame.urlFragment = '#next';
  entry.history.currentIndex = 1;
  wire.emit({
    method: 'Page.navigatedWithinDocument',
    sessionId: session,
    params: { frameId: 'same-document-history', url: entry.info.url },
  });
  wire.release(wire.held[0]);
  assert.equal((await pending.answer).error, undefined);
  assert.equal(
    (await wire.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, session)).error,
    undefined
  );
});

test('restored boundary an extension connection cannot borrow or detach another connection session', async (t) => {
  const observers = new Set();
  const calls = [];
  let serial = 0;
  const info = { targetId: 'shared-tab', type: 'page', url: ordinary };
  const cdp = {
    on(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.getTargetInfo') return { targetInfo: info };
      if (method === 'Target.attachToTarget') return { sessionId: `shared-session-${++serial}` };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: plainFrame('shared-tab') } };
      if (method === 'Page.getNavigationHistory')
        return { currentIndex: 0, entries: [{ id: 1, url: ordinary }] };
      if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 1 } };
      return {};
    },
  };
  function client() {
    const connection = guardProtected(extensionConnection(cdp), protectedOrigin);
    const pending = new Map();
    let next = 0;
    connection.onmessage = (text) => {
      const answer = JSON.parse(text);
      if (answer.id === undefined) return;
      pending.get(answer.id)?.(answer);
      pending.delete(answer.id);
    };
    t.after(() => connection.close());
    return (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => reject(new Error(`${method} was not answered`)), 1500);
        pending.set(id, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        connection.send(JSON.stringify({ id, method, params, sessionId }));
      });
  }
  const first = client();
  const second = client();
  const owned = (await first('Target.attachToTarget', { targetId: info.targetId, flatten: true }))
    .result.sessionId;
  for (const observer of observers)
    observer({
      method: 'Target.attachedToTarget',
      params: { sessionId: owned, targetInfo: info, waitingForDebugger: false },
    });
  await flush();
  const mark = calls.length;
  assert.equal(
    (await second('Target.detachFromTarget', { sessionId: owned })).error?.message,
    PROTECTED
  );
  assert.equal(
    calls.slice(mark).some((message) => message.method === 'Target.detachFromTarget'),
    false
  );
  assert.equal(
    (await second('Runtime.evaluate', { expression: '1' }, owned)).error?.message,
    PROTECTED
  );
  assert.equal((await first('Runtime.evaluate', { expression: '1' }, owned)).error, undefined);
});
