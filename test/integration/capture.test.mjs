import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const TITLE = 'Capture target';
const chrome = await launch({ args: [`--auto-select-tab-capture-source-by-title=${TITLE}`] });
after(() => chrome.close());

const helpers = `
  window.findConfirm = () => {
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.localName === 'slicc-confirm') return element;
        const inner = element.shadowRoot && walk(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return walk(document);
  };
  window.copied = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: async () => '',
      writeText: async () => {},
      write: async (items) => {
        for (const item of items)
          for (const type of item.types) {
            const blob = await item.getType(type);
            const head = [...new Uint8Array(await blob.slice(0, 4).arrayBuffer())];
            window.copied.push({ type, size: blob.size, head });
          }
      },
    },
  });
`;

const PNG = '89 50 4e 47';

async function target() {
  const html = `<!doctype html><title>${TITLE}</title><body style="margin:0;background:#0a6"><h1>dummy</h1>`;
  const { targetId } = await chrome.cdp.send('Target.createTarget', {
    url: `data:text/html,${encodeURIComponent(html)}`,
    background: true,
  });
  return () => chrome.cdp.send('Target.closeTarget', { targetId });
}

async function press(page, which) {
  await page.until(
    (which) => !!window.findConfirm()?.shadowRoot?.querySelector(`[data-${which}]`),
    which
  );
  const { x, y } = await page.evaluate((which) => {
    const box = window
      .findConfirm()
      .shadowRoot.querySelector(`[data-${which}]`)
      .getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, which);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

const magic = (file) => `od -An -tx1 -N4 ${file} | tr -s ' ' | sed 's/^ //'`;

test('screencapture through /dev/embedder: typed it captures the picked tab, delayed it asks first, Cancel refuses, and -c copies the PNG', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers });
  await boot(page);
  const close = await target();

  await run(page, `screencapture -x /tmp/typed.png; echo "typed $? $(${magic('/tmp/typed.png')})"`);
  await shows(page, `typed 0 ${PNG}`);
  assert.equal(await page.evaluate(() => window.findConfirm()), null);

  await run(
    page,
    `sleep 8; screencapture -x /tmp/late.png; echo "late $? $(${magic('/tmp/late.png')})"`
  );
  await page.until(() => !!window.findConfirm(), undefined);
  assert.match(
    await page.evaluate(() => window.findConfirm().shadowRoot.textContent),
    /Capture the screen\?.*A program asks seven to capture your screen\. You pick what to share next\./s
  );
  await page.screenshot(new URL('capture-prompt-light.png', page.dir));
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color !== 'dark') app.toggleColor();
  });
  await page.screenshot(new URL('capture-prompt-dark.png', page.dir));
  await page.evaluate(() => document.querySelector('slicc-app').toggleColor());
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.until(() => document.documentElement.clientWidth === 420);
  await page.screenshot(new URL('capture-prompt-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await press(page, 'action');
  await shows(page, `late 0 ${PNG}`);

  await run(page, `sleep 8; screencapture -x /tmp/no.png; echo "no $?"; ls /tmp/no.png`);
  await page.until(() => !!window.findConfirm(), undefined);
  await press(page, 'cancel');
  await shows(page, 'no 1');
  await shows(page, 'No such file or directory');

  await run(page, 'sleep 12; screencapture -c; echo "clip $?"');
  await page.until(() => !!window.findConfirm(), undefined);
  await press(page, 'action');
  await shows(page, 'KB to clipboard');
  await shows(page, 'clip 0');
  const copied = await page.evaluate(() => window.copied);
  assert.equal(copied.length, 1, JSON.stringify(copied));
  assert.equal(copied[0].type, 'image/png');
  assert.ok(copied[0].size > 100, JSON.stringify(copied));
  assert.deepEqual(copied[0].head, [0x89, 0x50, 0x4e, 0x47]);

  await close();
  assert.deepEqual(page.errors, []);
});

test('a capture that lands on another of seven’s tabs is stopped and refused', async (t) => {
  const a = await chrome.page(t);
  await a.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers });
  await boot(a);
  const b = await a.tab();
  await boot(b);
  await b.evaluate((title) => {
    document.title = title;
    new MutationObserver(() => {
      if (document.title !== title) document.title = title;
    }).observe(document.querySelector('title') ?? document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, TITLE);
  await a.send('Page.bringToFront');
  await run(
    a,
    `printf '%s\\n' '{"kind":"capture.screen","type":"image/png"}' | cat > /dev/embedder; echo "own $?"`
  );
  await shows(a, "seven doesn't capture its own pages or the vault");
  await shows(a, 'own 1');
  assert.equal(await a.evaluate(() => window.findConfirm()), null);
  assert.deepEqual(a.errors, []);
});
