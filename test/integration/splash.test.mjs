import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, booted, ready, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

async function observe(page) {
  const seen = [];
  await page.expose('splash', (event) => seen.push(event));
  await page.init(() => {
    const observer = new MutationObserver((records) => {
      for (const { target } of records) {
        const card = target.closest?.('.splash');
        if (!card || location.pathname !== '/') continue;
        const render = card.querySelector('[data-key="render"]')?.textContent ?? '';
        window.splash(JSON.stringify({ scene: card.dataset.scene, render }));
      }
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: ['data-scene'],
    });
  });
  return {
    scenes: () => [...new Set(seen.map((event) => event.scene))],
    renders: () => [...new Set(seen.map((event) => event.render))],
  };
}

function fakeClipboard() {
  window.copied = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text) => {
        window.copied.push(text);
      },
    },
  });
}

function parallelCompile() {
  const COMPLETION = 0x91b1;
  const { getExtension, getProgramParameter } = WebGL2RenderingContext.prototype;
  WebGL2RenderingContext.prototype.getExtension = function (name) {
    const found = getExtension.call(this, name);
    if (found || name !== 'KHR_parallel_shader_compile') return found;
    return { COMPLETION_STATUS_KHR: COMPLETION };
  };
  WebGL2RenderingContext.prototype.getProgramParameter = function (program, name) {
    if (name === COMPLETION) return true;
    return getProgramParameter.call(this, program, name);
  };
}

function loaded(page, path) {
  return page.responses.some((response) => new URL(response.url).pathname === path);
}

test('the steps report as before while the scene loads beside them, after the first paint', async (t) => {
  const page = await chrome.page(t);
  const bios = await watch(page);
  const splash = await observe(page);
  await boot(page);

  assert.deepEqual(bios.states(), booted);
  assert.ok(loaded(page, '/sw/splash.js'));
  assert.ok(loaded(page, '/sw/scene.js'));
  t.diagnostic(`scene: ${splash.scenes().join(' → ')}; render: ${splash.renders().join(' | ')}`);
  assert.deepEqual(page.errors, []);
});

test('without WebGL2 the card shows the static artwork, and the boot still reports and finishes', async (t) => {
  const page = await chrome.page(t);
  await page.init(() => {
    const context = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      return kind === 'webgl2' ? null : context.call(this, kind, ...rest);
    };
  });
  const bios = await watch(page);
  const splash = await observe(page);
  await boot(page);

  assert.deepEqual(bios.states(), booted);
  assert.deepEqual(splash.scenes(), ['static']);
  assert.ok(splash.renders().includes('static artwork, no WebGL2'), splash.renders().join(' | '));
  assert.deepEqual(page.errors, []);
});

test('with reduced motion the scene never loads, and the boot still reports and finishes', async (t) => {
  const page = await chrome.page(t);
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  const bios = await watch(page);
  const splash = await observe(page);
  await boot(page);

  assert.deepEqual(bios.states(), booted);
  assert.ok(!loaded(page, '/sw/scene.js'));
  assert.ok(
    splash.renders().includes('static artwork, reduced motion'),
    splash.renders().join(' | ')
  );
  assert.deepEqual(page.errors, []);
});

test('a failing boot opens the diagnostics, copies them without the join link, and Try again boots', async (t) => {
  const page = await chrome.page(t);
  await page.init(fakeClipboard);
  chrome.cdn.status = 404;
  await page.goto(`/#seat=${encodeURIComponent('https://example.test/join?token=s3cr3t')}`);
  await page.until(
    () => document.querySelector('[data-step="packages"]').dataset.state === 'failed'
  );

  const shown = await page.evaluate(() => {
    const drawer = document.querySelector('.diagnostics');
    return {
      open: drawer.classList.contains('open') && !drawer.inert,
      state: document.querySelector('.splash').dataset.state,
      verb: document.querySelector('.verb').textContent,
      retry: [...document.querySelectorAll('.retry')].every((button) => !button.hidden),
      progress: document.querySelector('progress').value,
    };
  });
  assert.deepEqual(shown, {
    open: true,
    state: 'failed',
    verb: 'Couldn’t install packages',
    retry: true,
    progress: 2,
  });

  await page.evaluate(() => document.querySelector('.copy').click());
  const [copied] = await page.until(() => window.copied.length && window.copied);
  assert.match(copied, /^SLICC seven boot diagnostics\n/);
  assert.match(copied, /^failed {3}packages: 404 https:\/\/registry\.npmjs\.org\/\S+\.tgz$/m);
  assert.match(copied, /^done {5}installer: connection #\d+$/m);
  assert.doesNotMatch(copied, /s3cr3t|seat|example\.test/);

  chrome.cdn.status = 0;
  await page.evaluate(() => document.querySelector('.diagnostics .retry').click());
  await page.until(() => location.pathname === '/os/join.html');
});

test('the scene keeps running across a tab that is hidden for longer than its frame budget', async (t) => {
  const page = await chrome.page(t);
  await page.init(parallelCompile);
  chrome.cdn.status = 404;
  await page.goto('/');
  await page.until(() => document.querySelector('.splash').dataset.scene === 'running');
  const other = await page.tab();
  const hold = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let round = 0; round < 2; round++) {
    await other.send('Page.bringToFront');
    await page.until(() => document.visibilityState === 'hidden');
    await hold(1500);
    await page.send('Page.bringToFront');
    await page.until(() => document.visibilityState === 'visible');
    await hold(300);
  }
  chrome.cdn.status = 0;
  const shown = await page.evaluate(() => ({
    scene: document.querySelector('.splash').dataset.scene,
    render: document.querySelector('[data-key="render"]').textContent,
  }));
  assert.equal(shown.scene, 'running', shown.render);
  assert.match(shown.render, /^\d+fps, scene at \d+%$/);
});

async function refuse(page, status) {
  const seen = [];
  const pattern = { patterns: [{ urlPattern: '*/sw/splash.js*' }] };
  const off = chrome.cdp.on(({ method, params, sessionId }) => {
    if (method !== 'Fetch.requestPaused' || !params.request.url.includes('/sw/splash.js')) return;
    seen.push(params.request.url);
    chrome.cdp
      .send(
        'Fetch.fulfillRequest',
        { requestId: params.requestId, responseCode: status, body: '' },
        sessionId
      )
      .catch(() => undefined);
  });
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const sessions = [];
  for (const { targetId, type, url } of targetInfos) {
    if (type !== 'service_worker' || !url.startsWith(chrome.url)) continue;
    const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await chrome.cdp.send('Fetch.enable', pattern, sessionId);
    sessions.push(sessionId);
  }
  await page.send('Fetch.enable', pattern);
  return {
    seen,
    workers: sessions.length,
    stop: async () => {
      off();
      await page.send('Fetch.disable');
      for (const sessionId of sessions)
        await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    },
  };
}

for (const status of [404, 500]) {
  test(`an installed seven boots to the UI with npm unreachable and the splash answering ${status}`, async (t) => {
    const page = await chrome.page(t);
    await boot(page);
    const warnings = [];
    const off = chrome.cdp.on(({ method, params }) => {
      if (method === 'Runtime.consoleAPICalled' && params.type === 'warning')
        warnings.push(params.args.map((arg) => arg.value).join(' '));
    });
    chrome.cdn.status = 503;
    const blocked = await refuse(page, status);
    const bios = await watch(page);
    await boot(page);
    await blocked.stop();
    off();
    chrome.cdn.status = 0;
    assert.ok(blocked.workers > 0);
    assert.ok(blocked.seen.length > 0);
    assert.deepEqual(bios.states(), booted);
    assert.deepEqual(
      warnings.filter((text) => text.startsWith('bios:')),
      [
        `bios: booting without the splash, Failed to fetch dynamically imported module: ${chrome.url}sw/splash.js`,
      ]
    );
    assert.deepEqual(page.errors, []);
  });
}

async function timed(page) {
  const start = Date.now();
  await page.goto('/');
  await page.until(() => location.pathname === '/os/');
  const ui = Date.now() - start;
  await ready(page);
  return { ui, prompt: Date.now() - start };
}

const median = (list) => list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)];

test('a cold boot and repeat boots through the BIOS reach the terminal prompt', async (t) => {
  const page = await chrome.page(t);
  const cold = await timed(page);
  const repeats = [];
  for (let run = 0; run < 5; run++) repeats.push(await timed(page));
  const warm = {
    ui: median(repeats.map((run) => run.ui)),
    prompt: median(repeats.map((run) => run.prompt)),
  };
  const line = `SPLASH-TIMING cold ui=${cold.ui} prompt=${cold.prompt} repeat ui=${warm.ui} prompt=${warm.prompt} runs=${JSON.stringify(repeats)}`;
  console.log(line);
  t.diagnostic(line);
  assert.ok(cold.prompt > 0 && warm.prompt > 0);
  assert.deepEqual(page.errors, []);
});
