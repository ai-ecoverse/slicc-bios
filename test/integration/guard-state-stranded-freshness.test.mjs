import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-state-fixture.mjs';

async function blocked(t) {
  const wire = protocol(t);
  const entry = wire.target('freshness');
  const session = await wire.attach('freshness');
  entry.tree.frame = errorFrame('freshness');
  entry.info.url = failed;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-freshness',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  return { wire, entry, session };
}

for (const navigationType of ['restore', 'differentDocument']) {
  test(`stranded pending protected ${navigationType} stays refused even with a nonprotected current tree`, async (t) => {
    const { wire, session } = await blocked(t);
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: 'guard-freshness',
      params: { frameId: 'freshness', url: failed, navigationType },
    });
    await flush();
    assert.equal(
      (await wire.send('Target.attachToTarget', { targetId: 'freshness', flatten: true })).error
        ?.message,
      PROTECTED
    );
    assert.equal(
      (await wire.send('Page.navigate', { url: ordinary }, session)).error?.message,
      PROTECTED
    );
    assert.equal((await wire.send('Target.getTargets')).result.targetInfos.length, 0);
  });
}

test('stranded a held empty-URL attachment cannot obtain recovery from a protected report', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('held-recovery');
  entry.info.url = '';
  wire.hold(
    (message) => message.method === 'Page.enable' && message.sessionId === 'guard-held-recovery'
  );
  wire.attached('held-recovery');
  await flush();
  entry.tree.frame = errorFrame('held-recovery');
  entry.info.url = failed;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  assert.equal(
    (await wire.send('Target.getTargetInfo', { targetId: 'held-recovery' })).error?.message,
    PROTECTED
  );
  assert.equal(
    (await wire.send('Target.closeTarget', { targetId: 'held-recovery' })).error?.message,
    PROTECTED
  );
  wire.hold(() => false);
  for (const pending of [...wire.held]) wire.release(pending);
  await flush();
});

test('stranded an exact unreachable URL is origin-only and no message carries the protected markers', async (t) => {
  const { wire, entry, session } = await blocked(t);
  const info = await wire.send('Target.getTargetInfo', { targetId: 'freshness' });
  assert.equal(info.result.targetInfo.url, protectedOrigin);
  const url = `${failed}?query-marker=never-publish-query#never-publish-fragment`;
  entry.tree.frame.unreachableUrl = url;
  entry.info.url = url;
  entry.info.title = 'never-publish-title';
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-freshness',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  wire.attached('freshness');
  await flush();
  for (const method of ['Target.getTargetInfo', 'Target.getTargets']) {
    const answer = await wire.send(
      method,
      method === 'Target.getTargetInfo' ? { targetId: 'freshness' } : {}
    );
    const shown = answer.result.targetInfo ?? answer.result.targetInfos[0];
    assert.equal(shown.url, protectedOrigin);
    assert.equal(shown.title, protectedOrigin);
  }
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
  for (const marker of [
    new URL(failed).pathname,
    'never-publish-query',
    'never-publish-fragment',
    'never-publish-title',
  ])
    assert.equal(JSON.stringify(wire.delivered).includes(marker), false);
});

test('stranded history admits an ordinary exit but still refuses a protected destination', async (t) => {
  const { wire, entry, session } = await blocked(t);
  entry.history = {
    currentIndex: 1,
    entries: [
      { id: 1, url: ordinary },
      { id: 2, url: failed },
    ],
  };
  assert.equal(
    (await wire.send('Page.navigateToHistoryEntry', { entryId: 2 }, session)).error?.message,
    PROTECTED
  );
  wire.hold((message) => {
    if (message.method !== 'Page.navigateToHistoryEntry' || message.id >= 2 ** 30) return false;
    queueMicrotask(() => {
      entry.tree.frame = plainFrame('freshness');
      entry.info.url = ordinary;
      entry.history.currentIndex = 0;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-freshness',
        params: { frame: entry.tree.frame },
      });
      wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
      wire.release(message);
    });
    return true;
  });
  assert.equal(
    (await wire.send('Page.navigateToHistoryEntry', { entryId: 1 }, session)).error,
    undefined
  );
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error, undefined);
});

test('stranded loss of the armed navigation session closes all recovery exits', async (t) => {
  const { wire, session } = await blocked(t);
  wire.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'guard-freshness' } });
  await flush();
  assert.equal((await wire.send('Page.reload', {}, session)).error?.message, PROTECTED);
  assert.equal(
    (await wire.send('Target.activateTarget', { targetId: 'freshness' })).error?.message,
    PROTECTED
  );
});
