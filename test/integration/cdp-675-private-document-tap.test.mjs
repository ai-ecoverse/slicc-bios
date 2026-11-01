import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const packaged = await readFile(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');
const start = packaged.indexOf('function tapGuardSource(source) {');
const end = packaged.indexOf('\nasync function lateFrameRow', start);
const tap = new Function(`${packaged.slice(start, end)}; return tapGuardSource;`)();
const evidenceStart = packaged.indexOf(
  "          if (row.status === 'pass' && row.privateDocumentTrace?.length) {"
);
const evidenceEnd = packaged.indexOf('\n          countRow(row);', evidenceStart);
const validate = new Function('row', 'assert', packaged.slice(evidenceStart, evidenceEnd));

test('private-document tap preserves one consumption and records no public message', () => {
  const source = `class Guard {
  received(message) {
    if (this.releasePendingDocument(message)) return;
    this.delivered.push(message);
  }
}
globalThis.Guard = Guard;`;
  const context = vm.createContext({ Date });
  vm.runInContext(tap(source), context);
  const guard = new context.Guard();
  guard.delivered = [];
  guard.scopeTarget = () => 'root';
  let calls = 0;
  guard.releasePendingDocument = () => {
    calls += 1;
    return true;
  };
  const message = {
    sessionId: 'client-watcher',
    params: { requestId: 'child-document', frameId: 'child' },
  };
  assert.equal(guard.received(message), undefined);
  assert.equal(calls, 1);
  assert.equal(guard.delivered.length, 0);
  assert.equal(context.cdp675PrivateDocumentTrace.length, 1);
  assert.equal(context.cdp675PrivateDocumentTrace[0].sessionId, 'client-watcher');
  guard.releasePendingDocument = () => false;
  guard.received(message);
  assert.equal(guard.delivered.length, 1);
  assert.equal(context.cdp675PrivateDocumentTrace.length, 1);
});

test('real guard tap keeps one private-document instrumentation site and parses', async () => {
  const source = await readFile(new URL('../../src/seed/guard.js', import.meta.url), 'utf8');
  const tapped = tap(source);
  new vm.Script(tapped.replace(/^import .*;$/gm, '').replace(/^export /gm, ''));
  assert.equal(tapped.split('cdp675PrivateDocumentTrace ??=').length, 2);
});

test('private-document evidence rejects client publication and absent private release', () => {
  for (const variant of ['continue', 'fail', 'public', 'missing']) {
    const record = { sessionId: 'client-watcher', requestId: 'child-document' };
    const row = { status: 'pass', privateDocumentTrace: [record], methods: [] };
    if (variant !== 'missing')
      row.methods.push({
        boundary: 'route',
        direction: 'send',
        packet: {
          id: 2 ** 30,
          method: variant === 'fail' ? 'Fetch.failRequest' : 'Fetch.continueRequest',
          sessionId: record.sessionId,
          params: { requestId: record.requestId },
        },
      });
    if (variant === 'public')
      row.methods.push({
        boundary: 'bios',
        direction: 'receive',
        packet: {
          method: 'Fetch.requestPaused',
          sessionId: record.sessionId,
          params: { requestId: record.requestId },
        },
      });
    validate(row, assert);
    assert.equal(row.status, ['public', 'missing'].includes(variant) ? 'finding' : 'pass');
  }
});
