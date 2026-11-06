import assert from 'node:assert/strict';
import test from 'node:test';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';
import { flush, plainFrame, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const route = { kind: 'extension', version: '7.12.2' };
const ordinaryChild = 'https://ordinary-cross.test/';
const protectedChild = `${protectedOrigin}/controller/oopif`;

const dom = (ids) => ({
  nodeId: 1,
  nodeName: '#document',
  children: ids.map((frameId, index) => ({
    nodeName: 'IFRAME',
    frameId,
    backendNodeId: index + 2,
    attributes: ['src', ordinaryChild],
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

async function placed(t, reader, ids = ['child']) {
  const p = protocol(t, (raw, own) => guardProtected(raw, own, new Map(), route, reader));
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'root-loader' });
  root.dom = dom(ids);
  const session = await p.attach('root');
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
  return { p, root, session };
}

async function attachChild(p, url = ordinaryChild) {
  const frame = {
    id: 'child',
    parentId: 'root',
    loaderId: 'child-loader',
    url,
    securityOrigin: new URL(url).origin,
  };
  const child = p.target('child', 'iframe', frame, 'root');
  child.info.url = url;
  p.attached('child', 'guard-root');
  await flush();
  for (let i = 0; i < 10; i += 1) await flush();
  return child;
}

function navigateChild(p, child, url) {
  child.info.url = url;
  child.tree.frame = {
    ...child.tree.frame,
    url,
    securityOrigin: new URL(url).origin,
  };
  p.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: child.info },
  });
  p.emit({
    sessionId: 'client-child',
    method: 'Page.frameNavigated',
    params: { frame: child.tree.frame },
  });
}

test('protected child navigation after placement refuses parent page reads', async (t) => {
  let list = snapshot(['child']);
  const { p, session } = await placed(t, async () => structuredClone(list));
  const child = await attachChild(p);
  assert.equal((await p.send('DOM.getDocument', { depth: -1 }, session)).error, undefined);
  list = snapshot(['child'], 'protected', 1);
  navigateChild(p, child, protectedChild);
  await flush();
  assert.equal((await p.send('DOM.getDocument', { depth: -1 }, session)).error?.message, PROTECTED);
  assert.equal(
    (await p.send('Page.captureSnapshot', { format: 'mhtml' }, session)).error?.message,
    PROTECTED
  );
  assert.equal((await p.send('Debugger.enable', {}, session)).error?.message, PROTECTED);
});

test('ordinary child navigation after placement still admits parent after re-placement', async (t) => {
  let list = snapshot(['child']);
  let reads = 0;
  const { p, session } = await placed(t, async () => {
    reads += 1;
    return structuredClone(list);
  });
  const placedReads = reads;
  const child = await attachChild(p);
  list = snapshot(['child'], 'ordinary', 1);
  navigateChild(p, child, `${ordinaryChild}next`);
  await flush();
  for (let i = 0; i < 10; i += 1) await flush();
  assert.equal((await p.send('DOM.getDocument', { depth: -1 }, session)).error, undefined);
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
  assert.ok(reads > placedReads, 'parent must re-place after the child navigates');
});

test('a page without OOPIF children admits without extra private frame reads', async (t) => {
  let reads = 0;
  const list = {
    version: 2,
    rootFrameId: 'root',
    rootLoaderId: 'root-loader',
    revision: 0,
    localFrames: ['root'],
    remoteOwners: [],
    frames: [{ frameId: 0, parentFrameId: -1, kind: 'ordinary' }],
  };
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), route, async () => {
      reads += 1;
      return structuredClone(list);
    })
  );
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'root-loader' });
  root.dom = { nodeId: 1, nodeName: '#document', children: [] };
  const session = await p.attach('root');
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
  const afterPlace = reads;
  assert.equal((await p.send('DOM.getDocument', { depth: -1 }, session)).error, undefined);
  assert.equal(
    (await p.send('Page.captureSnapshot', { format: 'mhtml' }, session)).error,
    undefined
  );
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
  assert.equal(reads, afterPlace);
});

test('child detached after placement re-checks the parent', async (t) => {
  let list = snapshot(['child']);
  const { p, root, session } = await placed(t, async () => structuredClone(list));
  await attachChild(p);
  assert.equal((await p.send('DOM.getDocument', { depth: -1 }, session)).error, undefined);
  list = snapshot([], 'ordinary', 1);
  root.dom = dom([]);
  p.emit({
    method: 'Target.targetDestroyed',
    params: { targetId: 'child' },
  });
  p.emit({
    sessionId: 'guard-root',
    method: 'Page.frameDetached',
    params: { frameId: 'child', reason: 'remove' },
  });
  await flush();
  for (let i = 0; i < 10; i += 1) await flush();
  assert.equal((await p.send('DOM.getDocument', { depth: -1 }, session)).error, undefined);
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
});

test('protected child that never navigated stays refused', async (t) => {
  const list = snapshot(['child'], 'protected');
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), route, async () => structuredClone(list))
  );
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'root-loader' });
  root.dom = dom(['child']);
  const session = await p.attach('root');
  assert.equal((await p.send('Debugger.enable', {}, session)).error?.message, PROTECTED);
  assert.equal((await p.send('DOM.getDocument', { depth: -1 }, session)).error?.message, PROTECTED);
});
