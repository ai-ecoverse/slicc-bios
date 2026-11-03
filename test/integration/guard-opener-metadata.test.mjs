import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const seven = 'https://seven.sliccy.ai/page';
const variants = [
  { name: 'ordinary destination', opener: seven, access: true, url: ordinary, admitted: true },
  { name: 'no opener', access: false, url: ordinary, admitted: true },
  { name: 'ordinary opener', opener: ordinary, access: true, url: ordinary, admitted: true },
  { name: 'empty destination', opener: seven, access: true, url: '', admitted: false },
  { name: 'blank destination', opener: seven, access: false, url: 'about:blank', admitted: false },
  {
    name: 'srcdoc destination',
    opener: seven,
    access: false,
    url: 'about:srcdoc',
    admitted: false,
  },
  { name: 'no opener access', opener: seven, access: false, url: ordinary, admitted: true },
];

for (const delivery of ['lookup', 'Target.targetCreated', 'Target.targetInfoChanged']) {
  for (const [index, variant] of variants.entries()) {
    test(`opener metadata ${delivery}: ${variant.name}`, { timeout: 5000 }, async (t) => {
      const wire = protocol(t);
      const id = `opener-${delivery}-${index}`;
      const openerId = `${id}-parent`;
      if (variant.opener)
        wire.target(openerId, 'page', {
          ...plainFrame(openerId),
          url: variant.opener,
          securityOrigin: new URL(variant.opener).origin,
        });
      const entry = wire.target(id, 'page', {
        ...plainFrame(id),
        url: variant.url,
        securityOrigin: variant.url.startsWith('https:') ? new URL(variant.url).origin : '://',
      });
      Object.assign(entry.info, {
        ...(variant.opener ? { openerId } : {}),
        canAccessOpener: variant.access,
        browserContextId: 'opener-context',
      });
      if (delivery !== 'lookup') {
        wire.emit({ method: delivery, params: { targetInfo: entry.info } });
        await flush();
      }
      const answer = await wire.send('Target.attachToTarget', { targetId: id, flatten: true });
      t.diagnostic(
        JSON.stringify({ variant: variant.name, delivery, targetInfo: entry.info, answer })
      );
      if (!variant.admitted) {
        assert.equal(answer.error?.message, PROTECTED);
        assert.equal(answer.result, undefined);
        assert.equal(
          wire.sent.some(
            ({ method, params }) => method === 'Target.attachToTarget' && params.targetId === id
          ),
          false
        );
        return;
      }
      assert.equal(answer.error, undefined, JSON.stringify(answer));
      assert.ok(answer.result?.sessionId);
      const read = await wire.send(
        'Runtime.evaluate',
        { expression: '1' },
        answer.result.sessionId
      );
      assert.equal(read.error, undefined);
    });
  }
}
