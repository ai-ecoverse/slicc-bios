import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

const encoded = Buffer.from(failed).toString('base64');
const surfaces = [
  [
    'Runtime.evaluate',
    { expression: "btoa(loadTimeData.getString('failedUrl'))", returnByValue: true },
    { result: { type: 'string', value: encoded } },
  ],
  [
    'DOM.getDocument',
    { depth: -1 },
    {
      root: {
        nodeId: 1,
        nodeName: '#document',
        children: [{ nodeId: 2, nodeName: '#text', nodeValue: encoded }],
      },
    },
  ],
  [
    'Accessibility.getFullAXTree',
    {},
    { nodes: [{ nodeId: 'synthetic-ax', name: { type: 'computedString', value: encoded } }] },
  ],
  ['Page.captureSnapshot', { format: 'mhtml' }, { data: `synthetic-error-document-${encoded}` }],
  ['Page.captureScreenshot', {}, { data: encoded }],
];

for (const path of ['blocked-hop', 'history-user-entry']) {
  for (const namespace of ['same-root', 'distinct-root']) {
    for (const [method, params, result] of surfaces) {
      test(`state ${path === 'blocked-hop' ? 'a' : 'b'} ${namespace} ${method}`, {
        timeout: 5000,
      }, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const root = namespace === 'same-root' ? 'surface' : 'physical-surface';
        const ownHistoryEntry = { ...errorFrame(root), loaderId: 'synthetic-error-loader' };
        const wire = protocol(t);
        const entry = wire.target('surface', 'page', {
          ...plainFrame(root),
          loaderId: 'synthetic-ordinary-loader',
        });
        const session = await wire.attach('surface');
        assert.equal(
          (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
          undefined
        );
        if (path === 'history-user-entry') {
          assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
          const back = await wire.send(
            'Runtime.evaluate',
            { expression: 'history.back()' },
            session
          );
          assert.equal(
            back.error,
            undefined,
            'back starts from an ordinary document and needs no known entry URL'
          );
        } else {
          wire.emit({
            method: 'Fetch.requestPaused',
            sessionId: 'guard-surface',
            params: {
              requestId: 'synthetic-protected-hop',
              frameId: root,
              resourceType: 'Document',
              request: { url: failed, method: 'GET' },
            },
          });
          await flush();
          assert.ok(
            wire.sent.some(
              (message) =>
                message.method === 'Fetch.failRequest' &&
                message.params?.requestId === 'synthetic-protected-hop'
            )
          );
        }
        entry.tree = { frame: ownHistoryEntry };
        wire.emit({
          method: 'Page.frameNavigated',
          sessionId: 'guard-surface',
          params: {
            frame: ownHistoryEntry,
            type: path === 'history-user-entry' ? 'BackForwardCacheRestore' : 'Navigation',
          },
        });
        await flush();
        const mark = wire.sent.length;
        wire.hold((message) => message.id < 2 ** 30 && message.method === method);
        const read = wire.request(method, params, session);
        await flush();
        t.mock.timers.tick(5001);
        await flush();
        t.mock.timers.tick(5001);
        await flush();
        t.mock.timers.tick(10001);
        await flush();
        const held = wire.held.find((message) => message.id === read.id);
        if (held) wire.release(held, { result });
        const answer = await read.answer;
        assert.deepEqual(
          wire.clients(mark).filter((message) => message.id === read.id),
          [],
          'protected error-page content is never forwarded'
        );
        assert.match(answer.error?.message ?? '', /^slicc: refused:/);
        assert.equal(answer.result, undefined);
        assert.equal(wire.delivered.filter((message) => message.id === read.id).length, 1);
        assert.equal(
          JSON.stringify(wire.delivered).includes(encoded),
          false,
          'opaque renderer-derived content is not published'
        );
      });
    }
  }
}
