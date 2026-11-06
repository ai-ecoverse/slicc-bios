import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const seven = 'https://seven.sliccy.ai/page';
const mid = 'https://mid.invalid/page';
const BURST = 20;
const GUARD = 2 ** 30;
const CURRENT = {
  'no-opener': 4,
  'ordinary-opener': 4,
  'two-deep-opener': 4,
  iframe: 3,
};
const guardCalls = (wire, since) => wire.sent.slice(since).filter((message) => message.id >= GUARD);
const page = (wire, id, url, type = 'page', openerId) => {
  const entry = wire.target(id, type, {
    ...plainFrame(id),
    url,
    securityOrigin: URL.parse(url)?.origin ?? '://',
  });
  Object.assign(entry.info, {
    ...(openerId ? { openerId } : {}),
    canAccessOpener: Boolean(openerId),
  });
  return entry;
};

async function settle() {
  for (let i = 0; i < 20; i += 1) await flush();
}

async function measure(t, shape, setup) {
  const wire = protocol(t);
  const session = await setup(wire);
  await settle();
  const warm = await wire.send('Runtime.evaluate', { expression: '1' }, session);
  assert.equal(warm.error, undefined, JSON.stringify(warm));
  await settle();
  const mark = wire.sent.length;
  for (let i = 0; i < BURST; i += 1) {
    const answer = await wire.send('Runtime.evaluate', { expression: String(i) }, session);
    assert.equal(answer.error, undefined, JSON.stringify(answer));
  }
  await settle();
  const calls = guardCalls(wire, mark);
  const perCommand = calls.length / BURST;
  const byMethod = Object.create(null);
  for (const message of calls) byMethod[message.method] = (byMethod[message.method] ?? 0) + 1;
  process.stdout.write(
    `FACT opener-cost ${shape} calls/command=${perCommand} methods=${JSON.stringify(byMethod)}\n`
  );
  assert.ok(
    perCommand <= CURRENT[shape],
    `${shape} calls/command=${perCommand} exceeds bound ${CURRENT[shape]}`
  );
  return { wire, session, perCommand };
}

test('opener-cost no-opener', async (t) => {
  await measure(t, 'no-opener', async (wire) => {
    page(wire, 'cost-none', ordinary);
    const answer = await wire.send('Target.attachToTarget', {
      targetId: 'cost-none',
      flatten: true,
    });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    return answer.result.sessionId;
  });
});

test('opener-cost ordinary-opener', async (t) => {
  await measure(t, 'ordinary-opener', async (wire) => {
    page(wire, 'cost-opener-parent', seven);
    page(wire, 'cost-opener-child', ordinary, 'page', 'cost-opener-parent');
    const answer = await wire.send('Target.attachToTarget', {
      targetId: 'cost-opener-child',
      flatten: true,
    });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    return answer.result.sessionId;
  });
});

test('opener-cost two-deep-opener', async (t) => {
  await measure(t, 'two-deep-opener', async (wire) => {
    page(wire, 'cost-deep-root', seven);
    page(wire, 'cost-deep-mid', mid, 'page', 'cost-deep-root');
    page(wire, 'cost-deep-child', ordinary, 'page', 'cost-deep-mid');
    const answer = await wire.send('Target.attachToTarget', {
      targetId: 'cost-deep-child',
      flatten: true,
    });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    return answer.result.sessionId;
  });
});

test('opener-cost iframe', async (t) => {
  await measure(t, 'iframe', async (wire) => {
    page(wire, 'cost-iframe-parent', ordinary);
    page(wire, 'cost-iframe', ordinary, 'iframe');
    wire.targets.get('cost-iframe').info.parentId = 'cost-iframe-parent';
    const answer = await wire.send('Target.attachToTarget', {
      targetId: 'cost-iframe',
      flatten: true,
    });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    return answer.result.sessionId;
  });
});

async function opened(t, name, childUrl = ordinary, parentUrl = seven) {
  const wire = protocol(t);
  const parent = page(wire, `${name}-parent`, parentUrl);
  const child = page(wire, `${name}-child`, childUrl, 'page', parent.info.targetId);
  const answer = await wire.send('Target.attachToTarget', {
    targetId: child.info.targetId,
    flatten: true,
  });
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  await settle();
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: '1' }, answer.result.sessionId)).error,
    undefined
  );
  await settle();
  return { wire, parent, child, session: answer.result.sessionId };
}

const move = (entry, url) => {
  entry.info.url = url;
  entry.tree.frame = {
    ...entry.tree.frame,
    url,
    securityOrigin: URL.parse(url)?.origin ?? '://',
  };
};

test('opener freshness cache refuses after opener navigates to a protected URL (event first)', async (t) => {
  const { wire, parent, child, session } = await opened(t, 'cache-nav-first', ordinary, ordinary);
  move(parent, seven);
  move(child, 'about:blank');
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: parent.info } });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: child.info } });
  await settle();
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: '2' }, session)).error?.message,
    PROTECTED
  );
});

test('opener freshness cache refuses when opener navigates during a command', async (t) => {
  const { wire, parent, session } = await opened(t, 'cache-nav-during');
  let delaying = true;
  wire.hold(
    (message) =>
      delaying &&
      message.id >= GUARD &&
      (message.method === 'Page.getFrameTree' || message.method === 'Page.getNavigationHistory')
  );
  const pending = wire.request('Runtime.evaluate', { expression: '3' }, session);
  await flush();
  hold(parent.info.targetId);
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: parent.info } });
  await settle();
  delaying = false;
  for (const message of wire.held.slice()) wire.release(message);
  await settle();
  assert.equal((await pending.answer).error?.message, PROTECTED);
});

test('opener freshness cache refuses after opener is destroyed and its id is reused', async (t) => {
  const { wire, parent, child, session } = await opened(t, 'cache-reuse', ordinary, ordinary);
  wire.emit({ method: 'Target.targetDestroyed', params: { targetId: parent.info.targetId } });
  await settle();
  const reused = page(wire, parent.info.targetId, seven);
  reused.info.openerId = undefined;
  reused.info.canAccessOpener = false;
  move(child, 'about:blank');
  child.info.openerId = reused.info.targetId;
  wire.emit({ method: 'Target.targetCreated', params: { targetInfo: reused.info } });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: child.info } });
  await settle();
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: '4' }, session)).error?.message,
    PROTECTED
  );
});

test('opener freshness cache takes a fresh path when target info changes in flight', async (t) => {
  const { wire, child, session } = await opened(t, 'cache-inflight');
  let delaying = true;
  wire.hold(
    (message) =>
      delaying &&
      message.id >= GUARD &&
      (message.method === 'Page.getFrameTree' || message.method === 'Page.getNavigationHistory')
  );
  const pending = wire.request('Runtime.evaluate', { expression: '5' }, session);
  await flush();
  move(child, seven);
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: child.info } });
  await settle();
  delaying = false;
  for (const message of wire.held.slice()) wire.release(message);
  await settle();
  assert.equal((await pending.answer).error?.message, PROTECTED);
});

test('opener freshness cache refuses when the opener gains a new opener', async (t) => {
  const { wire, parent, session } = await opened(t, 'cache-new-opener');
  const root = page(wire, 'cache-new-opener-root', seven);
  parent.info.openerId = root.info.targetId;
  parent.info.canAccessOpener = true;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: parent.info } });
  await settle();
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: '6' }, session)).error?.message,
    PROTECTED
  );
});
