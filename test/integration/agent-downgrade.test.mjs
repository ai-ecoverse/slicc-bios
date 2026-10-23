import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { agentUp, boot, ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const OLDER =
  'This profile was opened by a newer agent, and its sessions can’t be opened by the agent seven runs now. Seven didn’t start it. Turn on Developer mode and install the newer agent from Install / Update, or wait until seven ships it.';

const UNRECORDED =
  'Seven couldn’t record this agent’s profile version (storage full?), so it didn’t start it.';

const chrome = await launch({ agent: true, timeout: 120000 });
after(() => chrome.close());

const relabel = (page, version) =>
  page.evaluate(async (version) => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ['opt', 'agent', 'node_modules', '@ai-ecoverse', 'slicc-agent'])
      dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle('package.json');
    const manifest = JSON.parse(await (await handle.getFile()).text());
    const was = manifest.version;
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify({ ...manifest, version }, null, 2));
    await writable.close();
    return was;
  }, version);

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
  await page.init(() => {
    try {
      if (!sessionStorage.getItem('slicc-test.full')) return;
    } catch {
      return;
    }
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'slicc-os.agent-schema') throw new DOMException('full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
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

  await t.test('a marker that exists but can’t be read as a file refuses it', async () => {
    await marker(page, null);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('.slicc', { create: true });
      await dir.getDirectoryHandle('agent-profile.json', { create: true });
    });
    assert.equal((await refused(page)).error, OLDER);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('.slicc');
      await dir.removeEntry('agent-profile.json', { recursive: true });
    });
  });

  await t.test('seven’s own record of a 7.x agent refuses it with no marker', async () => {
    await marker(page, null);
    await page.evaluate(() => localStorage.setItem('slicc-os.agent-schema', '2'));
    assert.equal((await refused(page)).error, OLDER);
  });

  await t.test('a marker above 2 refuses a 7.x agent too', async () => {
    await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
    await marker(page, JSON.stringify({ durableSchema: 3, agent: '8.0.0' }));
    const was = await relabel(page, '7.0.0');
    assert.equal((await refused(page)).error, OLDER);
    await relabel(page, was);
    await marker(page, null);
  });

  await t.test(
    'a 7.x first start whose profile version can’t be recorded is refused',
    async (t) => {
      await page.evaluate(() => {
        localStorage.removeItem('slicc-os.agent-schema');
        sessionStorage.setItem('slicc-test.full', '1');
      });
      let was = null;
      t.after(async () => {
        await page.evaluate(() => sessionStorage.removeItem('slicc-test.full')).catch(() => {});
        if (was) await relabel(page, was).catch(() => {});
        await page.goto('/');
        await ready(page);
        assert.equal(
          await page.evaluate(() => {
            localStorage.setItem('slicc-os.probe', 'x');
            localStorage.removeItem('slicc-os.probe');
            return sessionStorage.getItem('slicc-test.full');
          }),
          null
        );
      });
      await page.goto('/');
      await ready(page);
      assert.equal(
        await page.evaluate(() => {
          try {
            localStorage.setItem('slicc-os.agent-schema', '0');
            return 'written';
          } catch (error) {
            return error.name;
          }
        }),
        'QuotaExceededError'
      );
      was = await relabel(page, '7.0.0');
      assert.equal((await refused(page)).error, UNRECORDED);
      assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.agent-schema')), null);
    }
  );

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
