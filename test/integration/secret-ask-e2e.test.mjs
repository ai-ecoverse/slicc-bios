import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, prompt, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startFakeVault } from './fake-vault.mjs';

const chrome = await launch({ vault: false });
after(() => chrome.close());

const secrets = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.approvals.list()
      .filter((item) => item.kind === 'secret')
  );

async function waitFor(label, read, ok, ms = 30000) {
  const deadline = Date.now() + ms;
  let seen = await read();
  while (!ok(seen)) {
    if (Date.now() >= deadline)
      throw new Error(`${label}: not within ${ms} ms; last saw ${JSON.stringify(seen)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    seen = await read();
  }
  return seen;
}

const listed = (page, count) =>
  waitFor(
    `${count} secret approvals listed`,
    () => secrets(page),
    (list) => list.length === count
  );

const settled = (page) =>
  page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((panel) => panel.startsWith('terminal:'));
    const terminal = dock.content(id).screen;
    const frames = [];
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.localName === 'iframe' && element.dataset.vault === 'value')
          frames.push(element);
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    };
    walk(document);
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const describe = (element) => {
      if (!element || element === document || element.nodeType !== 1) return null;
      const data = {};
      for (const attribute of element.attributes ?? []) {
        if (attribute.name.startsWith('data-')) data[attribute.name] = attribute.value;
      }
      return {
        tag: element.localName,
        id: element.id || null,
        ariaLabel: element.getAttribute('aria-label'),
        data,
      };
    };
    const chain = [];
    let node = active;
    let inTerminal = false;
    while (node) {
      if (node === terminal) inTerminal = true;
      if (chain.length < 4) {
        const step = describe(node);
        if (step) chain.push(step);
      }
      if (node === terminal) break;
      if (chain.length >= 4 && inTerminal) break;
      const next = node.parentNode ?? node.host ?? null;
      if (chain.length >= 4) {
        let rest = next;
        while (rest) {
          if (rest === terminal) inTerminal = true;
          rest = rest.parentNode ?? rest.host ?? null;
        }
        break;
      }
      node = next;
    }
    return {
      frames: frames.length,
      focus: describe(active),
      chain,
      inTerminal,
    };
  });

async function focusTerminal(page) {
  const box = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((panel) => panel.startsWith('terminal:'));
    dock.api.getPanel(id)?.api.setActive();
    const rect = dock.content(id).screen.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
  }
}

async function answered(page, marker) {
  await shows(page, marker);
  await waitFor(
    `the prompt after ${marker}`,
    () => screen(page),
    (text) => text.slice(text.lastIndexOf(marker)).includes(prompt.trim())
  );
  await waitFor(
    `the secret dialog gone after ${marker}`,
    () => settled(page),
    (state) => state.frames === 0
  );
  await focusTerminal(page);
  await waitFor(
    `focus in the terminal after ${marker}`,
    () => settled(page),
    (state) => state.inTerminal
  );
}

test('sealed ask from a terminal opens spectrum’s secret dialog with the vault’s frame: the typed value comes back to the program, Deny exits 1, and the session then rests', async (t) => {
  const fake = await startFakeVault({ secrets: [] });
  t.after(() => fake.close());
  const page = await chrome.page(t);
  await page.init(
    `() => { if (location.origin === ${JSON.stringify(new URL(chrome.url).origin)}) localStorage.setItem('slicc-os.vault-origin', ${JSON.stringify(fake.origin)}); }`
  );
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  assert.equal(await page.evaluate(() => globalThis.sliccSecretApprovals), undefined);

  await run(page, 'clear; V=$(sealed ask TIDE_TOKEN --reveal); echo "GOT-$V-$?"');
  const [entered] = await listed(page, 1);
  assert.deepEqual(
    [entered.mode, entered.requester.kind, entered.requester.where, entered.process.exe],
    ['enter', 'user', 'a terminal', '/usr/bin/sealed']
  );
  await waitFor(
    'spectrum’s dialog loading the vault’s frame for the request',
    () => fake.log.filter((entry) => entry.role === 'value'),
    (log) => log.some((entry) => entry.op === 'value' && entry.request === entered.id)
  );
  fake.set({ typed: { request: entered.id, value: 'tide-e2e-value-91ab' } });
  await answered(page, 'GOT-tide-e2e-value-91ab-0');
  await listed(page, 0);

  await run(page, 'clear; sealed ask TIDE_TOKEN --reveal; echo "DENIED-$?"');
  const [revealing] = await listed(page, 1);
  assert.equal(revealing.mode, 'reveal');
  await page.evaluate(
    (id) => document.querySelector('slicc-app').model.approvals.decide(id, 'deny'),
    revealing.id
  );
  await answered(page, 'DENIED-1');

  await run(page, 'clear; sealed ask TIDE_TOKEN; echo "RESTING-$?"');
  await shows(page, 'RESTING-3');
  assert.match(await screen(page), /another request was just dismissed/);
  assert.ok(!page.console.some((line) => line.includes('tide-e2e-value-91ab')));
  assert.deepEqual(page.errors, []);
});
