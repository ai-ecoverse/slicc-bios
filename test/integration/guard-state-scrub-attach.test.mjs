import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-state-fixture.mjs';

const errorPage = 'chrome-error://chromewebdata/';
const wipes = (wire) =>
  wire.sent.filter(({ method, params }) => method === 'Page.navigate' && params.url === BLANKED);

for (const metadata of ['failed URL', 'chrome-error']) {
  const name =
    metadata === 'failed URL'
      ? 'state created blocked redirect attach escapes the deferred scrub without exposing the error document'
      : 'state created blocked redirect chrome-error attach stays sealed through the deferred scrub (#749)';
  test(name, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('created-scrub', 'page', plainFrame('created-scrub'));
    wire.hold((message) => message.method === 'Target.createTarget' && message.id >= 2 ** 30);
    const creating = wire.request('Target.createTarget', { url: ordinary });
    await flush();
    wire.release(
      wire.held.find((message) => message.method === 'Target.createTarget'),
      {
        result: { targetId: 'created-scrub' },
      }
    );
    assert.equal((await creating.answer).result.targetId, 'created-scrub');
    wire.hold(() => false);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    entry.tree.frame = errorFrame('created-scrub');
    entry.info.url =
      metadata === 'failed URL' ? `${failed}?private-query#private-fragment` : errorPage;
    entry.info.title = 'private-title';
    entry.history = {
      currentIndex: 1,
      entries: [
        { id: 1, url: failed, userTypedURL: failed, title: 'private-history' },
        { id: 2, url: errorPage, userTypedURL: failed, title: 'private-error-history' },
      ],
    };
    wire.emit({
      method: 'Fetch.requestPaused',
      sessionId: 'guard-created-scrub',
      params: {
        requestId: 'created-blocked-request',
        resourceType: 'Document',
        frameId: 'created-scrub',
        request: { url: failed },
      },
    });
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-created-scrub',
      params: { frame: entry.tree.frame },
    });
    wire.emit({
      method: 'Page.frameStoppedLoading',
      sessionId: 'guard-created-scrub',
      params: { frameId: 'created-scrub' },
    });
    await flush();
    assert.equal(wipes(wire).length, 0);
    const mark = wire.sent.length;
    const events = wire.delivered.length;
    wire.hold((message) => {
      if (message.method !== 'Target.attachToTarget' || message.id >= 2 ** 30) return false;
      queueMicrotask(() => {
        wire.attached('created-scrub', undefined, 'client-created-error');
        wire.release(message, { result: { sessionId: 'client-created-error' } });
      });
      return true;
    });
    const attached = await wire.send('Target.attachToTarget', {
      targetId: 'created-scrub',
      flatten: true,
    });
    assert.equal(attached.error, undefined);
    const sessionId = attached.result.sessionId;
    await flush();
    const attachEvent = wire.delivered
      .slice(events)
      .find(({ method }) => method === 'Target.attachedToTarget');
    assert.ok(attachEvent);
    assert.equal(attachEvent.params.sessionId, sessionId);
    const shown = metadata === 'failed URL' ? protectedOrigin : errorPage;
    assert.equal(attachEvent.params.targetInfo.url, shown);
    assert.equal(attachEvent.params.targetInfo.title, shown);
    assert.ok(wire.clients(mark).some((message) => message.method === 'Target.attachToTarget'));
    for (const [method, params] of [
      ['Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }],
      ['Runtime.getProperties', { objectId: 'private-document-object' }],
      ['DOM.getDocument', { depth: -1, pierce: true }],
      ['Page.captureScreenshot', { format: 'png' }],
    ])
      assert.equal((await wire.send(method, params, sessionId)).error?.message, PROTECTED);
    const history = await wire.send('Page.getNavigationHistory', {}, sessionId);
    assert.equal(history.error, undefined);
    assert.deepEqual(history.result.entries, [
      { id: 1, url: errorPage, userTypedURL: errorPage, title: '' },
      { id: 2, url: errorPage, userTypedURL: errorPage, title: '' },
    ]);
    const content = wire.delivered.length;
    for (const method of [
      'DOM.childNodeInserted',
      'Runtime.consoleAPICalled',
      'Page.screencastFrame',
    ])
      wire.emit({ method, sessionId, params: { data: 'private-content-event' } });
    await flush();
    assert.equal(
      wire.delivered.slice(content).some((message) => message.method),
      false
    );
    assert.equal(JSON.stringify(wire.delivered.slice(events)).includes('private-'), false);
    t.mock.timers.tick(4999);
    await flush();
    assert.equal(wipes(wire).length, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(wipes(wire).length, 1);
    assert.equal((await wire.send('Runtime.evaluate', {}, sessionId)).error?.message, PROTECTED);
    entry.tree.frame = { ...plainFrame('created-scrub'), url: BLANKED, securityOrigin: 'null' };
    entry.info.url = BLANKED;
    entry.info.title = 'blocked';
    entry.history.currentIndex = 2;
    entry.history.entries.push({ id: 3, url: BLANKED, title: 'blocked' });
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-created-scrub',
      params: { frame: entry.tree.frame },
    });
    await flush();
    entry.info.url = BLANKED;
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    await flush();
    assert.equal((await wire.send('Runtime.evaluate', {}, sessionId)).error, undefined);
    assert.equal((await wire.send('DOM.getDocument', {}, sessionId)).error, undefined);
    assert.equal((await wire.send('Page.captureScreenshot', {}, sessionId)).error, undefined);
    assert.equal((await wire.send('Target.getTargets')).result.targetInfos[0].url, BLANKED);
  });
}
