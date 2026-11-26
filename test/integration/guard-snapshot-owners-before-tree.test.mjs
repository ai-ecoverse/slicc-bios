import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected: stockGuard } = await import(
  process.env.GUARD_SOURCE ?? '../../src/seed/guard.js'
);
const SEED = new URL('../../src/seed/', import.meta.url);
const route = { kind: 'extension', version: '7.12.0' };
const ordinaryReader = async () => ({
  version: 2,
  revision: 0,
  rootFrameId: 'page',
  rootLoaderId: 'loader',
  localFrames: ['page'],
  remoteOwners: [],
  frames: [
    {
      kind: 'ordinary',
      frameId: 0,
      parentFrameId: -1,
      documentId: 'doc',
      url: 'https://ordinary.invalid/page',
    },
  ],
});

const MUTANTS = {
  'skip-early-treeFrames': ['guard.js', 'if (!scope.treeFrames) return refused();\n    ', ''],
  'snapshot-tree-size': [
    'guard.js',
    "if (!scope.treeFrames) return refused();\n    if (\n      !Array.isArray(documents) ||\n      !documents.length ||\n      !Array.isArray(strings) ||\n      strings.some((value) => typeof value !== 'string') ||\n      strings[documents[0]?.frameId] !== scope.root\n    )\n      return refused();\n    const local = new Set();\n    const backend = new Set();\n    const owners = [];\n    const remote = new Map();\n    for (const document of documents) {\n      const frameId = strings[document?.frameId];\n      const nodes = document?.nodes;\n      if (\n        typeof frameId !== 'string' ||\n        !frameId ||\n        local.has(frameId) ||\n        !scope.treeFrames.has(frameId) ||",
    "if (\n      !Array.isArray(documents) ||\n      !documents.length ||\n      !Array.isArray(strings) ||\n      strings.some((value) => typeof value !== 'string') ||\n      strings[documents[0]?.frameId] !== scope.root\n    )\n      return refused();\n    const local = new Set();\n    const backend = new Set();\n    const owners = [];\n    const remote = new Map();\n    for (const document of documents) {\n      const frameId = strings[document?.frameId];\n      const nodes = document?.nodes;\n      if (\n        typeof frameId !== 'string' ||\n        !frameId ||\n        local.has(frameId) ||\n        (scope.treeFrames != null && !scope.treeFrames.has(frameId)) ||",
  ],
  'snapshot-local-has': [
    'guard.js',
    "if (!scope.treeFrames) return refused();\n    if (\n      !Array.isArray(documents) ||\n      !documents.length ||\n      !Array.isArray(strings) ||\n      strings.some((value) => typeof value !== 'string') ||\n      strings[documents[0]?.frameId] !== scope.root\n    )\n      return refused();\n    const local = new Set();\n    const backend = new Set();\n    const owners = [];\n    const remote = new Map();\n    for (const document of documents) {\n      const frameId = strings[document?.frameId];\n      const nodes = document?.nodes;\n      if (\n        typeof frameId !== 'string' ||\n        !frameId ||\n        local.has(frameId) ||\n        !scope.treeFrames.has(frameId) ||",
    "if (\n      !Array.isArray(documents) ||\n      !documents.length ||\n      !Array.isArray(strings) ||\n      strings.some((value) => typeof value !== 'string') ||\n      strings[documents[0]?.frameId] !== scope.root\n    )\n      return refused();\n    const local = new Set();\n    const backend = new Set();\n    const owners = [];\n    const remote = new Map();\n    for (const document of documents) {\n      const frameId = strings[document?.frameId];\n      const nodes = document?.nodes;\n      if (\n        typeof frameId !== 'string' ||\n        !frameId ||\n        local.has(frameId) ||\n        (scope.treeFrames != null && !scope.treeFrames.has(frameId)) ||",
  ],
};

const LOCAL_HAS_MUTANT = ['!scope.treeFrames?.has(id)', '!scope.treeFrames.has(id)'];

registerHooks({
  resolve(specifier, context, next) {
    const mutant = context.parentURL && URL.parse(context.parentURL)?.searchParams.get('mutant');
    const resolved = next(specifier, context);
    if (
      !mutant ||
      !MUTANTS[mutant] ||
      !specifier.startsWith('./') ||
      specifier.slice(2) !== 'guard.js'
    )
      return resolved;
    return { ...resolved, url: `${resolved.url}?mutant=${mutant}` };
  },
  load(url, context, next) {
    const mutant = URL.parse(url)?.searchParams.get('mutant');
    const loaded = next(url, context);
    if (!mutant || !MUTANTS[mutant] || !url.split('?')[0].endsWith('/guard.js')) return loaded;
    const [, from, to] = MUTANTS[mutant];
    let source = String(loaded.source);
    assert.ok(source.includes(from), `mutant ${mutant}: patch site missing`);
    source = source.replace(from, to);
    if (mutant === 'snapshot-local-has') {
      const [localFrom, localTo] = LOCAL_HAS_MUTANT;
      assert.ok(source.includes(localFrom), `mutant ${mutant}: local has site missing`);
      source = source.replace(localFrom, localTo);
    }
    return { ...loaded, source };
  },
});

const loadGuard = async (mutant) => {
  if (!mutant) return stockGuard;
  return (await import(`${new URL('guard.js', SEED).href}?mutant=${mutant}`)).guardProtected;
};

async function extensionWire(t, mutant) {
  const guardProtected = await loadGuard(mutant);
  return protocol(t, (raw, own) => guardProtected(raw, own, new Map(), route, ordinaryReader));
}

async function raceBeforeTree(t, { mutant, child = false } = {}) {
  const p = await extensionWire(t, mutant);
  const frame = { ...plainFrame('page'), loaderId: 'loader' };
  const entry = p.target('page', 'page', frame);
  if (child) entry.tree.childFrames = [{ frame: plainFrame('child', 'page') }];
  p.hold((message) => message.id >= 2 ** 30 && message.method === 'Page.getFrameTree');
  const attaching = p.attach('page');
  for (
    let i = 0;
    i < 20 && !p.held.some((message) => message.method === 'Page.getFrameTree');
    i += 1
  )
    await flush();
  const tree = p.held.find((message) => message.method === 'Page.getFrameTree');
  assert.ok(tree, 'placement is waiting on the frame tree');
  p.emit({
    sessionId: tree.sessionId,
    method: 'Page.frameNavigated',
    params: { frame },
  });
  await flush();
  const scope = p.inner().scope('page');
  assert.equal(scope.root, 'page');
  assert.equal(scope.treeFrames, undefined);
  const thrown = [];
  const guard = p.inner();
  const received = guard.received.bind(guard);
  guard.received = (text) => {
    try {
      const result = received(text);
      if (result != null && typeof result.then === 'function')
        result.catch((error) => thrown.push(error));
      return result;
    } catch (error) {
      thrown.push(error);
    }
  };
  p.release(tree);
  await flush();
  await flush();
  await flush();
  const afterSnapshot = {
    ownersReady: p.inner().scope('page').ownersReady,
    treeFrames: p.inner().scope('page').treeFrames,
    locked: p.inner().pageLocked('page'),
  };
  async function unlock() {
    p.hold(() => false);
    for (const held of [...p.held]) p.release(held);
    await flush();
    await flush();
    await flush();
    if (mutant) {
      await Promise.race([attaching, new Promise((resolve) => setTimeout(resolve, 100))]);
      return;
    }
    await attaching;
  }
  return {
    p,
    afterSnapshot,
    unlock,
    thrown: thrown[0],
  };
}

test('snapshot owners before the frame tree: tree then snapshot unlocks', {
  timeout: 5000,
}, async (t) => {
  const p = await extensionWire(t);
  p.target('page', 'page', { ...plainFrame('page'), loaderId: 'loader' });
  const session = await p.attach('page');
  await flush();
  await flush();
  const scope = p.inner().scope('page');
  assert.ok(scope.treeFrames?.has('page'));
  assert.equal(scope.ownersReady, true);
  assert.equal(p.inner().pageLocked('page'), false);
  assert.equal((await p.send('Page.captureScreenshot', {}, session)).error, undefined);
});

test('snapshot owners before the frame tree: snapshot before the tree stays locked then a later tree unlocks', {
  timeout: 5000,
}, async (t) => {
  const { p, afterSnapshot, unlock, thrown } = await raceBeforeTree(t);
  assert.equal(thrown, undefined, 'snapshot before the tree must not throw');
  assert.equal(afterSnapshot.treeFrames, undefined);
  assert.equal(afterSnapshot.ownersReady, false);
  assert.equal(afterSnapshot.locked, true);
  await unlock();
  for (let i = 0; i < 40 && p.inner().pageLocked('page'); i += 1) await flush();
  const after = p.inner().scope('page');
  assert.ok(after.treeFrames?.has('page'), 'a later frame-tree read must record the tree');
  assert.equal(after.ownersReady, true);
  assert.equal(p.inner().pageLocked('page'), false);
  const session = [...p.sessions.entries()].find(
    ([id, target]) => target === 'page' && id.startsWith('client-')
  )[0];
  assert.equal((await p.send('Page.captureScreenshot', {}, session)).error, undefined);
});

test('mutant: without the early treeFrames refusal the unread-tree snapshot throws on has', {
  timeout: 5000,
}, async (t) => {
  const { thrown, unlock } = await raceBeforeTree(t, { mutant: 'skip-early-treeFrames' });
  assert.ok(thrown, 'mutant must throw when the early refusal is removed');
  assert.match(String(thrown?.message ?? thrown), /has/);
  await unlock();
});

test('mutant: unguarded snapshot treeFrames.size throws when the tree is unread', {
  timeout: 5000,
}, async (t) => {
  const { thrown, unlock } = await raceBeforeTree(t, { mutant: 'snapshot-tree-size' });
  assert.ok(thrown, 'mutant must throw when treeFrames.size is reached unread');
  assert.match(String(thrown?.message ?? thrown), /size/);
  await unlock();
});

test('mutant: unguarded snapshotLocalOwner treeFrames.has throws when the tree is unread', {
  timeout: 5000,
}, async (t) => {
  const { thrown, unlock } = await raceBeforeTree(t, { mutant: 'snapshot-local-has', child: true });
  assert.ok(thrown, 'mutant must throw from snapshotLocalOwner when treeFrames is unread');
  assert.match(String(thrown?.message ?? thrown), /has/);
  await unlock();
});
