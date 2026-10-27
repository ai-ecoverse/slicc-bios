import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, PROTECTED } from '../../src/seed/guard.js';
import { errorFrame, flush, ordinary, plainFrame, protocol } from './guard-state-fixture.mjs';

for (const replaced of [false, true]) {
  test(`state blocked hop then private wipe and ordinary recovery replaced ${replaced}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('wipe-owner', 'page', plainFrame('wipe-root'));
    const session = await wire.attach('wipe-owner');
    entry.tree.frame = errorFrame('wipe-root');
    entry.info.url = 'chrome-error://chromewebdata/';
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-wipe-owner',
      params: { frame: entry.tree.frame },
    });
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    await flush();
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
    const wipedRoot = replaced ? 'wipe-replacement-root' : 'wipe-root';
    entry.tree.frame = { ...plainFrame(wipedRoot), url: BLANKED, securityOrigin: 'null' };
    entry.info.url = BLANKED;
    entry.info.title = 'blocked';
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-wipe-owner',
      params: { frame: entry.tree.frame },
    });
    await flush();
    const listing = await wire.send('Target.getTargets');
    assert.equal(listing.error, undefined);
    assert.equal(listing.result.targetInfos[0].url, BLANKED);
    assert.equal(listing.result.targetInfos[0].title, 'blocked');
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error, undefined);
    entry.tree.frame = plainFrame(wipedRoot);
    entry.info.url = ordinary;
    entry.info.title = 'ordinary';
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-wipe-owner',
      params: { frame: entry.tree.frame },
    });
    await flush();
    const navigated = await wire.send('Page.navigate', { url: ordinary }, session);
    assert.equal(navigated.error, undefined);
    const read = await wire.send('Runtime.evaluate', {}, session);
    assert.equal(read.error, undefined);
    assert.equal(read.result.result.value, 'synthetic-content');
    assert.equal(
      (await wire.send('Target.getTargetInfo', { targetId: 'wipe-owner' })).result.targetInfo.url,
      ordinary
    );
  });
}
