import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const RUNS = Number(env.BOOT_RUNS ?? 3);
const BOUND = 25 * 60 * 1000;
const chrome = await launch({ timeout: 120000, agent: true });
after(() => chrome.close());

function milestones() {
  const marks = {};
  window.sliccBootMarks = marks;
  const deep = (root, selector) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && deep(element.shadowRoot, selector);
      if (inner) return inner;
    }
    return null;
  };
  const last = (app, prefix) =>
    app.dock?.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith(prefix));
  const terminal = (app) => {
    const id = last(app, 'terminal:');
    if (!id) return false;
    const text = app.dock.content(id)?.screen?.textContent ?? '';
    if (/slicc:(~\$|\/home#) /.test(text)) return true;
    if (!marks.activated) {
      marks.activated = Date.now();
      app.dock.api.getPanel(id)?.api.setActive();
    }
    return false;
  };
  const chat = (app) => {
    const { model } = app;
    if (!model?.updates?.ready?.()) return false;
    const accounts = model.settings?.accounts?.();
    if (!Array.isArray(accounts) || accounts.length === 0) return false;
    marks.agent ??= Date.now();
    const id = last(app, 'chat:');
    const root = id && app.dock.content(id)?.shadowRoot;
    const area = root && deep(root, 'textarea');
    if (!area && marks.terminal && !marks.shown && Date.now() - marks.agent > 2000) {
      marks.shown = Date.now();
      app.show('chat');
    }
    return !!area && !area.disabled && !area.readOnly;
  };
  const tick = () => {
    const app = document.querySelector('slicc-app');
    if (app?.dock && location.pathname === '/os/') {
      marks.ui ??= Date.now();
      if (!marks.terminal && terminal(app)) marks.terminal = Date.now();
      if (!marks.chat && chat(app)) marks.chat = Date.now();
    }
    if (!marks.terminal || !marks.chat) setTimeout(tick, 50);
  };
  tick();
}

function traffic(cdp) {
  const entries = new Map();
  let on = false;
  const sessions = new Map();
  cdp.on(({ method, params, sessionId }) => {
    if (method === 'Target.attachedToTarget') {
      sessions.set(params.sessionId, params.targetInfo.type);
      if (params.targetInfo.type !== 'page')
        cdp.send('Network.enable', {}, params.sessionId).catch(() => {});
      return;
    }
    if (!on || !method?.startsWith('Network.')) return;
    const key = `${sessionId}:${params.requestId}`;
    if (method === 'Network.requestWillBeSent') {
      entries.set(key, {
        url: params.request.url,
        target: sessions.get(sessionId) ?? 'page',
        bytes: 0,
        encoded: 0,
      });
      return;
    }
    const entry = entries.get(key);
    if (!entry) return;
    if (method === 'Network.responseReceived') {
      const { response } = params;
      const headers = Object.fromEntries(
        Object.entries(response.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
      );
      Object.assign(entry, {
        status: response.status,
        mime: response.mimeType,
        type: headers['content-type'] ?? null,
        worker: response.fromServiceWorker === true,
        cache: response.fromDiskCache === true || response.fromPrefetchCache === true,
        served: headers['x-served-from'] ?? null,
      });
    }
    if (method === 'Network.dataReceived') entry.bytes += params.dataLength;
    if (method === 'Network.loadingFinished') {
      entry.encoded = params.encodedDataLength;
      entry.done = true;
    }
    if (method === 'Network.loadingFailed') entry.failed = params.errorText;
  });
  return {
    start() {
      entries.clear();
      on = true;
    },
    stop() {
      on = false;
      return [...entries.values()];
    },
  };
}

const watched = traffic(chrome.cdp);

function summary(list) {
  const http = list.filter(({ url }) => /^https?:/.test(url));
  const network = http.filter(({ worker, cache }) => worker === false && !cache);
  const opfs = http.filter(({ worker, served }) => worker && served && served !== 'sw');
  const sum = (items, field) => items.reduce((total, item) => total + (item[field] ?? 0), 0);
  const spectrum = http.filter(({ url }) => url.includes('/slicc-spectrum/dist/'));
  const wasm = http.filter(({ url }) => url.endsWith('/ghostty-vt.wasm'));
  return {
    requests: http.length,
    network: { count: network.length, bytes: sum(network, 'encoded') },
    opfs: { count: opfs.length, bytes: sum(opfs, 'bytes') },
    cache: { count: http.filter(({ cache }) => cache).length },
    spectrum: {
      count: spectrum.length,
      network: spectrum.filter(({ worker, cache }) => worker === false && !cache).length,
      opfs: spectrum.filter(({ served }) => served === 'opfs').length,
      bytes: sum(spectrum, 'bytes'),
    },
    wasm: wasm.map(({ url, worker, served, type, mime, bytes, status }) => ({
      url,
      worker,
      served,
      type,
      mime,
      bytes,
      status,
    })),
    hosts: Object.fromEntries(
      Object.entries(Object.groupBy(network, ({ url }) => new URL(url).host)).map(
        ([host, items]) => [host, { count: items.length, bytes: sum(items, 'encoded') }]
      )
    ),
    biggest: [...network]
      .sort((a, b) => b.encoded - a.encoded)
      .slice(0, 8)
      .map(({ url, encoded }) => `${encoded} ${url}`),
  };
}

async function measure(page, label, go) {
  const server = chrome.requests.length;
  const cdn = chrome.cdn.requests.length;
  watched.start();
  const start = Date.now();
  await go();
  const marks = await page
    .within(BOUND, () => {
      const marks = window.sliccBootMarks;
      return marks?.terminal && marks?.chat && marks;
    })
    .catch(async (error) => {
      throw new Error(
        `${label}: no usable chat and terminal: ${error.message}\n${JSON.stringify(await page.evaluate(() => window.sliccBootMarks).catch(() => null))}`
      );
    });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const list = watched.stop();
  const result = {
    label,
    terminal: marks.terminal - start,
    chat: marks.chat - start,
    agent: marks.agent - start,
    ui: marks.ui - start,
    activated: marks.activated ? marks.activated - start : null,
    shown: marks.shown ? marks.shown - start : null,
    server: chrome.requests.slice(server),
    cdn: chrome.cdn.requests.slice(cdn),
    ...summary(list),
  };
  console.log(`BOOT-WEIGHT ${JSON.stringify(result)}`);
  await writeFile(
    new URL(`${label.replace(/\W+/g, '-')}.json`, page.dir),
    JSON.stringify({ result, list }, null, 2)
  );
  return result;
}

async function idle(page) {
  await page.within(BOUND, () => {
    const rows = document.querySelector('slicc-app')?.model?.updates?.list?.() ?? [];
    return (
      rows.length > 0 &&
      rows.every((row) => !/queued|starting|checking|downloading|linking/.test(row.state))
    );
  });
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test(`boot weight: ${RUNS} cold boots and warm reloads to the first terminal prompt and the first usable chat`, {
  timeout: RUNS * 2 * BOUND,
}, async (t) => {
  console.log(
    `BOOT-WEIGHT host ${JSON.stringify({ runner: env.RUNNER_NAME ?? null, os: env.ImageOS ?? null, cpus: cpus().length, cpu: cpus()[0]?.model, memory: totalmem() })}`
  );
  const results = [];
  for (let run = 1; run <= RUNS; run++) {
    await t.test(`run ${run}`, async (s) => {
      const page = await chrome.page(s);
      await page.init(milestones);
      results.push(await measure(page, `cold ${run}`, () => page.goto('/')));
      await idle(page);
      results.push(await measure(page, `warm ${run}`, () => page.reload()));
      const compiled = await page.evaluate(async () => {
        const url = customElements.get('slicc-terminal')?.wasmUrl;
        if (!url) return { url: null };
        const response = await fetch(url);
        const type = response.headers.get('content-type');
        const served = response.headers.get('x-served-from');
        const module = await WebAssembly.compileStreaming(response);
        return { url, type, served, exports: WebAssembly.Module.exports(module).length };
      });
      console.log(`BOOT-WEIGHT wasm ${JSON.stringify(compiled)}`);
      assert.equal(compiled.type, 'application/wasm');
      assert.equal(compiled.served, 'opfs');
      assert.ok(compiled.exports > 0);
      assert.deepEqual(page.errors, []);
    });
  }
  const pick = (kind, field) =>
    results.filter(({ label }) => label.startsWith(kind)).map((result) => result[field]);
  const table = {};
  for (const kind of ['cold', 'warm']) {
    for (const field of ['terminal', 'chat']) {
      const values = pick(kind, field);
      table[`${kind} ${field}`] = {
        median: median(values),
        min: Math.min(...values),
        max: Math.max(...values),
        values,
      };
    }
    const network = pick(kind, 'network').map(({ bytes }) => bytes);
    const opfs = pick(kind, 'opfs').map(({ bytes }) => bytes);
    table[`${kind} bytes`] = { network, opfs };
  }
  console.log(`BOOT-WEIGHT table ${JSON.stringify(table)}`);
  for (const warm of results.filter(({ label }) => label.startsWith('warm'))) {
    assert.equal(warm.spectrum.network, 0, `${warm.label}: spectrum from the network`);
    assert.ok(warm.spectrum.opfs > 0, `${warm.label}: spectrum not seen from OPFS`);
    assert.ok(
      warm.wasm.every(({ served, worker }) => worker && served === 'opfs'),
      `${warm.label}: ${JSON.stringify(warm.wasm)}`
    );
    assert.deepEqual(
      warm.cdn.filter((url) => /slicc-spectrum|ghostty/.test(url)),
      [],
      `${warm.label}: CDN fetches`
    );
  }
});
