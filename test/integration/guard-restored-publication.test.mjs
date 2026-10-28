import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, PROTECTED } from '../../src/seed/guard.js';
import { flush, plainFrame, protectedOrigin, protocol } from './guard-state-fixture.mjs';

const events = {
  'DOM.childNodeInserted': {
    parentNodeId: 1,
    node: { nodeId: 2, nodeValue: 'synthetic-document-body' },
  },
  'Page.screencastFrame': { data: 'c3ludGhldGlj', metadata: {}, sessionId: 1 },
  'Runtime.consoleAPICalled': {
    type: 'log',
    args: [{ type: 'string', value: 'synthetic-document-body' }],
    executionContextId: 1,
    timestamp: 1,
  },
};

for (const kind of ['ordinary', 'blank']) {
  for (const [method, params] of Object.entries(events)) {
    test(`restored publication a positive ${kind} tree cannot publish ${method} under a protected target hint`, async (t) => {
      const wire = protocol(t);
      t.after(() => {
        wire.hold(() => false);
        for (const message of [...wire.held]) wire.release(message);
      });
      const entry = wire.target('publication');
      const session = await wire.attach('publication');
      await wire.send('Page.enable', {}, session);
      await wire.send('Runtime.enable', {}, session);
      if (kind === 'blank')
        entry.tree.frame = { id: 'publication', url: BLANKED, securityOrigin: '://' };
      wire.hold((message) => message.method === 'Page.getFrameTree');
      const sent = wire.sent.length;
      entry.info.url = `${protectedOrigin}/private`;
      wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
      await flush();
      assert.equal(wire.held.length, 1);
      wire.hold(() => false);
      wire.release(wire.held[0]);
      await flush();
      assert.equal(
        wire.sent
          .slice(sent)
          .some(
            (message) =>
              message.method === 'Target.detachFromTarget' && message.params.sessionId === session
          ),
        false
      );
      assert.equal(
        (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error
          ?.message,
        PROTECTED
      );
      const receipt = wire.delivered.length;
      wire.emit({ method, params, sessionId: session });
      await flush();
      assert.equal(
        wire.delivered.slice(receipt).some((message) => message.method === method),
        false
      );
      assert.equal(
        (await wire.send('Page.captureScreenshot', {}, session)).error?.message,
        PROTECTED
      );
      entry.info.url = BLANKED;
      entry.tree.frame = { ...plainFrame('publication'), url: BLANKED, securityOrigin: '://' };
      entry.history = { currentIndex: 0, entries: [{ id: 1, url: BLANKED }] };
      wire.hold((message) => message.method === 'Page.getFrameTree');
      wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
      await flush();
      const reopening = wire.delivered.length;
      wire.emit({ method, params, sessionId: session });
      assert.equal(
        (await wire.send('Page.captureScreenshot', {}, session)).error?.message,
        PROTECTED
      );
      wire.hold(() => false);
      wire.release(wire.held[0]);
      await flush();
      assert.equal(
        wire.delivered.slice(reopening).some((message) => message.method === method),
        false
      );
      const shot = await wire.send('Page.captureScreenshot', {}, session);
      assert.equal(shot.error, undefined);
      assert.equal(shot.result.data, 'c3ludGhldGlj');
      wire.emit({ method, params, sessionId: session });
      await flush();
      assert.equal(
        wire.delivered.slice(reopening).some((message) => message.method === method),
        true
      );
    });
  }
}
