import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { flush, ordinary, protectedOrigin, recoveryProtocol } from './guard-recovery-fixture.mjs';

async function admitted(t) {
  const wire = recoveryProtocol(t);
  wire.target('proof');
  const client = await wire.connect();
  const session = await client.attach('proof');
  assert.equal((await client.send('Page.enable', {}, session)).error, undefined);
  const owner = wire.calls.find((call) => call.method === 'Fetch.enable')?.sessionId;
  assert.ok(owner, 'the backend observed the guard-owned navigation session');
  return { wire, client, session, owner };
}

for (const authoritative of [false, true]) {
  test(`a public protected error tree records only an owned private re-read ${authoritative}`, {
    timeout: 5000,
  }, async (t) => {
    const { wire, client, session, owner } = await admitted(t);
    const ordinaryTree = structuredClone(wire.targets.get('proof').tree);
    let hinted = false;
    let release;
    const ready = new Promise((resolve) => {
      release = resolve;
    });
    t.after(release);
    const errorTree = {
      frame: {
        ...ordinaryTree.frame,
        url: 'chrome-error://chromewebdata/',
        securityOrigin: '://',
        unreachableUrl: `${protectedOrigin}/private`,
      },
    };
    wire.trees(async (entry, caller) => {
      if (caller === session) {
        hinted = true;
        return errorTree;
      }
      if (caller === owner && hinted) {
        await ready;
        return authoritative ? errorTree : ordinaryTree;
      }
      return ordinaryTree;
    });
    const mark = wire.calls.length;
    const pending = client.send('Runtime.evaluate', { expression: '1' }, session);
    await flush();
    await flush();
    assert.ok(
      wire.calls
        .slice(mark)
        .some((call) => call.method === 'Page.getFrameTree' && call.sessionId === session)
    );
    assert.ok(
      wire.calls
        .slice(mark)
        .some((call) => call.method === 'Page.getFrameTree' && call.sessionId === owner),
      'a public hint requires an existing own-session re-read'
    );
    const entry = wire.targets.get('proof');
    entry.info = { ...entry.info, url: `${protectedOrigin}/private` };
    const before = await wire.connect();
    const unrecorded = await before.send('Target.getTargetInfo', { targetId: 'proof' });
    assert.equal(
      unrecorded.error?.message,
      PROTECTED,
      'the public tree alone cannot record recovery evidence'
    );
    before.close();
    release();
    assert.equal((await pending).error?.message, PROTECTED);
    await flush();
    await flush();
    client.close();
    await flush();
    const after = await wire.connect();
    const identified = await after.send('Target.getTargetInfo', { targetId: 'proof' });
    if (authoritative) {
      assert.equal(identified.error, undefined);
      assert.equal(identified.result.targetInfo.url, protectedOrigin);
    } else {
      assert.equal(identified.error?.message, PROTECTED);
      assert.equal(identified.result, undefined);
    }
  });
}

async function recovering(t) {
  const initial = await admitted(t);
  initial.wire.blocked('proof');
  await flush();
  initial.client.close();
  await flush();
  const client = await initial.wire.connect();
  const session = await client.attach('proof');
  assert.equal((await client.send('Page.enable', {}, session)).error, undefined);
  const owner = initial.wire.calls
    .filter((call) => call.method === 'Fetch.enable')
    .at(-1)?.sessionId;
  const destination = `${ordinary}?recovered=proof`;
  const frame = {
    id: 'root-proof',
    url: destination,
    securityOrigin: new URL(destination).origin,
    loaderId: 'accepted-proof',
  };
  const entry = initial.wire.targets.get('proof');
  entry.info = { ...entry.info, url: destination, title: 'ordinary' };
  entry.tree = { frame };
  const gate = initial.wire.pauseTree((caller) => caller === session);
  t.after(gate.release);
  initial.wire.emit({ method: 'Page.frameNavigated', sessionId: owner, params: { frame } });
  await flush();
  return { ...initial, client, session, owner, frame, gate };
}

test('a recovery load waits for own proof and forwards only its finite timestamp', {
  timeout: 5000,
}, async (t) => {
  const { wire, client, session, gate } = await recovering(t);
  const mark = client.delivered.length;
  wire.emit({
    method: 'Page.loadEventFired',
    sessionId: session,
    params: { timestamp: 123.5, url: `${protectedOrigin}/private`, content: 'sealed' },
  });
  await flush();
  assert.equal(
    client.delivered.slice(mark).some((message) => message.method === 'Page.loadEventFired'),
    false
  );
  gate.release();
  await flush();
  await flush();
  assert.deepEqual(
    client.delivered.slice(mark).filter((message) => message.method === 'Page.loadEventFired'),
    [{ method: 'Page.loadEventFired', sessionId: session, params: { timestamp: 123.5 } }]
  );
});

for (const failure of [
  'missing timestamp',
  'nonfinite timestamp',
  'string timestamp',
  'session detached',
  'protected commit',
  'stale loader',
]) {
  test(`a held recovery load is dropped after ${failure}`, { timeout: 5000 }, async (t) => {
    const { wire, client, session, owner, frame, gate } = await recovering(t);
    const mark = client.delivered.length;
    const timestamp =
      failure === 'missing timestamp'
        ? undefined
        : failure === 'nonfinite timestamp'
          ? Infinity
          : failure === 'string timestamp'
            ? '123'
            : 123;
    wire.emit({ method: 'Page.loadEventFired', sessionId: session, params: { timestamp } });
    await flush();
    if (failure === 'session detached')
      wire.emit({ method: 'Target.detachedFromTarget', params: { sessionId: session } });
    if (failure === 'protected commit') wire.commit('proof', `${protectedOrigin}/private`);
    if (failure === 'stale loader')
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: session,
        params: { frame: { ...frame, loaderId: 'newer-loader' } },
      });
    gate.release();
    await flush();
    await flush();
    assert.equal(
      client.delivered.slice(mark).some((message) => message.method === 'Page.loadEventFired'),
      false
    );
  });
}

test('only a current accepted own ordinary frame URL survives recovery metadata redaction', {
  timeout: 5000,
}, async (t) => {
  const { wire, client, session, frame, gate } = await recovering(t);
  const mark = client.delivered.length;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: {
      frame: { ...frame, name: 'sealed-name', title: 'sealed-title', extra: 'sealed-content' },
    },
  });
  await flush();
  const events = client.delivered
    .slice(mark)
    .filter((message) => message.method === 'Page.frameNavigated');
  assert.equal(events.length, 1);
  assert.equal(events[0].params.frame.url, frame.url);
  assert.equal(events[0].params.frame.name, undefined);
  assert.equal(events[0].params.frame.extra, undefined);
  assert.notEqual(events[0].params.frame.title, 'sealed-title');
  gate.release();
});

for (const [kind, url] of [
  ['protected', `${protectedOrigin}/private?secret=value`],
  ['error', 'chrome-error://chromewebdata/'],
  ['redactor-sensitive', `${ordinary}?next=https://vault.sliccy.ai/private`],
]) {
  test(`a matching own and public ${kind} URL is never restored through metadata`, {
    timeout: 5000,
  }, async (t) => {
    const { wire, client, session, owner, frame, gate } = await recovering(t);
    gate.release();
    await flush();
    const marked = {
      ...frame,
      url,
      securityOrigin: kind === 'error' ? '://' : new URL(url).origin,
      ...(kind === 'error' ? { unreachableUrl: `${protectedOrigin}/private` } : {}),
    };
    const entry = wire.targets.get('proof');
    entry.info = { ...entry.info, url };
    entry.tree = { frame: marked };
    const hold = wire.pauseTree((caller) => caller === session);
    t.after(hold.release);
    wire.emit({ method: 'Page.frameNavigated', sessionId: owner, params: { frame: marked } });
    const start = client.delivered.length;
    wire.emit({ method: 'Page.frameNavigated', sessionId: session, params: { frame: marked } });
    await flush();
    const events = client.delivered
      .slice(start)
      .filter((message) => message.method === 'Page.frameNavigated');
    for (const event of events) assert.notEqual(event.params.frame.url, url);
    assert.equal(JSON.stringify(client.delivered.slice(start)).includes('/private'), false);
    if (kind === 'redactor-sensitive')
      assert.equal(
        events.length,
        1,
        'the matching accepted ordinary event remains observable but sanitized'
      );
    hold.release();
  });
}

for (const kind of ['child', 'stale']) {
  test(`a ${kind} frame does not restore an accepted root URL`, { timeout: 5000 }, async (t) => {
    const { wire, client, session, frame, gate } = await recovering(t);
    const mark = client.delivered.length;
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: {
        frame: {
          ...frame,
          ...(kind === 'child' ? { parentId: 'different-root' } : { loaderId: 'stale-loader' }),
        },
      },
    });
    await flush();
    for (const event of client.delivered
      .slice(mark)
      .filter((message) => message.method === 'Page.frameNavigated'))
      assert.notEqual(event.params.frame.url, frame.url);
    gate.release();
  });
}
