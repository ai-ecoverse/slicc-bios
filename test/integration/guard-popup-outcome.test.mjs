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

function replacementEvents(report, attached) {
  const targetInfo = report.target.result.targetInfo;
  return [
    { method: 'Target.targetCreated', params: { targetInfo } },
    { method: 'Target.targetInfoChanged', params: { targetInfo } },
    {
      method: 'Target.attachedToTarget',
      params: { targetInfo, sessionId: attached.result.sessionId, waitingForDebugger: false },
    },
  ];
}

for (const eventState of [
  'different session',
  'protected URL',
  'ordinary URL',
  'wrong title',
  'frame',
  'context',
  'marker',
  'missing proof',
  'wrong proved target',
]) {
  test(`popup outcome rejects replacement events with ${eventState}`, {
    timeout: 5000,
  }, async (t) => {
    const { popup, attached, report } = await blockedPopup(t);
    let proof = assertPopupOutcome('C3.popup', popup, attached, report, { value: null }, false);
    const events = structuredClone(replacementEvents(report, attached));
    const last = events.at(-1);
    if (eventState === 'different session') last.params.sessionId = 'unproved-client';
    if (eventState === 'protected URL') last.params.targetInfo.url = failed;
    if (eventState === 'ordinary URL') last.params.targetInfo.url = 'https://ordinary.invalid/page';
    if (eventState === 'wrong title') last.params.targetInfo.title = 'other';
    if (eventState === 'frame') last.params.frame = { id: popup.targetId };
    if (eventState === 'context') last.params.context = { origin: 'null' };
    if (eventState === 'marker') last.params.marker = 'STAND';
    if (eventState === 'missing proof') proof = null;
    if (eventState === 'wrong proved target') proof.targetId = 'other';
    assert.throws(() => assertChildEvents('C3.popup', 'popup', failed, popup, events, proof));
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
