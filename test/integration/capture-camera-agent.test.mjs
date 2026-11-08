import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { agentUp, ready, run, shows } from './bios.mjs';
import { standIn } from './camera-standin.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ tools: false, agent: true, timeout: 60000, intercept: [] });
after(() => chrome.close());
const camera = await standIn(chrome);

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
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (descriptor) =>
    descriptor?.name === 'camera' ? Promise.resolve({ state: 'prompt' }) : query(descriptor);
  window.opened = [];
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async (constraints) => {
      window.opened.push({
        video: Boolean(constraints?.video),
        active: navigator.userActivation.isActive,
      });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d');
      context.fillStyle = '#0a6';
      context.fillRect(0, 0, 64, 64);
      return canvas.captureStream(10);
    },
  });
};

async function pressDeep(page, selector) {
  await page.until((selector) => {
    const box = window.deep(selector)?.getBoundingClientRect();
    return !!box && box.width > 0;
  }, selector);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const { x, y } = await page.evaluate((selector) => {
    const box = window.deep(selector).getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, selector);
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

const still = (name) =>
  `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"capture.camera","type":"image/png","warmup":0}' >&3; cat <&3 > /tmp/${name}.png; echo "${name} $?"; exec 3<&-`;

test('with the real agent and kernel users, a camera still nobody’s guest started asks nothing: typed it runs at once, and in the background only the Allow camera click shows', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  camera();
  await page.init(media);
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page, ['slicc:/home# ']);
  await agentUp(page);

  await run(page, still('typed'));
  await shows(page, 'typed 0');
  assert.deepEqual(await page.evaluate(() => window.clickItems()), []);

  await run(page, `sleep 8; ${still('background')}`);
  await page.until(() => window.clickItems().length === 1);
  const [item] = await page.evaluate(() => window.clickItems());
  assert.equal(item.action, 'Allow camera');
  assert.equal(item.here, true);
  await pressDeep(page, 'dialog[data-kind="click"] [data-action="once"]');
  await shows(page, 'background 0');
  assert.deepEqual(await page.evaluate(() => window.opened), [
    { video: true, active: true },
    { video: true, active: true },
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
