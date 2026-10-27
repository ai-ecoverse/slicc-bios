import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, protocol } from './guard-state-fixture.mjs';

const opaque = Buffer.from(failed).toString('base64');
const refused = (answer) => {
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
};

for (const method of ['Page.screencastFrame']) {
  test(`state descendant publication ${method}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('parent');
    const session = await wire.attach('parent');
    await wire.send('Page.enable', {}, session);
    assert.equal(
      (await wire.send('Page.startScreencast', { format: 'png' }, session)).error,
      undefined
    );
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-parent',
      params: { frame: errorFrame('child', 'parent') },
    });
    await flush();
    const mark = wire.delivered.length;
    wire.emit({
      method,
      sessionId: session,
      params: {
        data: opaque,
        sessionId: 17,
        metadata: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: 800,
          deviceHeight: 600,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
      },
    });
    await flush();
    assert.equal(
      JSON.stringify(wire.delivered.slice(mark)).includes(opaque),
      false,
      'whole-page renderer publications cannot include protected error descendants'
    );
  });
}

for (const method of [
  'LayerTree.makeSnapshot',
  'LayerTree.replaySnapshot',
  'CSS.getStyleSheetText',
]) {
  test(`state descendant content ${method}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('parent');
    const session = await wire.attach('parent');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-parent',
      params: { frame: errorFrame('child', 'parent') },
    });
    if (method === 'CSS.getStyleSheetText') {
      await wire.send('CSS.enable', {}, session);
      wire.emit({
        method: 'CSS.styleSheetAdded',
        sessionId: session,
        params: {
          header: {
            styleSheetId: 'synthetic-error-sheet',
            frameId: 'child',
            sourceURL: 'chrome-error://chromewebdata/',
            origin: 'user-agent',
            title: '',
            disabled: false,
            isInline: false,
            isMutable: false,
            isConstructed: false,
            startLine: 0,
            startColumn: 0,
            length: 37,
            endLine: 1,
            endColumn: 0,
          },
        },
      });
    } else {
      await wire.send('LayerTree.enable', {}, session);
      wire.emit({
        method: 'LayerTree.layerTreeDidChange',
        sessionId: session,
        params: {
          layers: [
            {
              layerId: 'synthetic-error-layer',
              offsetX: 0,
              offsetY: 0,
              width: 800,
              height: 600,
              paintCount: 1,
              drawsContent: true,
            },
          ],
        },
      });
      if (method === 'LayerTree.replaySnapshot') {
        wire.hold((m) => m.id < 2 ** 30 && m.method === 'LayerTree.makeSnapshot');
        const make = wire.request(
          'LayerTree.makeSnapshot',
          { layerId: 'synthetic-error-layer' },
          session
        );
        await flush();
        const pending = wire.held.find((m) => m.id === make.id);
        if (pending) wire.release(pending, { result: { snapshotId: 'synthetic-error-snapshot' } });
        const answer = await make.answer;
        if (answer.error) {
          assert.match(answer.error.message, /^slicc: refused:/);
          return;
        }
        assert.equal(answer.result.snapshotId, 'synthetic-error-snapshot');
      }
    }
    await flush();
    wire.hold((m) => m.id < 2 ** 30 && m.method === method);
    const params =
      method === 'LayerTree.makeSnapshot'
        ? { layerId: 'synthetic-error-layer' }
        : method === 'LayerTree.replaySnapshot'
          ? { snapshotId: 'synthetic-error-snapshot' }
          : { styleSheetId: 'synthetic-error-sheet' };
    const mark = wire.sent.length;
    const request = wire.request(method, params, session);
    await flush();
    const pending = wire.held.find((m) => m.id === request.id);
    if (pending)
      wire.release(pending, {
        result:
          method === 'LayerTree.makeSnapshot'
            ? { snapshotId: 'synthetic-error-snapshot' }
            : method === 'LayerTree.replaySnapshot'
              ? { dataURL: `data:image/png;base64,${opaque}` }
              : { text: `body::after { content: '${opaque}'; }` },
      });
    const answer = await request.answer;
    assert.equal(
      wire.clients(mark).some((m) => m.id === request.id),
      false,
      'renderer handles do not bypass the known error descendant'
    );
    refused(answer);
  });
}
