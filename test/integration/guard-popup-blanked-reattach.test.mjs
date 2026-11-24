import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { BLANKED, guardProtected as stockGuard } from '../../src/seed/guard.js';
import { failed, flush, protocol } from './guard-ordering-fixture.mjs';

const SEED = new URL('../../src/seed/', import.meta.url);

const MUTANTS = {
  'drop-blanked-sticky': [
    'guard.js',
    `    if (!found.real && ORDINARY.test(found.url) && !this.is.url(found.url)) {
      if (found.url === BLANKED && (found.was || found.guarded)) {
        found.was = true;
        found.guarded = false;
      } else {
        found.guarded = false;
        found.was = false;
      }
    }`,
    `    if (!found.real && ORDINARY.test(found.url) && !this.is.url(found.url)) {
      found.guarded = false;
      found.was = false;
    }`,
    `    const prior = this.targets.get(info.targetId);
    this.targets.delete(info.targetId);
    this.learn(info);
    if (prior?.was || prior?.guarded) {
      const entry = this.targets.get(info.targetId);
      if (entry) entry.was = true;
    }`,
    `    this.targets.delete(info.targetId);
    this.learn(info);`,
  ],
  'admit-any-while-client-attach': [
    'guard.js',
    `  suppressReplacedBlankAttach(sessionId, info, parent, message, viaBlank = false) {
    if (!this.replacedBlank(info)) return false;
    if (this.clientAttached.has(sessionId)) return false;
    if (this.clientAttachPending(info.targetId)) {
      this.holdClientAttachEvent(info.targetId, message, parent, sessionId, viaBlank);
      return true;
    }
    this.cut(sessionId, parent, false);
    return true;
  }`,
    `  suppressReplacedBlankAttach(sessionId, info, parent, message, viaBlank = false) {
    if (!this.replacedBlank(info)) return false;
    if (this.clientAttached.has(sessionId)) return false;
    if (this.clientAttachPending(info.targetId)) return false;
    this.cut(sessionId, parent, false);
    return true;
  }`,
  ],
};

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
    const patches = MUTANTS[mutant].slice(1);
    let source = String(loaded.source);
    for (let i = 0; i < patches.length; i += 2) {
      const from = patches[i];
      const to = patches[i + 1];
      assert.ok(source.includes(from), `mutant ${mutant}: patch site missing`);
      source = source.replace(from, to);
    }
    return { ...loaded, source };
  },
});

const loadGuard = async (mutant) => {
  if (!mutant) return stockGuard;
  return (await import(`${new URL('guard.js', SEED).href}?mutant=${mutant}`)).guardProtected;
};

function blankInfo(entry) {
  entry.info.url = BLANKED;
  entry.info.title = 'blocked';
  entry.tree.frame = {
    id: entry.info.targetId,
    url: BLANKED,
    securityOrigin: '://',
    loaderId: `${entry.info.targetId}-blank-loader`,
  };
}

function clientAttaches(wire, targetId, from = 0) {
  return wire.delivered
    .slice(from)
    .filter(
      (message) =>
        message.method === 'Target.attachedToTarget' &&
        message.params?.targetInfo?.targetId === targetId
    );
}

function clientDetaches(wire, sessionId, from = 0) {
  return wire.delivered
    .slice(from)
    .filter(
      (message) =>
        message.method === 'Target.detachedFromTarget' && message.params?.sessionId === sessionId
    );
}

async function openOpener(wire, id) {
  wire.target(`${id}-opener`);
  const openerSession = await wire.attach(`${id}-opener`);
  assert.equal(
    (
      await wire.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      })
    ).error,
    undefined
  );
  assert.equal(
    (
      await wire.send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        openerSession
      )
    ).error,
    undefined
  );
  return { openerSession };
}

async function advance(timers, ms) {
  for (let left = ms; left > 0; left -= 100) {
    timers.tick(Math.min(100, left));
    await flush();
  }
}

async function cutProtectedPopup(wire, id, timers) {
  const { openerSession } = await openOpener(wire, id);
  const entry = wire.target(id);
  entry.info.url = failed;
  entry.info.title = '';
  entry.info.openerId = `${id}-opener`;
  entry.info.canAccessOpener = true;
  entry.tree.frame = {
    id,
    url: failed,
    securityOrigin: new URL(failed).origin,
    loaderId: `${id}-protected-loader`,
  };
  wire.hold((message) => message.method === 'Target.detachFromTarget');
  const auto = `${id}-auto`;
  wire.sessions.set(auto, id);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: openerSession,
    params: {
      sessionId: auto,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: true,
    },
  });
  await flush();
  await flush();
  await advance(timers, 2000);
  assert.ok(
    wire.held.some(
      (message) =>
        message.method === 'Target.detachFromTarget' && message.params?.sessionId === auto
    ),
    'the guard cuts the protected popup auto-attach'
  );
  return { entry, openerSession, auto };
}

async function releaseCut(wire, openerSession, auto) {
  for (const message of [...wire.held]) {
    if (message.params?.sessionId === auto) wire.release(message, { result: {} });
  }
  wire.emit({
    method: 'Target.detachedFromTarget',
    sessionId: openerSession,
    params: { sessionId: auto },
  });
  await flush();
}

async function blankedAutoAttach(wire, entry, openerSession, sessionId, waitingForDebugger) {
  blankInfo(entry);
  wire.hold((message) => {
    if (
      message.method !== 'Target.getTargetInfo' ||
      message.params?.targetId !== entry.info.targetId
    )
      return false;
    queueMicrotask(() => wire.release(message, { result: { targetInfo: { ...entry.info } } }));
    return true;
  });
  wire.sessions.set(sessionId, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: openerSession,
    params: {
      sessionId,
      targetInfo: {
        targetId: entry.info.targetId,
        type: 'page',
        url: '',
        title: '',
        openerId: entry.info.openerId,
        canAccessOpener: true,
        attached: true,
      },
      waitingForDebugger,
    },
  });
  await flush();
}

async function clientAttachOnly(wire, entry, from) {
  const attached = await wire.send('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  const reply = attached.result.sessionId;
  wire.sessions.set(reply, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: reply,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  await flush();
  const about = clientAttaches(wire, entry.info.targetId, from);
  assert.deepEqual(
    about.map((message) => message.params.sessionId),
    [reply],
    "a popup the guard replaced with its blocked page is attached only through the client's own attach"
  );
  return reply;
}

test('blanked re-auto-attach after a cut stays private until the client attaches (reattach order)', {
  timeout: 10000,
}, async (t) => {
  const wire = protocol(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'reattach-popup',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  const from = wire.delivered.length;
  await blankedAutoAttach(wire, entry, openerSession, 'reattach-popup-second', false);
  await advance(t.mock.timers, 2000);
  assert.deepEqual(
    clientAttaches(wire, entry.info.targetId, from).map((message) => message.params.sessionId),
    [],
    'the blanked re-auto-attach never reaches the client'
  );
  await clientAttachOnly(wire, entry, from);
});

test('blanked auto-attach after a cut stays private when named resolves to the blocked page (blank-order)', {
  timeout: 10000,
}, async (t) => {
  const wire = protocol(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'blank-order-popup',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  const from = wire.delivered.length;
  await blankedAutoAttach(wire, entry, openerSession, 'blank-order-popup-named', true);
  await advance(t.mock.timers, 2000);
  assert.deepEqual(
    clientAttaches(wire, entry.info.targetId, from).map((message) => message.params.sessionId),
    [],
    'the blanked named auto-attach never reaches the client'
  );
  await clientAttachOnly(wire, entry, from);
});

test('a pending client attach does not admit a different-session auto-attach', {
  timeout: 10000,
}, async (t) => {
  const wire = protocol(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'pending-attach-popup',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  blankInfo(entry);
  await blankedAutoAttach(wire, entry, openerSession, 'pending-attach-popup-second', false);
  await advance(t.mock.timers, 2000);
  const from = wire.delivered.length;
  wire.hold((message) => message.method === 'Target.attachToTarget');
  const pending = wire.send('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  await flush();
  const reply = `client-${entry.info.targetId}`;
  const intruder = 'pending-attach-popup-intruder';
  wire.sessions.set(intruder, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: openerSession,
    params: {
      sessionId: intruder,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  for (const message of [...wire.held]) {
    if (message.method === 'Target.attachToTarget')
      wire.release(message, { result: { sessionId: reply } });
  }
  wire.hold(() => false);
  const attached = await pending;
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  wire.sessions.set(reply, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: reply,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  await flush();
  assert.deepEqual(
    clientAttaches(wire, entry.info.targetId, from).map((message) => message.params.sessionId),
    [reply],
    "a popup the guard replaced with its blocked page is attached only through the client's own attach"
  );
});

test('blanked empty-url auto-attach does not orphan a detach at the client', {
  timeout: 10000,
}, async (t) => {
  const wire = protocol(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'orphan-detach-popup',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  const from = wire.delivered.length;
  const second = 'orphan-detach-popup-second';
  await blankedAutoAttach(wire, entry, openerSession, second, false);
  await advance(t.mock.timers, 2000);
  assert.deepEqual(
    clientAttaches(wire, entry.info.targetId, from).map((message) => message.params.sessionId),
    [],
    'the blanked re-auto-attach never reaches the client'
  );
  assert.deepEqual(
    clientDetaches(wire, second, from),
    [],
    'a suppressed blanked auto-attach does not orphan a detach at the client'
  );
});

test('blanked auto-attach with the blocked page already named stays private (showAttachment; passes on main)', {
  timeout: 10000,
}, async (t) => {
  const wire = protocol(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'shown-blank-popup',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  const from = wire.delivered.length;
  blankInfo(entry);
  const second = 'shown-blank-popup-second';
  wire.sessions.set(second, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: openerSession,
    params: {
      sessionId: second,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  await advance(t.mock.timers, 2000);
  assert.deepEqual(
    clientAttaches(wire, entry.info.targetId, from).map((message) => message.params.sessionId),
    [],
    'the blanked named auto-attach never reaches the client'
  );
});

test('a client attach event that races ahead of its reply still reaches the client', {
  timeout: 10000,
}, async (t) => {
  const wire = protocol(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'race-blank-popup',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  blankInfo(entry);
  await blankedAutoAttach(wire, entry, openerSession, 'race-blank-popup-second', false);
  await advance(t.mock.timers, 2000);
  const from = wire.delivered.length;
  wire.hold((message) => message.method === 'Target.attachToTarget');
  const pending = wire.send('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  await flush();
  const reply = `client-${entry.info.targetId}`;
  wire.sessions.set(reply, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: reply,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  for (const message of [...wire.held]) {
    if (message.method === 'Target.attachToTarget')
      wire.release(message, { result: { sessionId: reply } });
  }
  wire.hold(() => false);
  const attached = await pending;
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  await flush();
  await flush();
  assert.ok(
    clientAttaches(wire, entry.info.targetId, from).some(
      (message) => message.params.sessionId === reply
    ),
    "a popup the guard replaced with its blocked page is attached only through the client's own attach"
  );
});

test('an ordinary popup still auto-attaches after the blocked-page sticky rule', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const { openerSession } = await openOpener(wire, 'ordinary-popup');
  const entry = wire.target('ordinary-popup');
  entry.info.url = 'about:blank';
  entry.info.title = '';
  entry.info.openerId = 'ordinary-popup-opener';
  entry.info.canAccessOpener = true;
  entry.tree.frame = { id: 'ordinary-popup', url: 'about:blank', securityOrigin: '://' };
  const from = wire.delivered.length;
  const auto = 'ordinary-popup-auto';
  wire.sessions.set(auto, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: openerSession,
    params: {
      sessionId: auto,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: true,
    },
  });
  await flush();
  await flush();
  assert.ok(
    clientAttaches(wire, entry.info.targetId, from).some(
      (message) => message.params.sessionId === auto
    ),
    'an ordinary popup still auto-attaches'
  );
});

test('a held auto-attach expires closed when the client attach never answers', {
  timeout: 10000,
}, async (t) => {
  const wire = protocol(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'expire-hold-popup',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  blankInfo(entry);
  await blankedAutoAttach(wire, entry, openerSession, 'expire-hold-popup-second', false);
  await advance(t.mock.timers, 2000);
  const from = wire.delivered.length;
  wire.hold((message) => message.method === 'Target.attachToTarget');
  void wire.send('Target.attachToTarget', { targetId: entry.info.targetId, flatten: true });
  await flush();
  const intruder = 'expire-hold-popup-intruder';
  wire.sessions.set(intruder, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: openerSession,
    params: {
      sessionId: intruder,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  await advance(t.mock.timers, 1000);
  await flush();
  assert.deepEqual(
    clientAttaches(wire, entry.info.targetId, from).map((message) => message.params.sessionId),
    [],
    'a held auto-attach never reaches the client after the answer window'
  );
});

test('a client blank attach that races ahead of its reply still reaches the client', {
  timeout: 10000,
}, async (t) => {
  const wire = protocol(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'race-blank-via',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  blankInfo(entry);
  await blankedAutoAttach(wire, entry, openerSession, 'race-blank-via-second', false);
  await advance(t.mock.timers, 2000);
  const from = wire.delivered.length;
  wire.hold((message) => message.method === 'Target.attachToTarget');
  const pending = wire.send('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  await flush();
  const reply = `client-${entry.info.targetId}`;
  wire.sessions.set(reply, entry.info.targetId);
  wire.hold((message) => {
    if (
      message.method !== 'Target.getTargetInfo' ||
      message.params?.targetId !== entry.info.targetId
    )
      return false;
    queueMicrotask(() => wire.release(message, { result: { targetInfo: { ...entry.info } } }));
    return true;
  });
  wire.emit({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: reply,
      targetInfo: {
        targetId: entry.info.targetId,
        type: 'page',
        url: '',
        title: '',
        openerId: entry.info.openerId,
        canAccessOpener: true,
        attached: true,
      },
      waitingForDebugger: true,
    },
  });
  await flush();
  for (const message of [...wire.held]) {
    if (message.method === 'Target.attachToTarget')
      wire.release(message, { result: { sessionId: reply } });
  }
  wire.hold(() => false);
  const attached = await pending;
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  await flush();
  await flush();
  await advance(t.mock.timers, 2000);
  assert.ok(
    clientAttaches(wire, entry.info.targetId, from).some(
      (message) => message.params.sessionId === reply
    ),
    "a popup the guard replaced with its blocked page is attached only through the client's own attach"
  );
});

test('destroying a blanked target drops its client attach bookkeeping', {
  timeout: 10000,
}, async (t) => {
  const wire = protocol(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'destroy-blank-popup',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  blankInfo(entry);
  await blankedAutoAttach(wire, entry, openerSession, 'destroy-blank-popup-second', false);
  await advance(t.mock.timers, 2000);
  await clientAttachOnly(wire, entry, wire.delivered.length);
  const from = wire.delivered.length;
  wire.emit({
    method: 'Target.targetDestroyed',
    params: { targetId: entry.info.targetId },
  });
  await flush();
  wire.sessions.set('destroy-blank-popup-late', entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: openerSession,
    params: {
      sessionId: 'destroy-blank-popup-late',
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  await advance(t.mock.timers, 2000);
  assert.deepEqual(
    clientAttaches(wire, entry.info.targetId, from).map((message) => message.params.sessionId),
    [],
    'after destroy, a blanked auto-attach still stays private'
  );
});

test('a held intruder is dropped when its session detaches before the client reply', {
  timeout: 10000,
}, async (t) => {
  const wire = protocol(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'detach-held-popup',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  blankInfo(entry);
  await blankedAutoAttach(wire, entry, openerSession, 'detach-held-popup-second', false);
  await advance(t.mock.timers, 2000);
  const from = wire.delivered.length;
  wire.hold((message) => message.method === 'Target.attachToTarget');
  const pending = wire.send('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  await flush();
  const reply = `client-${entry.info.targetId}`;
  const intruder = 'detach-held-popup-intruder';
  wire.sessions.set(intruder, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: openerSession,
    params: {
      sessionId: intruder,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  wire.emit({
    method: 'Target.detachedFromTarget',
    sessionId: openerSession,
    params: { sessionId: intruder },
  });
  await flush();
  for (const message of [...wire.held]) {
    if (message.method === 'Target.attachToTarget')
      wire.release(message, { result: { sessionId: reply } });
  }
  wire.hold(() => false);
  await pending;
  wire.sessions.set(reply, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: reply,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  await flush();
  assert.deepEqual(
    clientAttaches(wire, entry.info.targetId, from).map((message) => message.params.sessionId),
    [reply],
    "a popup the guard replaced with its blocked page is attached only through the client's own attach"
  );
});

test('clientAttached bookkeeping is bounded and forgets destroyed holds', {
  timeout: 10000,
}, async (t) => {
  const wire = protocol(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const captured = wire.inner();
  assert.ok(captured, 'fixture retained the guard');
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'bound-client-popup',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  blankInfo(entry);
  await blankedAutoAttach(wire, entry, openerSession, 'bound-client-popup-second', false);
  await advance(t.mock.timers, 2000);
  wire.hold((message) => message.method === 'Target.attachToTarget');
  void wire.send('Target.attachToTarget', { targetId: entry.info.targetId, flatten: true });
  await flush();
  const held = 'bound-client-popup-held';
  wire.sessions.set(held, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: openerSession,
    params: {
      sessionId: held,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  assert.ok(captured.pendingClientAttaches.has(entry.info.targetId));
  wire.emit({
    method: 'Target.targetDestroyed',
    params: { targetId: entry.info.targetId },
  });
  await flush();
  assert.equal(captured.pendingClientAttaches.has(entry.info.targetId), false);
  captured.clientAttached.add('stale-session');
  for (let i = 0; i < 260; i++) {
    const id = `overflow-${i}`;
    captured.sessions.set(id, { targetId: 'overflow' });
    captured.clientAttached.add(id);
  }
  captured.sessions.set('keep-session', { targetId: 'keep' });
  captured.clientAttached.add('keep-session');
  captured.boundClientAttached();
  assert.equal(captured.clientAttached.has('stale-session'), false);
  assert.equal(captured.clientAttached.size, 256);
  assert.ok(captured.clientAttached.has('keep-session'));
  captured.sessions.set('pending-session', { targetId: entry.info.targetId });
  captured.pendingCommit.add('pending-session');
  await captured.resumeClientAttachEvent(
    {
      message: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'ghost-reprove',
          targetInfo: { ...entry.info, attached: true },
          waitingForDebugger: false,
        },
      },
      parent: openerSession,
      sessionId: 'ghost-reprove',
      viaBlank: false,
    },
    'ghost-reprove'
  );
  captured.pendingCommit.delete('pending-session');
});

test('mutant: dropping blanked sticky publishes the re-auto-attach', {
  timeout: 10000,
}, async (t) => {
  const protect = await loadGuard('drop-blanked-sticky');
  const wire = protocol(t, protect);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'mutant-reattach',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  const from = wire.delivered.length;
  await blankedAutoAttach(wire, entry, openerSession, 'mutant-reattach-second', false);
  await advance(t.mock.timers, 2000);
  assert.ok(
    clientAttaches(wire, entry.info.targetId, from).some(
      (message) => message.params.sessionId === 'mutant-reattach-second'
    ),
    'mutant must turn the blanked re-auto-attach row red'
  );
});

test('mutant: admitting any session while a client attach is in flight publishes the intruder', {
  timeout: 10000,
}, async (t) => {
  const protect = await loadGuard('admit-any-while-client-attach');
  const wire = protocol(t, protect);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { entry, openerSession, auto } = await cutProtectedPopup(
    wire,
    'mutant-pending',
    t.mock.timers
  );
  await releaseCut(wire, openerSession, auto);
  blankInfo(entry);
  await blankedAutoAttach(wire, entry, openerSession, 'mutant-pending-second', false);
  await advance(t.mock.timers, 2000);
  const from = wire.delivered.length;
  wire.hold((message) => message.method === 'Target.attachToTarget');
  const pending = wire.send('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  await flush();
  const reply = `client-${entry.info.targetId}`;
  const intruder = 'mutant-pending-intruder';
  wire.sessions.set(intruder, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: openerSession,
    params: {
      sessionId: intruder,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  for (const message of [...wire.held]) {
    if (message.method === 'Target.attachToTarget')
      wire.release(message, { result: { sessionId: reply } });
  }
  wire.hold(() => false);
  await pending;
  wire.sessions.set(reply, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: reply,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger: false,
    },
  });
  await flush();
  await flush();
  assert.ok(
    clientAttaches(wire, entry.info.targetId, from).some(
      (message) => message.params.sessionId === intruder
    ),
    'mutant must turn the pending-client-attach row red'
  );
});
