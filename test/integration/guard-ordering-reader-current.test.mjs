import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-ordering-fixture.mjs';

const refused = (answer) => {
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
};
const read = (wire, session) =>
  wire.send('Runtime.evaluate', { expression: 'document.title' }, session);

for (const change of ['fragment', 'detach']) {
  test(`ordering prior guard commit cannot admit a later revision ${change}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('live');
    const session = await wire.attach('live');
    await read(wire, session);
    entry.tree.frame = errorFrame('live');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: entry.tree.frame },
    });
    entry.tree.frame = { ...plainFrame('live'), loaderId: 'synthetic-current-loader' };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-live',
      params: { frame: entry.tree.frame },
    });
    wire.emit(
      change === 'fragment'
        ? {
            method: 'Page.navigatedWithinDocument',
            sessionId: session,
            params: { frameId: 'live', url: `${ordinary}#fragment` },
          }
        : {
            method: 'Page.frameDetached',
            sessionId: session,
            params: { frameId: 'synthetic-child', reason: 'remove' },
          }
    );
    assert.equal(
      (await read(wire, session)).error,
      undefined,
      'a current own tree permits a harmless command without clearing evidence history'
    );
    wire.privateFailure(true);
    const mark = wire.sent.length;
    refused(await read(wire, session));
    assert.deepEqual(wire.clients(mark), []);
  });
}

test('ordering current guard commit restores ordinary admission without extra fragment reads', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('live');
  const session = await wire.attach('live');
  await read(wire, session);
  entry.tree.frame = errorFrame('live');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame: entry.tree.frame },
  });
  entry.tree.frame = { ...plainFrame('live'), loaderId: 'synthetic-current-loader' };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-live',
    params: { frame: entry.tree.frame },
  });
  assert.equal((await read(wire, session)).error, undefined);
  wire.emit({
    method: 'Page.navigatedWithinDocument',
    sessionId: session,
    params: { frameId: 'live', url: `${ordinary}#fragment` },
  });
  wire.privateFailure(true);
  const mark = wire.sent.length;
  assert.equal((await read(wire, session)).error, undefined);
  assert.equal(
    wire.sent
      .slice(mark)
      .some((message) => message.id >= 2 ** 30 && message.method === 'Page.getFrameTree'),
    false
  );
});

for (const method of [
  'Fetch.requestPaused',
  'Network.requestWillBeSent',
  'Runtime.executionContextCreated',
]) {
  for (const url of [
    'chrome-error://chromewebdata',
    'chrome-error://chromewebdata/#fragment',
    'chrome-error://chromewebdata/?synthetic-query',
  ]) {
    test(`ordering error receipt closes content synchronously ${method} ${url}`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t);
      const entry = wire.target('live');
      const session = await wire.attach('live');
      await wire.send('Runtime.enable', {}, session);
      await read(wire, session);
      entry.tree.frame = errorFrame('live');
      wire.hold(
        (message) =>
          message.id >= 2 ** 30 &&
          message.method === 'Runtime.evaluate' &&
          message.params.expression === 'location.href'
      );
      const params =
        method === 'Runtime.executionContextCreated'
          ? {
              context: {
                id: 77,
                uniqueId: 'synthetic-error-origin-realm',
                origin: url,
                name: '',
                auxData: { frameId: 'live', isDefault: true, type: 'default' },
              },
            }
          : {
              requestId: 'synthetic-error-document',
              type: 'Document',
              resourceType: 'Document',
              request: { url },
            };
      const mark = wire.sent.length;
      wire.emit({
        method,
        sessionId: method.startsWith('Runtime.') ? session : 'guard-live',
        params,
      });
      const answer = await read(wire, session);
      refused(answer);
      assert.equal(
        wire.clients(mark).some((message) => message.method === 'Runtime.evaluate'),
        false,
        'receipt evidence closes forwarding before its asynchronous event proof'
      );
      for (const pending of [...wire.held])
        wire.release(pending, { error: { code: -32000, message: 'synthetic held realm error' } });
      await flush();
    });
  }
}

for (const route of ['private-current', 'public-info', 'public-listing']) {
  test(`ordering noncanonical error metadata retains history ${route}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('live');
    const session = await wire.attach('live');
    await read(wire, session);
    if (route === 'private-current') {
      entry.info.url = 'chrome-error://chromewebdata#synthetic-fragment';
      await wire.send('Target.getTargetInfo', { targetId: 'live' });
    } else {
      const method = route === 'public-info' ? 'Target.getTargetInfo' : 'Target.getTargets';
      wire.hold((message) => message.id < 2 ** 30 && message.method === method);
      const request = wire.request(
        method,
        method === 'Target.getTargetInfo' ? { targetId: 'live' } : {}
      );
      await flush();
      const targetInfo = { ...entry.info, url: 'chrome-error://chromewebdata#synthetic-fragment' };
      wire.release(
        wire.held.find((message) => message.id === request.id),
        { result: route === 'public-info' ? { targetInfo } : { targetInfos: [targetInfo] } }
      );
      await request.answer;
    }
    wire.privateFailure(true);
    const mark = wire.sent.length;
    refused(await read(wire, session));
    assert.deepEqual(wire.clients(mark), []);
  });
}

for (const method of ['Page.getFrameTree', 'Page.getResourceTree']) {
  for (const place of ['root', 'child']) {
    test(`ordering tree publication masks a protected origin ${method} ${place}`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t);
      wire.target('live');
      const session = await wire.attach('live');
      await read(wire, session);
      wire.hold((message) => message.id < 2 ** 30 && message.method === method);
      const request = wire.request(method, {}, session);
      await flush();
      const protectedFrame = {
        ...plainFrame(place === 'root' ? 'live' : 'child', place === 'root' ? undefined : 'live'),
        securityOrigin: protectedOrigin,
        unreachableUrl: failed,
        urlFragment: '#synthetic-private-fragment',
      };
      delete protectedFrame.unreachableUrl;
      const frameTree =
        place === 'root'
          ? { frame: protectedFrame }
          : { frame: plainFrame('live'), childFrames: [{ frame: protectedFrame }] };
      wire.release(
        wire.held.find((message) => message.id === request.id),
        { result: { frameTree } }
      );
      const answer = await request.answer;
      assert.equal(JSON.stringify(answer).includes(protectedOrigin), false);
      assert.equal(JSON.stringify(answer).includes('synthetic-private-fragment'), false);
      const shown =
        place === 'root'
          ? answer.result.frameTree.frame
          : answer.result.frameTree.childFrames[0].frame;
      assert.equal(shown.url, 'chrome-error://chromewebdata/');
      assert.equal(shown.securityOrigin, '://');
    });
  }
}
