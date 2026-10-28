import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { ordinary, protectedOrigin, protocol } from './guard-state-fixture.mjs';

const failed = `${protectedOrigin}/failed/synthetic-document-id`;

for (const method of ['Page.getFrameTree', 'Page.getNavigationHistory']) {
  test(`restored observing a protected target hint keeps the blank document stand-in ${method}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('observed-blank');
    const session = await wire.attach('observed-blank');
    entry.info.url = `${protectedOrigin}/private`;
    entry.tree.frame = {
      id: 'observed-blank',
      url: 'about:blank',
      securityOrigin: 'null',
      unreachableUrl: failed,
    };
    entry.history = { currentIndex: 0, entries: [{ id: 1, url: 'about:blank', title: failed }] };
    const mark = wire.sent.length;
    const answer = await wire.send(method, {}, session);
    assert.equal(answer.error, undefined);
    const url =
      method === 'Page.getFrameTree'
        ? answer.result.frameTree.frame.url
        : answer.result.entries[0].url;
    assert.equal(url, 'chrome-error://chromewebdata/');
    assert.equal(JSON.stringify(answer).includes(failed), false);
    assert.equal(wire.clients(mark).length, 0);
    const shot = await wire.send('Page.captureScreenshot', {}, session);
    assert.equal(shot.error, undefined);
    assert.equal(shot.result.data, 'c3ludGhldGlj');
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error
        ?.message,
      PROTECTED
    );
  });
}

test('restored observing an ordinary blank target still returns ordinary metadata', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('ordinary-observed-blank');
  const session = await wire.attach('ordinary-observed-blank');
  entry.info.url = 'about:blank';
  entry.tree.frame = {
    id: 'ordinary-observed-blank',
    url: 'about:blank',
    securityOrigin: 'null',
    unreachableUrl: ordinary,
  };
  entry.history = {
    currentIndex: 0,
    entries: [{ id: 1, url: 'about:blank', title: 'ordinary-title' }],
  };
  assert.equal(
    (await wire.send('Page.getFrameTree', {}, session)).result.frameTree.frame.url,
    'about:blank'
  );
  assert.equal(
    (await wire.send('Page.getNavigationHistory', {}, session)).result.entries[0].title,
    'ordinary-title'
  );
});
