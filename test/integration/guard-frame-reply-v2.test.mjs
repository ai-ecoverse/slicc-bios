import assert from 'node:assert/strict';
import test from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';
import { plainFrame, protocol } from './guard-ordering-fixture.mjs';

function list() {
  return {
    version: 2,
    revision: 0,
    rootFrameId: 'root',
    rootLoaderId: 'loader',
    localFrames: ['root'],
    remoteOwners: [{ frameId: 'remote', backendNodeId: 2 }],
    frames: [
      { frameId: 0, parentFrameId: -1, kind: 'ordinary' },
      { frameId: 1, parentFrameId: 0, kind: 'ordinary' },
    ],
  };
}

function setup(t, snapshot) {
  const p = protocol(t, (raw, own) =>
    guardProtected(
      raw,
      own,
      new Map(),
      { kind: 'extension', version: '7.11.99' },
      async () => snapshot
    )
  );
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'loader' });
  root.dom = {
    nodeId: 1,
    nodeName: '#document',
    children: [
      {
        nodeName: 'IFRAME',
        frameId: 'remote',
        backendNodeId: 2,
        attributes: ['src', 'https://ordinary-cross.test/'],
      },
    ],
  };
  return p;
}

test('an ordinary URL-free v2 closure places through the real bios guard and admits owned debugger work', async (t) => {
  const snapshot = list();
  assert.doesNotMatch(JSON.stringify(snapshot), /url|origin|documentId|https?:/i);
  const p = setup(t, snapshot);
  const answer = await p.send('Debugger.enable', {}, await p.attach('root'));
  assert.equal(answer.error, undefined);
  assert.equal(p.clients().filter(({ method }) => method === 'Debugger.enable').length, 1);
});

test('a mixed ordinary/protected kind-only reply revokes before any placement identity is needed', async (t) => {
  const snapshot = {
    version: 2,
    revision: 5,
    rootLoaderId: 'loader',
    frames: [{ kind: 'ordinary' }, { kind: 'protected' }],
    localFrames: [],
    remoteOwners: [],
  };
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /frameId|parentFrameId|backendNodeId|documentId|url|origin/i
  );
  const p = setup(t, snapshot);
  const session = await p.attach('root');
  const answer = await p.send('Debugger.enable', {}, session);
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(
    p.clients().some(({ method }) => method === 'Debugger.enable'),
    false
  );
  Object.assign(snapshot, list());
  assert.match(
    (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
    /^slicc: refused:/
  );
});

test('unknown and error kind-only replies refuse without local or remote identifier counts', async (t) => {
  for (const kind of ['unknown', 'error']) {
    const snapshot = {
      version: 2,
      revision: 5,
      rootLoaderId: 'loader',
      frames: [{ kind: 'ordinary' }, { kind }],
      localFrames: [],
      remoteOwners: [],
    };
    const p = setup(t, snapshot);
    const answer = await p.send('Debugger.enable', {}, await p.attach('root'));
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(
      p.clients().some(({ method }) => method === 'Debugger.enable'),
      false
    );
  }
});

test('bios rejects a legacy raw-URL snapshot instead of treating it as the URL-free v2 proof', async (t) => {
  const snapshot = list();
  snapshot.version = 1;
  snapshot.rootDocumentId = 'native-root';
  snapshot.frames[0].documentId = 'native-root';
  snapshot.frames[0].url = 'https://ordinary.invalid/page';
  snapshot.frames[1].documentId = 'native-child';
  snapshot.frames[1].url = 'https://ordinary-cross.test/';
  const p = setup(t, snapshot);
  const answer = await p.send('Debugger.enable', {}, await p.attach('root'));
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(
    p.clients().some(({ method }) => method === 'Debugger.enable'),
    false
  );
  assert.doesNotMatch(JSON.stringify(p.delivered), /ordinary-cross\.test|native-child/);
});
