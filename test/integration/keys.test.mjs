import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const INSTALL = 15 * 60 * 1000;
const chrome = await launch({ agent: true, timeout: 60000 });
after(() => chrome.close());

const deep = (selector) => {
  const walk = (root) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && walk(element.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  return walk(document);
};

test('agent 4.x wipes 3.x’s key store once, says which accounts to add again, and a send says Bedrock isn’t connected', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/manifest.json');
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('slicc-agent-credentials', 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore('keys');
        opening.result.createObjectStore('credentials');
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const store = db.transaction('credentials', 'readwrite').objectStore('credentials');
    const sealed = { iv: new Uint8Array(12), data: new Uint8Array(32) };
    for (const key of ['adobe', 'amazon-bedrock', 'mcp:github|0f3a']) store.put(sealed, key);
    await new Promise((resolve) => {
      store.transaction.oncomplete = resolve;
    });
    db.close();
  });
  await page.init(() => {
    Object.defineProperty(navigator.storage, 'persist', { value: async () => false });
    Object.defineProperty(navigator.storage, 'persisted', { value: async () => false });
  });
  await page.goto('/');
  await ready(page);
  await page.within(INSTALL, () => document.querySelector('slicc-app').model.updates.ready());
  const notice = await page.within(60000, () =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .find((item) => item.id === 'keys-moved')
  );
  assert.equal(notice.title, "Your keys moved to seven's vault.");
  assert.equal(
    notice.body,
    'Add them again in Settings › Accounts: Adobe, Bedrock, and the MCP server github.'
  );
  const databases = await page.evaluate(async () =>
    (await indexedDB.databases()).map((database) => database.name)
  );
  assert.equal(databases.includes('slicc-agent-credentials'), false);
  assert.equal(
    chrome.vault.log.some((entry) => ['put', 'seal', 'remove', 'restore'].includes(entry.op)),
    false
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.within(30000, new Function(`return !!(${deep})('[data-notice="keys-moved"]')`));
  await shoot(page, 'keys-moved', { show: 'chat', target: '[data-notice="keys-moved"]' });

  await page.within(30000, new Function(`return !!(${deep})('textarea')`));
  await page.evaluate(new Function(`(${deep})('textarea').focus()`));
  await page.insert('Say hello');
  await page.enter();
  await page.within(120000, () => {
    const { agent } = document.querySelector('slicc-app').model;
    return /Bedrock isn.t connected\./.test(JSON.stringify(agent.messages(agent.active())));
  });
  await page.within(30000, () => {
    const ids = document
      .querySelector('slicc-app')
      .model.notices.list()
      .map((item) => item.id);
    return ids.includes('storage') && ids.includes('keys-moved');
  });
  await shoot(page, 'not-connected', { show: 'chat' });

  await page.evaluate(
    new Function(`(${deep})('[data-notice="keys-moved"] [data-dismiss]').click()`)
  );
  await page.within(30000, () =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .every((item) => item.id !== 'keys-moved')
  );
  await page.reload();
  await ready(page);
  await page.within(INSTALL, () => document.querySelector('slicc-app').model.updates.ready());
  await new Promise((resolve) => setTimeout(resolve, 5000));
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.notices.list()
        .some((item) => item.id === 'keys-moved')
    ),
    false
  );
  assert.deepEqual(page.errors, []);
});
