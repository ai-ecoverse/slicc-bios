import assert from 'node:assert/strict';
import { test } from 'node:test';
import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { EXTENSION_FRAME, PROTECTED, UNGUARDED } from '../../src/seed/guard.js';
import { flush, ordinary, plainFrame, protectedOrigin, protocol } from './guard-state-fixture.mjs';

const CHROME_REFUSAL = 'Cannot access a chrome-extension:// URL of different extension';
const VAULT = 'https://vault.sliccy.ai/';
const PRIVATE = 2 ** 30;

function framed(t) {
  const wire = protocol(t);
  const state = { cause: null, only: null };
  wire.hold((message) => {
    if (message.method !== 'Target.attachToTarget' || message.id < PRIVATE || !state.cause)
      return false;
    if (state.only && message.params.targetId !== state.only) return false;
    const error = { code: -32000, message: state.cause };
    queueMicrotask(() => wire.release(message, { error }));
    return true;
  });
  const attach = (targetId) => wire.send('Target.attachToTarget', { targetId, flatten: true });
  const privateAttaches = () =>
    wire.sent.filter(
      (message) => message.method === 'Target.attachToTarget' && message.id >= PRIVATE
    );
  return { wire, state, attach, privateAttaches };
}

async function read(wire, sessionId) {
  const answer = await wire.send(
    'Runtime.evaluate',
    { expression: 'document.title', returnByValue: true },
    sessionId
  );
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  return answer.result.result.value;
}

for (const cause of [EXTENSION_FRAME, CHROME_REFUSAL]) {
  test(`a private attach refused with "${cause.slice(0, 40)}" answers the extension-frame refusal`, async (t) => {
    const { wire, state, attach, privateAttaches } = framed(t);
    wire.target('tab');
    state.cause = cause;
    const refused = await attach('tab');
    assert.equal(refused.error?.message, EXTENSION_FRAME, JSON.stringify(refused));
    assert.notEqual(refused.error?.message, UNGUARDED);
    assert.equal(wire.clients().filter((m) => m.method === 'Target.attachToTarget').length, 0);
    const again = await attach('tab');
    assert.equal(again.error?.message, EXTENSION_FRAME, JSON.stringify(again));
    assert.equal(privateAttaches().length, 2, 'every attach tries the private arm again');
  });
}

test('once the foreign frame is gone the same tab attaches again without a reload', async (t) => {
  const { wire, state, attach, privateAttaches } = framed(t);
  wire.target('tab');
  state.cause = EXTENSION_FRAME;
  assert.equal((await attach('tab')).error?.message, EXTENSION_FRAME);
  state.cause = null;
  const since = wire.sent.length;
  const attached = await attach('tab');
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  await flush();
  assert.equal(privateAttaches().length, 2);
  const later = wire.sent.slice(since);
  const arm = later.findIndex(
    (message) => message.method === 'Fetch.enable' && message.sessionId === 'guard-tab'
  );
  const tree = later.findIndex(
    (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'guard-tab'
  );
  const forwarded = later.findIndex(
    (message) => message.method === 'Target.attachToTarget' && message.id < PRIVATE
  );
  assert.ok(arm >= 0 && arm < forwarded, 'the retried nav arms Fetch before the client attaches');
  assert.ok(tree >= 0 && tree < forwarded, 'the retried nav places the tab before it attaches');
  assert.equal(await read(wire, attached.result.sessionId), 'synthetic-content');
});

test('a private session detached when the frame appears surfaces the refusal, then recovers', async (t) => {
  const { wire, state, attach, privateAttaches } = framed(t);
  wire.target('tab');
  const first = await attach('tab');
  assert.equal(first.error, undefined, JSON.stringify(first));
  await flush();
  state.cause = EXTENSION_FRAME;
  for (const sessionId of ['guard-tab', first.result.sessionId])
    wire.emit({ method: 'Target.detachedFromTarget', params: { sessionId, targetId: 'tab' } });
  await flush();
  const refused = await attach('tab');
  assert.equal(refused.error?.message, EXTENSION_FRAME, JSON.stringify(refused));
  state.cause = null;
  const back = await attach('tab');
  assert.equal(back.error, undefined, JSON.stringify(back));
  await flush();
  assert.equal(privateAttaches().length, 3);
  assert.equal(await read(wire, back.result.sessionId), 'synthetic-content');
});

test('seven’s own tab stays refused while the frame is there and after it goes', async (t) => {
  const { wire, state, attach } = framed(t);
  wire.target('seven', 'page', { ...plainFrame('seven'), url: `${protectedOrigin}/app` });
  state.cause = EXTENSION_FRAME;
  assert.equal((await attach('seven')).error?.message, PROTECTED);
  state.cause = null;
  assert.equal((await attach('seven')).error?.message, PROTECTED);
  assert.equal(wire.clients().filter((m) => m.method === 'Target.attachToTarget').length, 0);
});

test('a tab that moved to the vault while the frame blocked it stays refused on retry', async (t) => {
  const { wire, state, attach } = framed(t);
  const entry = wire.target('tab');
  state.cause = EXTENSION_FRAME;
  assert.equal((await attach('tab')).error?.message, EXTENSION_FRAME);
  entry.info = { ...entry.info, url: VAULT };
  entry.tree = {
    frame: { ...plainFrame('tab'), url: VAULT, securityOrigin: new URL(VAULT).origin },
  };
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  assert.equal((await attach('tab')).error?.message, PROTECTED);
  state.cause = null;
  assert.equal((await attach('tab')).error?.message, PROTECTED);
  assert.equal(wire.clients().filter((m) => m.method === 'Target.attachToTarget').length, 0);
});

test('a retried nav that finds a vault frame in the tab keeps the tab refused', async (t) => {
  const { wire, state, attach } = framed(t);
  const entry = wire.target('tab');
  state.cause = EXTENSION_FRAME;
  assert.equal((await attach('tab')).error?.message, EXTENSION_FRAME);
  entry.tree = {
    frame: plainFrame('tab'),
    childFrames: [
      {
        frame: {
          id: 'tab-vault',
          parentId: 'tab',
          url: VAULT,
          securityOrigin: new URL(VAULT).origin,
        },
      },
    ],
  };
  state.cause = null;
  const retried = await attach('tab');
  assert.match(retried.error?.message ?? '', /^slicc: refused:/, JSON.stringify(retried));
  assert.equal(retried.result, undefined);
});

for (const cause of [PROTECTED, catalog.protectedOrigins.refusal]) {
  test(`a nav refused as protected ("${cause.slice(15, 45)}") is not retried`, async (t) => {
    const { wire, state, attach, privateAttaches } = framed(t);
    wire.target('tab');
    state.cause = cause;
    assert.equal((await attach('tab')).error?.message, UNGUARDED);
    state.cause = null;
    assert.equal((await attach('tab')).error?.message, UNGUARDED);
    assert.equal(privateAttaches().length, 1);
    assert.equal(wire.clients().filter((m) => m.method === 'Target.attachToTarget').length, 0);
  });
}

test('an ordinary tab next to a framed one is unaffected', async (t) => {
  const { wire, state, attach } = framed(t);
  wire.target('tab');
  wire.target('other', 'page', { ...plainFrame('other'), url: `${ordinary}?other` });
  state.cause = EXTENSION_FRAME;
  state.only = 'tab';
  assert.equal((await attach('tab')).error?.message, EXTENSION_FRAME);
  const other = await attach('other');
  assert.equal(other.error, undefined, JSON.stringify(other));
});

test('a nav whose Fetch arm failed is detached and armed again at the next attach', async (t) => {
  const wire = protocol(t);
  wire.target('armed');
  let refuse = true;
  wire.hold((message) => {
    if (!refuse || message.method !== 'Fetch.enable' || message.id < PRIVATE) return false;
    queueMicrotask(() =>
      wire.release(message, { error: { code: -32000, message: 'synthetic arm failure' } })
    );
    return true;
  });
  const failed = await wire.send('Target.attachToTarget', { targetId: 'armed', flatten: true });
  assert.equal(failed.error?.message, UNGUARDED);
  refuse = false;
  const since = wire.sent.length;
  const attached = await wire.send('Target.attachToTarget', { targetId: 'armed', flatten: true });
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  assert.ok(
    wire.sent
      .slice(since)
      .some(
        (message) =>
          message.method === 'Target.detachFromTarget' && message.params.sessionId === 'guard-armed'
      )
  );
});

test('a client session whose private watch was lost is refused until it attaches again', async (t) => {
  const wire = protocol(t);
  wire.target('lost');
  const session = await wire.attach('lost');
  wire.emit({
    method: 'Target.detachedFromTarget',
    params: { sessionId: 'guard-lost', targetId: 'lost' },
  });
  await flush();
  const read = await wire.send('Runtime.evaluate', { expression: '1' }, session);
  assert.equal(read.error?.message, UNGUARDED);
});
