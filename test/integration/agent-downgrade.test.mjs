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
  return page.within(
    5 * 60 * 1000,
    (text) => {
      const { updates, notices, agent } = document.querySelector('slicc-app').model;
      const row = updates.list().find((item) => item.id === 'agent');
      if (row?.state !== 'failed' || row.error !== text) return null;
      if (!notices.list().some((item) => item.id === 'agent:older')) return null;
      return {
        error: row.error,
        agents: agent?.list?.().length ?? 0,
      };
    },
    OLDER
  );
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
    const seen = await refused(page);
    assert.equal(seen.error, OLDER);
    assert.equal(seen.agents, 0);
  });

  await t.test('an unreadable marker refuses a 6.x agent too', async (t) => {
    await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
    await marker(page, 'not json');
    await relabel(page, '6.19.15');
    t.after(() => relabel(page, pinned).catch(() => {}));
    const seen = await refused(page);
    assert.equal(seen.error, OLDER);
    assert.equal(seen.agents, 0);
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
      t.after(async () => {
        await page
          .evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('.slicc');
            await dir.removeEntry('agent-profile.json', { recursive: true });
          })
          .catch(() => {});
      });
      await relabel(page, '6.19.15');
      t.after(() => relabel(page, pinned).catch(() => {}));
      const seen = await refused(page);
      assert.equal(seen.error, OLDER);
      assert.equal(seen.agents, 0);
    }
  );

  await t.test('a marker above 2 refuses the 7.x agent', async () => {
    await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
    await marker(page, JSON.stringify({ durableSchema: 3, agent: '8.0.0' }));
    const seen = await refused(page);
    assert.equal(seen.error, OLDER);
    assert.equal(seen.agents, 0);
    await marker(page, null);
  });

  await t.test(
    'an automatic check keeps a refused row failed, keeps the notice, and does not launch again',
    async (t) => {
      await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
      await marker(page, JSON.stringify({ durableSchema: 3, agent: '8.0.0' }));
      t.after(() => marker(page, null).catch(() => {}));
      const before = page.console.filter((line) => line.includes('the agent did not start')).length;
      const seen = await refused(page);
      assert.equal(seen.error, OLDER);
      assert.equal(seen.agents, 0);
      const checkedAt = await page.evaluate(() => {
        const { updates } = document.querySelector('slicc-app').model;
        window.agentStates = [];
        const note = () => {
          const row = updates.list().find((item) => item.id === 'agent');
          if (row) window.agentStates.push(row.state);
        };
        note();
        updates.on('items', note);
        return updates.list().find((item) => item.id === 'bios')?.checkedAt ?? null;
      });
      assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.until((before) => {
        const bios = document
          .querySelector('slicc-app')
          .model.updates.list()
          .find((item) => item.id === 'bios');
        return bios?.checkedAt != null && bios.checkedAt !== before;
      }, checkedAt);
      await page.until(() => {
        const items = document.querySelector('slicc-app').model.updates.list();
        return items.every(
          (item) => !/checking|downloading|linking|starting|queued/.test(item.state)
        );
      });
      const after = await page.evaluate(() => {
        const { updates, notices, agent } = document.querySelector('slicc-app').model;
        const row = updates.list().find((item) => item.id === 'agent');
        return {
          state: row?.state ?? null,
          error: row?.error ?? null,
          notice: notices.list().some((item) => item.id === 'agent:older'),
          agents: agent?.list?.().length ?? 0,
          states: window.agentStates,
        };
      });
      assert.equal(after.state, 'failed');
      assert.equal(after.error, OLDER);
      assert.equal(after.notice, true);
      assert.equal(after.agents, 0);
      assert.equal(after.states.includes('current'), false, after.states.join(','));
      assert.equal(
        page.console.filter((line) => line.includes('the agent did not start')).length - before,
        1,
        page.console.filter((line) => line.includes('the agent did not start')).join('\n')
      );
    }
  );

  await t.test(
    'a visibility check while the boot check runs starts the refused agent once',
    async (t) => {
      await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
      await marker(page, JSON.stringify({ durableSchema: 3, agent: '8.0.0' }));
      t.after(() => marker(page, null).catch(() => {}));
      const before = page.console.filter((line) => line.includes('the agent did not start')).length;
      await page.goto('/');
      await page.until(() => !!document.querySelector('slicc-app')?.model?.updates);
      assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
      for (let n = 0; n < 5; n++)
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await ready(page);
      let seen;
      try {
        seen = await page.within(
          5 * 60 * 1000,
          (text) => {
            const { updates, notices, agent } = document.querySelector('slicc-app').model;
            const row = updates.list().find((item) => item.id === 'agent');
            if (row?.state !== 'failed' || row.error !== text) return null;
            if (!notices.list().some((item) => item.id === 'agent:older')) return null;
            return {
              error: row.error,
              agents: agent?.list?.().length ?? 0,
            };
          },
          OLDER
        );
      } catch (error) {
        const dump = await page
          .evaluate(async () => {
            const { updates, notices, agent } = document.querySelector('slicc-app')?.model ?? {};
            const locks = await navigator.locks.query();
            return {
              updates: updates?.list?.() ?? null,
              notices: notices?.list?.() ?? null,
              agents: agent?.list?.()?.length ?? null,
              locks: {
                held: (locks.held ?? []).map((lock) => lock.name),
                pending: (locks.pending ?? []).map((lock) => lock.name),
              },
            };
          })
          .catch((failed) => ({ error: failed.message }));
        const agentLines = page.console.filter((line) => /agent/i.test(line));
        throw new Error(
          `${error.message}\ndump: ${JSON.stringify(dump)}\nagent console:\n${agentLines.join('\n')}`,
          { cause: error }
        );
      }
      assert.equal(seen.error, OLDER);
      assert.equal(seen.agents, 0);
      assert.equal(
        page.console.filter((line) => line.includes('the agent did not start')).length - before,
        1,
        page.console.filter((line) => line.includes('the agent did not start')).join('\n')
      );
    }
  );

  await t.test('a marker change after the refusal lets seven start the agent', async (t) => {
    await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
    await marker(page, JSON.stringify({ durableSchema: 3, agent: '8.0.0' }));
    const seen = await refused(page);
    assert.equal(seen.error, OLDER);
    assert.equal(seen.agents, 0);
    await marker(page, null);
    t.after(() => marker(page, null).catch(() => {}));
    await page.evaluate(() => {
      window.sliccRetry = document
        .querySelector('slicc-app')
        .model.updates.act('agent', 'retry')
        .then(
          () => 'done',
          (error) => error.message
        );
    });
    assert.equal(await page.until(() => window.sliccRetry), 'done');
    await agentUp(page);
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector('slicc-app')
          .model.notices.list()
          .some((item) => item.id === 'agent:older')
      ),
      false
    );
    assert.equal(await record(page), '2');
  });

  await t.test(
    'an explicit Retry after a refusal attempts a start again with nothing changed',
    async (t) => {
      await page.evaluate(() => localStorage.removeItem('slicc-os.agent-schema'));
      await marker(page, JSON.stringify({ durableSchema: 3, agent: '8.0.0' }));
      t.after(() => marker(page, null).catch(() => {}));
      const before = page.console.filter((line) => line.includes('the agent did not start')).length;
      const seen = await refused(page);
      assert.equal(seen.error, OLDER);
      assert.equal(seen.agents, 0);
      await page.evaluate(() => {
        window.sliccRetry = document
          .querySelector('slicc-app')
          .model.updates.act('agent', 'retry')
          .then(
            () => 'done',
            (error) => error.message
          );
      });
      assert.equal(await page.until(() => window.sliccRetry), 'done');
      const after = await page.evaluate(() => {
        const { updates, notices, agent } = document.querySelector('slicc-app').model;
        const row = updates.list().find((item) => item.id === 'agent');
        return {
          state: row?.state ?? null,
          error: row?.error ?? null,
          notice: notices.list().some((item) => item.id === 'agent:older'),
          agents: agent?.list?.().length ?? 0,
        };
      });
      assert.equal(after.state, 'failed');
      assert.equal(after.error, OLDER);
      assert.equal(after.notice, true);
      assert.equal(after.agents, 0);
      assert.equal(
        page.console.filter((line) => line.includes('the agent did not start')).length - before,
        2,
        page.console.filter((line) => line.includes('the agent did not start')).join('\n')
      );
    }
  );

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
    'an automatic check starts the agent once recording the profile version works again',
    async () => {
      assert.equal(
        await page.evaluate(() => {
          const row = document
            .querySelector('slicc-app')
            .model.updates.list()
            .find((item) => item.id === 'agent');
          return row?.error ?? null;
        }),
        UNRECORDED
      );
      await page.evaluate(() => {
        if (window.sliccSet) Storage.prototype.setItem = window.sliccSet;
      });
      assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.until(() => {
        const row = document
          .querySelector('slicc-app')
          .model.updates.list()
          .find((item) => item.id === 'agent');
        return row && row.state !== 'failed';
      });
      await agentUp(page);
      assert.equal(await record(page), '2');
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
