import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_BUDGET, agentUp, connectAccount, ready } from './bios.mjs';
import {
  agentRow,
  installedOld,
  installs,
  KEY,
  NEW_VERSION,
  oneHolder,
  say,
} from './old-agent-fixture.mjs';

test("slicc-agent 5.0.3, which honours held, answers while seven's agent installs in place, without the updating notice, and Restart agent puts the chat on the new agent without a reload", {
  timeout: 60 * 60 * 1000,
}, async (t) => {
  const { page, owner } = await installedOld(t, '5.0.3');
  assert.match(owner, /options\.held/);
  const reloaded = Date.now();
  await page.reload();
  await ready(page);
  await agentUp(page, { label: 'agent 5.0.3 after the reload' });
  const up = Date.now();
  await connectAccount(page, 'amazon-bedrock', KEY);
  await say(page, 'Say hello');
  const answered = Date.now();
  const during = await page.evaluate(agentRow);
  await page.within(AGENT_BUDGET, () => {
    const row = document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'agent');
    return row.state === 'ready' && row.actions.includes('restart-agent');
  });
  const offered = Date.now();
  const offer = await page.evaluate(agentRow);
  assert.deepEqual([offer.from, offer.to], ['5.0.3', NEW_VERSION]);
  const { started, done } = await installs(page, '5.0.3');
  assert.ok(
    answered < (done ?? offered),
    `the old agent answered at ${answered}, the install ended at ${done}`
  );
  assert.equal(await page.evaluate(() => window.noticeSeen), false);
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.updates.act('agent', 'restart-agent')
  );
  await page.within(
    AGENT_BUDGET,
    (version) => {
      const row = document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === 'agent');
      return row.state === 'current' && row.from === version && row.to === version;
    },
    NEW_VERSION
  );
  const restarted = Date.now();
  await oneHolder(page);
  await say(page, 'Say hello again');
  assert.equal(await page.evaluate(() => window.noticeSeen), false);
  t.diagnostic(
    `agent 5.0.3 → ${NEW_VERSION} in place: the old agent was up ${up - reloaded} ms after the reload (row ${during.state} when it answered), the install took ${(done ?? offered) - started} ms, Restart agent was offered ${offered - reloaded} ms after the reload and took ${restarted - offered} ms`
  );
  assert.deepEqual(page.errors, []);
});
