import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const finder = `
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
`;

async function opened(url) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  return targetInfos.filter((info) => info.type === 'page' && info.url.startsWith(url));
}

async function eventually(check, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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

const ask = (url) => `printf '{"kind":"open.url","url":"%s"}\\n' '${url}' | cat > /dev/embedder`;

test('a program opens an http(s) URL in a new tab through /dev/embedder, and a javascript:, protected or unanswered one is refused', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: finder });
  await boot(page);
  const seven = await page.evaluate(() => location.origin);

  await run(page, `${ask('https://example.test/typed')}; echo "typed $?"`);
  await shows(page, 'typed 0');
  const [tab] = await eventually(() => opened('https://example.test/typed'));
  assert.equal(tab.canAccessOpener, false);
  assert.equal(await page.evaluate(() => window.findConfirm()), null);

  await run(page, `${ask('javascript:alert(1)')}; echo "script $?"`);
  await shows(page, 'seven opens only http and https URLs');
  await shows(page, 'script 1');
  await run(page, `${ask(`${seven}/os/#follow=x`)}; echo "own $?"`);
  await shows(page, "seven doesn't open its own pages or the vault for a program");
  await shows(page, 'own 1');
  await run(page, `${ask('https://vault.sliccy.ai/')}; echo "vault $?"`);
  await shows(page, 'vault 1');
  await run(page, `${ask('not a url')}; echo "bad $?"`);
  await shows(page, "that isn't a URL");
  await shows(page, 'bad 1');
  assert.deepEqual(await opened(`${seven}/os/#follow`), []);
  assert.deepEqual(await opened('https://vault.sliccy.ai'), []);

  await run(page, `sleep 8; ${ask('https://example.test/late')}; echo "late $?"`);
  await page.until(() => !!window.findConfirm(), undefined);
  assert.match(
    await page.evaluate(() => window.findConfirm().shadowRoot.textContent),
    /A program asks seven to open https:\/\/example\.test\/late/
  );
  await page.screenshot(new URL('open-url-prompt-light.png', page.dir));
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color !== 'dark') app.toggleColor();
  });
  await page.screenshot(new URL('open-url-prompt-dark.png', page.dir));
  await page.evaluate(() => document.querySelector('slicc-app').toggleColor());
  await press(page, 'cancel');
  await shows(page, 'the request to open the page was dismissed');
  await shows(page, 'late 1');
  assert.deepEqual(await opened('https://example.test/late'), []);

  await run(page, `sleep 8; ${ask('https://example.test/clicked')}; echo "clicked $?"`);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.until(() => !!window.findConfirm(), undefined);
  await page.screenshot(new URL('open-url-prompt-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await press(page, 'action');
  await shows(page, 'clicked 0');
  await eventually(() => opened('https://example.test/clicked'));

  await run(
    page,
    `{ sleep 8; printf '%s\\n' '{"kind":"open.url","url":"https://example.test/withdrawn"}'; } | timeout 12 cat > /dev/embedder; echo "withdrawn $?"`
  );
  await page.until(() => !!window.findConfirm(), undefined);
  await shows(page, 'withdrawn 124');
  await page.until(() => !window.findConfirm(), undefined);
  assert.deepEqual(await opened('https://example.test/withdrawn'), []);
  assert.deepEqual(page.errors, []);
});
