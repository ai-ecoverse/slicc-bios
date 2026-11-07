import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startFakeVault } from './fake-vault.mjs';

const chrome = await launch({ vault: false });
after(() => chrome.close());

const helpers = () => {
  window.deep = (root, selector) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && window.deep(element.shadowRoot, selector);
      if (inner) return inner;
    }
    return null;
  };
  window.composer = () => {
    const dock = document.querySelector('slicc-app').dock;
    const ids = dock.api.panels.map((panel) => panel.id);
    const chats = [
      ...ids.filter((id) => id.startsWith('chat:')),
      ...ids.filter((id) => id === 'chat'),
    ];
    const view = chats.map((id) => dock.content(id)).find((each) => each?.shadowRoot);
    return view ? window.deep(view.shadowRoot, 'slicc-composer') : null;
  };
  window.holds = (needle) => {
    const seen = [];
    const walk = (root) => {
      for (const node of root.querySelectorAll('*')) {
        if (node.textContent?.includes(needle)) seen.push(`text:${node.localName}`);
        for (const attribute of node.attributes)
          if (attribute.value.includes(needle))
            seen.push(`attr:${node.localName}.${attribute.name}`);
        if (typeof node.value === 'string' && node.value.includes(needle))
          seen.push(`value:${node.localName}`);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    walk(document);
    return seen;
  };
  window.passwords = () => {
    const found = [];
    const walk = (root) => {
      for (const node of root.querySelectorAll('input'))
        if (node.type === 'password') found.push(node);
      for (const node of root.querySelectorAll('*')) if (node.shadowRoot) walk(node.shadowRoot);
    };
    walk(document);
    return found.length;
  };
};

async function logged(fake, check, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!check(fake.log) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return check(fake.log);
}

test('the composer’s Share a secret saves the value through the vault’s frame, and spectrum’s DOM never holds it', async (t) => {
  const fake = await startFakeVault({ secrets: [] });
  t.after(() => fake.close());
  const page = await chrome.page(t);
  await page.init(
    `() => { if (location.origin === ${JSON.stringify(new URL(chrome.url).origin)}) localStorage.setItem('slicc-os.vault-origin', ${JSON.stringify(fake.origin)}); }`
  );
  await page.init(`(${helpers})`);
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  assert.equal(await page.evaluate(() => globalThis.sliccValueEntry), undefined);
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(() => !!window.composer()?.shadowRoot);

  await page.evaluate(() => {
    window.composer().popup = { kind: 'secret' };
  });
  await page.until(() => !!window.deep(window.composer().shadowRoot, 'form.popup.secret'));
  assert.equal(await page.evaluate(() => window.passwords()), 0);
  await page.evaluate(() => {
    const form = window.deep(window.composer().shadowRoot, 'form.popup.secret');
    const name = form.querySelector('input[name=name]');
    name.value = 'TIDE_SHARED';
    name.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  });
  await page.evaluate(() =>
    window.deep(window.composer().shadowRoot, '[data-action=share-secret]').click()
  );
  await page.until(() => {
    const form = window.deep(window.composer().shadowRoot, 'form.popup.secret[data-entry]');
    const host = form?.querySelector('slicc-vault-value');
    return !!host?.shadowRoot?.querySelector('iframe[data-vault="value"]');
  });
  assert.ok(
    await logged(fake, (log) =>
      log.some(
        (entry) =>
          entry.role === 'value' && entry.op === 'value' && entry.request?.startsWith('enter-')
      )
    )
  );
  const request = fake.log.find(
    (entry) => entry.role === 'value' && entry.op === 'value' && entry.request?.startsWith('enter-')
  ).request;
  const fields = fake.log.find((entry) => entry.op === 'enter-fields');
  assert.deepEqual([fields.name, fields.fields], ['TIDE_SHARED', ['name']]);
  assert.equal(await page.evaluate(() => window.passwords()), 0);

  const value = 'tide-shared-in-frame-5e7a';
  fake.set({ typed: { request, value } });
  await page.until(() =>
    [...window.composer().shadowRoot.querySelectorAll('swc-upload-attachment')].some((item) =>
      item.textContent.includes('TIDE_SHARED')
    )
  );
  assert.ok(
    await logged(fake, (log) =>
      log.some(
        (entry) =>
          entry.op === 'entered' && entry.request === request && entry.name === 'TIDE_SHARED'
      )
    )
  );
  const record = await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.vault.list()
      ?.secrets.find((secret) => secret.name === 'TIDE_SHARED')
  );
  assert.equal(record.source, 'settings');
  assert.equal(
    await page.evaluate(() => !!window.deep(window.composer().shadowRoot, 'form.popup.secret')),
    false
  );

  for (const needle of [value, 'frame-extra-value'])
    assert.deepEqual(await page.evaluate((needle) => window.holds(needle), needle), [], needle);
  assert.ok(!fake.log.some((entry) => entry.op === 'put'));
  assert.ok(!page.console.some((line) => line.includes(value)));
  assert.deepEqual(page.errors, []);
});
