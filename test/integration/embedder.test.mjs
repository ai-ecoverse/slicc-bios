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

async function box(page) {
  return page.until(() => {
    const element = window.findConfirm();
    const dialog = element?.shadowRoot?.querySelector('dialog[open]');
    const body = element?.shadowRoot?.querySelector('#body');
    if (!dialog || !body) return null;
    const { left, right, width } = dialog.getBoundingClientRect();
    if (!width) return null;
    return {
      left,
      right,
      width,
      viewport: document.documentElement.clientWidth,
      fits: body.scrollWidth <= body.clientWidth + 1,
    };
  }, undefined);
}

function inside(found, what) {
  assert.ok(found.left >= 0 && found.right <= found.viewport, `${what}: ${JSON.stringify(found)}`);
  assert.ok(found.fits, `${what} doesn't wrap: ${JSON.stringify(found)}`);
}

let probes = 0;

async function settled(page, wide) {
  await page.until((wide) => innerWidth === wide, wide);
  for (;;) {
    const token = `zq${(probes += 1)}`;
    await page.evaluate(() => {
      const { dock } = document.querySelector('slicc-app');
      const id = dock.api.panels
        .map((panel) => panel.id)
        .findLast((id) => id.startsWith('terminal:'));
      dock.api.getPanel(id)?.api.setActive();
      dock.content(id).screen.focus();
    });
    await page.insert(token);
    try {
      await shows(page, token, 5000);
      break;
    } catch (error) {
      if (probes > 10) throw error;
    }
  }
  await page.press('u', 'ctrl');
}

async function focusedTerminal(page) {
  const token = `zf${(probes += 1)}`;
  for (const key of token) await page.press(key);
  await shows(page, token, 10000);
  await page.press('u', 'ctrl');
}

const REST_MS = 10_000;

const LONG = `https://example.test/${'a'.repeat(280)}`;

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
  const wide = await page.evaluate(() => innerWidth);

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

  await run(
    page,
    `sleep 8; ${ask('https://example.test/late')}; echo "late $?"; ${ask('https://example.test/rested')}; echo "rested $?"`
  );
  await page.until(() => !!window.findConfirm(), undefined);
  assert.match(
    await page.evaluate(() => window.findConfirm().shadowRoot.textContent),
    /A program asks seven to open https:\/\/example\.test\/late/
  );
  const short1280 = await box(page);
  inside(short1280, 'the short URL at 1280');
  await page.screenshot(new URL('open-url-prompt-light.png', page.dir));
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color !== 'dark') app.toggleColor();
  });
  await page.screenshot(new URL('open-url-prompt-dark.png', page.dir));
  await page.evaluate(() => document.querySelector('slicc-app').toggleColor());
  await page.until(() => navigator.userActivation.isActive === false, undefined);
  await page.evaluate(() => window.findConfirm().shadowRoot.querySelector('[data-cancel]').click());
  const cancelled = Date.now();
  const outcome = await page.until(() => {
    if (window.findConfirm()?.shadowRoot?.textContent.includes('example.test/rested'))
      return 'prompted';
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    return dock.content(id).screen.textContent.includes('rested 1') ? 'refused' : null;
  }, undefined);
  const answered = Date.now() - cancelled;
  t.diagnostic(`rest: the refusal came ${answered} ms after Cancel`);
  assert.equal(
    outcome,
    'refused',
    `the request ${answered} ms after Cancel got a prompt instead of the rest's refusal`
  );
  assert.ok(answered < REST_MS, `the refusal came ${answered} ms after Cancel, past the rest`);
  assert.equal(await page.evaluate(() => navigator.userActivation.isActive), false);
  await shows(page, 'late 1');
  assert.deepEqual(await opened('https://example.test/late'), []);
  assert.equal(await page.evaluate(() => window.findConfirm()), null);
  assert.match(
    await page.evaluate(() => {
      const { dock } = document.querySelector('slicc-app');
      const id = dock.api.panels
        .map((panel) => panel.id)
        .findLast((id) => id.startsWith('terminal:'));
      return dock.content(id).screen.textContent;
    }),
    /late 1.*the request to open the page was dismissed.*rested 1/s
  );
  assert.deepEqual(await opened('https://example.test/rested'), []);

  await run(page, `sleep 12; ${ask(LONG)}; echo "long $?"`);
  await page.until(() => !!window.findConfirm(), undefined);
  const long1280 = await box(page);
  inside(long1280, 'the long URL at 1280');
  t.diagnostic(`dialog width at 1280: ${short1280.width} short, ${long1280.width} long`);
  assert.ok(
    long1280.width <= short1280.width + 100,
    `the long URL widens the dialog: ${short1280.width} → ${long1280.width}`
  );
  await page.screenshot(new URL('open-url-prompt-long-light.png', page.dir));
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.until(() => document.documentElement.clientWidth === 420);
  const long420 = await box(page);
  inside(long420, 'the long URL at 420');
  await page.screenshot(new URL('open-url-prompt-long-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await press(page, 'cancel');
  await shows(page, 'long 1');
  await settled(page, wide);

  await run(page, `sleep 12; ${ask('https://example.test/clicked')}; echo "clicked $?"`);
  await shows(page, 'echo "clicked $?"');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.until(() => !!window.findConfirm(), undefined);
  await page.screenshot(new URL('open-url-prompt-420.png', page.dir));
  const short420 = await box(page);
  inside(short420, 'the short URL at 420');
  t.diagnostic(`dialog width at 420: ${short420.width} short, ${long420.width} long`);
  assert.ok(
    Math.abs(long420.width - short420.width) <= 1,
    `the long URL changes the dialog's width at 420: ${short420.width} → ${long420.width}`
  );
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await press(page, 'action');
  await shows(page, 'clicked 0');
  await eventually(() => opened('https://example.test/clicked'));
  await settled(page, wide);

  const header = (url) => `'{"kind":"open.url","url":"${url}"}'`;
  await run(
    page,
    `{ sleep 8; printf '%s\\n' ${header('https://example.test/withdrawn')}; } | cat > /dev/embedder & p=$!; sleep 14; kill $p; wait $p; echo "withdrawn $?"`
  );
  await page.until(() => !!window.findConfirm(), undefined);
  await shows(page, 'withdrawn 143');
  await page.until(() => !window.findConfirm(), undefined);
  await focusedTerminal(page);
  assert.deepEqual(await opened('https://example.test/withdrawn'), []);

  await run(
    page,
    `{ sleep 8; printf '%s\\n' ${header('https://example.test/first')}; } | cat > /dev/embedder & p=$!; sleep 12; printf '%s\\n' ${header('https://example.test/second')} | cat > /dev/embedder; echo "second $?"; wait $p; echo "first $?"`
  );
  await page.until(() => !!window.findConfirm(), undefined);
  await shows(page, 'another request is waiting for you');
  await shows(page, 'second 1');
  assert.match(
    await page.evaluate(() => window.findConfirm().shadowRoot.textContent),
    /open https:\/\/example\.test\/first/
  );
  await shows(page, 'nobody answered the request to open the page within 60 s');
  await shows(page, 'first 1');
  await page.until(() => !window.findConfirm(), undefined);
  assert.deepEqual(await opened('https://example.test/first'), []);
  assert.deepEqual(await opened('https://example.test/second'), []);
  assert.deepEqual(page.errors, []);
});

test('a second tab answers its own terminal’s requests: the prompt shows there, not in the owner', async (t) => {
  const a = await chrome.page(t);
  await a.send('Page.addScriptToEvaluateOnNewDocument', { source: finder });
  await boot(a);
  const b = await a.tab();
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: finder });
  await boot(b);
  await a.until(() => document.querySelector('slicc-app').model.tabs?.state().role === 'owner');
  await b.until(() => document.querySelector('slicc-app').model.tabs?.state().role === 'follower');
  await b.send('Page.bringToFront');
  await run(b, `${ask('https://example.test/from-b')}; echo "b typed $?"`);
  await shows(b, 'b typed 0');
  await eventually(() => opened('https://example.test/from-b'));
  await run(b, `sleep 8; ${ask('https://example.test/b-late')}; echo "b late $?"`);
  await b.until(() => !!window.findConfirm(), undefined);
  assert.equal(await a.evaluate(() => window.findConfirm()), null);
  await press(b, 'cancel');
  await shows(b, 'the request to open the page was dismissed');
  await shows(b, 'b late 1');
  assert.deepEqual(await opened('https://example.test/b-late'), []);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
});
