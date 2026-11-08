import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { boot, ready } from './bios.mjs';
import { devtools as boundPort, debuggerUrl, launch } from './chrome.mjs';
import { CLI, cliEnv } from './cli.mjs';
import { extensionOver } from './fake-extension.mjs';
import { model, startHub } from './fake-hub.mjs';

const cli = CLI;
const NO_GRANT =
  "browser control from this device is off; turn on Browser for it in seven's Linked devices";
const SWITCHED_OFF = "browser control from linked devices is off in seven's settings";
const STOPPED = 'stopped in seven';

const pin = JSON.parse(
  await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
).devDependencies['@ai-ecoverse/slicc'];
assert.equal(pin, '1.63.0', `bios pins @ai-ecoverse/slicc at ${pin}, want 1.63.0`);

const stand = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pages = {
    '/plain': '<!doctype html><title>PLAIN-MARK</title><h1>Plain</h1>',
    '/vault': '<!doctype html><title>VAULT-MARK</title><h1>VAULT-BODY-MARK</h1>',
  };
  res.writeHead(pages[url.pathname] ? 200 : 404, { 'content-type': 'text/html' });
  res.end(pages[url.pathname] ?? 'missing');
});
await new Promise((resolve) => stand.listen(0, '127.0.0.1', resolve));
const standPort = stand.address().port;
const PLAIN = `http://localhost:${standPort}/plain`;
const VAULT = `http://vault.sliccy.ai:${standPort}/vault`;
const chrome = await launch({
  args: ['--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1'],
  timeout: 120000,
});
const { port: debugPort } = await boundPort(chrome);
const browserUrl = await debuggerUrl(debugPort);
const fakeExtension = extensionOver(browserUrl);
const direct = new WebSocket(browserUrl);
await new Promise((resolve, reject) => {
  direct.on('open', resolve);
  direct.on('error', reject);
});
const answers = new Map();
let calls = 0;
direct.on('message', (data) => {
  const message = JSON.parse(data.toString());
  answers.get(message.id)?.(message);
  answers.delete(message.id);
});
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    calls += 1;
    answers.set(calls, (message) =>
      message.error ? reject(new Error(message.error.message)) : resolve(message.result)
    );
    direct.send(JSON.stringify({ id: calls, method, params }));
  });
after(() => {
  direct.close();
  chrome.close();
  stand.close();
});

const items = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.live.items()
      .filter((item) => item.kind === 'cdp')
      .map(({ id, kind, label, what, asker, action }) => ({ id, kind, label, what, asker, action }))
  );

const setSwitch = (page, value) =>
  page.evaluate(
    (value) => document.querySelector('slicc-app').model.switches.set('remote-browser', value),
    value
  );

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), 'remote-cdp-accept-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return {
    ...cliEnv(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    SLICC_CDP_PORTS: '9300-9309',
    SLICC_NO_TELEMETRY: '1',
  };
}

function startCdp(t, args, { env, page = null } = {}) {
  const node = spawn(cli, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ?? cliEnv({ SLICC_CDP_PORTS: '9300-9309', SLICC_NO_TELEMETRY: '1' }),
  });
  const events = [];
  const stderr = [];
  node.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  createInterface({ input: node.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.nonce) {
      page?.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {});
      return;
    }
    events.push(message);
  });
  const exited = new Promise((resolve) =>
    node.on('exit', (code, signal) => resolve({ code, signal }))
  );
  const run = { node, events, stderr, exited };
  run.stop = async () => {
    if (node.exitCode === null) node.kill('SIGTERM');
    return exited;
  };
  t.after(() => run.stop());
  return run;
}

async function waitListening(run, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const found = run.events.find((event) => event.event === 'listening' && event.url);
    if (found) return found.url;
    if (run.node.exitCode !== null)
      assert.fail(
        `slicc cdp exited ${run.node.exitCode} before listening: ${run.stderr.join('')}\n${JSON.stringify(run.events)}`
      );
    if (Date.now() >= end)
      assert.fail(
        `slicc cdp never listened: ${run.stderr.join('')}\n${JSON.stringify(run.events)}`
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function httpJson(url, { method = 'GET', headers = {} } = {}) {
  const response = await fetch(url, { method, headers });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

function dial(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  let closed = null;
  const wake = () => {
    for (const look of waiters.splice(0)) look();
  };
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
    wake();
  });
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const done = new Promise((resolve) => {
    ws.on('close', (code, reason) => {
      closed = { code, reason: reason.toString() };
      wake();
      resolve(closed);
    });
  });
  const wait = (check, ms = 60000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`wait timed out; closed=${JSON.stringify(closed)}`)),
        ms
      );
      const look = () => {
        const found = check({ messages, closed });
        if (found) {
          clearTimeout(timer);
          resolve(found);
        } else waiters.push(look);
      };
      look();
    });
  let next = 0;
  const call = async (method, params = {}, sessionId) => {
    next += 1;
    const id = next;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    const answer = await wait(({ messages: inbox, closed: gone }) => {
      if (gone) return { closed: gone };
      return inbox.find((message) => message.id === id);
    });
    if (answer.closed)
      throw new Error(`socket closed before ${method}: ${JSON.stringify(answer.closed)}`);
    return answer;
  };
  return { ws, opened, done, wait, call, messages: () => messages, closed: () => closed };
}

async function seedProtected(t) {
  const { targetId: vaultTab } = await cdp('Target.createTarget', { url: VAULT });
  t.after(() => cdp('Target.closeTarget', { targetId: vaultTab }).catch(() => {}));
  await cdp('Storage.setCookies', {
    cookies: [
      { name: 'vaultc', value: 'VAULT-COOKIE', url: `http://vault.sliccy.ai:${standPort}/` },
      { name: 'plainc', value: 'PLAIN-COOKIE', url: `http://localhost:${standPort}/` },
    ],
  });
  const { targetInfos } = await cdp('Target.getTargets');
  const own = new URL(chrome.url).origin;
  const sevenTab = targetInfos.find((info) => info.type === 'page' && info.url.startsWith(own));
  assert.ok(sevenTab, JSON.stringify(targetInfos.map((info) => info.url)));
  return { vaultTab, sevenTab };
}

async function exerciseRaw(t, base, { vaultTab, sevenTab, sevenUrl }) {
  const version = await httpJson(`${base}/json/version`);
  assert.equal(version.status, 200, version.text);
  for (const key of [
    'Browser',
    'Protocol-Version',
    'User-Agent',
    'V8-Version',
    'WebKit-Version',
    'webSocketDebuggerUrl',
  ])
    assert.equal(typeof version.body[key], 'string', key);
  assert.match(version.body.webSocketDebuggerUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);

  const listed = await httpJson(`${base}/json/list`);
  assert.equal(listed.status, 200, listed.text);
  assert.ok(Array.isArray(listed.body), listed.text);
  for (const entry of listed.body) {
    assert.notEqual(entry.type, 'browser');
    assert.notEqual(entry.type, 'tab');
    assert.equal(
      typeof entry.url === 'string' &&
        (entry.url.includes('/vault') || entry.url.includes('/os/') || entry.url === sevenUrl),
      false,
      JSON.stringify(entry)
    );
  }

  const browser = dial(version.body.webSocketDebuggerUrl);
  await browser.opened;
  t.after(() => browser.ws.close());
  const created = await browser.call('Target.createTarget', { url: 'about:blank' });
  assert.equal(created.error, undefined, JSON.stringify(created));
  const targetId = created.result.targetId;
  t.after(() => cdp('Target.closeTarget', { targetId }).catch(() => {}));
  const attached = await browser.call('Target.attachToTarget', { targetId, flatten: true });
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  const sessionId = attached.result.sessionId;
  await browser.call('Page.enable', {}, sessionId);
  await browser.call('Page.navigate', { url: PLAIN }, sessionId);
  let title;
  {
    const end = Date.now() + 30000;
    for (;;) {
      const answer = await browser.call(
        'Runtime.evaluate',
        { expression: 'document.title', returnByValue: true },
        sessionId
      );
      if (answer.result?.result?.value === 'PLAIN-MARK') {
        title = answer.result.result.value;
        break;
      }
      if (Date.now() >= end) assert.fail(`navigate: ${JSON.stringify(answer)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(title, 'PLAIN-MARK');
  const shot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
  assert.equal(shot.error, undefined, JSON.stringify(shot));
  assert.match(shot.result.data, /^[A-Za-z0-9+/=]+$/);
  assert.ok(shot.result.data.length > 100);

  const pageList = await httpJson(`${base}/json/list`);
  const pageEntry = pageList.body.find((entry) => entry.id === targetId || entry.url === PLAIN);
  assert.ok(pageEntry?.webSocketDebuggerUrl, JSON.stringify(pageList.body));
  const pageSocket = dial(pageEntry.webSocketDebuggerUrl);
  await pageSocket.opened;
  t.after(() => pageSocket.ws.close());
  const pageEval = await pageSocket.call('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true,
  });
  assert.equal(pageEval.sessionId, undefined, JSON.stringify(pageEval));
  assert.equal(pageEval.result?.result?.value, 'PLAIN-MARK');
  await pageSocket.call('Page.navigate', { url: PLAIN });

  const put = await httpJson(`${base}/json/new?${PLAIN}`, { method: 'PUT' });
  t.diagnostic(
    `PUT /json/new known gap (G3 1e): status=${put.status} body=${put.text.slice(0, 300)}`
  );
  if (put.status === 200 && put.body?.webSocketDebuggerUrl) {
    const fresh = dial(put.body.webSocketDebuggerUrl);
    const outcome = await Promise.race([
      fresh.opened.then(() => 'opened').catch((error) => `open-error:${error.message}`),
      fresh.done.then((closed) => `closed:${closed.code}:${closed.reason}`),
    ]);
    t.diagnostic(`PUT /json/new page socket after createTarget(url): ${outcome}`);
    fresh.ws.close();
  }

  const refuseSeven = await browser.call('Target.attachToTarget', {
    targetId: sevenTab.targetId,
    flatten: true,
  });
  assert.ok(refuseSeven.error, JSON.stringify(refuseSeven));
  const refuseVault = await browser.call('Target.attachToTarget', {
    targetId: vaultTab,
    flatten: true,
  });
  assert.ok(refuseVault.error, JSON.stringify(refuseVault));
  const networkJar = await browser.call('Network.getAllCookies');
  t.diagnostic(`Network.getAllCookies: ${JSON.stringify(networkJar).slice(0, 300)}`);
  const jar =
    networkJar.error && /wasn't found/i.test(networkJar.error.message ?? '')
      ? await browser.call('Storage.getCookies')
      : networkJar;
  assert.equal(jar.error, undefined, JSON.stringify(jar));
  const names = (jar.result?.cookies ?? []).map((cookie) => cookie.name);
  assert.ok(names.includes('plainc'), JSON.stringify(names));
  assert.equal(names.includes('vaultc'), false, JSON.stringify(names));
  const navSeven = await browser.call('Page.navigate', { url: sevenUrl }, sessionId);
  if (!navSeven.error) {
    let landed = '';
    const end = Date.now() + 15000;
    for (;;) {
      const answer = await browser.call(
        'Runtime.evaluate',
        {
          expression:
            'location.href + " " + document.title + " " + (document.body?.innerText ?? "").slice(0, 200)',
          returnByValue: true,
        },
        sessionId
      );
      landed = answer.result?.result?.value ?? '';
      if (
        /error|refused|slicc|chrome-error|not available/i.test(landed) ||
        !landed.includes('/os/')
      )
        break;
      if (Date.now() >= end) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      /\/os\//.test(landed) && !/error|refused|chrome-error|not available/i.test(landed),
      false,
      `navigated into seven: ${landed}`
    );
  }

  await browser.call('Target.closeTarget', { targetId });
  return { browser, version };
}

test('released slicc cdp --signal stdio serves seven over a local link for a raw CDP client', {
  skip: !cli,
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  await ready(page);
  const sevenUrl = await page.evaluate(() => location.href);
  const protectedTabs = await seedProtected(t);
  let current = null;
  await page.expose('sliccLinkSend', (message) =>
    current?.node.stdin.write(`${JSON.stringify(message)}\n`)
  );
  const env = await scratch(t);
  const run = startCdp(t, ['cdp', '--signal', 'stdio', '--port', '0', '--json'], { env, page });
  current = run;
  const base = await waitListening(run);
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  await exerciseRaw(t, base, { ...protectedTabs, sevenUrl });
  const chip = await items(page);
  assert.ok(chip.some((item) => item.kind === 'cdp' && item.label === 'Driving this browser'));
});

test('released slicc <join-url> cdp through the fake tray needs Browser, then a raw CDP client drives seven', {
  skip: !cli,
  timeout: 25 * 60 * 1000,
}, async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page);
  const joinUrl = await page.within(
    60000,
    () => document.querySelector('slicc-app').model.network.status().links?.joinUrl
  );
  assert.equal(joinUrl, `${hub.url}/join/j1`);
  const sevenUrl = await page.evaluate(() => location.href);
  const protectedTabs = await seedProtected(t);
  const env = await scratch(t);

  const denied = startCdp(t, [joinUrl, 'cdp', '--port', '0', '--json'], { env });
  const deniedExit = await denied.exited;
  assert.equal(deniedExit.code, 3, denied.stderr.join(''));
  assert.match(denied.stderr.join(''), new RegExp(NO_GRANT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(
    denied.events.some((event) => event.event === 'listening'),
    false
  );

  const device = await page.within(60000, () => {
    const rows = document.querySelector('slicc-app').model.network.status().links?.devices ?? [];
    return rows.find((row) => row.kind === 'cli' && row.mode === 'remote')?.id;
  });
  assert.match(device, /^[0-9a-f]{64}$/);
  await model(page, (network, id) => network.setAccess(id, 'browser', true), device);
  assert.deepEqual(
    (
      await model(
        page,
        (network, id) => network.status().links.devices.find((row) => row.id === id),
        device
      )
    ).access,
    { control: false, browser: true }
  );

  const run = startCdp(t, [joinUrl, 'cdp', '--port', '0', '--json'], { env });
  const base = await waitListening(run);
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(run.stderr.join(''), /serving seven's browser at http:\/\/127\.0\.0\.1:/);

  const { browser } = await exerciseRaw(t, base, { ...protectedTabs, sevenUrl });
  const whileOpen = dial((await httpJson(`${base}/json/version`)).body.webSocketDebuggerUrl);
  await whileOpen.opened;
  await whileOpen.call('Browser.getVersion');
  const chip = await items(page);
  assert.ok(
    chip.some(
      (item) =>
        item.kind === 'cdp' &&
        item.label === 'Driving this browser' &&
        item.action?.label === 'Stop'
    ),
    JSON.stringify(chip)
  );

  await setSwitch(page, false);
  const switched = await whileOpen.done;
  assert.equal(switched.code, 1008, JSON.stringify(switched));
  assert.equal(switched.reason, SWITCHED_OFF);
  assert.deepEqual(await items(page), []);
  await setSwitch(page, true);

  const again = dial((await httpJson(`${base}/json/version`)).body.webSocketDebuggerUrl);
  await again.opened;
  await again.call('Browser.getVersion');
  const [live] = await items(page);
  assert.ok(live, 'chip missing after reconnect');
  await page.evaluate((id) => document.querySelector('slicc-app').model.live.act(id), live.id);
  const stopped = await again.done;
  assert.match(stopped.reason, new RegExp(STOPPED));
  assert.deepEqual(await items(page), []);
  browser.ws.close();
});
