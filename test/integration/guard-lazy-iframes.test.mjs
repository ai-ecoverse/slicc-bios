import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { flush, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) await flush();
};

const lazy = (id, parentId) => ({
  id,
  parentId,
  loaderId: `${id}-initial`,
  url: '',
  securityOrigin: '://',
});

async function page(t, id) {
  const wire = protocol(t);
  t.after(() => {
    wire.hold(() => false);
    for (const message of [...wire.held]) wire.release(message);
  });
  const entry = wire.target(id);
  entry.tree.frame.loaderId = `${id}-loader`;
  const session = await wire.attach(id);
  assert.equal((await wire.send('Runtime.enable', {}, session)).error, undefined);
  entry.tree.childFrames = ['lazy-a', 'lazy-b', 'lazy-c'].map((child) => ({
    frame: lazy(child, id),
  }));
  for (const child of entry.tree.childFrames)
    wire.emit({
      method: 'Page.frameAttached',
      sessionId: `guard-${id}`,
      params: { frameId: child.frame.id, parentFrameId: id },
    });
  await settle();
  return { wire, entry, session };
}

const lookups = (message) => message.id >= 2 ** 30 && message.method === 'Target.getTargetInfo';

const retitle = (wire, entry, title) =>
  wire.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { ...entry.info, title, attached: true } },
  });

async function slowHint(t, wire, entry, title) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.hold(lookups);
  retitle(wire, entry, title);
  await settle();
  for (let step = 0; step < 14; step += 1) {
    t.mock.timers.tick(500);
    await settle(20);
  }
  wire.hold(() => false);
  for (const message of [...wire.held]) wire.release(message);
  await settle(80);
  t.mock.timers.reset();
}

const detached = (wire, session) =>
  wire.sent.some(
    (message) =>
      message.method === 'Target.detachFromTarget' && message.params?.sessionId === session
  );

test('an unanswered target check on a page whose lazy iframes never loaded leaves the page drivable', async (t) => {
  const { wire, entry, session } = await page(t, 'lazy-slow');
  await slowHint(t, wire, entry, 'Top 100 Most Visited Websites');
  assert.equal(detached(wire, session), false);
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error,
    undefined
  );
  assert.equal((await wire.send('Fetch.disable', {}, session)).error, undefined);
});

test('a lazy iframe that commits on seven while the page is checked again still cuts it', async (t) => {
  const { wire, entry, session } = await page(t, 'lazy-seven');
  Object.assign(entry.tree.childFrames[0].frame, {
    url: `${protectedOrigin}/controller/lazy`,
    securityOrigin: protectedOrigin,
    loaderId: 'lazy-seven-commit',
  });
  await slowHint(t, wire, entry, 'seven inside');
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error?.message,
    PROTECTED
  );
});

test('lazy iframes under a root that moved to seven do not keep the page open', async (t) => {
  const { wire, entry, session } = await page(t, 'lazy-root');
  Object.assign(entry.tree.frame, {
    url: `${protectedOrigin}/controller/root`,
    securityOrigin: protectedOrigin,
    loaderId: 'lazy-root-commit',
  });
  await slowHint(t, wire, entry, 'seven');
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error?.message,
    PROTECTED
  );
});

test('a target check that answers late does not refuse reads that were in flight', async (t) => {
  const { wire, entry, session } = await page(t, 'lazy-late');
  const reads = new Set(['Runtime.evaluate', 'Network.getAllCookies']);
  let slow;
  wire.hold((message) => {
    if (lookups(message) && !slow) return Boolean((slow = message));
    return message.id < 2 ** 30 && reads.has(message.method);
  });
  retitle(wire, entry, 'Top 100 Most Visited Websites');
  await settle();
  const read = wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
  const cookies = wire.send('Network.getAllCookies', {}, session);
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  wire.hold(() => false);
  for (const message of wire.held.filter((held) => held.id < 2 ** 30)) wire.release(message);
  for (const message of [...wire.held]) wire.release(message);
  assert.equal((await read).error, undefined);
  assert.equal((await cookies).error, undefined);
  await settle(80);
  assert.equal(detached(wire, session), false);
  assert.equal((await wire.send('Fetch.disable', {}, session)).error, undefined);
});
