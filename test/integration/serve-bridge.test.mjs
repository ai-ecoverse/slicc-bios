import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, boot, ready, run } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';
import { startHub } from './fake-hub.mjs';

const chrome = await launch({ extension: false, timeout: 120000 });
const { port: devtoolsPort } = await devtools(chrome);
after(() => chrome.close());
const fakeExtension = extensionOver(await debuggerUrl(devtoolsPort));

const SITE = `<!doctype html><html><head><title>Shop</title></head><body>
<button id="buy" onclick="window.clicks = (window.clicks || 0) + 1; window.slicc.emit('bought', { n: window.clicks })">Buy</button>
<input id="name" aria-label="Name">
</body></html>`;

const home = (page, name) =>
  page.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return dir.getFileHandle(name).then(
      async (handle) => (await handle.getFile()).text(),
      () => null
    );
  }, name);

async function until(check, what, ms = 60000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `${what} not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const lines = async (page, name) =>
  ((await home(page, name)) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

async function shell(page, name, command) {
  await run(page, `{ ${command}; } > /home/${name} 2>&1; echo "${name}-$?" >> /home/${name}.done`);
  await until(() => home(page, `${name}.done`), name, 120000);
  return (await home(page, name)) ?? '';
}

async function visit(url) {
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url, background: true });
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return {
    evaluate: async (expression) =>
      (await chrome.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId))
        .result.value,
    close: () => chrome.cdp.send('Target.closeTarget', { targetId }),
  };
}

async function seven(t, { extension = false } = {}) {
  const hub = await startHub();
  t.after(() => hub.close());
  const page = await chrome.page(t);
  if (extension) {
    const over = await fakeExtension(page);
    t.after(over.close);
  }
  await boot(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page);
  await page.until(() => document.querySelector('slicc-app').model.network.status().links?.joinUrl);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'serve')
  );
  assert.equal(await actPackage(page, 'serve', 'install'), 'ok');
  await page.evaluate(async (html) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    const site = await dir.getDirectoryHandle('site', { create: true });
    const file = await (await site.getFileHandle('index.html', { create: true })).createWritable();
    await file.write(html);
    await file.close();
  }, SITE);
  await run(page, '(serve --local /home/site > /home/serve.url 2>&1 &)');
  const local = (await until(() => home(page, 'serve.url'), 'serve --local')).trim();
  const port = Number(/^http:\/\/(\d+)\.kernel\.localhost/.exec(local)?.[1]);
  assert.ok(port > 0, local);

  return { hub, page, port };
}

const ask = (kind, extra = {}) => JSON.stringify({ kind, ...extra });

test('serve.publish with the bridge: kernel playwright-cli drives a visitor tab through the guard, emits and the first visit go to the webhook, and serve.logs and serve.truncate answer', async (t) => {
  const { hub, page, port } = await seven(t);
  const publish = ask('serve.publish', { port, root: '/home/site', bridge: true, maxTabs: 2 });
  await run(
    page,
    `{ exec 3<>/dev/embedder; printf '%s\\n' '${publish}' >&3; while IFS= read -r l <&3; do printf '%s\\n' "$l" >> /home/pub.jsonl; done; } &`
  );
  const published = await until(async () => (await lines(page, 'pub.jsonl'))[0], 'the publish');
  const { previewToken, url, webhook } = published;
  assert.match(webhook, /^serve-[0-9a-f]{16}$/);
  assert.equal(url, `${hub.url}/__preview/${encodeURIComponent(previewToken)}/`);
  const minted = hub.minting.at(-1);
  assert.deepEqual(
    [minted.bridge, minted.maxTabs, minted.quiet, minted.webhookId],
    [true, 2, false, webhook]
  );
  const hook = JSON.parse(await shell(page, 'hook', `cat /root/.slicc/webhooks/${webhook}.json`));
  assert.equal(hook.target, 'cone');
  assert.match(hook.message, /serve --bridge/);

  const visitor = await visit(url);
  t.after(() => visitor.close().catch(() => undefined));
  await until(() => hub.tabs.size === 1, 'the visitor tab');
  const [tab] = hub.tabs.values();
  const target = `preview:${previewToken}:${tab.connId}`;
  const connected = await until(
    async () => (await lines(page, 'pub.jsonl')).find((line) => line.event === 'connected'),
    'the connected event line'
  );
  assert.deepEqual(
    [connected.previewToken, connected.connId, connected.announced, connected.origin],
    [previewToken, tab.connId, true, hub.url]
  );
  assert.deepEqual(hub.states.at(-1), {
    type: 'preview.state.update',
    previewToken,
    announced: true,
  });
  await until(
    () => page.console.some((line) => line.includes(`serve: the webhook ${webhook}`)),
    "the first visit handed to the agent, which this harness doesn't run"
  );

  const listed = await shell(page, 'pw-list', 'playwright-cli tab-list');
  assert.ok(listed.includes(`[${target}]`), listed);
  assert.match(listed, /"Shop"/);
  assert.equal(
    (await shell(page, 'pw-title', 'playwright-cli eval document.title')).trim(),
    'Shop'
  );
  const snapshot = await shell(page, 'pw-snap', 'playwright-cli snapshot');
  const ref = /button "Buy" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
  assert.ok(ref, snapshot);
  const clicked = await shell(
    page,
    'pw-click',
    `playwright-cli snapshot > /dev/null && playwright-cli click ${ref}`
  );
  assert.match(clicked, /Clicked/, clicked);
  assert.equal(await visitor.evaluate('window.clicks'), 1);
  const shot = await shell(
    page,
    'pw-shot',
    'playwright-cli screenshot --filename /home/shot.png && head -c 8 /home/shot.png | od -An -tx1'
  );
  assert.match(shot, /89 50 4e 47 0d 0a 1a 0a/, shot);
  assert.ok(!tab.seen.includes('Input.dispatchMouseEvent'), tab.seen.join(' '));

  const emitted = await until(
    async () => (await lines(page, 'pub.jsonl')).find((line) => line.event === 'emit'),
    'the emit event line'
  );
  assert.deepEqual([emitted.name, emitted.detail], ['bought', '{"n":1}']);

  await shell(
    page,
    'logs',
    `exec 3<>/dev/embedder; printf '%s\\n' '${ask('serve.logs', { previewToken })}' >&3; cat <&3`
  );
  const logged = await lines(page, 'logs');
  assert.deepEqual(
    logged.map((line) => line.event),
    ['connected', 'emit']
  );
  await shell(
    page,
    'truncate',
    `exec 3<>/dev/embedder; printf '%s\\n' '${ask('serve.truncate')}' >&3; cat <&3`
  );
  assert.deepEqual(await lines(page, 'truncate'), [{ cleared: 2, rearmed: 1 }]);
  assert.deepEqual(hub.states.at(-1), {
    type: 'preview.state.update',
    previewToken,
    announced: false,
  });

  await visitor.close();
  await until(
    async () => (await lines(page, 'pub.jsonl')).some((line) => line.event === 'disconnected'),
    'the disconnected event line'
  );
  const gone = await shell(page, 'pw-gone', 'playwright-cli tab-list');
  assert.ok(!gone.includes(target), gone);

  const stopped = await shell(
    page,
    'stop',
    `exec 3>/dev/embedder; printf '%s\\n' '${ask('serve.stop', { previewToken })}' >&3; exec 3>&-`
  );
  await until(
    async () => (await lines(page, 'pub.jsonl')).some((line) => line.stopped),
    `the stopped line (${stopped})`
  );
  await until(
    async () =>
      !(await shell(page, `hook-gone-${Date.now()}`, 'ls /root/.slicc/webhooks/')).includes(
        webhook
      ),
    'the webhook removed'
  );
  await shell(
    page,
    'logs-after',
    `exec 3<>/dev/embedder; printf '%s\\n' '${ask('serve.logs', { previewToken })}' >&3; cat <&3`
  );
  assert.deepEqual(
    (await lines(page, 'logs-after')).map((line) => line.event),
    ['disconnected']
  );
  const unknown = await shell(
    page,
    'logs-unknown',
    `exec 3<>/dev/embedder; printf '%s\\n' '${ask('serve.logs', { previewToken: 't9.p9' })}' >&3; cat <&3`
  );
  assert.doesNotMatch(await home(page, 'logs-unknown.done'), /logs-unknown-0/, unknown);
});

test('next to a browser the guard drives, a quiet bridged preview adds its visitor tab to the same targets: playwright-cli lists both and drives the preview one, and the first visit is recorded but not announced', async (t) => {
  const { hub, page, port } = await seven(t, { extension: true });
  const publish = ask('serve.publish', { port, bridge: true, maxTabs: 1, quiet: true });
  await run(
    page,
    `{ exec 3<>/dev/embedder; printf '%s\\n' '${publish}' >&3; while IFS= read -r l <&3; do printf '%s\\n' "$l" >> /home/quiet.jsonl; done; } &`
  );
  const { previewToken, url } = await until(
    async () => (await lines(page, 'quiet.jsonl'))[0],
    'the publish'
  );
  assert.deepEqual([hub.minting.at(-1).maxTabs, hub.minting.at(-1).quiet], [1, true]);
  const visitor = await visit(url);
  t.after(() => visitor.close().catch(() => undefined));
  const connected = await until(
    async () => (await lines(page, 'quiet.jsonl')).find((line) => line.event === 'connected'),
    'the connected event line'
  );
  assert.equal(connected.announced, false);
  assert.deepEqual(hub.states.at(-1), {
    type: 'preview.state.update',
    previewToken,
    announced: true,
  });
  const target = `preview:${previewToken}:${connected.connId}`;
  const listed = await shell(page, 'both-list', 'playwright-cli tab-list');
  const rows = listed.split('\n').filter((row) => row.includes('/__preview/'));
  assert.equal(rows.length, 2, listed);
  const index = /^\D*(\d+)/.exec(rows.find((row) => row.includes(`[${target}]`)) ?? '')?.[1];
  assert.ok(index, listed);
  const seen = hub.tabs.get(connected.connId).seen.length;
  const driven = await shell(
    page,
    'both-eval',
    `playwright-cli tab-select ${index} > /dev/null && playwright-cli eval "document.title + ' ' + String(typeof window.slicc)"`
  );
  assert.equal(driven.trim(), 'Shop object', driven);
  assert.ok(hub.tabs.get(connected.connId).seen.length > seen, 'the eval went over the bridge');
  assert.ok(
    !page.console.some((row) => row.includes('serve: the webhook')),
    page.console.join('\n')
  );
});
