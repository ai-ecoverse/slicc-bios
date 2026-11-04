import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { hold, isHeld } from '../../src/seed/held.js';
import { flush, plainFrame, protocol } from './guard-state-fixture.mjs';

const seven = 'https://seven.sliccy.ai/page';
const ordinary = 'https://ordinary.invalid/page';
function page(wire, id, url = ordinary, extra = {}) {
  const entry = wire.target(id, 'page', {
    ...plainFrame(id),
    url,
    securityOrigin: new URL(url).origin,
  });
  Object.assign(entry.info, { canAccessOpener: false, ...extra });
  return entry;
}
const attach = (wire, id) => wire.send('Target.attachToTarget', { targetId: id, flatten: true });
const refused = (answer) => assert.equal(answer.error?.message, PROTECTED);

for (const relation of ['openerId', 'parentId', 'nested opener']) {
  test(`opener review checks fresh protected-opener ancestry: ${relation}`, async (t) => {
    const wire = protocol(t);
    const root = page(wire, `ancestry-held-${relation}`);
    hold(root.info.targetId);
    let ancestor = root.info.targetId;
    if (relation === 'nested opener')
      ancestor = page(wire, 'ancestry-intermediate', ordinary, { openerId: ancestor }).info
        .targetId;
    const parent = page(wire, `ancestry-seven-${relation}`, seven, {
      [relation === 'nested opener' ? 'openerId' : relation]: ancestor,
    });
    const child = page(wire, `ancestry-child-${relation}`, ordinary, {
      openerId: parent.info.targetId,
      canAccessOpener: true,
    });
    refused(await attach(wire, child.info.targetId));
    assert.equal(isHeld(parent.info.targetId), true);
    assert.equal(isHeld(child.info.targetId), true);
    assert.equal(
      wire.clients().some((message) => message.method === 'Target.attachToTarget'),
      false
    );
  });
}

for (const access of [false, true]) {
  for (const state of ['closed', 'transient']) {
    test(`opener review preserves ordinary opener ${state}, access ${access}`, async (t) => {
      const wire = protocol(t);
      const parent = page(wire, `ordinary-parent-${state}-${access}`);
      assert.equal((await attach(wire, parent.info.targetId)).error, undefined);
      const child = page(wire, `ordinary-child-${state}-${access}`, ordinary, {
        openerId: parent.info.targetId,
        canAccessOpener: access,
      });
      let failed = false;
      wire.hold((message) => {
        if (
          message.method !== 'Target.getTargetInfo' ||
          message.params.targetId !== parent.info.targetId
        )
          return false;
        if (state === 'transient' && failed) return false;
        failed = true;
        queueMicrotask(() =>
          wire.release(message, { error: { code: -32000, message: 'No target' } })
        );
        return true;
      });
      const answer = await attach(wire, child.info.targetId);
      assert.equal(answer.error, undefined, JSON.stringify(answer));
      assert.equal(isHeld(child.info.targetId), false);
      assert.equal(failed, true);
    });
  }
  test(`opener review admits an unknown closed ordinary opener, access ${access}`, async (t) => {
    const wire = protocol(t);
    const parent = `never-observed-closed-${access}`;
    page(wire, parent);
    const child = page(wire, `never-observed-child-${access}`, ordinary, {
      openerId: parent,
      canAccessOpener: access,
    });
    wire.hold((message) => {
      if (message.method !== 'Target.getTargetInfo' || message.params.targetId !== parent)
        return false;
      queueMicrotask(() =>
        wire.release(message, { error: { code: -32000, message: 'No target' } })
      );
      return true;
    });
    assert.equal((await attach(wire, child.info.targetId)).error, undefined);
    assert.equal(isHeld(child.info.targetId), false);
  });
}

for (const [method, params] of [
  ['CSS.enable', {}],
  ['CSS.getStyleSheetText', { styleSheetId: 'ordinary-sheet' }],
  ['CSS.getComputedStyleForNode', { nodeId: 1 }],
  ['Fetch.enable', {}],
  ['Fetch.disable', {}],
  ['Fetch.getResponseBody', { requestId: 'ordinary-response' }],
  ['Runtime.enable', {}],
  ['Runtime.disable', {}],
  ['Runtime.getIsolateId', {}],
  ['Runtime.getHeapUsage', {}],
  ['DOM.enable', {}],
  ['DOM.disable', {}],
]) {
  test(`opener review gates the first silently reparented session command: ${method}`, async (t) => {
    const wire = protocol(t);
    const parent = page(wire, `command-held-${method}`);
    hold(parent.info.targetId);
    const child = page(wire, `command-child-${method}`);
    const attached = await attach(wire, child.info.targetId);
    assert.equal(attached.error, undefined);
    const session = attached.result.sessionId;
    if (method === 'Fetch.getResponseBody') {
      wire.emit({
        method: 'Fetch.requestPaused',
        sessionId: session,
        params: {
          requestId: 'ordinary-response',
          frameId: child.info.targetId,
          resourceType: 'XHR',
          request: { url: ordinary, method: 'GET' },
          responseStatusCode: 200,
        },
      });
      await flush();
    }
    assert.equal((await wire.send(method, params, session)).error, undefined, method);
    child.info.openerId = parent.info.targetId;
    child.info.canAccessOpener = true;
    const mark = wire.clients().length;
    refused(await wire.send(method, params, session));
    assert.equal(
      wire
        .clients()
        .slice(mark)
        .some((message) => message.method === method),
      false
    );
  });
}
