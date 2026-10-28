import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-ordering-fixture.mjs';

const actual = `${ordinary}?redirect_uri=${encodeURIComponent(`${protectedOrigin}/vault/cb`)}&state=s`;
const masked = `${ordinary}?redirect_uri=${protectedOrigin}&state=s`;

for (const kind of [
  'masked',
  'different-state',
  'different-state-encoding',
  'different-path',
  'other-parameter',
  'duplicate',
  'failed-tree',
]) {
  test(`residual masked redirect metadata preserves only the matching ordinary context ${kind}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const id = `location-${kind}`;
    const entry = wire.target(id, 'page', {
      ...plainFrame(id),
      url: kind === 'different-state-encoding' ? masked.replace('state=s', 'state=%73') : masked,
    });
    const session = await wire.attach(id);
    assert.equal((await wire.send('Runtime.enable', {}, session)).error, undefined);
    const proof = wire.sent.length;
    wire.hold(
      (message) =>
        message.id >= 2 ** 30 &&
        message.method === 'Runtime.evaluate' &&
        message.params.expression === 'location.href'
    );
    wire.emit({
      method: 'Runtime.executionContextCreated',
      sessionId: session,
      params: {
        context: {
          id: 71,
          uniqueId: `location-context-${kind}`,
          origin: new URL(ordinary).origin,
          name: '',
          auxData: { isDefault: true, type: 'default', frameId: id },
        },
      },
    });
    await flush();
    if (kind === 'failed-tree') wire.privateFailure(true);
    const value =
      kind === 'different-state'
        ? actual.replace('state=s', 'state=other')
        : kind === 'different-path'
          ? actual.replace('/page?', '/other?')
          : kind === 'other-parameter'
            ? `${actual}&other=1`
            : kind === 'duplicate'
              ? `${actual}&redirect_uri=${encodeURIComponent(protectedOrigin)}`
              : actual;
    wire.release(wire.held[0], { result: { result: { type: 'string', value } } });
    await flush();
    await flush();
    assert.equal(
      wire.delivered.some((message) => message.method === 'Runtime.executionContextCreated'),
      kind === 'masked'
    );
    assert.ok(
      wire.sent
        .slice(proof)
        .some(
          (message) => message.method === 'Page.getFrameTree' && message.sessionId === `guard-${id}`
        )
    );
    if (kind === 'failed-tree') {
      const mark = wire.sent.length;
      assert.match(
        (await wire.send('Runtime.evaluate', {}, session)).error?.message ?? '',
        /^slicc: refused:/
      );
      assert.equal(
        wire.clients(mark).some((message) => message.method === 'Runtime.evaluate'),
        false
      );
    }
  });
}
