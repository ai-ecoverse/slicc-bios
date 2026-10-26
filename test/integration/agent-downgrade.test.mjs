import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { agentUp, boot, ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const OLDER =
  'This profile was opened by a newer agent, and its sessions can’t be opened by the agent seven runs now. Seven didn’t start it. Turn on Developer mode and install the newer agent from Install / Update, or wait until seven ships it.';

const UNRECORDED =
  'Seven couldn’t record this agent’s profile version (storage full?), so it didn’t start it.';

const pinned = JSON.parse(
  await readFile(new URL('../../src/packages/agent/package.json', import.meta.url), 'utf8')
).dependencies['@ai-ecoverse/slicc-agent'];

const chrome = await launch({ tools: false, agent: true, timeout: 120000 });
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

const profile = (page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('.slicc');
    const file = await (await dir.getFileHandle('agent-profile.json')).getFile();
    return JSON.parse(await file.text());
  });

const record = (page) => page.evaluate(() => localStorage.getItem('slicc-os.agent-schema'));

test('a profile a 6.x agent last opened upgrades to the pinned 7.x agent one way, and seven then never starts a 6.x agent on it, by the agent’s marker or by its own record', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await agentUp(page);
  assert.match(pinned, /^7\./);

  await t.test(
    'a profile a 6.x agent opened starts the 7.x agent, which marks it, and seven records it',
    async () => {
      await marker(page, null);
      await page.evaluate(() => localStorage.setItem('slicc-os.agent-schema', '1'));
      await page.goto('/');
      await ready(page);
      await agentUp(page);
      assert.equal(await record(page), '2');
      assert.deepEqual(await profile(page), { durableSchema: 2, agent: pinned });
      assert.equal(
        await page.evaluate(() =>
          document
            .querySelector('slicc-app')
            .model.notices.list()
            .some((item) => item.id === 'agent:older')
        ),
        false
      );
    }
  );

  await t.test('the 7.x agent’s own marker refuses a 6.x agent', async (t) => {
    await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
    await relabel(page, '6.19.15');
    t.after(() => relabel(page, pinned).catch(() => {}));
    const seen = await refused(page);
    assert.equal(seen.error, OLDER);
    assert.equal(seen.agents, 0);
  });

  await t.test('with no marker, seven’s own record refuses a 6.x agent', async (t) => {
    await marker(page, null);
    await page.evaluate(() => localStorage.setItem('slicc-os.agent-schema', '2'));
    await relabel(page, '6.19.15');
    t.after(() => relabel(page, pinned).catch(() => {}));
    assert.equal((await refused(page)).error, OLDER);
  });

  await t.test('an unreadable marker refuses a 6.x agent too', async (t) => {
    await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
    await marker(page, 'not json');
    await relabel(page, '6.19.15');
    t.after(() => relabel(page, pinned).catch(() => {}));
    assert.equal((await refused(page)).error, OLDER);
  });

  await t.test(
    'a marker that exists but can’t be read as a file refuses a 6.x agent',
    async (t) => {
      await marker(page, null);
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('.slicc', { create: true });
        await dir.getDirectoryHandle('agent-profile.json', { create: true });
      });
      await relabel(page, '6.19.15');
      t.after(() => relabel(page, pinned).catch(() => {}));
      assert.equal((await refused(page)).error, OLDER);
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('.slicc');
        await dir.removeEntry('agent-profile.json', { recursive: true });
      });
    }
  );

  await t.test('a marker above 2 refuses the 7.x agent', async () => {
    await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
    await marker(page, JSON.stringify({ durableSchema: 3, agent: '8.0.0' }));
    assert.equal((await refused(page)).error, OLDER);
    await marker(page, null);
  });

  await t.test(
    'a 7.x first start whose profile version can’t be recorded is refused',
    async (t) => {
      await page.evaluate(() => {
        localStorage.removeItem('slicc-os.agent-schema');
        const set = Storage.prototype.setItem;
        window.sliccSet = set;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'slicc-os.agent-schema') throw new DOMException('full', 'QuotaExceededError');
          return set.call(this, key, value);
        };
      });
      t.after(async () => {
        await page
          .evaluate(() => {
            if (window.sliccSet) Storage.prototype.setItem = window.sliccSet;
          })
          .catch(() => {});
      });
      await page.evaluate(() => {
        void document
          .querySelector('slicc-app')
          .model.updates.act('agent', 'retry')
          .catch(() => {});
      });
      const error = await page.within(
        5 * 60 * 1000,
        (text) => {
          const row = document
            .querySelector('slicc-app')
            .model.updates.list()
            .find((item) => item.id === 'agent');
          return row?.state === 'failed' && row.error === text ? row.error : null;
        },
        UNRECORDED
      );
      assert.equal(error, UNRECORDED);
      assert.equal(await record(page), null);
    }
  );

  await t.test(
    'with no marker and no record, the 7.x agent starts and seven records it',
    async () => {
      await marker(page, null);
      await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
      await page.goto('/');
      await ready(page);
      await agentUp(page);
      assert.equal(await record(page), '2');
      assert.deepEqual(await profile(page), { durableSchema: 2, agent: pinned });
      assert.deepEqual(page.errors, []);
    }
  );
});
