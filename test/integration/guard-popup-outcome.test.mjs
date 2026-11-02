import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, PROTECTED, SCRIPTS } from '../../src/seed/guard.js';
import { assertChildEvents, assertPopupOutcome, popupReport } from './guard-popup.mjs';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

async function blockedPopup(t) {
  const wire = protocol(t);
  wire.target('popup-opener');
  const entry = wire.target('popup-outcome');
  entry.info.openerId = 'popup-opener';
  const session = await wire.attach('popup-outcome');
  for (const method of ['Page.addScriptToEvaluateOnNewDocument', 'Runtime.addBinding'])
    assert.equal((await wire.send(method, {}, session)).error?.message, SCRIPTS);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: 'guard-popup-outcome',
    params: {
      requestId: 'popup-request',
      resourceType: 'Document',
      frameId: 'popup-outcome',
      request: { url: failed },
    },
  });
  entry.tree.frame = { ...errorFrame('popup-outcome'), loaderId: 'error-loader' };
  entry.info.url = entry.tree.frame.url;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-popup-outcome',
    params: { frame: entry.tree.frame },
  });
  await flush();
  assert.ok(
    wire.sent.some(
      ({ method, params }) =>
        method === 'Fetch.failRequest' && params.errorReason === 'BlockedByClient'
    )
  );
  t.mock.timers.tick(5000);
  await flush();
  assert.ok(
    wire.sent.some(({ method, params }) => method === 'Page.navigate' && params.url === BLANKED)
  );
  entry.tree.frame = {
    ...plainFrame('popup-outcome'),
    url: BLANKED,
    securityOrigin: '://',
    loaderId: 'blank-loader',
  };
  entry.info.url = BLANKED;
  entry.info.title = 'blocked';
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-popup-outcome',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  wire.hold((message) => {
    if (message.method !== 'Runtime.evaluate') return false;
    queueMicrotask(() =>
      wire.release(message, {
        result: { result: { type: 'object', subtype: 'null', value: null } },
      })
    );
    return true;
  });
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'popup-outcome',
    flatten: true,
  });
  assert.equal(attached.error, undefined);
  const own = {
    async send(method) {
      if (method === 'Target.attachToTarget') return { result: { sessionId: 'harness-popup' } };
      if (method === 'Target.getTargetInfo') return { result: { targetInfo: entry.info } };
      if (method === 'Page.getFrameTree') return { result: { frameTree: entry.tree } };
      if (method === 'Runtime.evaluate')
        return { result: { result: { type: 'object', subtype: 'null', value: null } } };
      return { result: {} };
    },
  };
  const popup = { targetId: 'popup-outcome', url: '' };
  const report = await popupReport(own, wire, popup, attached, 'https://protected.invalid');
  return { popup, attached, report };
}

test('popup outcome accepts the guarded replacement after a prevented load and a private wipe', {
  timeout: 5000,
}, async (t) => {
  const { popup, attached, report } = await blockedPopup(t);
  assert.equal(report.pathObserved, 'blocked blank after attach reply');
  const proof = assertPopupOutcome(
    'C3.popup',
    popup,
    attached,
    report,
    { found: false, value: null },
    false
  );
  assertChildEvents('C3.popup', 'popup', failed, popup, replacementEvents(report, attached), proof);
});

test('popup outcome keeps the protected refusal and leakage checks independent', () => {
  const attached = { error: { message: PROTECTED } };
  assertPopupOutcome('C3.popup', {}, attached, null, { value: null }, false);
  assert.throws(() =>
    assertPopupOutcome('C3.popup', {}, attached, null, { value: 'marker' }, false)
  );
  assert.throws(() => assertPopupOutcome('C3.popup', {}, attached, null, { value: null }, true));
});

const SHOWN = 'data:text/html,<title>blocked<%2Ftitle>';

function replacementEvents(report, attached) {
  const targetInfo = report.target.result.targetInfo;
  return [
    { method: 'Target.targetCreated', params: { targetInfo } },
    { method: 'Target.targetInfoChanged', params: { targetInfo: { ...targetInfo, title: SHOWN } } },
    { method: 'Target.targetInfoChanged', params: { targetInfo } },
    {
      method: 'Target.attachedToTarget',
      params: { targetInfo, sessionId: attached.result.sessionId, waitingForDebugger: false },
    },
    {
      method: 'Runtime.executionContextCreated',
      params: {
        context: {
          id: 1,
          origin: '://',
          name: '',
          uniqueId: '-2443638084466758385.-6751452122298768778',
          auxData: { isDefault: true, type: 'default', frameId: targetInfo.targetId },
        },
      },
      sessionId: attached.result.sessionId,
    },
  ];
}

const only = (method, title) => (events) =>
  events.find(
    (event) => event.method === method && (!title || event.params.targetInfo.title === title)
  );
const attachedEvent = only('Target.attachedToTarget');
const shownEvent = only('Target.targetInfoChanged', SHOWN);
const contextEvent = only('Runtime.executionContextCreated');
const context = (events) => contextEvent(events).params.context;

const mutations = {
  'different session': (events) => {
    attachedEvent(events).params.sessionId = 'unproved-client';
  },
  'protected URL': (events) => {
    attachedEvent(events).params.targetInfo.url = failed;
  },
  'ordinary URL': (events) => {
    attachedEvent(events).params.targetInfo.url = 'https://ordinary.invalid/page';
  },
  'wrong title': (events) => {
    attachedEvent(events).params.targetInfo.title = 'other';
  },
  frame: (events) => {
    attachedEvent(events).params.frame = { id: 'popup-outcome' };
  },
  context: (events) => {
    attachedEvent(events).params.context = { origin: 'null' };
  },
  marker: (events) => {
    attachedEvent(events).params.marker = 'STAND';
  },
  'missing proof': (events, proof) => ({ events, proof: null }),
  'wrong proved target': (events, proof) => {
    proof.targetId = 'other';
  },
  'the shown title on attach': (events) => {
    attachedEvent(events).params.targetInfo.title = SHOWN;
  },
  'the shown title on creation': (events) => {
    events[0].params.targetInfo.title = SHOWN;
  },
  'another shown title': (events) => {
    shownEvent(events).params.targetInfo.title = 'data:text/html,<title>other<%2Ftitle>';
  },
  'the shown title and a protected URL': (events) => {
    shownEvent(events).params.targetInfo.url = failed;
  },
  'the shown title and an ordinary URL': (events) => {
    shownEvent(events).params.targetInfo.url = 'https://ordinary.invalid/page';
  },
  'the shown title without proof': (events) => ({ events: [shownEvent(events)], proof: null }),
  'a context on another session': (events) => {
    contextEvent(events).sessionId = 'unproved-client';
  },
  'a context on the harness session': (events) => {
    contextEvent(events).sessionId = 'harness-popup';
  },
  'a context without a session': (events) => {
    delete contextEvent(events).sessionId;
  },
  'a context with a protected origin': (events) => {
    context(events).origin = new URL(failed).origin;
  },
  'a context with an ordinary origin': (events) => {
    context(events).origin = 'https://ordinary.invalid';
  },
  'a context with another opaque origin': (events) => {
    context(events).origin = 'null';
  },
  'a context with a name': (events) => {
    context(events).name = 'kworld';
  },
  'an isolated context': (events) => {
    context(events).auxData = { isDefault: false, type: 'isolated', frameId: 'popup-outcome' };
  },
  'a context in a child frame': (events) => {
    context(events).auxData.frameId = 'child-frame';
    context(events).name = 'popup-outcome';
  },
  'a context with a url': (events) => {
    context(events).auxData.url = BLANKED;
  },
  'a context with a marker': (events) => {
    context(events).uniqueId = 'STAND';
  },
  'a context with another field': (events) => {
    contextEvent(events).params.frame = { id: 'popup-outcome' };
  },
  'a context with another method': (events) => {
    contextEvent(events).method = 'Runtime.executionContextDestroyed';
  },
  'a context without proof': (events) => ({ events: [contextEvent(events)], proof: null }),
  'a context for another proved target': (events, proof) => ({
    events: [contextEvent(events)],
    proof: { ...proof, targetId: 'other' },
  }),
  'a context for another proved session': (events, proof) => ({
    events: [contextEvent(events)],
    proof: { ...proof, sessionId: 'unproved-client' },
  }),
  'a context with a protected proved origin': (events, proof) => {
    context(events).origin = new URL(failed).origin;
    return { events: [contextEvent(events)], proof: { ...proof, origin: context(events).origin } };
  },
  'a context with an ordinary proved origin': (events, proof) => {
    context(events).origin = 'https://ordinary.invalid';
    return { events: [contextEvent(events)], proof: { ...proof, origin: context(events).origin } };
  },
};

for (const [eventState, mutate] of Object.entries(mutations)) {
  test(`popup outcome rejects replacement events with ${eventState}`, {
    timeout: 5000,
  }, async (t) => {
    const { popup, attached, report } = await blockedPopup(t);
    const proof = assertPopupOutcome('C3.popup', popup, attached, report, { value: null }, false);
    const events = structuredClone(replacementEvents(report, attached));
    const changed = mutate(events, proof) ?? { events, proof };
    assert.throws(() =>
      assertChildEvents('C3.popup', 'popup', failed, popup, changed.events, changed.proof)
    );
  });
}

for (const state of [
  'ordinary blank',
  'sealed error',
  'protected root',
  'protected origin',
  'protected child',
  'unreachable URL',
  'loader mismatch',
  'missing proof',
  'missing session',
  'other refusal',
  'harness attribute',
  'client attribute',
  'protected attribute',
  'beacon',
]) {
  test(`popup outcome rejects an admitted ${state}`, { timeout: 5000 }, async (t) => {
    const { popup, attached, report } = await blockedPopup(t);
    let attribute = { value: null };
    let beacon = false;
    const frame = report.guardedTree.result.frameTree.frame;
    if (state === 'ordinary blank') frame.url = 'about:blank';
    if (state === 'sealed error') frame.url = 'chrome-error://chromewebdata/';
    if (state === 'protected root') frame.url = failed;
    if (state === 'protected origin') frame.securityOrigin = new URL(failed).origin;
    if (state === 'protected child')
      report.guardedTree.result.frameTree.childFrames = [{ frame: errorFrame('protected-child') }];
    if (state === 'unreachable URL') frame.unreachableUrl = failed;
    if (state === 'loader mismatch') frame.loaderId = 'other-loader';
    if (state === 'missing proof') report.guardedTree = null;
    if (state === 'missing session') attached.result = {};
    if (state === 'other refusal') attached.error = { message: 'slicc: refused: unguarded' };
    if (state === 'harness attribute') report.harnessAttribute.result.result.value = 'marker';
    if (state === 'client attribute') report.guardedAttribute.result.result.value = 'marker';
    if (state === 'protected attribute') attribute = { value: 'marker' };
    if (state === 'beacon') beacon = true;
    assert.throws(() => assertPopupOutcome('C3.popup', popup, attached, report, attribute, beacon));
  });
}
