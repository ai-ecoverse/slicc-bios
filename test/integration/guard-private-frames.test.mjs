import assert from 'node:assert/strict';
import test from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const route = { kind: 'extension', version: '7.11.99' };
const dom = (ids) => ({
  nodeId: 1,
  nodeName: '#document',
  children: ids.map((frameId, index) => ({
    nodeName: 'IFRAME',
    frameId,
    backendNodeId: index + 2,
    attributes: ['src', 'https://ordinary-cross.test/'],
  })),
});
const snapshot = (ids, kind = 'ordinary', revision = 0) => ({
  version: 2,
  rootFrameId: 'root',
  rootLoaderId: 'root-loader',
  revision,
  localFrames: ['root'],
  remoteOwners: ids.map((frameId, index) => ({ frameId, backendNodeId: index + 2 })),
  frames: [
    { frameId: 0, parentFrameId: -1, kind: 'ordinary' },
    ...ids.map((_, index) => ({
      frameId: index + 1,
      parentFrameId: 0,
      kind: typeof kind === 'string' ? kind : kind[index],
    })),
  ],
});

function fixture(t, reader, ids = ['remote']) {
  const p = protocol(t, (raw, own) => guardProtected(raw, own, new Map(), route, reader));
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'root-loader' });
  root.dom = dom(ids);
  return { p, root };
}

test('bios privately places an ordinary cross-origin closure without a URL join or publishing the list', async (t) => {
  let reads = 0;
  const list = snapshot(['remote']);
  const { p } = fixture(t, async (tabId) => {
    assert.equal(tabId, 'root');
    reads++;
    return structuredClone(list);
  });
  const session = await p.attach('root');
  const answer = await p.send('Debugger.enable', {}, session);
  assert.equal(
    answer.error,
    undefined,
    'ordinary remote owner must be placed by the private native snapshot'
  );
  assert.ok(reads > 0, 'private reader must actually run');
  assert.doesNotMatch(JSON.stringify(p.delivered), /ordinary-cross\.test|child-document/);
});

for (const cause of [
  'protected',
  'protected-sibling',
  'unknown',
  'missing',
  'owner-count',
  'loader',
  'version',
  'backend-owner',
  'duplicate-backend',
  'duplicate-frame',
  'local-remote-overlap',
  'local-missing',
]) {
  test(`bios refuses the whole closure on ${cause}, with no list URL in output`, async (t) => {
    const ids = ['protected-sibling', 'duplicate-backend', 'duplicate-frame'].includes(cause)
      ? ['one', 'two', 'three']
      : ['remote'];
    const list = snapshot(
      ids,
      cause === 'protected-sibling'
        ? ['ordinary', 'protected', 'ordinary']
        : cause === 'protected'
          ? 'protected'
          : cause === 'unknown'
            ? 'unknown'
            : 'ordinary'
    );
    if (cause === 'owner-count') list.frames = list.frames.slice(0, 1);
    if (cause === 'loader') list.rootLoaderId = 'stale';
    if (cause === 'version') list.version = 99;
    if (cause === 'backend-owner') list.remoteOwners[0].backendNodeId = 999;
    if (cause === 'duplicate-backend')
      list.remoteOwners[1].backendNodeId = list.remoteOwners[0].backendNodeId;
    if (cause === 'duplicate-frame') list.remoteOwners[1].frameId = list.remoteOwners[0].frameId;
    if (cause === 'local-remote-overlap') list.remoteOwners[0].frameId = 'root';
    if (cause === 'local-missing') list.localFrames = [];
    let reads = 0;
    const { p } = fixture(
      t,
      async () => {
        reads++;
        return cause === 'missing' ? null : list;
      },
      ids
    );
    const answer = await p.send('Debugger.enable', {}, await p.attach('root'));
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.ok(reads > 0);
    assert.doesNotMatch(
      JSON.stringify(p.delivered),
      /private-frame|ordinary-cross\.test|one\.test|three\.test/
    );
    assert.equal(
      p.clients().some(({ method }) => method === 'Debugger.enable'),
      false
    );
  });
}

test('old extension at the method floor but without the new private list fails closed with an update message', async (t) => {
  const { p } = fixture(t, undefined, []);
  const answer = await p.send('Debugger.enable', {}, await p.attach('root'));
  assert.match(answer.error?.message ?? '', /refused:.*(?:update|Update|frame list)/);
  assert.equal(
    p.clients().some(({ method }) => method === 'Debugger.enable'),
    false
  );
});

test('a late owner suspends the bios-owned lease, privately resumes a gap pause, and all-ordinary re-placement can lift it', async (t) => {
  let list = snapshot([]);
  let resolve;
  let held = false;
  const reader = async () =>
    held
      ? new Promise((done) => {
          resolve = done;
        })
      : structuredClone(list);
  const { p, root } = fixture(t, reader, []);
  const session = await p.attach('root');
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
  list = snapshot(['remote'], 'ordinary', 1);
  root.dom = dom(['remote']);
  held = true;
  p.emit({
    sessionId: session,
    method: 'Page.frameAttached',
    params: { frameId: 'remote', parentFrameId: 'root' },
  });
  await flush();
  const since = p.sent.length;
  p.emit({
    sessionId: session,
    method: 'Debugger.paused',
    params: {
      reason: 'other',
      callFrames: [{ callFrameId: 'frame', location: { scriptId: 'script' } }],
    },
  });
  await flush();
  assert.equal(
    p.delivered.some(({ method }) => method === 'Debugger.paused'),
    false
  );
  assert.ok(
    p.sent
      .slice(since)
      .some(
        ({ id, method, sessionId: owner }) =>
          id >= 2 ** 30 && method === 'Debugger.resume' && owner === session
      ),
    'gap pause needs an owned private resume'
  );
  held = false;
  resolve?.(snapshot(['remote'], 'unknown', 1));
  await flush();
  assert.match(
    (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
    /^slicc: refused:/
  );
  p.emit({
    sessionId: session,
    method: 'Page.frameNavigated',
    params: {
      frame: {
        id: 'remote',
        parentId: 'root',
        loaderId: 'child-loader',
        url: 'https://ordinary-cross.test/',
        securityOrigin: 'https://ordinary-cross.test',
      },
    },
  });
  await flush();
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
});

test('an unsettled late child revokes at five seconds and only a new root document can start clean', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let list = snapshot([]);
  const { p, root } = fixture(t, async () => structuredClone(list), []);
  const session = await p.attach('root');
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
  root.dom = dom(['remote']);
  list = snapshot(['remote'], 'unknown', 1);
  p.emit({
    sessionId: session,
    method: 'Page.frameAttached',
    params: { frameId: 'remote', parentFrameId: 'root' },
  });
  await flush();
  t.mock.timers.tick(5001);
  list = snapshot(['remote'], 'ordinary', 2);
  p.emit({
    sessionId: session,
    method: 'Page.frameNavigated',
    params: {
      frame: {
        id: 'remote',
        parentId: 'root',
        loaderId: 'child-loader',
        url: 'https://ordinary-cross.test/',
        securityOrigin: 'https://ordinary-cross.test',
      },
    },
  });
  await flush();
  assert.match(
    (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
    /^slicc: refused:/
  );
  root.tree.frame.loaderId = 'new-root-loader';
  list.rootLoaderId = 'new-root-loader';
  p.emit({ sessionId: session, method: 'Page.frameNavigated', params: { frame: root.tree.frame } });
  await flush();
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
});

test('a protected late owner revokes Debugger work for this document even if it later becomes ordinary', async (t) => {
  let list = snapshot([]);
  const { p, root } = fixture(t, async () => structuredClone(list), []);
  const session = await p.attach('root');
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
  root.dom = dom(['remote']);
  list = snapshot(['remote'], 'protected', 1);
  p.emit({
    sessionId: session,
    method: 'Page.frameAttached',
    params: { frameId: 'remote', parentFrameId: 'root' },
  });
  await flush();
  assert.match(
    (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
    /^slicc: refused:/
  );
  list = snapshot(['remote'], 'ordinary', 2);
  assert.match(
    (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
    /^slicc: refused:/
  );
  assert.doesNotMatch(JSON.stringify(p.delivered), /private-frame/);
});
