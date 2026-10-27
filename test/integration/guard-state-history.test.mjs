import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failed, flush, ordinary, protocol } from './guard-state-fixture.mjs';

for (const [kind, url] of [
  ['absent', undefined],
  ['empty', ''],
  ['invalid', '://'],
  ['null', null],
  ['object', {}],
]) {
  for (const source of ['existing', 'later']) {
    test(`state history ${kind} ${source}`, async (t) => {
      const wire = protocol(t);
      const entry = wire.target('history-state');
      if (source === 'existing')
        entry.history = {
          currentIndex: 1,
          entries: [
            { id: 71, url },
            { id: 72, url: ordinary },
          ],
        };
      const session = await wire.attach('history-state');
      if (source === 'later')
        entry.history = {
          currentIndex: 1,
          entries: [
            { id: 71, url },
            { id: 72, url: ordinary },
          ],
        };
      const listing = await wire.send('Page.getNavigationHistory', {}, session);
      assert.equal(listing.error, undefined);
      assert.equal(listing.result.entries[0].url, 'chrome-error://chromewebdata/');
      assert.equal(listing.result.entries[0].title, '');
      wire.hold(
        (message) => message.id < 2 ** 30 && message.method === 'Page.navigateToHistoryEntry'
      );
      const mark = wire.sent.length;
      const back = wire.request('Page.navigateToHistoryEntry', { entryId: 71 }, session);
      await flush();
      const held = wire.held.find((message) => message.id === back.id);
      if (held) wire.release(held);
      const answer = await back.answer;
      assert.deepEqual(
        wire.clients(mark).filter((message) => message.id === back.id),
        []
      );
      assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      assert.equal(answer.result, undefined);
      assert.equal(
        (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
        undefined
      );
      assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
    });
  }
}
