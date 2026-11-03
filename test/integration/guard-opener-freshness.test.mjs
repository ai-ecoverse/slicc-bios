import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { hold, isHeld } from '../../src/seed/held.js';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const first = 'https://first-idp.invalid/page';
const second = 'https://second-idp.invalid/page';
const other = 'https://other.invalid/page';
const page = (wire, id, url, openerId) => {
  const entry = wire.target(id, 'page', {
    ...plainFrame(id),
    url,
    securityOrigin: URL.parse(url)?.origin ?? '://',
  });
  Object.assign(entry.info, { openerId, canAccessOpener: true });
  return entry;
};
const move = (entry, url) => {
  entry.info.url = url;
  entry.tree.frame = { ...entry.tree.frame, url, securityOrigin: URL.parse(url)?.origin ?? '://' };
};
const attach = (wire, targetId) => wire.send('Target.attachToTarget', { targetId, flatten: true });
const denied = (answer) => {
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(answer.result, undefined);
};
async function setup(t, name, url = other) {
  const wire = protocol(t);
  const parent = page(wire, `${name}-parent`, first);
  hold(parent.info.targetId);
  denied(await attach(wire, parent.info.targetId));
  const child = page(wire, `${name}-child`, url, parent.info.targetId);
  return { wire, parent, child };
}

for (const event of [false, true]) {
  test(`opener freshness learns a held parent's actual origin without discovery: event ${event}`, async (t) => {
    const { wire, parent, child } = await setup(
      t,
      `stale-${event}`,
      `${new URL(second).origin}/popup`
    );
    move(parent, second);
    if (event)
      wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: parent.info } });
    const mark = wire.clients().length;
    denied(await attach(wire, child.info.targetId));
    assert.equal(isHeld(child.info.targetId), true);
    assert.ok(
      wire.sent.filter(
        (message) =>
          message.method === 'Target.getTargetInfo' &&
          message.params.targetId === parent.info.targetId
      ).length >= 2
    );
    assert.equal(
      wire
        .clients()
        .slice(mark)
        .some((message) => message.method === 'Target.attachToTarget'),
      false
    );
    await wire.send(
      'Runtime.evaluate',
      { expression: 'window.opener.document.body.textContent' },
      `client-${child.info.targetId}`
    );
    assert.equal(
      wire
        .clients()
        .some(
          (message) => message.params?.expression === 'window.opener.document.body.textContent'
        ),
      false
    );
  });
}

for (const mutate of ['opener', 'child', 'opener hint']) {
  test(`opener freshness rejects a ${mutate} mutation during lookup`, async (t) => {
    const { wire, parent, child } = await setup(t, `mutation-${mutate}`);
    let delaying = true;
    wire.hold(
      (message) =>
        delaying &&
        message.method === 'Target.getTargetInfo' &&
        message.params.targetId === parent.info.targetId
    );
    const pending = wire.request('Target.attachToTarget', {
      targetId: child.info.targetId,
      flatten: true,
    });
    await flush();
    const held = wire.held[0];
    assert.ok(held);
    const snapshot = structuredClone(parent.info);
    if (mutate === 'child') move(child, first);
    else move(parent, other);
    if (mutate === 'opener hint')
      wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: parent.info } });
    delaying = false;
    for (const message of wire.held.slice())
      wire.release(message, { result: { targetInfo: snapshot } });
    denied(await pending.answer);
    assert.equal(isHeld(child.info.targetId), true);
  });
}

test('opener freshness waits for a delayed positive response before forwarding an attach', async (t) => {
  const { wire, parent, child } = await setup(t, 'delayed');
  let delaying = true;
  wire.hold(
    (message) =>
      delaying &&
      message.method === 'Target.getTargetInfo' &&
      message.params.targetId === parent.info.targetId
  );
  const pending = wire.request('Target.attachToTarget', {
    targetId: child.info.targetId,
    flatten: true,
  });
  await flush();
  assert.equal(
    wire
      .clients()
      .some(
        (message) =>
          message.method === 'Target.attachToTarget' &&
          message.params.targetId === child.info.targetId
      ),
    false
  );
  assert.equal(
    wire.delivered.some((message) => message.id === pending.id),
    false
  );
  delaying = false;
  for (const message of wire.held.slice()) wire.release(message);
  assert.equal((await pending.answer).error, undefined);
});

for (const invalid of [
  'empty',
  'missing URL',
  'missing type',
  'wrong target',
  'protocol error',
  'second read empty',
  'child read empty',
]) {
  test(`opener freshness fails closed for ${invalid}`, async (t) => {
    const { wire, parent, child } = await setup(t, `invalid-${invalid}`);
    let parents = 0;
    let children = 0;
    wire.hold((message) => {
      if (message.method !== 'Target.getTargetInfo') return false;
      let intercept = false;
      if (message.params.targetId === parent.info.targetId) {
        parents += 1;
        intercept =
          invalid !== 'child read empty' && (invalid !== 'second read empty' || parents === 2);
      }
      if (message.params.targetId === child.info.targetId) {
        children += 1;
        intercept = invalid === 'child read empty' && children === 2;
      }
      if (!intercept) return false;
      const info = structuredClone(parent.info);
      if (invalid === 'missing URL') delete info.url;
      if (invalid === 'missing type') delete info.type;
      if (invalid === 'wrong target') info.targetId = 'another-target';
      const payload =
        invalid === 'protocol error'
          ? { error: { code: -32000, message: 'synthetic metadata failure' } }
          : ['empty', 'second read empty', 'child read empty'].includes(invalid)
            ? { result: {} }
            : { result: { targetInfo: info } };
      queueMicrotask(() => wire.release(message, payload));
      return true;
    });
    denied(await attach(wire, child.info.targetId));
    assert.equal(isHeld(child.info.targetId), true);
  });
}

test('opener freshness has a bounded wait for an unanswered opener lookup', async (t) => {
  const { wire, parent, child } = await setup(t, 'unanswered');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.hold(
    (message) =>
      message.method === 'Target.getTargetInfo' && message.params.targetId === parent.info.targetId
  );
  const pending = wire.request('Target.attachToTarget', {
    targetId: child.info.targetId,
    flatten: true,
  });
  await flush();
  t.mock.timers.tick(1001);
  await flush();
  denied(await pending.answer);
  wire.hold(() => false);
  for (const message of wire.held.slice()) wire.release(message);
});

for (const initial of ['same-origin', 'about:blank', 'about:srcdoc', 'empty']) {
  test(`opener freshness persists a ${initial} observation before back-to-back cross-origin hints`, async (t) => {
    const url = initial === 'same-origin' ? first : initial === 'empty' ? '' : initial;
    const { wire, child } = await setup(t, `hints-${initial}`, url);
    wire.emit({ method: 'Target.targetCreated', params: { targetInfo: child.info } });
    assert.equal(isHeld(child.info.targetId), true);
    move(child, other);
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: child.info } });
    await flush();
    denied(await attach(wire, child.info.targetId));
  });
}

test('opener freshness retains a proven same-origin ordinary hold across navigation and later opener loss', async (t) => {
  const { wire, parent, child } = await setup(t, 'proven-hold', first);
  denied(await attach(wire, child.info.targetId));
  await flush();
  assert.equal(isHeld(child.info.targetId), true);
  move(child, other);
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: child.info } });
  await flush();
  denied(await attach(wire, child.info.targetId));
  wire.emit({ method: 'Target.targetDestroyed', params: { targetId: parent.info.targetId } });
  delete child.info.openerId;
  child.info.canAccessOpener = false;
  await flush();
  denied(await attach(wire, child.info.targetId));
});

for (const url of [
  'blob:https://foreign.invalid/id',
  'ftp://foreign.invalid/page',
  'ws://foreign.invalid/page',
  'wss://foreign.invalid/page',
  'data:text/html,hello',
  'file:///page',
  'filesystem:https://foreign.invalid/temporary/page',
]) {
  test(`opener freshness never waives an opener hold for ${url.split(':')[0]}`, async (t) => {
    const { wire, child } = await setup(t, `scheme-${url}`, url);
    denied(await attach(wire, child.info.targetId));
    assert.equal(isHeld(child.info.targetId), true);
  });
}

for (const [name, url, opener, admitted] of [
  ['credentials', 'https://user:pass@idn.invalid:443/child', 'https://idn.invalid/page', false],
  ['default port', 'https://idn.invalid:443/child', 'https://IDN.invalid/page', false],
  ['different port', 'https://idn.invalid:444/child', 'https://idn.invalid/page', true],
  ['IDN', 'https://bücher.invalid/child', 'https://xn--bcher-kva.invalid/page', false],
  ['trailing dot', 'https://idn.invalid./child', 'https://idn.invalid/page', true],
  ['different scheme', 'http://idn.invalid/child', 'https://idn.invalid/page', true],
]) {
  test(`opener freshness compares ${name} through the protocol`, async (t) => {
    const { wire, parent, child } = await setup(t, `tuple-${name}`, url);
    move(parent, opener);
    const answer = await attach(wire, child.info.targetId);
    if (admitted) {
      assert.equal(answer.error, undefined, JSON.stringify(answer));
      assert.ok(answer.result.sessionId);
    } else denied(answer);
  });
}

test('opener freshness rechecks an already attached child before reading its opener', async (t) => {
  const { wire, parent, child } = await setup(t, 'live-session');
  const attached = await attach(wire, child.info.targetId);
  assert.equal(attached.error, undefined);
  move(parent, other);
  const mark = wire.clients().length;
  const answer = await wire.send(
    'Runtime.evaluate',
    { expression: 'window.opener.document.body.textContent' },
    attached.result.sessionId
  );
  denied(answer);
  assert.equal(
    wire
      .clients()
      .slice(mark)
      .some((message) => message.method === 'Runtime.evaluate'),
    false
  );
  assert.equal(isHeld(child.info.targetId), true);
});

test('opener freshness accepts concurrent checks when fresh metadata agrees', async (t) => {
  const { wire, child } = await setup(t, 'concurrent');
  const answers = await Promise.all([
    attach(wire, child.info.targetId),
    attach(wire, child.info.targetId),
  ]);
  for (const answer of answers) {
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    assert.ok(answer.result.sessionId);
  }
  assert.equal(isHeld(child.info.targetId), false);
});
