import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const frame = (id, loaderId = 'synthetic-current') => ({ ...plainFrame(id), loaderId });
const commit = (wire, sessionId, value) =>
  wire.emit({ method: 'Page.frameNavigated', sessionId, params: { frame: value } });
const read = (wire, session) =>
  wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
const privateTrees = (wire, mark) =>
  wire.sent
    .slice(mark)
    .filter((message) => message.id >= 2 ** 30 && message.method === 'Page.getFrameTree');
const refuse = (answer) => {
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
};

for (const evidence of [
  'protected',
  'opaque',
  'unplaced',
  'missing-frame',
  'metadata',
  'request',
  'context',
]) {
  test(`ordering transition ordinary to strict ${evidence}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('transition');
    const session = await wire.attach('transition');
    assert.equal((await read(wire, session)).error, undefined);
    wire.hold(
      (message) =>
        (message.id < 2 ** 30 && message.method === 'Page.captureScreenshot') ||
        (message.sessionId === 'guard-transition' && message.method === 'Page.getFrameTree')
    );
    const snapshot = wire.request('Page.captureScreenshot', {}, session);
    await flush();
    const pending = wire.held.find((message) => message.id === snapshot.id);
    assert.ok(pending);
    if (evidence === 'metadata') {
      wire.emit({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: { ...entry.info, url: 'chrome-error://chromewebdata/' } },
      });
    } else if (evidence === 'request') {
      wire.emit({
        method: 'Fetch.requestPaused',
        sessionId: 'guard-transition',
        params: {
          requestId: 'synthetic-transition',
          resourceType: 'Document',
          frameId: 'transition',
          request: { url: 'https://protected.invalid/synthetic' },
        },
      });
    } else if (evidence === 'context') {
      wire.emit({
        method: 'Runtime.executionContextCreated',
        sessionId: session,
        params: {
          context: {
            id: 99,
            origin: new URL(ordinary).origin,
            name: '',
            auxData: { frameId: 'synthetic-unplaced', isDefault: true },
          },
        },
      });
    } else if (evidence === 'missing-frame') {
      wire.emit({ method: 'Page.frameNavigated', sessionId: session, params: {} });
    } else {
      commit(
        wire,
        session,
        evidence === 'protected'
          ? errorFrame('transition')
          : evidence === 'opaque'
            ? { id: 'transition', url: 'chrome-error://chromewebdata/', securityOrigin: '://' }
            : { ...plainFrame('synthetic-unplaced'), parentId: 'synthetic-missing-parent' }
      );
    }
    const mark = wire.sent.length;
    const command = read(wire, session);
    wire.release(pending);
    await flush();
    assert.deepEqual(
      wire.clients(mark),
      [],
      'no content is forwarded before independent classification'
    );
    refuse(await snapshot.answer);
    wire.hold(() => false);
    for (const query of [...wire.held])
      wire.release(query, { error: { code: -32000, message: 'synthetic unknown document' } });
    refuse(await command);
  });
}

for (const recovery of [
  'tree-only',
  'client-commit',
  'old-guard-commit',
  'mismatched-loader',
  'fresh-guard-commit',
]) {
  test(`ordering transition strict recovery ${recovery}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('recover', 'page', frame('recover'));
    const session = await wire.attach('recover');
    await read(wire, session);
    if (recovery === 'old-guard-commit') commit(wire, 'guard-recover', frame('recover'));
    commit(wire, session, errorFrame('recover'));
    entry.tree = { frame: frame('recover') };
    if (recovery === 'client-commit') commit(wire, session, frame('recover'));
    if (recovery === 'mismatched-loader')
      commit(wire, 'guard-recover', frame('recover', 'synthetic-other'));
    if (recovery === 'fresh-guard-commit') commit(wire, 'guard-recover', frame('recover'));
    assert.equal(
      (await read(wire, session)).error,
      undefined,
      'a positive strict tree permits harmless content'
    );
    const mark = wire.sent.length;
    assert.equal((await read(wire, session)).error, undefined);
    assert.equal(
      privateTrees(wire, mark).length > 0,
      recovery !== 'fresh-guard-commit',
      'only a matching fresh guard commit restores ordinary admission'
    );
  });
}

test('ordering transition new target waits for its own positive guard tree', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.target('new');
  wire.hold(
    (message) => message.sessionId === 'guard-new' && message.method === 'Page.getFrameTree'
  );
  const session = wire.attached('new');
  const mark = wire.sent.length;
  const command = read(wire, session);
  await flush();
  assert.deepEqual(wire.clients(mark), []);
  assert.equal(
    wire.delivered.some((message) => message.method === 'Target.attachedToTarget'),
    false
  );
  refuse(await command);
  wire.hold(() => false);
  for (const query of [...wire.held]) wire.release(query);
  await flush();
  await flush();
  assert.equal((await read(wire, session)).error, undefined);
  assert.ok(wire.delivered.some((message) => message.method === 'Target.attachedToTarget'));
});

test('ordering transition related child closes parent content and pending snapshot', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const parent = wire.target('scope');
  const session = await wire.attach('scope');
  await read(wire, session);
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.captureScreenshot');
  const snapshot = wire.request('Page.captureScreenshot', {}, session);
  await flush();
  const pending = wire.held.find((message) => message.id === snapshot.id);
  const unsafe = errorFrame('scope-child', 'scope');
  wire.target('scope-child', 'iframe', unsafe, 'scope');
  parent.tree.childFrames = [{ frame: unsafe }];
  wire.attached('scope-child', session);
  const mark = wire.sent.length;
  const command = read(wire, session);
  wire.release(pending);
  refuse(await command);
  refuse(await snapshot.answer);
  assert.deepEqual(wire.clients(mark), []);
});

test('ordering transition ordinary navigation retains current contexts and console', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('ordinary');
  const session = await wire.attach('ordinary');
  await wire.send('Runtime.enable', {}, session);
  await wire.send('Page.enable', {}, session);
  await read(wire, session);
  entry.tree = { frame: { ...frame('ordinary'), url: `${ordinary}/next` } };
  commit(wire, 'guard-ordinary', entry.tree.frame);
  commit(wire, session, entry.tree.frame);
  wire.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id: 41,
        uniqueId: 'synthetic-next',
        origin: new URL(ordinary).origin,
        name: '',
        auxData: { frameId: 'ordinary', type: 'default', isDefault: true },
      },
    },
  });
  wire.emit({
    method: 'Runtime.consoleAPICalled',
    sessionId: session,
    params: {
      type: 'log',
      executionContextId: 41,
      args: [{ type: 'string', value: 'synthetic-next-console' }],
    },
  });
  await flush();
  assert.equal((await read(wire, session)).error, undefined);
  await flush();
  assert.ok(wire.delivered.some((message) => message.method === 'Page.frameNavigated'));
  assert.ok(wire.delivered.some((message) => message.method === 'Runtime.executionContextCreated'));
  assert.ok(wire.delivered.some((message) => message.method === 'Runtime.consoleAPICalled'));
  const mark = wire.sent.length;
  assert.equal((await read(wire, session)).error, undefined);
  assert.deepEqual(privateTrees(wire, mark), []);
});
