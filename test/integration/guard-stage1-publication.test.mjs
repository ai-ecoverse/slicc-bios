import assert from 'node:assert/strict';
import test from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const route = { kind: 'extension', version: '7.12.0' };
const ordinarySnapshot = () => ({
  version: 1,
  revision: 0,
  rootFrameId: 'root',
  rootLoaderId: 'loader',
  rootDocumentId: 'native',
  remoteOwners: [],
  frames: [
    {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'native',
      url: 'https://ordinary.invalid/page',
    },
  ],
});

function placed(t, reader = async () => ordinarySnapshot()) {
  const p = protocol(t, (raw, own) => guardProtected(raw, own, new Map(), route, reader));
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'loader' });
  return { p, root };
}

test('a placed ordinary root publishes a default-world pause the client can resume', async (t) => {
  const { p } = placed(t);
  const session = await p.attach('root');
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
  assert.equal(
    (
      await p.send(
        'Debugger.setInstrumentationBreakpoint',
        { instrumentation: 'beforeScriptExecution' },
        session
      )
    ).error,
    undefined
  );
  p.emit({
    sessionId: session,
    method: 'Runtime.executionContextCreated',
    params: {
      context: {
        id: 1,
        uniqueId: 'main-root',
        name: '',
        origin: 'https://ordinary.invalid',
        auxData: { frameId: 'root', isDefault: true },
      },
    },
  });
  await flush();
  const before = p.delivered.length;
  p.emit({
    sessionId: session,
    method: 'Debugger.paused',
    params: {
      reason: 'instrumentation',
      callFrames: [
        {
          callFrameId: '1.1.1',
          functionName: '',
          location: { scriptId: 'root-script', lineNumber: 0, columnNumber: 0 },
          url: 'https://ordinary.invalid/page',
          scopeChain: [{ type: 'local', object: { objectId: '1.1.2' } }],
          this: { objectId: '1.1.3' },
        },
      ],
    },
  });
  await flush();
  const pauses = p.delivered.slice(before).filter(({ method }) => method === 'Debugger.paused');
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].params.callFrames.length, 1);
  assert.equal(pauses[0].params.callFrames[0].url, 'https://ordinary.invalid/page');
  assert.match(pauses[0].params.callFrames[0].this.objectId, /^1\.1\./);
  assert.equal((await p.send('Debugger.resume', {}, session)).error, undefined);
});

test('a suspended lease privately resumes a pause and publishes nothing to the client', async (t) => {
  let list = ordinarySnapshot();
  let resolve;
  let held = false;
  const { p, root } = placed(t, async () =>
    held
      ? new Promise((done) => {
          resolve = done;
        })
      : structuredClone(list)
  );
  const session = await p.attach('root');
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
  list = {
    version: 2,
    revision: 1,
    rootFrameId: 'root',
    rootLoaderId: 'loader',
    localFrames: ['root'],
    remoteOwners: [{ frameId: 'remote', backendNodeId: 2 }],
    frames: [
      { frameId: 0, parentFrameId: -1, kind: 'ordinary' },
      { frameId: 1, parentFrameId: 0, kind: 'ordinary' },
    ],
  };
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
      )
  );
  held = false;
  resolve?.(structuredClone(list));
  await flush();
});
