import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

const opaque = Buffer.from(failed).toString('base64');

for (const alias of ['Page.enable', 'Runtime.evaluate']) {
  test(`state identifier ${alias} request`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('live');
    const session = await wire.attach('live');
    wire.hold((m) => m.id < 2 ** 30 && m.id === 701);
    wire.request('Page.captureScreenshot', {}, session, 701);
    await flush();
    const original = wire.held.find((m) => m.id === 701 && m.method === 'Page.captureScreenshot');
    assert.ok(original);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-live',
      params: { frame: errorFrame('live') },
    });
    if (alias === 'Runtime.evaluate')
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-live',
        params: { frame: plainFrame('live') },
      });
    wire.request(alias, alias === 'Runtime.evaluate' ? { expression: '1' } : {}, session, 701);
    await flush();
    const mark = wire.delivered.length;
    wire.release(original, { result: { data: opaque } });
    await flush();
    assert.equal(
      JSON.stringify(wire.delivered.slice(mark)).includes(opaque),
      false,
      'a tainted original command is not reauthorized through an untainted id alias'
    );
  });
}

for (const kind of ['command', 'screencast', 'css-event', 'layer-event']) {
  test(`state descendant receipt ${kind}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('parent');
    const session = await wire.attach('parent');
    await wire.send('Page.enable', {}, session);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-parent',
      params: { frame: errorFrame('child', 'parent') },
    });
    const mark = wire.delivered.length;
    const request =
      kind === 'command'
        ? wire.request('Page.printToPDF', { transferMode: 'ReturnAsBase64' }, session)
        : undefined;
    if (kind === 'screencast')
      wire.emit({
        method: 'Page.screencastFrame',
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
    if (kind === 'css-event')
      wire.emit({
        method: 'CSS.styleSheetAdded',
        sessionId: session,
        params: {
          header: {
            styleSheetId: 'synthetic-error-sheet',
            frameId: 'child',
            sourceURL: 'chrome-error://chromewebdata/',
            origin: 'user-agent',
            title: opaque,
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
    if (kind === 'layer-event')
      wire.emit({
        method: 'LayerTree.layerTreeDidChange',
        sessionId: session,
        params: {
          layers: [
            {
              layerId: 'synthetic-layer',
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
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-parent',
      params: { frame: plainFrame('child', 'parent') },
    });
    await flush();
    if (request) assert.match((await request.answer).error?.message ?? '', /^slicc: refused:/);
    else
      assert.equal(
        wire.delivered
          .slice(mark)
          .some(
            (m) =>
              m.method ===
              (kind === 'screencast'
                ? 'Page.screencastFrame'
                : kind === 'css-event'
                  ? 'CSS.styleSheetAdded'
                  : 'LayerTree.layerTreeDidChange')
          ),
        false
      );
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
      undefined,
      'fresh ordinary commands stay live'
    );
  });
}

for (const method of ['Page.printToPDF', 'LayerTree.replaySnapshot', 'CSS.getStyleSheetText']) {
  test(`state descendant pending ${method}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('parent');
    const session = await wire.attach('parent');
    wire.hold((m) => m.id < 2 ** 30 && m.method === method);
    const request = wire.request(
      method,
      method === 'Page.printToPDF'
        ? {}
        : method === 'LayerTree.replaySnapshot'
          ? { snapshotId: 'synthetic-snapshot' }
          : { styleSheetId: 'synthetic-sheet' },
      session
    );
    await flush();
    const held = wire.held.find((m) => m.id === request.id);
    assert.ok(held);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-parent',
      params: { frame: errorFrame('child', 'parent') },
    });
    wire.emit({
      method: 'Page.frameDetached',
      sessionId: 'guard-parent',
      params: { frameId: 'child', reason: 'remove' },
    });
    wire.release(held, {
      result:
        method === 'Page.printToPDF'
          ? { data: opaque }
          : method === 'LayerTree.replaySnapshot'
            ? { dataURL: `data:image/png;base64,${opaque}` }
            : { text: opaque },
    });
    const answer = await request.answer;
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
  });
}
