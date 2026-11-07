import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, protectedOrigin, protocol } from './guard-state-fixture.mjs';

const READS = 40;
const GUARD = 2 ** 30;

const probes = (wire, since) =>
  wire.sent
    .slice(since)
    .filter(
      (message) =>
        message.id >= GUARD &&
        ['Target.getTargetInfo', 'Page.getFrameTree', 'Page.getNavigationHistory'].includes(
          message.method
        )
    ).length;

const forwarded = (wire, since, method) =>
  wire.clients(since).filter((message) => message.method === method).length;

function protect(wire, id) {
  const entry = wire.targets.get(id);
  const url = `${protectedOrigin}/moved`;
  entry.info = { ...entry.info, url };
  entry.tree = { frame: { ...entry.tree.frame, url, securityOrigin: protectedOrigin } };
}

async function page(t) {
  const wire = protocol(t);
  wire.target('T1');
  const session = await wire.attach('T1');
  await flush();
  return { wire, session };
}

const describe = (wire, session) =>
  Promise.all(
    Array.from(
      { length: READS },
      (_, i) => wire.request('DOM.describeNode', { nodeId: i + 2 }, session).answer
    )
  );

test('reads a program sends together on one session share the guard’s opener and surface checks', async (t) => {
  const { wire, session } = await page(t);
  const since = wire.sent.length;
  const answers = await describe(wire, session);
  assert.deepEqual(
    answers.filter((answer) => answer.error),
    []
  );
  assert.equal(forwarded(wire, since, 'DOM.describeNode'), READS);
  const checked = probes(wire, since);
  assert.ok(checked <= 12, `${READS} reads cost ${checked} guard probes`);
});

test('a browser event between reads sent together makes the later reads check again, and a target that moved to a protected origin refuses them', async (t) => {
  const { wire, session } = await page(t);
  const since = wire.sent.length;
  let moved = false;
  wire.hold((message) => {
    if (!moved && message.id < GUARD && message.method === 'DOM.describeNode') {
      moved = true;
      protect(wire, 'T1');
      queueMicrotask(() =>
        wire.emit({ method: 'Network.dataReceived', sessionId: session, params: {} })
      );
    }
    return false;
  });
  const answers = await describe(wire, session);
  const passed = forwarded(wire, since, 'DOM.describeNode');
  assert.ok(passed < READS, `${passed} of ${READS} reads reached the browser`);
  assert.ok(answers.slice(passed).every((answer) => answer.error));
});

test('a command that can change the page, forwarded between reads sent together, makes the later reads check again', async (t) => {
  const { wire, session } = await page(t);
  const since = wire.sent.length;
  wire.hold((message) => {
    if (message.id < GUARD && message.method === 'Runtime.evaluate') protect(wire, 'T1');
    return false;
  });
  const first = wire.request('DOM.describeNode', { nodeId: 1 }, session).answer;
  const evaluated = wire.request(
    'Runtime.evaluate',
    { expression: 'location.href = "elsewhere"' },
    session
  ).answer;
  const rest = describe(wire, session);
  assert.equal((await first).error, undefined);
  await evaluated;
  const answers = await rest;
  assert.equal(forwarded(wire, since, 'DOM.describeNode'), 1);
  assert.ok(answers.every((answer) => answer.error));
});

async function flipAfterSurface(t, holdMs) {
  const { wire, session } = await page(t);
  const since = wire.sent.length;
  let held = false;
  wire.hold((message) => {
    if (held || message.id < GUARD || message.method !== 'Page.getNavigationHistory') return false;
    held = true;
    setTimeout(() => {
      wire.release(message);
      protect(wire, 'T1');
    }, holdMs);
    return true;
  });
  const answers = await Promise.all([
    wire.request('DOM.describeNode', { nodeId: 2 }, session).answer,
    wire.request('DOM.describeNode', { nodeId: 3 }, session).answer,
  ]);
  return { answers, passed: forwarded(wire, since, 'DOM.describeNode') };
}

test('a shared check is used only while it is at most 100 ms old: a target that moved without an event is refused once the check is older', async (t) => {
  const fresh = await flipAfterSurface(t, 10);
  assert.equal(fresh.passed, 2, 'inside the bound the second read shares the first read’s check');
  const stale = await flipAfterSurface(t, 150);
  assert.equal(stale.passed, 1, 'beyond the bound the second read checks again');
  assert.equal(stale.answers[0].error, undefined);
  assert.ok(stale.answers[1].error);
});
