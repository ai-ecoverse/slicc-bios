import assert from 'node:assert/strict';
import { test } from 'node:test';
import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };

const { guardProtected, PROTECTED } = await import(
  process.env.GUARD_SOURCE ?? '../../src/seed/guard.js'
);

const flush = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REFUSAL = catalog.protectedOrigins.refusal;
const OWN = 'https://seven.sliccy.ai';

function blankWire(t, { href = 'about:blank', locationPlan, hold } = {}) {
  let guardInst;
  const targets = new Map();
  const sessions = new Map();
  const delivered = [];
  const pending = new Map();
  const held = [];
  let next = 0;
  let locationStep = 0;
  let holdFn = hold ?? (() => false);
  const key = (id, sessionId) => JSON.stringify([sessionId ?? null, id]);
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      if (holdFn(message)) return void held.push(message);
      queueMicrotask(() => respond(message));
    },
    close() {},
    captureGuard(instance) {
      guardInst = instance;
    },
  };
  const guard = guardProtected(raw, OWN);
  assert.ok(guardInst, 'captureGuard');
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    delivered.push(message);
    pending.get(key(message.id, message.sessionId))?.(message);
    pending.delete(key(message.id, message.sessionId));
  };
  t.after(() => guard.close());
  const emit = (message) => raw.onmessage(JSON.stringify(message));
  function respond(message) {
    const { id, method, params = {}, sessionId } = message;
    const targetId = params.targetId ?? sessions.get(sessionId);
    const target = targets.get(targetId);
    let result = {};
    let error;
    if (method === 'Target.getTargetInfo') result = { targetInfo: target.info };
    if (method === 'Target.getTargets')
      result = { targetInfos: [...targets.values()].map((entry) => entry.info) };
    if (method === 'Target.attachToTarget') {
      const attached = `${id >= 2 ** 30 ? 'guard' : 'client'}-${targetId}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Page.getFrameTree') result = { frameTree: target.tree };
    if (method === 'Page.getNavigationHistory')
      result = {
        currentIndex: 0,
        entries: [{ id: 1, url: target.info.url, title: 'blank' }],
      };
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'location.href') {
        if (locationPlan) {
          const step = locationPlan[Math.min(locationStep++, locationPlan.length - 1)];
          if (step.error) error = { code: -32000, message: step.error };
          else result = { result: { type: 'string', value: step.value } };
        } else result = { result: { type: 'string', value: href } };
      } else result = { result: { type: 'number', value: 2 } };
    }
    if (method === 'DOM.getDocument')
      result = { root: { nodeId: 1, nodeName: '#document', children: [] } };
    if (method === 'Page.captureScreenshot') result = { data: 'c3ludGhldGlj' };
    emit({ id, ...(sessionId ? { sessionId } : {}), ...(error ? { error } : { result }) });
  }
  targets.set('blank', {
    info: { targetId: 'blank', type: 'page', url: 'about:blank' },
    tree: { frame: { id: 'blank', url: 'about:blank', securityOrigin: '://' } },
  });
  async function send(method, params = {}, sessionId) {
    const id = ++next;
    const answer = new Promise((resolve) => pending.set(key(id, sessionId), resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  }
  async function attach() {
    const answer = await send('Target.attachToTarget', { targetId: 'blank', flatten: true });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    await flush();
    return answer.result.sessionId;
  }
  async function ready() {
    const session = await attach();
    await send('Page.enable', {}, session);
    await send('Runtime.enable', {}, session);
    await flush();
    emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-blank',
      params: { frame: { id: 'blank', url: 'about:blank', securityOrigin: '://' } },
    });
    await flush();
    guardInst.scope('blank');
    return session;
  }
  function contextCreated(session, origin, extra = {}) {
    const context = {
      id: extra.id ?? 1,
      uniqueId: extra.uniqueId ?? `u-${origin}`,
      origin,
      name: extra.name ?? '',
      auxData: {
        isDefault: extra.isDefault ?? true,
        type: extra.type ?? 'default',
        frameId: extra.frameId ?? 'blank',
      },
    };
    emit({
      method: 'Runtime.executionContextCreated',
      sessionId: session,
      params: { context },
    });
    return context;
  }
  function release(message) {
    assert.ok(message, 'held message');
    held.splice(held.indexOf(message), 1);
    respond(message);
  }
  return {
    send,
    emit,
    delivered,
    held,
    release,
    ready,
    contextCreated,
    guard: guardInst,
    locationSteps: () => locationStep,
    hold(fn) {
      holdFn = fn;
    },
  };
}

const sliceMethods = (delivered, mark) => delivered.slice(mark).map((message) => message.method);

test('an inheriting about:blank target hides a default context whose origin is about:blank', {
  timeout: 5000,
}, async (t) => {
  const wire = blankWire(t);
  const session = await wire.ready();
  const mark = wire.delivered.length;
  wire.contextCreated(session, 'about:blank');
  await wait(150);
  await flush();
  const methods = sliceMethods(wire.delivered, mark);
  assert.equal(
    methods.includes('Runtime.executionContextCreated'),
    false,
    'protected context origin must not reach the client'
  );
  assert.equal(methods.includes('Target.detachedFromTarget'), true, 'session is cut');
  const later = await wire.send('Runtime.evaluate', { expression: '1+1' }, session);
  assert.equal(later.error?.message, PROTECTED, JSON.stringify(later));
});

test('an inheriting about:blank target admits a default context whose origin is about://', {
  timeout: 5000,
}, async (t) => {
  const wire = blankWire(t);
  const session = await wire.ready();
  const mark = wire.delivered.length;
  wire.contextCreated(session, 'about://');
  await wait(150);
  await flush();
  const methods = sliceMethods(wire.delivered, mark);
  assert.equal(methods.includes('Target.detachedFromTarget'), false, 'session stays attached');
  const later = await wire.send('Runtime.evaluate', { expression: '1+1' }, session);
  assert.equal(later.error, undefined, JSON.stringify(later));
  assert.equal(later.result?.result?.value, 2);
  const consoleMark = wire.delivered.length;
  wire.emit({
    method: 'Runtime.consoleAPICalled',
    sessionId: session,
    params: {
      type: 'log',
      executionContextId: 1,
      args: [{ type: 'string', value: 'admitted-context' }],
      timestamp: 1,
    },
  });
  await flush();
  const consoleEvent = wire.delivered
    .slice(consoleMark)
    .find((message) => message.method === 'Runtime.consoleAPICalled');
  assert.ok(consoleEvent, 'runtime events on the admitted session reach the client');
  assert.equal(
    JSON.stringify(consoleEvent).includes('admitted-context'),
    true,
    'console payload is visible'
  );
});

test('scopeEvent invalidation refuses a blank screenshot once about:blank context arrives', {
  timeout: 5000,
}, async (t) => {
  const wire = blankWire(t);
  const session = await wire.ready();
  wire.hold((message) => message.method === 'Page.captureScreenshot' && message.id < 2 ** 30);
  const shot = wire.send('Page.captureScreenshot', {}, session);
  await flush();
  const pending = wire.held.find((message) => message.method === 'Page.captureScreenshot');
  assert.ok(pending, 'screenshot is waiting on the wire');
  assert.equal(wire.guard.shots.size > 0, true, 'blank shot was noted');
  wire.contextCreated(session, 'about:blank');
  await wait(150);
  await flush();
  assert.equal(wire.guard.shots.size, 0, 'protected context origin cleared the shot');
  wire.release(pending);
  const answer = await shot;
  assert.equal(answer.error?.message, PROTECTED, JSON.stringify(answer));
});

test('contextRetryBlocked refuses to retry a protected about:blank context probe', {
  timeout: 5000,
}, async (t) => {
  const wire = blankWire(t, {
    locationPlan: [{ error: REFUSAL }, { value: 'about:blank' }],
  });
  const session = await wire.ready();
  const mark = wire.delivered.length;
  wire.contextCreated(session, 'about:blank', { id: 7, uniqueId: 'retry-blank' });
  await wait(250);
  await flush();
  assert.equal(wire.locationSteps(), 1, 'protected origin blocks the retry');
  assert.equal(
    sliceMethods(wire.delivered, mark).includes('Runtime.executionContextCreated'),
    false
  );
  assert.equal(sliceMethods(wire.delivered, mark).includes('Target.detachedFromTarget'), false);
  const later = await wire.send('Runtime.evaluate', { expression: '1+1' }, session);
  assert.equal(
    later.error,
    undefined,
    'session was not cut by walked when the probe dropped first'
  );
});

test('contextRetryBlocked retries an ordinary about:// context probe', {
  timeout: 5000,
}, async (t) => {
  const wire = blankWire(t, {
    locationPlan: [{ error: REFUSAL }, { value: 'about:blank' }],
  });
  const session = await wire.ready();
  wire.contextCreated(session, 'about://', { id: 8, uniqueId: 'retry-about' });
  await wait(250);
  await flush();
  assert.equal(wire.locationSteps() >= 2, true, 'ordinary origin allows the retry');
  const later = await wire.send('Runtime.evaluate', { expression: '1+1' }, session);
  assert.equal(later.error, undefined, JSON.stringify(later));
});

test('commitScope keeps an about:// context from stamping the frame as a protected url', {
  timeout: 5000,
}, async (t) => {
  const wire = blankWire(t, {
    locationPlan: [{ error: REFUSAL }, { value: 'about:blank' }],
  });
  const session = await wire.ready();
  wire.contextCreated(session, 'about://', { id: 3, uniqueId: 'commit-about' });
  await wait(250);
  await flush();
  assert.equal(wire.locationSteps() >= 2, true, 'frame stays ordinary so the probe can retry');
  const later = await wire.send('Runtime.evaluate', { expression: '1+1' }, session);
  assert.equal(later.error, undefined, JSON.stringify(later));
});

test('judgedMain leaves a protected about:blank default context out of world.main', {
  timeout: 5000,
}, async (t) => {
  const wire = blankWire(t);
  const session = await wire.ready();
  wire.contextCreated(session, 'about:blank', { id: 4, uniqueId: 'main-blank' });
  await wait(150);
  await flush();
  assert.equal(wire.guard.worlds.get(session)?.main, undefined);
});

test('judgedMain records an ordinary about:// default context as world.main', {
  timeout: 5000,
}, async (t) => {
  const wire = blankWire(t);
  const session = await wire.ready();
  wire.contextCreated(session, 'about://', { id: 5, uniqueId: 'main-about' });
  await wait(150);
  await flush();
  assert.equal(wire.guard.worlds.get(session)?.main, 'main-about');
});

test('isolated world tracking ignores a protected about:blank isolated origin', {
  timeout: 5000,
}, async (t) => {
  const wire = blankWire(t);
  const session = await wire.ready();
  wire.contextCreated(session, 'about:blank', {
    id: 11,
    uniqueId: 'iso-blank',
    type: 'isolated',
    isDefault: false,
    name: 'isolated-blank',
  });
  await wait(100);
  await flush();
  assert.equal(wire.guard.worlds.get(session)?.isolated.has(11), false);
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Runtime.bindingCalled',
    sessionId: session,
    params: { name: 'probe', payload: 'iso-secret', executionContextId: 11 },
  });
  await flush();
  assert.equal(
    wire.delivered.slice(mark).some((message) => message.method === 'Runtime.bindingCalled'),
    false,
    'binding from a non-isolated protected origin stays hidden'
  );
});

test('isolated world tracking admits an ordinary about:// isolated origin', {
  timeout: 5000,
}, async (t) => {
  const wire = blankWire(t);
  const session = await wire.ready();
  wire.contextCreated(session, 'about://', {
    id: 12,
    uniqueId: 'iso-about',
    type: 'isolated',
    isDefault: false,
    name: 'isolated-about',
  });
  await wait(100);
  await flush();
  assert.equal(wire.guard.worlds.get(session)?.isolated.has(12), true);
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Runtime.bindingCalled',
    sessionId: session,
    params: { name: 'probe', payload: 'iso-visible', executionContextId: 12 },
  });
  await flush();
  const binding = wire.delivered
    .slice(mark)
    .find((message) => message.method === 'Runtime.bindingCalled');
  assert.ok(binding, 'binding from an ordinary isolated origin reaches the client');
  assert.equal(JSON.stringify(binding).includes('iso-visible'), true);
});
