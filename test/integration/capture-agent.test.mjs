import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { agentUp, ready, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ tools: false, agent: true, timeout: 60000 });
after(() => chrome.close());

const media = () => {
  window.deep = (selector) => {
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
  window.clickItems = () =>
    document
      .querySelector('slicc-app')
      ?.model?.approvals?.list()
      .filter((item) => item.kind === 'click') ?? [];
  window.prompted = 0;
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function (...args) {
    if (this.getRootNode()?.host?.localName === 'slicc-confirm') window.prompted += 1;
    return showModal.apply(this, args);
  };
  window.displays = [];
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async () => {
      window.displays.push({ active: navigator.userActivation.isActive });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d');
      context.fillStyle = '#0a6';
      context.fillRect(0, 0, 64, 64);
      const stream = canvas.captureStream(10);
      const [track] = stream.getVideoTracks();
      track.getCaptureHandle = () => ({ handle: 'ordinary', origin: 'https://example.test' });
      return stream;
    },
  });
};

async function pressDeep(page, selector) {
  const ready = (selector) => {
    const button = window.deep(selector);
    const box = button?.getBoundingClientRect();
    let owner = button;
    while (owner && typeof owner.arming !== 'number')
      owner = owner.parentElement ?? owner.getRootNode()?.host;
    const arming = owner?.arming ?? 500;
    const x = box ? box.x + box.width / 2 : 0;
    const y = box ? box.y + box.height / 2 : 0;
    let hit = box?.width > 0 ? document.elementFromPoint(x, y) : null;
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    const within = (outer, node) => {
      for (let at = node; at; at = at.parentNode ?? at.host) if (at === outer) return true;
      return false;
    };
    const on = !!hit && (within(button, hit) || within(hit, button));
    const key = [
      selector,
      button?.disabled,
      button?.textContent,
      box?.x,
      box?.y,
      box?.width,
      box?.height,
    ].join();
    const now = performance.now();
    if (window.settled?.key !== key) window.settled = { key, since: now };
    const stable = now - window.settled.since;
    window.pressing = {
      found: !!button,
      box: box && [box.x, box.y, box.width, box.height].map(Math.round),
      hit: hit
        ? `${hit.localName}${hit.dataset?.action ? `[data-action=${hit.dataset.action}]` : ''}`
        : null,
      on,
      stable: Math.round(stable),
      arming,
    };
    return box?.width > 0 && on && stable >= arming + 100;
  };
  await page.evaluate(() => {
    window.settled = null;
  });
  try {
    await page.until(ready, selector);
  } catch (error) {
    const seen = await page.evaluate(() => window.pressing);
    assert.fail(
      `waited for ${selector} to be the hit target at its centre with its rect unchanged for the arming time, and saw ${JSON.stringify(seen)}: ${error.message}`
    );
  }
  const { x, y } = await page.evaluate((selector) => {
    const box = window.deep(selector).getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, selector);
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

test('with the real agent and kernel users, a capture nobody’s guest started asks nothing: typed it runs at once, and in the background only the picker’s click item shows', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(media);
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page, ['slicc:/home# ']);
  await agentUp(page);
  const version = await page.evaluate(async () => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ['opt', 'agent', 'node_modules', '@ai-ecoverse', 'slicc-agent'])
      dir = await dir.getDirectoryHandle(part);
    return JSON.parse(await (await (await dir.getFileHandle('package.json')).getFile()).text())
      .version;
  });
  t.diagnostic(`slicc-agent ${version}`);

  await run(page, 'screencapture -x /tmp/typed.png; echo "typed $?"');
  await shows(page, 'typed 0');
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

  await run(page, 'sleep 8; screencapture -x /tmp/background.png; echo "background $?"');
  await page.until(() => window.clickItems().length === 1);
  const [item] = await page.evaluate(() => window.clickItems());
  assert.equal(item.action, 'Choose what to share');
  assert.equal(item.here, true);
  await pressDeep(page, 'dialog[data-kind="click"] [data-action="once"]');
  await shows(page, 'background 0');
  assert.deepEqual(await page.evaluate(() => window.displays), [
    { active: true },
    { active: true },
  ]);
  assert.equal(await page.evaluate(() => window.prompted), 0);
  assert.deepEqual(
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.approvals.list()
        .filter((entry) => entry.kind === 'capture')
    ),
    []
  );
  assert.deepEqual(page.errors, []);
});
