import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { actPackage, boot, ready, run, screen, shows } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';
import { linkNode } from './linked-node.mjs';
import { display, EXTENSIONS, realExtension, SEVEN } from './real-extension.mjs';

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const hits = [];
const heard = [];
const stand = createHttp((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  hits.push(`${url.host}${url.pathname}${url.search}`);
  heard.push({
    path: `${url.pathname}${url.search}`,
    agent: req.headers['x-agent'] ?? null,
    ua: req.headers['user-agent'] ?? '',
  });
  const pages = {
    '/vault': `<!doctype html><title>VAULT-MARK</title><h1>VAULT-BODY-MARK</h1><script>fetch('http://localhost:${url.port}/data?from=vault', { mode: 'no-cors' });</script>`,
    '/plain': '<!doctype html><title>PLAIN-MARK</title><h1>Plain</h1>',
    '/walker': '<!doctype html><title>WALKER-MARK</title><h1>Walker</h1>',
  };
  if (url.pathname === '/hop') {
    res.writeHead(302, {
      location: `/landed?token=${['PLAN', 'TED', 'LOCATION4321'].join('')}`,
      'access-control-allow-origin': '*',
    });
    return res.end();
  }
  if (url.pathname === '/to-vault') {
    res.writeHead(302, { location: `${VAULT}?code=${['HOP', 'MARK', '77'].join('')}` });
    return res.end();
  }
  if (url.pathname === '/landed') {
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    return res.end('landed');
  }
  if (url.pathname === '/data') {
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    return res.end(`data for ${url.searchParams.get('from')}`);
  }
  res.writeHead(pages[url.pathname] ? 200 : 404, { 'content-type': 'text/html' });
  res.end(pages[url.pathname] ?? 'missing');
});
await new Promise((resolve) => stand.listen(0, '127.0.0.1', resolve));
const standPort = stand.address().port;
const VAULT = `http://vault.sliccy.ai:${standPort}/vault`;
const PLAIN = `http://localhost:${standPort}/plain`;
const chrome = await launch({
  args: [`--remote-debugging-port=${port}`, '--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1'],
});
const elsewhere = (path) => {
  const at = new URL(path, chrome.url);
  at.hostname = 'localhost';
  return at.href;
};
after(() => {
  chrome.close();
  stand.close();
});
const browser = await debuggerUrl(port);

const fakeExtension = extensionOver(browser);

const automation = (page) =>
  page.evaluate(() => document.querySelector('slicc-app').model.network.status().browser);

const open = (page) =>
  page.evaluate(() =>
    Boolean(document.querySelector('slicc-app').shadowRoot.querySelector('slicc-confirm'))
  );

test('playwright-cli drives a page through slicc-extension without asking, and the page cannot reach 9222', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  chrome.overrides.set(
    '/driven.html',
    '<!doctype html><title>driven</title><h1>Driven from the kernel</h1>'
  );
  const target = elsewhere('/driven.html');

  await run(
    page,
    `curl -sf http://127.0.0.1:9222/json/list | jq -r '[.[] | select(.url | endswith("/os/"))] | "seven listed " + (length | tostring)'`
  );
  await shows(page, 'seven listed 0');
  assert.deepEqual(await automation(page), { via: 'extension' });
  assert.equal(await open(page), false);
  await page.evaluate(() =>
    document.querySelector('slicc-app').shadowRoot.querySelector('[data-network]').click()
  );
  await page.until(
    () =>
      document
        .querySelector('slicc-app')
        .dock.content('network')
        ?.shadowRoot?.textContent.includes('Browser automation: through the SLICC extension.') ??
      false
  );
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color !== 'light') app.toggleColor();
  });
  await page.screenshot(new URL('network-browser-light.png', page.dir));

  await run(
    page,
    `playwright-cli open about:blank && playwright-cli goto ${target} && playwright-cli snapshot`
  );
  await shows(page, 'heading "Driven from the kernel"');
  await run(
    page,
    `playwright-cli route '**/routed.json' --body '{"routed":42}' --content-type application/json && playwright-cli eval "fetch('/routed.json').then((r) => r.json()).then((j) => 'routed-' + j.routed)"`
  );
  await shows(page, 'routed-42');
  await run(page, 'playwright-cli unroute && echo unrouted-$?');
  await shows(page, 'unrouted-0');
  const driven = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert.ok(driven.some(({ url }) => url === target));
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
  await run(page, `curlwright http://foreign.test/ > /tmp/curlwright 2>&1; echo "curlwright-$?"`);
  await shows(page, 'curlwright-2');
  assert.match(await read(page, '/tmp/curlwright'), /--tab/);
  assert.equal(await open(page), false);

  for (const method of ['Target.getTargets', 'Target.attachToTarget', 'Runtime.evaluate']) {
    assert.ok(extension.sent.includes(method), `${method} went to the extension`);
  }

  const refused = await page.evaluate(() =>
    fetch('http://9222.kernel.localhost/json/version').then(async (r) => [r.status, await r.text()])
  );
  assert.deepEqual(refused, [502, 'sw: nothing listening on kernel port 9222\n']);
  assert.deepEqual(page.errors, []);
});

test('over the extension’s shield, the guard arms every driven tab with no protected pattern: playwright-cli opens, goes and snapshots, an ordinary document isn’t held, and a protected one still fails before it commits', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  chrome.overrides.set(
    '/shield.html',
    '<!doctype html><title>shield</title><h1>Past the shield</h1>'
  );
  const target = elsewhere('/shield.html');
  await run(
    page,
    `playwright-cli open about:blank > /tmp/pw 2>&1 && playwright-cli goto ${target} >> /tmp/pw 2>&1 && playwright-cli snapshot >> /tmp/pw 2>&1; echo pw-$? >> /tmp/pw; echo "pw-""done"`
  );
  await shows(page, 'pw-done', 120000);
  const pw = await read(page, '/tmp/pw');
  assert.deepEqual(extension.shielding, [], `the shield refused the guard’s Fetch.enable: ${pw}`);
  assert.ok(
    extension.sent.includes('Fetch.enable'),
    'the guard armed the tab through the extension'
  );
  assert.match(pw, /heading "Past the shield"/, pw);
  assert.match(pw, /pw-0/, pw);

  await run(
    page,
    `playwright-cli goto ${PLAIN} > /tmp/plain 2>&1; echo "plain-$?" >> /tmp/plain; playwright-cli eval '(() => { const n = performance.getEntriesByType("navigation")[0]; return "waited-" + Math.round(n.responseStart - n.startTime); })()' >> /tmp/plain 2>&1; echo "plain-""done"`
  );
  await shows(page, 'plain-done', 60000);
  const plain = await read(page, '/tmp/plain');
  const waited = Number(/waited-(\d+)/.exec(plain)?.[1]);
  assert.match(plain, /plain-0/, plain);
  assert.ok(waited <= 3000, `an ordinary document waited ${waited} ms for its response: ${plain}`);

  hits.length = 0;
  await run(
    page,
    `playwright-cli goto ${VAULT} > /tmp/vault 2>&1; echo vault-$? >> /tmp/vault; playwright-cli eval 'location.href + " " + document.title' >> /tmp/vault 2>&1; echo "vault-""done"`
  );
  await shows(page, 'vault-done', 60000);
  const vault = await read(page, '/tmp/vault');
  assert.ok(
    !hits.some((hit) => hit.startsWith('vault.sliccy.ai')),
    `the vault was served: ${hits.join(' ')}`
  );
  assert.doesNotMatch(vault, /VAULT-MARK|VAULT-BODY-MARK/, vault);
  assert.deepEqual(extension.shielding, []);
  assert.deepEqual(page.errors, []);
});

for (const extension of EXTENSIONS) {
  test(`real slicc-extension ${extension.version}: playwright-cli opens about:blank on an opaque origin, drives an ordinary page, the vault stays out, and no driven document has the extension's origin`, {
    timeout: 10 * 60 * 1000,
  }, async (t) => {
    const real = await realExtension({ extension, rules: ['MAP vault.sliccy.ai 127.0.0.1'] });
    t.after(() => real.close());
    const page = await real.page(t);
    await page.goto(SEVEN);
    await ready(page);
    assert.deepEqual(await automation(page), { via: 'extension' });
    await page.evaluate(() => {
      globalThis.contextOrigins = [];
      globalThis.sliccExtension.cdp.on((message) => {
        if (message.method === 'Runtime.executionContextCreated')
          globalThis.contextOrigins.push({
            origin: message.params.context.origin,
            type: message.params.context.auxData?.type ?? null,
          });
      });
    });
    real.overrides.set(
      '/driven.html',
      '<!doctype html><title>driven</title><h1>Driven past the real shield</h1>'
    );
    const target = new URL('/driven.html', real.url);
    target.hostname = 'localhost';
    await run(
      page,
      `playwright-cli open about:blank > /tmp/pw 2>&1 && playwright-cli eval 'self.origin' > /tmp/origin 2>&1 && playwright-cli goto ${target.href} >> /tmp/pw 2>&1 && playwright-cli snapshot >> /tmp/pw 2>&1; echo pw-$? >> /tmp/pw; echo "pw-""done"`
    );
    await shows(page, 'pw-done', 180000);
    const pw = await read(page, '/tmp/pw');
    assert.doesNotMatch(pw, /slicc: refused/, pw);
    assert.match(pw, /heading "Driven past the real shield"/, pw);
    assert.match(pw, /pw-0/, pw);
    const origin = await read(page, '/tmp/origin');
    assert.match(origin, /null/, `the opened about:blank's self.origin: ${origin}`);
    assert.doesNotMatch(origin, /chrome-extension:/, origin);
    hits.length = 0;
    await run(
      page,
      `playwright-cli goto ${VAULT} > /tmp/vault 2>&1; playwright-cli eval 'self.origin + " " + location.href + " " + document.title' >> /tmp/vault 2>&1; echo "vault-""done"`
    );
    await shows(page, 'vault-done', 60000);
    const vault = await read(page, '/tmp/vault');
    assert.ok(
      !hits.some((hit) => hit.startsWith('vault.sliccy.ai')),
      `the vault was served: ${hits.join(' ')}`
    );
    assert.doesNotMatch(vault, /VAULT-MARK|VAULT-BODY-MARK/, vault);
    assert.doesNotMatch(vault, /chrome-extension:/, vault);
    real.overrides.set(
      '/hop.html',
      `<!doctype html><title>hop</title><meta http-equiv="refresh" content="0;url=${VAULT}">`
    );
    const hop = new URL('/hop.html', real.url);
    hop.hostname = 'localhost';
    await run(
      page,
      `playwright-cli goto ${hop.href} > /tmp/hop 2>&1; playwright-cli eval 'self.origin + " " + location.href' >> /tmp/hop 2>&1; echo "hop-""done"`
    );
    await shows(page, 'hop-done', 60000);
    const hopped = await read(page, '/tmp/hop');
    assert.doesNotMatch(hopped, /chrome-extension:|VAULT-MARK/, hopped);
    assert.ok(
      !hits.some((hit) => hit.startsWith('vault.sliccy.ai')),
      `the vault was served after a hop: ${hits.join(' ')}`
    );
    await run(
      page,
      `playwright-cli goto about:blank > /tmp/inherit 2>&1; playwright-cli goto ' about:blank' >> /tmp/inherit 2>&1; playwright-cli eval 'self.origin' >> /tmp/inherit 2>&1; echo "inherit-""done"`
    );
    await shows(page, 'inherit-done', 60000);
    const inherit = await read(page, '/tmp/inherit');
    assert.match(
      inherit,
      /slicc: refused: a browser-side navigation to about: gives the page the origin of whatever drives the browser/,
      inherit
    );
    assert.doesNotMatch(inherit, /chrome-extension:/, inherit);
    const origins = await page.evaluate(() => globalThis.contextOrigins);
    assert.ok(real.extension, 'the harness extension is loaded');
    const harness = ({ origin, type }) =>
      type === 'isolated' && origin === `chrome-extension://${real.extension.id}`;
    assert.deepEqual(
      origins.filter((each) => !harness(each) && /^chrome-extension:/i.test(each.origin)),
      [],
      `a driven tab's context had the extension's origin: ${JSON.stringify(origins)}`
    );
  });
}

for (const extension of EXTENSIONS.filter(
  ({ version }) => version.localeCompare('7.6.3', undefined, { numeric: true }) >= 0
)) {
  test(`headed, real slicc-extension ${extension.version}: an agent tab or window opens behind seven, which keeps rendering, the tab still screencasts and screenshots, and activate brings it forward`, {
    timeout: 10 * 60 * 1000,
  }, async (t) => {
    const real = await realExtension({ extension, realistic: true });
    t.after(() => real.close());
    const page = await real.page(t);
    await page.goto(SEVEN);
    await ready(page);
    assert.deepEqual(await automation(page), { via: 'extension' });
    await page.evaluate(() => {
      globalThis.painted = 0;
      const tick = () => {
        globalThis.painted += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const sample = async () => ({
      at: Date.now(),
      ...(await page.evaluate(() => ({
        painted: globalThis.painted,
        shown: document.visibilityState,
        focused: document.hasFocus(),
      }))),
    });
    const behind = (list) =>
      list
        .slice(1)
        .filter(
          (now, i) => now.painted <= list[i].painted || now.shown !== 'visible' || !now.focused
        );
    real.overrides.set(
      '/driven.html',
      '<!doctype html><title>driven</title><h1>Driven behind seven</h1><p id="n">0</p><script>let n = 0; setInterval(() => (document.getElementById("n").textContent = ++n), 100)</script>'
    );
    const target = new URL('/driven.html', real.url);
    target.hostname = 'localhost';
    await page.evaluate(async () => {
      const { guardProtected } = await import(new URL('guard.js', location.href).href);
      const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
      const connection = guardProtected(
        extensionConnection(globalThis.sliccExtension.cdp),
        location.origin
      );
      const pending = new Map();
      let next = 0;
      connection.onmessage = (text) => {
        const message = JSON.parse(text);
        if (message.id === undefined) return;
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      };
      window.guarded = (method, params = {}) =>
        new Promise((resolve) => {
          next += 1;
          const id = next;
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ error: { message: `${method} got no answer` } });
          }, 20000);
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          connection.send(JSON.stringify({ id, method, params }));
        });
    });
    const opening = [await sample()];
    assert.ok(
      opening[0].focused && opening[0].shown === 'visible',
      `seven is in front before the test: ${JSON.stringify(opening)}`
    );
    const created = await page.evaluate(
      (url) => window.guarded('Target.createTarget', { url, newWindow: true }),
      target.href
    );
    assert.ok(created.result?.targetId, JSON.stringify(created));
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      opening.push(await sample());
    }
    await page.evaluate(
      (targetId) => window.guarded('Target.closeTarget', { targetId }),
      created.result.targetId
    );
    assert.deepEqual(
      opening.filter(({ focused }) => !focused),
      [],
      `a new window the guard created took the focus from seven (without a window manager it covers seven whatever its focus, so focus is what this checks): ${JSON.stringify(opening)}`
    );
    const uncovered = Date.now() + 15000;
    let shown = await sample();
    while (shown.shown !== 'visible' || !shown.focused) {
      if (Date.now() > uncovered)
        throw new Error(
          `seven stayed behind after the new window closed: ${JSON.stringify({ opening, shown })}`
        );
      await new Promise((resolve) => setTimeout(resolve, 500));
      shown = await sample();
    }
    const samples = [await sample()];
    let driving = true;
    const sampler = (async () => {
      while (driving) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        samples.push(await sample());
      }
    })();
    await run(
      page,
      `{ playwright-cli open ${target.href} && playwright-cli snapshot && playwright-cli click e1 && playwright-cli screenshot --filename=/tmp/s1.png && sleep 2 && playwright-cli screenshot --filename=/tmp/s2.png; echo pw-$?; } > /tmp/bg 2>&1; cmp -s /tmp/s1.png /tmp/s2.png; echo same-$? >> /tmp/bg; echo "bytes $(wc -c < /tmp/s1.png)" >> /tmp/bg; for i in $(seq 1 240); do playwright-cli eval "fetch('/release?' + Date.now()).then((r) => r.status)" 2>/dev/null | grep -q 200 && break; sleep 0.5; done; echo held-$i >> /tmp/bg; echo "bg-""done"`
    );
    const id = await page.within(
      120000,
      () =>
        document
          .querySelector('slicc-app')
          .model.browser.list()
          .find((tab) => tab.url?.endsWith('/driven.html') && tab.controlled)?.id
    );
    await page.evaluate((tab) => {
      const { browser } = document.querySelector('slicc-app').model;
      window.liveFrames = [];
      browser.on('frame', (frame) => frame.tabId === tab && window.liveFrames.push(frame.src));
      window.stopLive = browser.watch(tab, { width: 480, height: 300 });
    }, id);
    const frames = () =>
      page.evaluate(() => ({
        frames: window.liveFrames.length,
        distinct: new Set(window.liveFrames).size,
      }));
    const watching = Date.now() + 60000;
    let live = await frames();
    while (!(live.frames >= 3 && live.distinct >= 2)) {
      if (Date.now() > watching)
        throw new Error(
          `the panel's live view of the background tab got too few frames in 60 s: ${JSON.stringify(live)}\n${await screen(page)}`
        );
      await new Promise((resolve) => setTimeout(resolve, 500));
      live = await frames();
    }
    real.overrides.set('/release', 'released');
    await shows(page, 'bg-done', 180000);
    await page.evaluate(() => window.stopLive());
    driving = false;
    await sampler;
    const bg = await read(page, '/tmp/bg');
    assert.match(bg, /heading "Driven behind seven"/, bg);
    assert.match(bg, /pw-0/, bg);
    assert.match(
      bg,
      /same-1/,
      `two screenshots of the background tab 2 s apart are identical: ${bg}`
    );
    assert.ok(Number(bg.match(/bytes\s+(\d+)/)?.[1]) > 1000, bg);
    assert.doesNotMatch(bg, /held-240/, `the shell never saw the release: ${bg}`);
    assert.deepEqual(
      behind(samples),
      [],
      `seven stopped rendering while the agent drove: ${JSON.stringify(samples)}`
    );
    const rate =
      (samples.at(-1).painted - samples[0].painted) / (samples.at(-1).at - samples[0].at);
    await page.evaluate(
      (tab) => document.querySelector('slicc-app').model.browser.activate(tab),
      id
    );
    const deadline = Date.now() + 30000;
    const after = [await sample()];
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const now = await sample();
      const before = after.at(-1);
      after.push(now);
      if (
        now.shown !== 'visible' ||
        now.painted - before.painted < (rate * (now.at - before.at)) / 4
      )
        break;
      if (Date.now() > deadline)
        throw new Error(
          `activate never brought the driven tab forward over seven: ${JSON.stringify({ samples, after })}`
        );
    }
    assert.deepEqual(page.errors, []);
  });
}

test('the browser port lists only the tabs the agent drives, holds them for a while, and shows them', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  chrome.overrides.set(
    '/port.html',
    '<!doctype html><title>Tide tables</title><h1 style="font-size:96px">Tide tables</h1>'
  );
  const target = elsewhere('/port.html');
  const foreign = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  t.after(() => fetch(`http://127.0.0.1:${port}/json/close/${foreign.id}`));

  await run(page, `playwright-cli open ${target} && echo opened-$?`);
  await shows(page, 'opened-0');
  const listed = () => document.querySelector('slicc-app').model.browser.list();
  const opened = () => {
    const tabs = document.querySelector('slicc-app').model.browser.list();
    const away = ({ url, title, status }) =>
      url &&
      url !== 'about:blank' &&
      title &&
      title !== 'about:blank' &&
      !url.endsWith(title) &&
      status === 'complete';
    return tabs.length > 0 && tabs.every(away) && tabs;
  };
  let tabs;
  try {
    tabs = await page.within(30000, opened);
  } catch (error) {
    throw new Error(
      `the agent's tab never left about:blank in the list: ${error.message}\nlast list: ${JSON.stringify(await page.evaluate(listed))}`
    );
  }
  assert.deepEqual(
    tabs.map(({ url, title, agentId }) => [url, title, agentId]),
    [[target, 'Tide tables', null]]
  );
  assert.equal(tabs[0].controlled, true);
  const shot = await page.evaluate(
    (id) => document.querySelector('slicc-app').model.browser.screenshot(id),
    tabs[0].id
  );
  assert.match(shot, /^data:image\/jpeg;base64,\/9j\//);
  const refused = await page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.browser.screenshot(id)
        .then(
          () => 'shown',
          (error) => error.message
        ),
    foreign.id
  );
  assert.equal(refused, `not a tab SLICC is using: ${foreign.id}`);
  await page.within(
    20000,
    () => document.querySelector('slicc-app').model.browser.list()[0]?.controlled === false
  );
  assert.ok(extension.sent.includes('Page.captureScreenshot'));
  assert.ok(extension.sent.includes('Target.detachFromTarget'));
  assert.equal(extension.sent.filter((method) => method.startsWith('Slicc.')).length, 0);

  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
  await page.until(() => document.querySelector('slicc-app').model.browser.list().length === 0);
  assert.deepEqual(page.errors, []);
});

test('playwright-cli’s reports become private action rows, and Stop closes the agent’s connection', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  chrome.overrides.set(
    '/form.html',
    '<!doctype html><title>Tide form</title><input aria-label="Port"><button>Show forecast</button>'
  );
  const target = elsewhere('/form.html');
  await page.evaluate(() => {
    window.rows = [];
    document
      .querySelector('slicc-app')
      .model.browser.on('action', (row) => window.rows.push(JSON.stringify(row)));
  });
  const agent = 'SLICC_AGENT=cone:harbor';
  await run(
    page,
    `${agent} playwright-cli open '${target}?q=QUERYSECRET#FRAGSECRET' && ${agent} playwright-cli snapshot > /tmp/snap && ref=$(grep -o 'textbox "Port" \\[ref=[a-z0-9]*' /tmp/snap | sed 's/.*ref=//') && ${agent} playwright-cli fill $ref secret-text && ${agent} playwright-cli eval 'document.title + "-hidden-source"' && { ${agent} playwright-cli eval 'throw new Error("EVALSECRET")'; echo acted-$?; }`
  );
  await shows(page, 'acted-1');
  const rows = await page.until(() => {
    const rows = document.querySelector('slicc-app').model.browser.actions();
    return rows.length >= 5 && rows.every(({ status }) => status !== 'running') && rows;
  });
  assert.deepEqual(
    rows.map(({ kind, status, agentId }) => [kind, status, agentId]),
    [
      ['open', 'done', 'harbor'],
      ['snapshot', 'done', 'harbor'],
      ['fill', 'done', 'harbor'],
      ['eval', 'done', 'harbor'],
      ['eval', 'failed', 'harbor'],
    ]
  );
  assert.equal('error' in rows[4], false);
  const [opened, , filled] = rows;
  assert.equal(opened.value, target);
  assert.equal(filled.target, 'textbox "Port"');
  assert.equal(filled.length, 11);
  const everything = JSON.stringify([rows, await page.evaluate(() => window.rows)]);
  assert.equal(everything.includes('secret-text'), false);
  for (const secret of ['hidden-source', 'QUERYSECRET', 'FRAGSECRET', 'EVALSECRET']) {
    assert.equal(everything.includes(secret), false, secret);
  }
  const tabs = await page.evaluate(() => document.querySelector('slicc-app').model.browser.list());
  assert.deepEqual(
    tabs.map(({ id, agentId }) => [id, agentId]),
    [[opened.tabId, 'harbor']]
  );
  await run(
    page,
    `${agent} playwright-cli goto 'data:text/html,<p>DATASECRET</p>' > /dev/null 2>&1; ${agent} playwright-cli goto 'javascript:void("JSSECRET")' > /dev/null 2>&1; ${agent} playwright-cli goto 'host:8080/HOSTSECRET' > /dev/null 2>&1; ${agent} playwright-cli goto 'user:USERSECRET@host/x' > /dev/null 2>&1; echo opaque-done`
  );
  await shows(page, 'opaque-done');
  const opaque = await page.until(() => {
    const gone = document
      .querySelector('slicc-app')
      .model.browser.actions()
      .filter(({ kind }) => kind === 'goto');
    return gone.length === 4 && gone.every(({ status }) => status !== 'running') && gone;
  });
  assert.deepEqual(
    opaque.map(({ value }) => value),
    ['data:', 'javascript:', undefined, undefined]
  );
  const later = JSON.stringify([
    await page.evaluate(() => document.querySelector('slicc-app').model.browser.actions()),
    await page.evaluate(() => window.rows),
  ]);
  for (const secret of ['DATASECRET', 'JSSECRET', 'HOSTSECRET', 'USERSECRET']) {
    assert.equal(later.includes(secret), false, secret);
  }
  assert.equal(extension.sent.filter((method) => method.startsWith('Slicc.')).length, 0);

  const cone = 'cone';
  await run(
    page,
    `SLICC_AGENT=cone:${cone} playwright-cli eval 'new Promise(() => {})' > /tmp/held 2>&1; echo "held-$?"`
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.browser.actions()
      .some(({ kind, status }) => kind === 'eval' && status === 'running')
  );
  await page.evaluate((cone) => document.querySelector('slicc-app').model.agent.stop(cone), cone);
  await shows(page, 'held-1');
  const stopped = await page.evaluate(() =>
    document.querySelector('slicc-app').model.browser.actions().at(-1)
  );
  assert.deepEqual([stopped.kind, stopped.status, stopped.error], ['eval', 'failed', 'Stopped']);
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
  assert.deepEqual(page.errors, []);
});

test('watch gives a live view of a driven tab, sampled when it is in the background, and stops', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  chrome.overrides.set(
    '/live.html',
    '<!doctype html><title>Live</title><h1 id="n">0</h1><script>let n = 0; setInterval(() => (document.getElementById("n").textContent = ++n), 100)</script>'
  );
  const target = elsewhere('/live.html');
  await run(
    page,
    `playwright-cli open ${target} && playwright-cli eval 'new Promise((r) => setTimeout(r, 8000))'; echo watched-$?`
  );
  const id = await page.until(() => {
    const [tab] = document.querySelector('slicc-app').model.browser.list();
    return tab?.controlled && tab.id;
  });
  await page.evaluate((id) => {
    const { browser } = document.querySelector('slicc-app').model;
    window.liveFrames = [];
    browser.on('frame', (frame) => frame.tabId === id && window.liveFrames.push(frame.src.length));
    window.stopLive = browser.watch(id, { width: 480, height: 300 });
  }, id);
  await page.within(10000, () => window.liveFrames.length >= 3);
  await page.evaluate(() => window.stopLive());
  await shows(page, 'watched-0');
  assert.ok(extension.sent.includes('Page.startScreencast'));
  assert.ok(extension.sent.includes('Page.stopScreencast'));
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
  assert.deepEqual(page.errors, []);
});

const tides =
  '<!doctype html><title>Tide tables</title><style>body{font:16px system-ui;margin:0;color:#1d2b36}header{background:#0b5b7a;color:#fff;padding:18px 32px;font-size:22px}main{padding:24px 32px;display:grid;grid-template-columns:1fr 320px;gap:24px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d8e3ea;padding:8px;text-align:left}aside{background:#e8f3f8;border-radius:12px;padding:16px}input{font:inherit;padding:6px;width:180px}button{font:inherit;padding:6px 14px;background:#0b5b7a;color:#fff;border:0;border-radius:6px}</style><header>tidewatch.example · Harbor forecast</header><main><section><h1>Tide tables</h1><table><tr><th>Time</th><th>Height</th><th>Tide</th></tr><tr><td>04:12</td><td>3.4 m</td><td>High</td></tr><tr><td>10:31</td><td>0.6 m</td><td>Low</td></tr><tr><td>16:40</td><td>3.2 m</td><td>High</td></tr><tr><td>22:55</td><td>0.8 m</td><td>Low</td></tr></table></section><aside><p><input aria-label="Port" placeholder="Port"></p><p><button>Show forecast</button></p></aside></main>';
const lighthouse =
  '<!doctype html><title>Lighthouse log</title><style>body{font:16px system-ui;margin:0;color:#2b2416}header{background:#7a4b0b;color:#fff;padding:18px 32px;font-size:22px}main{padding:24px 32px}li{margin:8px 0}</style><header>lighthouse.example · Keeper’s log</header><main><h1>Lighthouse log</h1><ul><li>06:00 Lamp off, lens cleaned</li><li>12:00 Visibility 8 nm</li><li>18:30 Lamp on</li></ul></main>';

test('screenshots of the browser panel: a driven tab live, two driven tabs, the All tabs view kept when the dock switches to phone, Stop and its last frame', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  chrome.overrides.set('/tidewatch/forecast.html', tides);
  chrome.overrides.set('/lighthouse/log.html', lighthouse);
  const forecast = elsewhere('/tidewatch/forecast.html');
  const log = elsewhere('/lighthouse/log.html');
  const harbor = 'SLICC_AGENT=cone:harbor';
  const keeper = 'SLICC_AGENT=cone:keeper';
  const wait = "eval 'new Promise((r) => setTimeout(r, 25000))'";
  const hold = "eval 'new Promise((r) => setTimeout(r, 25000))'";
  await run(
    page,
    `mkdir -p /tmp/keeper && cd /tmp/keeper && ${keeper} playwright-cli open ${log} > /tmp/k && ${keeper} playwright-cli snapshot > /dev/null && (for n in 1 2 3 4 5 6 7 8 9 10; do ${keeper} playwright-cli ${hold} > /dev/null 2>&1; done &) ; cd /home; ${harbor} playwright-cli open ${forecast} && ${harbor} playwright-cli snapshot > /tmp/snap && ref=$(grep -o 'textbox "Port" \\[ref=[a-z0-9]*' /tmp/snap | sed 's/.*ref=//') && ${harbor} playwright-cli fill $ref Lisbon && ${harbor} playwright-cli snapshot > /tmp/snap && button=$(grep -o 'button "Show forecast" \\[ref=[a-z0-9]*' /tmp/snap | sed 's/.*ref=//') && ${harbor} playwright-cli click $button && ${harbor} playwright-cli snapshot > /dev/null; ${harbor} playwright-cli click e99 > /dev/null 2>&1; echo acted-$?; (for n in 1 2 3 4 5 6 7 8; do echo "start $n $(date +%s)" >> /tmp/harbor; ${harbor} playwright-cli ${wait} >> /tmp/harbor 2>&1 || { echo "failed $n $(date +%s)" >> /tmp/harbor; break; }; echo "end $n $(date +%s)" >> /tmp/harbor; done &)`
  );
  await shows(page, 'acted-1');
  await page.until(
    () =>
      document
        .querySelector('slicc-app')
        .model.browser.list()
        .filter(({ controlled }) => controlled).length === 2
  );
  const live = () => !!window.panel()?.querySelector('figure[data-view="live"]');
  const color = (wanted) =>
    page.evaluate((wanted) => {
      const app = document.querySelector('slicc-app');
      if (app.color !== wanted) app.toggleColor();
    }, wanted);
  const shot = (name) => page.screenshot(new URL(`browser-${name}.png`, page.dir));
  const pointer = async (selector) => {
    const { x, y } = await page.evaluate((selector) => {
      const box = window.panel().querySelector(selector).getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }, selector);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  };
  const pick = async (title) => {
    await page.until(
      () => !!window.panel()?.querySelector('[data-action="all-tabs"], li[data-id] .window')
    );
    if (await page.evaluate(() => !!window.panel().querySelector('[data-action="all-tabs"]')))
      await pointer('[data-action="all-tabs"]');
    await page.until(() => window.panel().querySelectorAll('li[data-id] .window').length === 2);
    await page.evaluate(
      (title) =>
        [...window.panel().querySelectorAll('li[data-id]')]
          .find((card) => card.textContent.includes(title))
          .querySelector('.window')
          .click(),
      title
    );
  };

  await page.evaluate(() => {
    window.panel = () => document.querySelector('slicc-app').dock.content('browser')?.shadowRoot;
    document.querySelector('slicc-app').show('browser');
  });
  await color('light');
  await pick('Tide tables');
  await page.within(20000, live);
  await page.until(() => window.panel().textContent.includes('harbor is using this tab'));
  await page.until(() => !!window.panel().querySelector('li[data-status="failed"]'));
  await shot('live-light');
  await page.evaluate((to) => {
    const box = window.panel().querySelector('.scroll');
    box.scrollTop = to === 'end' ? box.scrollHeight : 0;
  }, 'end');
  await shot('actions-light');
  await page.evaluate((to) => {
    const box = window.panel().querySelector('.scroll');
    box.scrollTop = to === 'end' ? box.scrollHeight : 0;
  }, 'top');
  await color('dark');
  await page.within(20000, live);
  await shot('live-dark');
  await page.evaluate((to) => {
    const box = window.panel().querySelector('.scroll');
    box.scrollTop = to === 'end' ? box.scrollHeight : 0;
  }, 'end');
  await shot('actions-dark');
  await page.evaluate((to) => {
    const box = window.panel().querySelector('.scroll');
    box.scrollTop = to === 'end' ? box.scrollHeight : 0;
  }, 'top');
  await pointer('[data-action="all-tabs"]');
  await page.until(() => window.panel().querySelectorAll('li[data-controlled]').length === 2);
  await page.until(() => window.panel().querySelectorAll('.thumb img').length === 2);
  await shot('overview-dark');
  await color('light');
  await shot('overview-light');

  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.evaluate(() => document.querySelector('slicc-app').show('browser'));
  await page.until(() => window.panel()?.querySelectorAll('li[data-controlled]').length === 2);
  assert.equal(await page.evaluate(live), false);
  await shot('overview-420');
  await page.evaluate(() =>
    [...window.panel().querySelectorAll('li[data-controlled]')]
      .find((card) => card.textContent.includes('Tide tables'))
      .querySelector('.window')
      .click()
  );
  await page.within(20000, live);
  await shot('live-420');
  await page.until(() =>
    [...window.panel().querySelectorAll('[data-action="stop-agent"]')].some((button) =>
      button.textContent.includes('harbor')
    )
  );
  const seen = async () => {
    const state = await page.evaluate(() => {
      const browser = document.querySelector('slicc-app').model.browser;
      return {
        now: Date.now(),
        tabs: browser.list().map(({ id, url, agentId, controlled, status }) => ({
          id,
          url,
          agentId,
          controlled,
          status,
        })),
        actions: browser
          .actions()
          .slice(-12)
          .map(({ agentId, kind, status, error, at, tabId }) => ({
            agentId,
            kind,
            status,
            error,
            at,
            tabId,
          })),
      };
    });
    return `${JSON.stringify(state)}\n/tmp/harbor:\n${await read(page, '/tmp/harbor').catch((error) => error.message)}`;
  };
  try {
    await page.within(30000, () => {
      const busy = document
        .querySelector('slicc-app')
        .model.browser.actions()
        .some(({ agentId, status }) => agentId === 'harbor' && status === 'running');
      const stop = [...window.panel().querySelectorAll('[data-action="stop-agent"]')].find(
        (button) => button.textContent.includes('harbor')
      );
      if (!busy || !stop) return false;
      stop.click();
      return true;
    });
  } catch (error) {
    throw new Error(
      `harbor never had a command in flight to stop while its Stop showed: ${error.message}\n${await seen()}`
    );
  }
  try {
    await page.within(20000, () =>
      document
        .querySelector('slicc-app')
        .model.browser.actions()
        .some(({ agentId, error }) => agentId === 'harbor' && error === 'Stopped')
    );
  } catch (error) {
    throw new Error(
      `Stop never landed on harbor’s command in flight: ${error.message}\n${await seen()}`
    );
  }
  await page.until(() => window.panel().textContent.includes('No agent is using this tab'));
  await shot('stopped-420');
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await page.evaluate(() => document.querySelector('slicc-app').show('browser'));
  await pick('Tide tables');
  await page.until(() => window.panel()?.textContent.includes('No agent is using this tab'));
  await shot('stopped-light');
  await color('dark');
  await shot('stopped-dark');
  await color('light');
  const stopped = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.browser.actions()
      .filter(({ agentId, error }) => agentId === 'harbor' && error === 'Stopped')
  );
  assert.deepEqual(
    stopped.map(({ kind, status }) => [kind, status]),
    [['eval', 'failed']]
  );
  await page.within(60000, () =>
    document
      .querySelector('slicc-app')
      .model.browser.actions()
      .some(
        ({ agentId, kind, status }) =>
          agentId === 'keeper' && kind === 'eval' && status !== 'running'
      )
  );
  const kept = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.browser.actions()
      .filter(({ agentId, status }) => agentId === 'keeper' && status === 'failed')
      .map(({ kind, error, at }) => ({ kind, error, at }))
  );
  assert.deepEqual(kept, [], `keeper's holds failed: ${JSON.stringify(kept)}`);
  assert.deepEqual(page.errors, []);
});

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/').filter(Boolean);
    const name = names.pop();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, path);
}

test('with no host, the CDP endpoint says what to install', async (t) => {
  const page = await chrome.page(t);
  await boot(page);

  await run(
    page,
    `curl -s -w '%{http_code}' http://127.0.0.1:9222/json/list > /tmp/none; curl -s -w '%{http_code}' 'http://127.0.0.1:9222/json/list?runtime=elsewhere' > /tmp/elsewhere; echo done-$?`
  );
  await shows(page, 'done-0');
  assert.equal(
    await read(page, '/tmp/none'),
    'CDP host: no browser to drive: install slicc-extension, or run npx @ai-ecoverse/slicc-node\n502'
  );
  assert.equal(
    await read(page, '/tmp/elsewhere'),
    'CDP host: unknown runtime "elsewhere" (extension, proxy)\n502'
  );
  assert.deepEqual(await automation(page), { via: null });
});

const devtools = (path, init) =>
  fetch(`http://127.0.0.1:${port}${path}`, init).then((r) => r.json());
async function tabAt(url, title) {
  const made = await devtools(`/json/new?${url}`, { method: 'PUT' });
  for (let n = 0; n < 100; n += 1) {
    const found = (await devtools('/json/list')).find((tab) => tab.id === made.id);
    if (found?.title === title) return made.id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} did not load`);
}
const listed = async (id) => (await devtools('/json/list')).some((tab) => tab.id === id);

test('the guard keeps seven’s tabs and the vault out of reach, and a protected document’s requests away from the agent', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  const vault = await tabAt(VAULT, 'VAULT-MARK');
  const plain = await tabAt(PLAIN, 'PLAIN-MARK');
  t.after(() =>
    Promise.all([vault, plain].map((id) => fetch(`http://127.0.0.1:${port}/json/close/${id}`)))
  );
  const seven = (await devtools('/json/list')).find(
    (tab) => tab.type === 'page' && tab.url.startsWith(new URL('/os/', chrome.url).href)
  ).id;
  await page.evaluate(async () => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const connection = guardProtected(
      extensionConnection(globalThis.sliccExtension.cdp),
      location.origin
    );
    const pending = new Map();
    const events = [];
    let next = 0;
    connection.onmessage = (text) => {
      const message = JSON.parse(text);
      if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
        return;
      }
      events.push(message);
      if (message.method === 'Fetch.requestPaused') {
        connection.send(
          JSON.stringify({
            id: ++next,
            method: 'Fetch.continueRequest',
            params: { requestId: message.params.requestId },
            sessionId: message.sessionId,
          })
        );
      }
    };
    window.guarded = {
      events,
      send: (method, params = {}, sessionId) =>
        new Promise((resolve) => {
          next += 1;
          const id = next;
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ error: { message: `${method} got no answer` } });
          }, 20000);
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          connection.send(
            JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) })
          );
        }),
    };
  });
  const send = (method, params, sessionId) =>
    page.evaluate(([m, p, s]) => window.guarded.send(m, p, s), [method, params, sessionId]);
  const events = () => page.evaluate(() => window.guarded.events);
  const REFUSAL =
    'slicc: refused: seven’s own pages and the vault are out of reach of browser automation';

  assert.equal(
    (await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })).error?.message,
    'slicc: refused: Fetch needs a tab session; it can’t pause the whole browser'
  );
  assert.equal(
    await page.evaluate(() => fetch(location.href).then((response) => response.status)),
    200
  );
  const listing = await send('Target.getTargets');
  assert.ok(listing.result, JSON.stringify(listing));
  const { result } = listing;
  const ids = result.targetInfos.map((info) => info.targetId);
  assert.ok(ids.includes(plain));
  assert.ok(!ids.includes(vault) && !ids.includes(seven));
  assert.ok(!JSON.stringify(result).includes('VAULT-MARK'));
  for (const targetId of [seven, vault]) {
    for (const method of [
      'Target.attachToTarget',
      'Target.activateTarget',
      'Target.getTargetInfo',
      'Target.closeTarget',
    ]) {
      const answer = await send(method, { targetId, flatten: true });
      assert.equal(
        answer.error?.message,
        REFUSAL,
        `${method} on ${targetId === seven ? 'seven' : 'the vault'}`
      );
    }
    assert.equal(await listed(targetId), true);
  }

  const errorPage = async (sessionId) => {
    let href = null;
    for (let n = 0; n < 50 && href !== 'about:blank#blocked'; n += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      href = (
        await send(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true },
          sessionId
        )
      ).result?.result?.value;
    }
    return href;
  };
  const session = (await send('Target.attachToTarget', { targetId: plain, flatten: true })).result
    .sessionId;
  assert.equal(
    (await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, session))
      .result.result.value,
    'PLAIN-MARK'
  );
  for (const [method, params] of [
    ['Page.enable', {}],
    ['Network.enable', {}],
    ['Fetch.enable', { patterns: [{ urlPattern: '*' }] }],
  ]) {
    assert.deepEqual((await send(method, params, session)).error, undefined, method);
  }
  assert.equal(
    (
      await send(
        'Runtime.evaluate',
        {
          expression: "fetch('/data?from=plain').then((r) => r.text())",
          awaitPromise: true,
          returnByValue: true,
        },
        session
      )
    ).result.result.value,
    'data for plain'
  );
  const plainRequest = (await events()).find(
    (event) =>
      event.method === 'Network.requestWillBeSent' &&
      event.params.request.url.endsWith('from=plain')
  ).params.requestId;
  assert.ok(
    (await events()).some(
      (event) =>
        event.method === 'Fetch.requestPaused' && event.params.request.url.endsWith('from=plain')
    )
  );
  assert.equal(
    (await send('Network.getResponseBody', { requestId: plainRequest }, session)).result.body,
    'data for plain'
  );
  assert.match(
    (await send('Network.getResponseBody', { requestId: 'never-seen' }, session)).error.message,
    /wasn’t seen/
  );

  hits.length = 0;
  await send(
    'Runtime.evaluate',
    {
      expression: `document.body.append(Object.assign(document.createElement('iframe'), { src: ${JSON.stringify(`${VAULT}?framed`)} }))`,
    },
    session
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.ok(
    !hits.some((hit) => hit.endsWith('from=vault') || hit.endsWith('/vault?framed')),
    `the vault frame is failed at the request: ${hits.join(' ')}`
  );
  assert.equal(
    (await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, session))
      .result?.result?.value,
    'PLAIN-MARK',
    'the client keeps its session on the page that framed the vault'
  );

  const walker = await tabAt(`http://localhost:${standPort}/walker`, 'WALKER-MARK');
  t.after(() => fetch(`http://127.0.0.1:${port}/json/close/${walker}`));
  const walking = (await send('Target.attachToTarget', { targetId: walker, flatten: true })).result
    .sessionId;
  for (const method of ['Page.enable', 'Network.enable', 'Runtime.enable']) {
    assert.deepEqual((await send(method, {}, walking)).error, undefined, method);
  }
  const SESSION_WIDE = /settings for a whole session/;
  for (const [method, params] of [
    ['Network.setExtraHTTPHeaders', { headers: { 'X-Agent': 'set-by-agent' } }],
    ['Network.setUserAgentOverride', { userAgent: 'agent-set-ua/1' }],
    ['Emulation.setUserAgentOverride', { userAgent: 'agent-set-ua/1' }],
  ]) {
    assert.match((await send(method, params, walking)).error?.message ?? '', SESSION_WIDE, method);
  }
  heard.length = 0;
  await send(
    'Runtime.evaluate',
    { expression: `location.href = ${JSON.stringify(`${VAULT}?walked`)}` },
    walking
  );
  assert.equal(
    await errorPage(walking),
    'about:blank#blocked',
    'the walk into the vault ends on a blank page, and the client keeps its session'
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.ok(
    !heard.some((hit) => hit.path === '/vault?walked'),
    `the walk into the vault is failed at the request: ${JSON.stringify(heard)}`
  );
  assert.equal(
    (await devtools('/json/list')).find((tab) => tab.id === walker)?.url,
    'about:blank#blocked'
  );
  assert.equal(
    (await send('Target.getTargetInfo', { targetId: walker })).result?.targetInfo.url,
    'about:blank#blocked',
    'the client sees the blank page, not the vault URL it failed'
  );
  assert.equal((await send('Target.activateTarget', { targetId: walker })).error, undefined);
  assert.equal(await listed(walker), true);
  const seen = JSON.stringify(await events());
  assert.ok(!seen.includes('VAULT') && !seen.includes('vault.sliccy.ai'), seen.slice(0, 2000));

  await run(
    page,
    `playwright-cli tab-list > /tmp/tabs 2>&1; playwright-cli eval --tab ${vault} 'document.title' > /tmp/eval 2>&1; echo "eval-$?"`
  );
  await shows(page, 'eval-1');
  assert.doesNotMatch(await read(page, '/tmp/tabs'), /VAULT-MARK|vault\.sliccy\.ai/);
  assert.doesNotMatch(await read(page, '/tmp/eval'), /VAULT-MARK/);
  assert.equal(await listed(vault), true);
  assert.deepEqual(page.errors, []);
});

async function viaProxy(t) {
  const proxy = await startProxy({
    port: 0,
    origins: [new URL(chrome.url).origin],
    cdp: `http://127.0.0.1:${port}`,
    kernelPort: null,
    log: () => {},
  });
  t.after(() => proxy.close());
  return proxy;
}

async function launched(t, proxy) {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}`);
  await ready(page);
  return page;
}

test('headed, on the proxy path: a tab created through the guard with an empty URL opens blank behind seven, which keeps the focus', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const undisplay = await display();
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => undefined);
    undisplay();
  });
  const debugging = await new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
  const headed = await launch({ realistic: true, args: [`--remote-debugging-port=${debugging}`] });
  cleanup.push(() => headed.close());
  await debuggerUrl(debugging);
  const proxy = await startProxy({
    port: 0,
    origins: [new URL(headed.url).origin],
    cdp: `http://127.0.0.1:${debugging}`,
    kernelPort: null,
    log: () => {},
  });
  cleanup.push(async () => proxy.close());
  const page = await headed.page(t);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}`);
  await ready(page);
  await page.evaluate(
    async (proxy) => {
      const { guardProtected } = await import(new URL('guard.js', location.href).href);
      const { proxyHost } = await import(new URL('cdp.js', location.href).href);
      const connection = guardProtected(await proxyHost(proxy)(), location.origin);
      const pending = new Map();
      let next = 0;
      connection.onmessage = (text) => {
        const message = JSON.parse(text);
        if (message.id === undefined) return;
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      };
      window.guarded = (method, params = {}) =>
        new Promise((resolve) => {
          next += 1;
          const id = next;
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ error: { message: `${method} got no answer` } });
          }, 20000);
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          connection.send(JSON.stringify({ id, method, params }));
        });
    },
    { url: proxy.url, key: proxy.key }
  );
  const sample = () =>
    page.evaluate(() => ({ shown: document.visibilityState, focused: document.hasFocus() }));
  const before = await sample();
  assert.deepEqual(before, { shown: 'visible', focused: true });
  const created = await page.evaluate(() => window.guarded('Target.createTarget', { url: '' }));
  assert.ok(created.result?.targetId, JSON.stringify(created));
  cleanup.push(() =>
    page.evaluate(
      (targetId) => window.guarded('Target.closeTarget', { targetId }),
      created.result.targetId
    )
  );
  const info = await page.evaluate(
    (targetId) => window.guarded('Target.getTargetInfo', { targetId }),
    created.result.targetId
  );
  assert.equal(info.result?.targetInfo?.url, 'about:blank', JSON.stringify(info));
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    seen.push(await sample());
  }
  assert.deepEqual(
    seen,
    Array(4).fill(before),
    `seven after an empty-URL tab: ${JSON.stringify(seen)}`
  );
  assert.deepEqual(page.errors, []);
});

test('a browser extension’s hidden world stays out of reach through the guard: a world named like it, its id and a binding into it are refused, and its mark is never readable', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const debugging = await new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
  const worlds = await launch({
    extensions: [fileURLToPath(new URL('./fixtures/injected-frame', import.meta.url))],
    args: [`--remote-debugging-port=${debugging}`],
  });
  t.after(() => worlds.close());
  await debuggerUrl(debugging);
  const proxy = await startProxy({
    port: 0,
    origins: [new URL(worlds.url).origin],
    cdp: `http://127.0.0.1:${debugging}`,
    kernelPort: null,
    log: () => {},
  });
  t.after(() => proxy.close());
  worlds.overrides.set('/marked.html', '<!doctype html><title>marked</title><h1>Ordinary</h1>');
  const url = new URL('/marked.html', worlds.url);
  url.hostname = 'localhost';
  const { targetId } = await worlds.cdp.send('Target.createTarget', { url: url.href });
  t.after(() => worlds.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  const { sessionId: watching } = await worlds.cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const contexts = [];
  const off = worlds.cdp.on((event) => {
    if (event.sessionId === watching && event.method === 'Runtime.executionContextCreated')
      contexts.push(event.params.context);
  });
  t.after(off);
  await worlds.cdp.send('Runtime.enable', {}, watching);
  const deadline = Date.now() + 15000;
  let hidden;
  while (
    !(hidden = contexts.find(
      (context) =>
        context.auxData?.type === 'isolated' &&
        context.origin.startsWith('chrome-extension://') &&
        context.origin !== `chrome-extension://${worlds.extension?.id}`
    ))
  ) {
    if (Date.now() > deadline)
      throw new Error(`no extension world on the page: ${JSON.stringify(contexts)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const MARK =
    'typeof chrome === "object" && Boolean(chrome.runtime && chrome.runtime.id) && document.documentElement.dataset.extensionFixture === chrome.runtime.id';
  const control = await worlds.cdp.send(
    'Runtime.evaluate',
    { contextId: hidden.id, expression: MARK, returnByValue: true },
    watching
  );
  assert.equal(control.result?.value, true, 'the observer reads the mark in the extension world');
  const page = await worlds.page(t);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}`);
  await ready(page);
  const results = await page.evaluate(
    async ({ targetId, hidden, MARK, proxy }) => {
      const { guardProtected } = await import(new URL('guard.js', location.href).href);
      const { proxyHost } = await import(new URL('cdp.js', location.href).href);
      const connection = guardProtected(await proxyHost(proxy)(), location.origin);
      const pending = new Map();
      const events = [];
      let next = 0;
      connection.onmessage = (text) => {
        const message = JSON.parse(text);
        if (message.id === undefined) return events.push(message);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      };
      const send = (method, params = {}, sessionId) =>
        new Promise((resolve) => {
          next += 1;
          const id = next;
          const timer = setTimeout(
            () => resolve({ error: { message: `${method} got no answer` } }),
            20000
          );
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          connection.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
          );
        });
      const attached = await send('Target.attachToTarget', { targetId, flatten: true });
      const session = attached.result?.sessionId;
      if (!session) return { attach: JSON.stringify(attached) };
      const frameId = targetId;
      const named = await send(
        'Page.createIsolatedWorld',
        { frameId, worldName: hidden.name },
        session
      );
      await send('Runtime.enable', {}, session);
      const byId = await send(
        'Runtime.evaluate',
        { contextId: hidden.id, expression: MARK, returnByValue: true },
        session
      );
      const byUnique = await send(
        'Runtime.evaluate',
        { uniqueContextId: hidden.uniqueId, expression: MARK, returnByValue: true },
        session
      );
      const binding = await send(
        'Runtime.addBinding',
        { name: 'leak', executionContextName: hidden.name },
        session
      );
      const marks = [];
      for (let id = 1; id <= 32; id += 1) {
        const out = await send(
          'Runtime.evaluate',
          { contextId: id, expression: MARK, returnByValue: true },
          session
        );
        if (out.result?.result?.value === true) marks.push(id);
      }
      const own = await send(
        'Runtime.evaluate',
        { expression: MARK, returnByValue: true },
        session
      );
      return {
        named: named.error?.message ?? null,
        byId: byId.error?.message ?? null,
        byUnique: byUnique.error?.message ?? null,
        binding: binding.error?.message ?? null,
        marks,
        own: own.result?.result?.value ?? null,
        leaked: JSON.stringify(events).includes('chrome-extension://'),
      };
    },
    {
      targetId,
      hidden: { id: hidden.id, uniqueId: hidden.uniqueId, name: hidden.name },
      MARK,
      proxy: { url: proxy.url, key: proxy.key },
    }
  );
  assert.match(results.named ?? '', /belongs to a browser extension/, JSON.stringify(results));
  assert.match(results.byId ?? '', /belongs to a browser extension/, JSON.stringify(results));
  assert.match(results.byUnique ?? '', /belongs to a browser extension/, JSON.stringify(results));
  assert.match(results.binding ?? '', /^slicc: refused:/, JSON.stringify(results));
  assert.deepEqual(
    results.marks,
    [],
    `the extension's mark was readable in contexts ${results.marks}`
  );
  assert.equal(results.own, false);
  assert.equal(results.leaked, false, 'no event named the extension');
});

test('headed, on the link path: a tab created through the guard with an empty URL opens blank behind seven, which keeps the focus', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const undisplay = await display();
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => undefined);
    undisplay();
  });
  const debugging = await new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
  const headed = await launch({ realistic: true, args: [`--remote-debugging-port=${debugging}`] });
  cleanup.push(() => headed.close());
  await debuggerUrl(debugging);
  const page = await headed.page(t);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await page.goto('/');
  await ready(page);
  await linkNode(t, page, debugging);
  await page.evaluate(async () => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const connection = guardProtected(
      await globalThis.sliccLinkedBrowsers()[0].open(),
      location.origin
    );
    const pending = new Map();
    let next = 0;
    connection.onmessage = (text) => {
      const message = JSON.parse(text);
      if (message.id === undefined) return;
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    };
    window.guarded = (method, params = {}) =>
      new Promise((resolve) => {
        next += 1;
        const id = next;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ error: { message: `${method} got no answer` } });
        }, 20000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        connection.send(JSON.stringify({ id, method, params }));
      });
  }, null);
  const sample = () =>
    page.evaluate(() => ({ shown: document.visibilityState, focused: document.hasFocus() }));
  const before = await sample();
  assert.deepEqual(before, { shown: 'visible', focused: true });
  const created = await page.evaluate(() => window.guarded('Target.createTarget', { url: '' }));
  assert.ok(created.result?.targetId, JSON.stringify(created));
  cleanup.push(() =>
    page.evaluate(
      (targetId) => window.guarded('Target.closeTarget', { targetId }),
      created.result.targetId
    )
  );
  const info = await page.evaluate(
    (targetId) => window.guarded('Target.getTargetInfo', { targetId }),
    created.result.targetId
  );
  assert.equal(info.result?.targetInfo?.url, 'about:blank', JSON.stringify(info));
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    seen.push(await sample());
  }
  assert.deepEqual(
    seen,
    Array(4).fill(before),
    `seven after an empty-URL tab: ${JSON.stringify(seen)}`
  );
  assert.deepEqual(page.errors, []);
});

test('a browser extension’s hidden world stays out of reach through the guard on the link path: a world named like it, its id and a binding into it are refused, and its mark is never readable', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const debugging = await new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
  const worlds = await launch({
    extensions: [fileURLToPath(new URL('./fixtures/injected-frame', import.meta.url))],
    args: [`--remote-debugging-port=${debugging}`],
  });
  t.after(() => worlds.close());
  await debuggerUrl(debugging);
  worlds.overrides.set('/marked.html', '<!doctype html><title>marked</title><h1>Ordinary</h1>');
  const url = new URL('/marked.html', worlds.url);
  url.hostname = 'localhost';
  const { targetId } = await worlds.cdp.send('Target.createTarget', { url: url.href });
  t.after(() => worlds.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  const { sessionId: watching } = await worlds.cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const contexts = [];
  const off = worlds.cdp.on((event) => {
    if (event.sessionId === watching && event.method === 'Runtime.executionContextCreated')
      contexts.push(event.params.context);
  });
  t.after(off);
  await worlds.cdp.send('Runtime.enable', {}, watching);
  const deadline = Date.now() + 15000;
  let hidden;
  while (
    !(hidden = contexts.find(
      (context) =>
        context.auxData?.type === 'isolated' &&
        context.origin.startsWith('chrome-extension://') &&
        context.origin !== `chrome-extension://${worlds.extension?.id}`
    ))
  ) {
    if (Date.now() > deadline)
      throw new Error(`no extension world on the page: ${JSON.stringify(contexts)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const MARK =
    'typeof chrome === "object" && Boolean(chrome.runtime && chrome.runtime.id) && document.documentElement.dataset.extensionFixture === chrome.runtime.id';
  const control = await worlds.cdp.send(
    'Runtime.evaluate',
    { contextId: hidden.id, expression: MARK, returnByValue: true },
    watching
  );
  assert.equal(control.result?.value, true, 'the observer reads the mark in the extension world');
  const page = await worlds.page(t);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await page.goto('/');
  await ready(page);
  await linkNode(t, page, debugging);
  const results = await page.evaluate(
    async ({ targetId, hidden, MARK }) => {
      const { guardProtected } = await import(new URL('guard.js', location.href).href);
      const connection = guardProtected(
        await globalThis.sliccLinkedBrowsers()[0].open(),
        location.origin
      );
      const pending = new Map();
      const events = [];
      let next = 0;
      connection.onmessage = (text) => {
        const message = JSON.parse(text);
        if (message.id === undefined) return events.push(message);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      };
      const send = (method, params = {}, sessionId) =>
        new Promise((resolve) => {
          next += 1;
          const id = next;
          const timer = setTimeout(
            () => resolve({ error: { message: `${method} got no answer` } }),
            20000
          );
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          connection.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
          );
        });
      const attached = await send('Target.attachToTarget', { targetId, flatten: true });
      const session = attached.result?.sessionId;
      if (!session) return { attach: JSON.stringify(attached) };
      const frameId = targetId;
      const named = await send(
        'Page.createIsolatedWorld',
        { frameId, worldName: hidden.name },
        session
      );
      await send('Runtime.enable', {}, session);
      const byId = await send(
        'Runtime.evaluate',
        { contextId: hidden.id, expression: MARK, returnByValue: true },
        session
      );
      const byUnique = await send(
        'Runtime.evaluate',
        { uniqueContextId: hidden.uniqueId, expression: MARK, returnByValue: true },
        session
      );
      const binding = await send(
        'Runtime.addBinding',
        { name: 'leak', executionContextName: hidden.name },
        session
      );
      const marks = [];
      for (let id = 1; id <= 32; id += 1) {
        const out = await send(
          'Runtime.evaluate',
          { contextId: id, expression: MARK, returnByValue: true },
          session
        );
        if (out.result?.result?.value === true) marks.push(id);
      }
      const own = await send(
        'Runtime.evaluate',
        { expression: MARK, returnByValue: true },
        session
      );
      return {
        named: named.error?.message ?? null,
        byId: byId.error?.message ?? null,
        byUnique: byUnique.error?.message ?? null,
        binding: binding.error?.message ?? null,
        marks,
        own: own.result?.result?.value ?? null,
        leaked: JSON.stringify(events).includes('chrome-extension://'),
      };
    },
    {
      targetId,
      hidden: { id: hidden.id, uniqueId: hidden.uniqueId, name: hidden.name },
      MARK,
    }
  );
  assert.match(results.byId ?? '', /^slicc: refused:/, JSON.stringify(results));
  assert.match(results.byUnique ?? '', /^slicc: refused:/, JSON.stringify(results));
  assert.match(results.binding ?? '', /^slicc: refused:/, JSON.stringify(results));
  assert.deepEqual(
    results.marks,
    [],
    `the extension's mark was readable in contexts ${results.marks}`
  );
  assert.equal(results.own, false);
  assert.equal(results.leaked, false, 'no event named the extension');
});

test('playwright-cli drives a page through slicc-node’s /cdp, on one shared socket', async (t) => {
  const proxy = await viaProxy(t);
  const page = await launched(t, proxy);
  assert.deepEqual(await automation(page), { via: 'proxy' });
  chrome.overrides.set(
    '/driven.html',
    '<!doctype html><title>driven</title><h1>Driven through slicc-node</h1>'
  );
  const target = elsewhere('/driven.html');

  await run(
    page,
    `curl -sf http://127.0.0.1:9222/json/list | jq -r '[.[] | select(.url | endswith("/os/"))] | "seven listed " + (length | tostring)'`
  );
  await shows(page, 'seven listed 0');

  await run(
    page,
    `playwright-cli open about:blank && playwright-cli goto ${target} && playwright-cli snapshot`
  );
  await shows(page, 'heading "Driven through slicc-node"');
  hits.length = 0;
  await run(
    page,
    `playwright-cli goto ${VAULT} > /tmp/vault 2>&1; playwright-cli eval 'location.href + " " + document.title' >> /tmp/vault 2>&1; echo "vault-""done"`
  );
  await shows(page, 'vault-done', 60000);
  const vault = await read(page, '/tmp/vault');
  assert.ok(
    !hits.some((hit) => hit.startsWith('vault.sliccy.ai')),
    `the vault was served: ${hits.join(' ')}`
  );
  assert.doesNotMatch(vault, /VAULT-MARK|VAULT-BODY-MARK/, vault);
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
  assert.equal(await open(page), false);
  assert.deepEqual(page.errors, []);
});

test('playwright-cli: a goto that redirects into the vault fails cleanly, and a page whose own URL names a vault redirect_uri stays drivable', async (t) => {
  const proxy = await viaProxy(t);
  const page = await launched(t, proxy);
  await run(page, 'playwright-cli open about:blank');
  await shows(page, 'Opened about:blank');
  hits.length = 0;
  const started = Date.now();
  await run(
    page,
    `playwright-cli goto http://localhost:${standPort}/to-vault > /tmp/hop 2>&1; echo "status $?" >> /tmp/hop; echo "hop-""done"`
  );
  await shows(page, 'hop-done', 60000);
  const hop = await read(page, '/tmp/hop');
  assert.ok(Date.now() - started < 60000, hop);
  assert.doesNotMatch(hop, /HOPMARK77|VAULT-MARK/, hop);
  assert.ok(!hits.some((hit) => hit.startsWith('vault.sliccy.ai')), hits.join(' '));
  const idp = `http://localhost:${standPort}/plain?redirect_uri=${encodeURIComponent(`${VAULT}/cb`)}&state=s`;
  await run(page, `playwright-cli open '${idp}' && playwright-cli snapshot`);
  await shows(page, 'heading "Plain"');
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
  assert.deepEqual(page.errors, []);
});

test('on the link path, playwright-cli: a goto that redirects into the vault fails cleanly, and a page whose own URL names a vault redirect_uri, opened in a fresh tab, stays drivable', async (t) => {
  const page = await chrome.page(t);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await page.goto('/');
  await ready(page);
  await linkNode(t, page, port);
  await page.until(
    () => document.querySelector('slicc-app').model.network.status().browser.via === 'link'
  );
  await run(page, 'playwright-cli open about:blank');
  await shows(page, 'Opened about:blank');
  hits.length = 0;
  const started = Date.now();
  await run(
    page,
    `playwright-cli goto http://localhost:${standPort}/to-vault > /tmp/hop 2>&1; echo "status $?" >> /tmp/hop; echo "hop-""done"`
  );
  await shows(page, 'hop-done', 60000);
  const hop = await read(page, '/tmp/hop');
  assert.ok(Date.now() - started < 60000, hop);
  assert.doesNotMatch(hop, /HOPMARK77|VAULT-MARK/, hop);
  assert.ok(!hits.some((hit) => hit.startsWith('vault.sliccy.ai')), hits.join(' '));
  const idp = `http://localhost:${standPort}/plain?redirect_uri=${encodeURIComponent(`${VAULT}/cb`)}&state=s`;
  await run(
    page,
    `playwright-cli open '${idp}' > /tmp/idp 2>&1 && playwright-cli snapshot >> /tmp/idp 2>&1; echo "idp-""done"`
  );
  await shows(page, 'idp-done', 120000);
  const idpOut = await read(page, '/tmp/idp');
  assert.match(idpOut, /heading "Plain"/, idpOut);
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
  assert.deepEqual(page.errors, []);
});

test('playwright-cli drives a page through a linked slicc CLI’s browser, through the guard', async (t) => {
  const page = await chrome.page(t);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await page.goto('/');
  await ready(page);
  await linkNode(t, page, port);
  await page.until(
    () => document.querySelector('slicc-app').model.network.status().browser.via === 'link'
  );
  chrome.overrides.set(
    '/driven.html',
    '<!doctype html><title>driven</title><h1>Driven through the link</h1>'
  );
  const target = elsewhere('/driven.html');

  await run(
    page,
    `curl -sf http://127.0.0.1:9222/json/list | jq -r '[.[] | select(.url | endswith("/os/"))] | "seven listed " + (length | tostring)'`
  );
  await shows(page, 'seven listed 0');

  await run(
    page,
    `playwright-cli open about:blank && playwright-cli goto ${target} && playwright-cli snapshot`
  );
  await shows(page, 'heading "Driven through the link"');
  hits.length = 0;
  await run(
    page,
    `playwright-cli goto ${VAULT} > /tmp/vault 2>&1; playwright-cli eval 'location.href + " " + document.title' >> /tmp/vault 2>&1; echo "vault-""done"`
  );
  await shows(page, 'vault-done', 60000);
  const vault = await read(page, '/tmp/vault');
  assert.ok(
    !hits.some((hit) => hit.startsWith('vault.sliccy.ai')),
    `the vault was served: ${hits.join(' ')}`
  );
  assert.doesNotMatch(vault, /VAULT-MARK|VAULT-BODY-MARK/, vault);
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
  assert.equal(await open(page), false);
  assert.deepEqual(page.errors, []);
});

test('when another page takes over slicc-node’s /cdp, the first page’s connections close and say so', async (t) => {
  const proxy = await viaProxy(t);
  const first = await launched(t, proxy);
  await run(first, 'playwright-cli open about:blank');
  await shows(first, 'Opened about:blank');
  const second = await first.tab();
  await second.goto('/packages/agent/package.json');
  await first.send('Page.bringToFront');
  await run(first, `playwright-cli eval 'new Promise(() => {})' > /tmp/held 2>&1; echo "held-$?"`);
  await first.within(60000, () =>
    document
      .querySelector('slicc-app')
      .model.browser.actions()
      .some(({ kind, status }) => kind === 'eval' && status === 'running')
  );

  assert.equal(
    await second.evaluate(
      ({ url, key }) =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(new URL('/cdp', url), ['slicc.cdp.v1', `slicc.key.${key}`]);
          socket.onopen = () => resolve(socket.protocol);
          socket.onerror = () => reject(new Error('the second page could not connect'));
        }),
      { url: proxy.url, key: proxy.key }
    ),
    'slicc.cdp.v1'
  );
  await first.send('Page.bringToFront');
  await shows(first, 'held-1');
  assert.equal(
    await read(first, '/tmp/held'),
    'websocket closed 1011 another page took over the local proxy’s browser connection (superseded-by-new-cdp-client)\n'
  );
});

test('a cone’s .jsh script, with sliccy:browser installed from the catalog, opens an ordinary tab and reads its title, and never finds seven or the vault', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  const vault = await tabAt(VAULT, 'VAULT-MARK');
  const opened = [];
  t.after(async () => {
    const tabs = await devtools('/json/list');
    const walker = tabs.filter((tab) => tab.url.includes('/walker')).map((tab) => tab.id);
    await Promise.all(
      [vault, ...opened, ...walker].map((id) => fetch(`http://127.0.0.1:${port}/json/close/${id}`))
    );
  });
  await page.until(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === id),
    'jsh-browser'
  );
  assert.equal(await actPackage(page, 'jsh-browser', 'install'), 'ok');
  const script = `const browser = require('sliccy:browser');
(async () => {
  const tab = await browser.ensureTab(${JSON.stringify(`http://127.0.0.1:${standPort}/walker`)});
  console.log('title', await browser.eval(tab, 'document.title'));
  console.log('vault', JSON.stringify(await browser.findTab({ domain: 'vault.sliccy.ai' })));
  console.log('seven', JSON.stringify(await browser.findTab({ urlMatch: '/os/' })));
  console.log('user', require('node:os').userInfo().username);
})().catch((error) => console.log('failed', error.message));
`;
  await run(
    page,
    `clear; cd /; sudo -u cone bash -c 'cd && echo ${Buffer.from(script).toString('base64')} | base64 -d > browse.jsh && jsh browse.jsh'; echo browsed-$((40 + 2))`
  );
  await shows(page, 'browsed-42', 5 * 60 * 1000);
  const text = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    return dock.content(
      dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'))
    ).screen.textContent;
  });
  assert.match(text, /title WALKER-MARK/);
  assert.match(text, /vault null/);
  assert.match(text, /seven null/);
  assert.match(text, /user cone/);
  assert.doesNotMatch(text, /failed /);
  assert.equal(await listed(vault), true);
  assert.deepEqual(page.errors, []);
});

test('a cone runs playwright-cli from a directory it cannot write, and it drives the browser', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  chrome.overrides.set(
    '/read-only.html',
    '<!doctype html><title>READ-ONLY-MARK</title><h1>Read-only cwd</h1>'
  );
  const target = elsewhere('/read-only.html');
  t.after(async () => {
    const tabs = await devtools('/json/list');
    await Promise.all(
      tabs
        .filter((tab) => tab.url.includes('/read-only.html'))
        .map((tab) => fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`))
    );
  });
  await run(
    page,
    `clear; cd /; sudo -u cone bash -c 'cd /usr/local && touch probe 2> /dev/null; echo writable=$?; playwright-cli open ${target} > /dev/null && playwright-cli tab-list; echo listed=$?'; echo done-$((40 + 2))`
  );
  await shows(page, 'done-42', 2 * 60 * 1000);
  const text = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    return dock.content(
      dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'))
    ).screen.textContent;
  });
  assert.match(text, /writable=1/);
  assert.match(text, /READ-ONLY-MARK/);
  assert.match(text, /listed=0/);
  assert.doesNotMatch(text, /Permission denied/);
  assert.deepEqual(page.errors, []);
});

test('slicc-cdp#252: a guard setup step that answers after 12 s still arms the tab, inside the shared budget, and the page opens', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page, { slow: { 'Target.setDiscoverTargets': 12000 } });
  t.after(extension.close);
  await boot(page);
  chrome.overrides.set(
    '/slow-guard.html',
    '<!doctype html><title>slow guard</title><h1>Armed late</h1>'
  );
  const target = elsewhere('/slow-guard.html');
  await run(
    page,
    `clear; playwright-cli open ${target} > /tmp/slow-guard 2>&1; echo opened=$?; playwright-cli tab-list | grep -c 'slow guard' | sed 's/^/listed=/'; echo slow-$((40 + 2))`
  );
  await shows(page, 'slow-42', 180000);
  const text = await read(page, '/tmp/slow-guard');
  assert.doesNotMatch(text, /refused/, text);
  assert.match(text, /Opened /, text);
  await shows(page, 'opened=0');
  await shows(page, 'listed=1');
  assert.ok(extension.sent.includes('Target.setDiscoverTargets'));
  assert.deepEqual(page.errors, []);
});
