import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-ordering-fixture.mjs';

const read = (wire, session) =>
  wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
const refusal = (answer) => {
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
};
const context = (wire, session, frameId, id) =>
  wire.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id,
        uniqueId: `synthetic-realm-${id}`,
        origin: new URL(ordinary).origin,
        name: '',
        auxData: { frameId, isDefault: true, type: 'default' },
      },
    },
  });

for (const result of ['protected', 'error']) {
  test(`ordering positive child root ownership closes its parent ${result}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    wire.target('parent');
    const parent = await wire.attach('parent');
    await read(wire, parent);
    wire.target('child', 'iframe', plainFrame('child', 'parent'));
    const child = wire.attached('child');
    await flush();
    await flush();
    assert.equal((await read(wire, child)).error, undefined);
    await wire.send('Runtime.enable', {}, child);
    wire.hold(
      (message) =>
        (message.id < 2 ** 30 && message.method === 'Page.captureScreenshot') ||
        (message.id >= 2 ** 30 &&
          message.method === 'Runtime.evaluate' &&
          message.params.expression === 'location.href')
    );
    const shot = wire.request('Page.captureScreenshot', {}, parent);
    await flush();
    const pending = wire.held.find((message) => message.id === shot.id);
    context(wire, child, 'child', 71);
    await flush();
    wire.release(
      wire.held.find((message) => message.method === 'Runtime.evaluate'),
      result === 'protected'
        ? { result: { result: { value: failed } } }
        : { error: { code: -32000, message: 'synthetic child uncertainty' } }
    );
    await flush();
    wire.privateFailure(true);
    const mark = wire.sent.length;
    refusal(await read(wire, parent));
    wire.release(pending, { result: { data: 'synthetic-crossing-parent-answer' } });
    refusal(await shot.answer);
    assert.deepEqual(wire.clients(mark), []);
  });
}

for (const route of ['current', 'listing', 'info']) {
  for (const evidence of ['protected', 'error']) {
    test(`ordering reply metadata closes document scope ${route} ${evidence}`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t);
      const entry = wire.target('owner');
      const session = await wire.attach('owner');
      await read(wire, session);
      const method = route === 'listing' ? 'Target.getTargets' : 'Target.getTargetInfo';
      wire.hold(
        (message) =>
          message.id < 2 ** 30 &&
          (message.method === 'Page.captureScreenshot' ||
            (route !== 'current' && message.method === method))
      );
      const shot = wire.request('Page.captureScreenshot', {}, session);
      await flush();
      const pending = wire.held.find((message) => message.id === shot.id);
      const url = evidence === 'protected' ? failed : 'chrome-error://chromewebdata/';
      let metadata;
      if (route === 'current') {
        entry.info.url = url;
        metadata = await wire.send(method, { targetId: 'owner' });
      } else {
        const request = wire.request(method, route === 'listing' ? {} : { targetId: 'owner' });
        await flush();
        const info = { ...entry.info, url, title: 'synthetic-unsafe-metadata' };
        wire.release(
          wire.held.find((message) => message.id === request.id),
          { result: route === 'listing' ? { targetInfos: [info] } : { targetInfo: info } }
        );
        metadata = await request.answer;
      }
      assert.equal(JSON.stringify(metadata).includes(failed), false);
      wire.privateFailure(true);
      const mark = wire.sent.length;
      refusal(await read(wire, session));
      wire.release(pending, { result: { data: 'synthetic-old-metadata-answer' } });
      refusal(await shot.answer);
      assert.deepEqual(wire.clients(mark), []);
    });
  }
}

for (const place of ['root', 'child']) {
  test(`ordering private cleanup retains evidence history ${place}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('owner');
    const session = await wire.attach('owner');
    await wire.send('Runtime.enable', {}, session);
    await read(wire, session);
    wire.hold(
      (message) =>
        message.id >= 2 ** 30 &&
        (message.method === 'Page.navigate' ||
          (message.method === 'Runtime.evaluate' && message.params.expression === 'location.href'))
    );
    context(wire, session, 'owner', 79);
    await flush();
    entry.tree =
      place === 'root'
        ? { frame: errorFrame('owner') }
        : { frame: plainFrame('owner'), childFrames: [{ frame: errorFrame('child', 'owner') }] };
    wire.release(
      wire.held.find((message) => message.method === 'Runtime.evaluate'),
      { result: { result: { value: `${ordinary}/changed` } } }
    );
    await flush();
    const navigation = wire.held.find((message) => message.method === 'Page.navigate');
    assert.ok(navigation);
    const frame = {
      ...plainFrame(place === 'root' ? 'owner' : 'child', place === 'root' ? undefined : 'owner'),
      url: BLANKED,
      securityOrigin: '://',
    };
    entry.tree =
      place === 'root' ? { frame } : { frame: plainFrame('owner'), childFrames: [{ frame }] };
    wire.release(navigation, { result: { frameId: frame.id } });
    await flush();
    await flush();
    wire.hold(() => false);
    assert.equal((await read(wire, session)).error, undefined);
    const mark = wire.sent.length;
    assert.equal((await read(wire, session)).error, undefined);
    assert.ok(
      wire.sent
        .slice(mark)
        .some((message) => message.id >= 2 ** 30 && message.method === 'Page.getFrameTree')
    );
    wire.privateFailure(true);
    const sent = wire.sent.length;
    refusal(await read(wire, session));
    assert.deepEqual(wire.clients(sent), []);
  });
}
