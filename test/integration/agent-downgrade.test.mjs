import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { agentUp, boot, ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const OLDER =
  'This profile was opened by a newer agent, and its sessions can’t be opened by the agent seven runs now. Seven didn’t start it. Install the newer agent again from Install / Update, or wait until seven ships it.';

const chrome = await launch({ agent: true, timeout: 120000 });
after(() => chrome.close());

const marker = (page, data) =>
  page.evaluate(async (data) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('.slicc', { create: true });
    if (data === null) {
      await dir.removeEntry('agent-profile.json').catch(() => {});
      return;
    }
    const writable = await (
      await dir.getFileHandle('agent-profile.json', { create: true })
    ).createWritable();
    await writable.write(data);
    await writable.close();
  }, data);

async function refused(page) {
  await page.goto('/');
  await ready(page);
  await page.within(5 * 60 * 1000, () => {
    const { updates, notices } = document.querySelector('slicc-app').model;
    const row = updates.list().find((item) => item.id === 'agent');
    return row?.state === 'failed' && notices.list().some((item) => item.id === 'agent:older');
  });
  return page.evaluate(() => {
    const { updates, agent } = document.querySelector('slicc-app').model;
    return {
      error: updates.list().find((item) => item.id === 'agent').error,
      agents: agent?.list?.().length ?? 0,
    };
  });
}

test('seven never starts a 6.x agent on a profile a 7.x agent opened, by the agent’s marker or by its own record', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await agentUp(page);

  await t.test('a marker of durableSchema 2 refuses the 6.x agent', async () => {
    await marker(page, JSON.stringify({ durableSchema: 2, agent: '7.0.1' }));
    const seen = await refused(page);
    assert.equal(seen.error, OLDER);
    assert.equal(seen.agents, 0);
  });

  await t.test('an unreadable marker refuses it too', async () => {
    await marker(page, 'not json');
    assert.equal((await refused(page)).error, OLDER);
  });

  await t.test('seven’s own record of a 7.x agent refuses it with no marker', async () => {
    await marker(page, null);
    await page.evaluate(() => localStorage.setItem('slicc-os.agent-schema', '2'));
    assert.equal((await refused(page)).error, OLDER);
  });

  await t.test(
    'with no marker and no record, the 6.x agent starts and seven records it',
    async () => {
      await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
      await page.goto('/');
      await ready(page);
      await agentUp(page);
      assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.agent-schema')), '1');
      assert.equal(
        await page.evaluate(() =>
          document
            .querySelector('slicc-app')
            .model.notices.list()
            .some((item) => item.id === 'agent:older')
        ),
        false
      );
      assert.deepEqual(page.errors, []);
    }
  );
});
