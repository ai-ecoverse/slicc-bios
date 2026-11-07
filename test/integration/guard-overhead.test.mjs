import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { boot, ready } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';
import { attach, CLI } from './cli.mjs';

const chrome = await launch();
after(() => chrome.close());

const RUNS = 5;
const TABS = 10;
const LIMIT = 10;
const WAIT = 45000;
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('');
const FIXTURE = `<!doctype html><title>bench</title>
<nav>${rows(30, (i) => `<a href="#l${i}">Link ${i}</a> `)}</nav>
<main><h1>Settings</h1>
<form>${rows(12, (i) => `<label>Field ${i} <input name="f${i}"></label><br>`)}<button>Save</button></form>
<table>${rows(20, (i) => `<tr><td>r${i}</td><td><a href="#r${i}">open</a></td><td><button>edit ${i}</button></td></tr>`)}</table>
<ul>${rows(40, (i) => `<li>Item ${i} <button>remove</button></li>`)}</ul></main>`;

function fixture() {
  const server = createServer((_, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(FIXTURE);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function recording(port) {
  const seen = { snapshot: null };
  const server = createServer(async (req, res) => {
    const answer = await fetch(`http://127.0.0.1:${port}${req.url}`);
    const body = (await answer.text()).replaceAll(
      `127.0.0.1:${port}`,
      `127.0.0.1:${server.address().port}`
    );
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(body);
  });
  server.on('upgrade', (req, socket, head) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${port}${req.url}`, {
      perMessageDeflate: false,
    });
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    wss.handleUpgrade(req, socket, head, (client) => {
      const early = [];
      upstream.on('open', () => {
        for (const text of early.splice(0)) upstream.send(text);
      });
      client.on('message', (data) => {
        const text = data.toString();
        if (text.includes('"Runtime.evaluate"') && text.includes('sliccAriaSnapshot')) {
          const expression = JSON.parse(text).params?.expression;
          if (expression.length > (seen.snapshot?.length ?? 0)) seen.snapshot = expression;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
        else early.push(text);
      });
      upstream.on('message', (data) => {
        if (client.readyState === WebSocket.OPEN) client.send(data.toString());
      });
      client.on('close', () => upstream.close());
      upstream.on('close', () => client.close());
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, seen, close: () => server.close() })
    )
  );
}

async function raw(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await new Promise((resolve) => ws.on('open', resolve));
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { send, close: () => ws.close() };
}

async function attached(port, targetId, work) {
  const c = await raw(port);
  await c.send('Target.getTargets');
  const { result } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  await work(c, result.sessionId);
  await c.send('Target.detachFromTarget', { sessionId: result.sessionId });
  c.close();
}

const unguarded = {
  async 'tab-list'(port) {
    const c = await raw(port);
    await c.send('Target.getTargets');
    c.close();
  },
  eval: (port, target) =>
    attached(port, target, (c, s) =>
      c.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, s)
    ),
  snapshot: (port, target, expression) =>
    attached(port, target, async (c, s) => {
      await c.send('Page.enable', {}, s);
      await c.send('Runtime.enable', {}, s);
      const tree = await c.send('Page.getFrameTree', {}, s);
      const world = await c.send(
        'Page.createIsolatedWorld',
        { frameId: tree.result.frameTree.frame.id, grantUniveralAccess: true },
        s
      );
      const contextId = world.result.executionContextId;
      const snap = await c.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, contextId },
        s
      );
      assert.ok(snap.result && !snap.result.exceptionDetails, JSON.stringify(snap).slice(0, 300));
      const handle = await c.send(
        'Runtime.evaluate',
        { expression: 'globalThis.__sliccAriaElements', objectGroup: 'bench', contextId },
        s
      );
      const props = await c.send(
        'Runtime.getProperties',
        { objectId: handle.result.result.objectId, ownProperties: true },
        s
      );
      for (const prop of props.result.result)
        if (prop.value?.objectId)
          await c.send('DOM.describeNode', { objectId: prop.value.objectId }, s);
      await c.send('Runtime.releaseObjectGroup', { objectGroup: 'bench' }, s);
    }),
  screenshot: (port, target) =>
    attached(port, target, async (c, s) => {
      const shot = await c.send('Page.captureScreenshot', { format: 'png' }, s);
      assert.ok(shot.result?.data, JSON.stringify(shot).slice(0, 300));
    }),
};

async function kernel(page, script) {
  const { out, done } = await page.evaluate(
    async ({ script, wait }) => {
      const { model } = document.querySelector('slicc-app');
      const terminal = model.terminals.open();
      const decoder = new TextDecoder();
      let out = '';
      let done;
      const exited = new Promise((resolve) => {
        done = resolve;
      });
      const session = await model.terminals.backend(terminal.id).open(
        {
          output: (bytes) => {
            out += decoder.decode(bytes, { stream: true });
          },
          exit: done,
        },
        { cols: 200, rows: 50 }
      );
      session.write(`${script}\nexit\n`);
      let timer;
      const finished = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), wait);
        }),
      ]);
      clearTimeout(timer);
      if (!finished) session.close();
      model.terminals.close(terminal.id);
      return { out, done: finished };
    },
    { script, wait: WAIT }
  );
  assert.ok(
    done,
    `the kernel did not finish in ${WAIT} ms:\n${script}\n--- output so far:\n${out.slice(-3000)}`
  );
  return out;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('guard overhead: snapshot and screenshot through seven, the link and the CLI take at most 10x what they take unguarded in Chrome', {
  skip: !CLI,
}, async (t) => {
  const site = await fixture();
  t.after(() => site.close());
  const other = await launch({ vault: false });
  t.after(() => other.close());
  const { port: debugPort } = await devtools(other);
  await debuggerUrl(debugPort);
  const proxy = await recording(debugPort);
  t.after(() => proxy.close());
  const direct = await raw(debugPort);
  const url = `http://127.0.0.1:${site.address().port}/`;
  const { targetId: target } = (await direct.send('Target.createTarget', { url })).result;
  for (let i = 0; i < TABS; i += 1)
    await direct.send('Target.createTarget', { url: `${url}?tab=${i}`, background: true });
  direct.close();
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  const node = attach(
    CLI,
    [
      '--signal',
      'stdio',
      '--name',
      'ref-node',
      '--no-kernel',
      '--cdp-extra',
      `http://127.0.0.1:${proxy.port}`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );
  t.after(() => node.kill());
  await page.expose('sliccLinkSend', (message) => node.stdin.write(`${JSON.stringify(message)}\n`));
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((d) => d.state === 'connected')
  );
  const listed = await kernel(page, "curl -s 'http://127.0.0.1:9222/json/list?runtime=nope'");
  const runtime = /ref-node\/[A-Za-z0-9._-]+/.exec(listed)?.[0];
  assert.ok(runtime, listed);
  const pw = `playwright-cli --runtime ${runtime}`;
  const ops = {
    'tab-list': `${pw} tab-list`,
    eval: `${pw} eval --tab ${target} document.title`,
    snapshot: `${pw} snapshot --tab ${target}`,
    screenshot: `${pw} screenshot --tab ${target} --filename /tmp/bench.png`,
  };
  const guarded = {};
  for (const [name, cmd] of Object.entries({ start: 'playwright-cli --version', ...ops })) {
    const ran = await kernel(
      page,
      `for i in $(seq 1 ${RUNS}); do a=\${EPOCHREALTIME/./}; ${cmd} > /tmp/bench.out 2>&1; r=$?; b=\${EPOCHREALTIME/./}; echo "BENCH $r $(((b-a)/1000))"; [ $r = 0 ] || head -c 600 /tmp/bench.out; done`
    );
    for (const [, code, ms] of ran.matchAll(/^BENCH (\d+) (\d+)\r?$/gm)) {
      assert.equal(code, '0', `${name} failed:\n${ran.slice(-3000)}`);
      (guarded[name] ??= []).push(Number(ms));
    }
    assert.equal(
      guarded[name]?.length,
      RUNS,
      `${name} ran ${guarded[name]?.length ?? 0} times:\n${ran.slice(-3000)}`
    );
  }
  assert.ok(proxy.seen.snapshot, 'the snapshot script went through the CLI');
  const report = { 'process start': { guardedMs: median(guarded.start) } };
  for (const name of Object.keys(ops)) {
    const times = [];
    for (let i = 0; i < RUNS; i += 1) {
      const started = performance.now();
      await unguarded[name](debugPort, target, proxy.seen.snapshot);
      times.push(performance.now() - started);
    }
    const g = median(guarded[name]);
    const u = median(times);
    report[name] = {
      guardedMs: g,
      unguardedMs: Number(u.toFixed(1)),
      ratio: Number((g / u).toFixed(1)),
    };
  }
  console.table(report);
  for (const name of ['snapshot', 'screenshot'])
    assert.ok(
      report[name].ratio <= LIMIT,
      `${name} took ${report[name].guardedMs} ms guarded and ${report[name].unguardedMs} ms unguarded`
    );
});
