import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_BUDGET, agentUp, connectAccount, ready } from './bios.mjs';
import {
  agentRow,
  helpers,
  installedOld,
  installs,
  KEY,
  NEW_VERSION,
  oneHolder,
  proxy,
  queue,
  say,
} from './old-agent-fixture.mjs';
import { shoot } from './shots.mjs';

test("slicc-agent 3.26.0, which ignores held, isn't started at boot: seven's agent installs, the chat queues what's sent here and in another tab, and the new agent gets it once, without a reload", {
  timeout: 60 * 60 * 1000,
}, async (t) => {
  const { page, owner } = await installedOld(t, '3.26.0');
  assert.match(owner, /const release = await holdLock\(/);
  assert.doesNotMatch(owner, /options\.held/);
  const reloaded = Date.now();
  await page.reload();
  await ready(page);
  await page.within(AGENT_BUDGET, () =>
    ['downloading', 'linking'].includes(
      document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === 'agent').state
    )
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(() => !!window.chatView()?.shadowRoot && !!window.installNotice());
  const notice = await page.evaluate(() => window.installNotice());
  assert.equal(notice.title, 'Seven is updating its agent');
  assert.equal(notice.body, `The chat starts once agent ${NEW_VERSION} is installed.`);
  assert.deepEqual(notice.actions, [{ id: 'show-updates', label: 'Open Install / Update' }]);
  const shown = await page.until(() => {
    const text = window.deepText(window.chatView().shadowRoot);
    return text.includes('Seven is updating its agent') && window.composer() && text;
  });
  assert.doesNotMatch(shown, /Couldn|failed|error|No messages yet/i);
  assert.deepEqual(await page.evaluate(() => window.composer()), {
    placeholder: 'Seven is updating its agent.',
    queued: [],
    empty: false,
  });
  await shoot(page, 'updating-from-3.26.0', { show: 'chat' });
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await queue(page, 'First while it installs');
  await queue(page, 'Second while it installs');
  await queue(page, 'Dropped while it installs');
  const rows = await page.evaluate(() => window.composer().queued);
  assert.equal(rows.length, 3);
  assert.ok(
    rows.every((row) => row.includes('Sent when the agent starts')),
    JSON.stringify(rows)
  );
  await page.evaluate(() => {
    const composer = window.deep(window.chatView().shadowRoot, 'slicc-composer');
    const rows = composer.shadowRoot.querySelectorAll('li.queued[data-mode="starting"]');
    rows[rows.length - 1].querySelector('[data-action="unqueue"]').click();
  });
  await page.until(() => window.composer().queued.length === 2);
  const kept = await page.evaluate(() => window.composer().queued);
  assert.match(kept[0], /First while it installs/);
  assert.match(kept[1], /Second while it installs/);
  await shoot(page, 'queued-while-updating', { show: 'chat' });
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  assert.equal(
    await page.evaluate(
      () => document.querySelector('slicc-app').dock.api.getPanel('updates')?.api.isVisible ?? false
    ),
    false
  );
  await page.evaluate(() =>
    window
      .deep(
        window.chatView().shadowRoot,
        '[data-notice^="agent:installing:"] [data-action="show-updates"]'
      )
      .click()
  );
  await page.until(
    () => document.querySelector('slicc-app').dock.api.getPanel('updates')?.api.isVisible
  );
  const other = await page.tab();
  await other.init(helpers);
  await other.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(other);
  await other.until(
    () => document.querySelector('slicc-app').model.tabs?.state().role === 'follower'
  );
  await other.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await other.until(
    () =>
      window.composer()?.placeholder === 'Seven is updating its agent.' && !window.composer().empty
  );
  await queue(other, 'From the other tab while it installs');

  await agentUp(page, { label: 'agent after 3.26.0' });
  const up = Date.now();
  const follower = await other.within(60000, () => {
    const root = window.chatView()?.shadowRoot;
    if (!root) return false;
    if (window.deep(root, '[data-tabs-notice="skew"]')) return 'skew';
    return window.composer()?.queued.length === 0 && 'sent';
  });
  if (follower === 'skew') {
    await other.until(
      () =>
        window.composer()?.placeholder === 'Reload this tab to reach the new agent.' &&
        window.composer().queued.length === 1
    );
    await shoot(other, 'follower-reload-line', { show: 'chat' });
    await other.evaluate(() => document.querySelector('slicc-app').show('chat'));
    await other.reload();
    await ready(other);
    await other.evaluate(() => document.querySelector('slicc-app').show('chat'));
    await other.within(60000, () => window.composer()?.queued.length === 0);
  }
  t.diagnostic(`the follower tab after the install: ${follower}`);
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  const sent = await page.within(60000, () => {
    const texts = window.delivered();
    return texts.length >= 3 && texts;
  });
  const own = sent.filter((text) => text !== 'From the other tab while it installs');
  assert.deepEqual(
    own,
    ['First while it installs', 'Second while it installs'],
    JSON.stringify(sent)
  );
  assert.equal(
    sent.filter((text) => text === 'From the other tab while it installs').length,
    1,
    JSON.stringify(sent)
  );
  assert.deepEqual(await page.evaluate(() => window.composer().queued), []);
  const row = await page.evaluate(agentRow);
  assert.equal(await page.evaluate(() => window.installedAgent()), NEW_VERSION);
  assert.equal(row.state, 'installed');
  assert.deepEqual([row.from, row.to], [NEW_VERSION, NEW_VERSION]);
  const { started, done } = await installs(page, '3.26.0');
  assert.deepEqual(other.errors, []);
  await other.close();
  await page.until(async () => {
    const { pending } = await navigator.locks.query();
    return !pending.some(({ name }) => name === 'slicc-agent');
  });
  await oneHolder(page);
  await page.until(() => window.installNotice() === null);
  t.diagnostic(
    `agent 3.26.0 → ${NEW_VERSION}: the chat waited ${up - reloaded} ms after the reload, the install took ${(done ?? up) - started} ms`
  );
  await connectAccount(page, 'amazon-bedrock', KEY);
  await say(page, 'Say hello');
  assert.deepEqual(
    (await page.evaluate(() => window.delivered())).filter(
      (text) => text === 'Dropped while it installs'
    ),
    []
  );
  assert.deepEqual(page.errors, []);
});
