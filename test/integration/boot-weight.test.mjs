import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const RUNS = Number(env.BOOT_RUNS ?? 3);
const PROFILED = Number(env.BOOT_PROFILED_RUNS ?? 1);
const BOUND = 25 * 60 * 1000;
const MARKERS = [
  '/var/lib/slicc/pnpm-lock.yaml',
  '/node_modules/.modules.yaml',
  '/var/lib/slicc/agent/pnpm-lock.yaml',
  '/opt/agent/node_modules/.modules.yaml',
];
const plain = await launch({ timeout: 120000, agent: true });
const profiled =
  PROFILED > 0 ? await launch({ timeout: 120000, agent: true, profile: true }) : null;
after(() => Promise.all([plain.close(), profiled?.close()]));

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

function tracer() {
  performance.setResourceTimingBufferSize(20000);
  globalThis.sliccKernelDebug = true;
  const events = [];
  window.sliccBootTrace = events;
  const note = (kind, detail) => events.push({ t: Date.now(), kind, ...detail });
  note('document', { path: location.pathname });
  const request = LockManager.prototype.request;
  LockManager.prototype.request = function (name, ...rest) {
    const callback = rest.pop();
    const options = rest[0] ?? {};
    const asked = Date.now();
    if (options.ifAvailable || options.steal)
      note('lock-ask', { name, options: Object.keys(options) });
    return request.call(this, name, ...rest, async (lock) => {
      note('lock', { name, waited: Date.now() - asked, got: Boolean(lock) });
      try {
        return await callback(lock);
      } finally {
        note('unlock', { name, held: Date.now() - asked });
      }
    });
  };
  for (const Kind of ['Worker', 'SharedWorker']) {
    const Original = globalThis[Kind];
    globalThis[Kind] = class extends Original {
      constructor(url, options) {
        super(url, options);
        note('worker', { kind: Kind, url: String(url).slice(-80), name: options?.name ?? null });
      }
    };
  }
  let text = '';
  let rows = '';
  let tabs = '';
  let client = null;
  let seen = new Map();
  let polling = false;
  const last = (app, prefix) =>
    app.dock?.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith(prefix));
  const ps = async () => {
    if (polling || !client) return;
    polling = true;
    try {
      const now = new Map((await client.ps()).map((entry) => [entry.pid, entry]));
      for (const [pid, entry] of now)
        if (!seen.has(pid))
          note('spawn', {
            pid,
            ppid: entry.ppid,
            argv: entry.argv.join(' ').slice(0, 160),
            started: entry.started,
          });
      for (const [pid, entry] of seen)
        if (!now.has(pid)) note('exit', { pid, argv: entry.argv.join(' ').slice(0, 80) });
      seen = now;
    } catch (error) {
      note('ps-failed', { error: error.message });
    } finally {
      polling = false;
    }
  };
  const tick = () => {
    const app = document.querySelector('slicc-app');
    if (app?.dock && location.pathname === '/os/') {
      const id = last(app, 'terminal:');
      const now = id ? (app.dock.content(id)?.screen?.textContent ?? '').trim().slice(-160) : '';
      if (now !== text) note('screen', { text: now });
      text = now;
      const listed = (app.model?.updates?.list?.() ?? [])
        .map((row) => `${row.id}:${row.state}`)
        .join(' ');
      if (listed !== rows) note('rows', { rows: listed });
      rows = listed;
      const state = JSON.stringify(app.model?.tabs?.state?.() ?? null);
      if (state !== tabs) note('tabs', { state });
      tabs = state;
    }
    if (!client && typeof globalThis.sliccKernelClient === 'function') {
      note('kernel', {});
      client = 'pending';
      globalThis.sliccKernelClient().then(
        (attached) => {
          client = attached;
          note('client', {});
        },
        (error) => note('client-failed', { error: error.message })
      );
    }
    if (client && client !== 'pending') void ps();
    if (events.length < 5000 && !window.sliccBootMarks?.chat) setTimeout(tick, 100);
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

async function idle(page) {
  await page.within(BOUND, () => {
    const rows = document.querySelector('slicc-app')?.model?.updates?.list?.() ?? [];
    return (
      rows.length > 0 &&
      rows.every((row) => !/queued|starting|checking|downloading|linking/.test(row.state))
    );
  });
}

async function timing(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]?.toJSON() ?? null;
    const resources = performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name.replace(location.origin, ''),
      start: Math.round(entry.startTime),
      worker: Math.round(entry.workerStart),
      fetch: Math.round(entry.fetchStart),
      response: Math.round(entry.responseStart),
      end: Math.round(entry.responseEnd),
      body: entry.decodedBodySize,
    }));
    return { origin: performance.timeOrigin, nav, resources };
  });
}

function markers(page) {
  return page.evaluate(async (paths) => {
    const out = {};
    for (const path of paths) {
      const names = path.split('/').filter(Boolean);
      const name = names.pop();
      try {
        let dir = await navigator.storage.getDirectory();
        for (const part of names) dir = await dir.getDirectoryHandle(part);
        out[path] = (await (await dir.getFileHandle(name)).getFile()).lastModified;
      } catch {
        out[path] = 0;
      }
    }
    return out;
  }, MARKERS);
}

function touch(page, path) {
  return page.evaluate(async (path) => {
    const names = path.split('/').filter(Boolean);
    const name = names.pop();
    let dir = await navigator.storage.getDirectory();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(name);
    const bytes = await (await handle.getFile()).arrayBuffer();
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return bytes.byteLength;
  }, path);
}

function changed(before, after) {
  return MARKERS.filter((path) => before?.[path] !== after?.[path]);
}

function phases(result, trace, timed) {
  const { start } = result;
  const at = (pred) => {
    const found = trace.find(pred);
    return found ? found.t - start : null;
  };
  const nav = timed.nav ?? {};
  const navStart = Math.round(timed.origin - start);
  const ui = result.ui - navStart;
  const served = timed.resources.filter(({ worker }) => worker > 0);
  const early = served.filter(({ end }) => end <= ui);
  const waits = served.map(({ fetch, response }) => response - fetch);
  const earlyWaits = early.map(({ fetch, response }) => response - fetch);
  return {
    label: result.label,
    navStart,
    nav: {
      workerStart: Math.round(nav.workerStart ?? 0),
      fetchStart: Math.round(nav.fetchStart ?? 0),
      responseStart: Math.round(nav.responseStart ?? 0),
      responseEnd: Math.round(nav.responseEnd ?? 0),
      domInteractive: Math.round(nav.domInteractive ?? 0),
      loaded: Math.round(nav.domContentLoadedEventEnd ?? 0),
    },
    document: at((e) => e.kind === 'document'),
    ui: result.ui,
    agentLock: at((e) => e.kind === 'lock' && e.name === 'slicc-agent'),
    kernelWorker: at((e) => e.kind === 'Worker' && /kernel-worker/.test(e.url)),
    client: at((e) => e.kind === 'client'),
    terminal: result.terminal,
    agentWorker: at((e) => e.kind === 'Worker' && /agent-worker/.test(e.url)),
    chat: result.chat,
    served: {
      count: served.length,
      waitMs: waits.reduce((sum, wait) => sum + wait, 0),
      beforeUi: early.length,
      beforeUiWaitMs: earlyWaits.reduce((sum, wait) => sum + wait, 0),
      beforeUiMaxMs: Math.max(0, ...earlyWaits),
      slowest: [...served]
        .sort((a, b) => b.response - b.fetch - (a.response - a.fetch))
        .slice(0, 6)
        .map(({ name, fetch, response }) => `${response - fetch} ${name.slice(-60)}`),
    },
  };
}

const steps = [
  { name: 'first' },
  { name: 'steady' },
  { name: 'touched', before: (page) => touch(page, MARKERS[0]) },
  { name: 'steady-again' },
];

async function series(chrome, tag, runs, t, results) {
  const watched = traffic(chrome.cdp);

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
      start,
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
    const { server: _s, cdn: _c, biggest: _b, hosts: _h, wasm: _w, ...short } = result;
    console.log(`BOOT-WEIGHT ${JSON.stringify(short)}`);
    await writeFile(
      new URL(`${label.replace(/\W+/g, '-')}.json`, page.dir),
      JSON.stringify({ result, list }, null, 2)
    );
    return result;
  }

  for (let run = 1; run <= runs; run++) {
    await t.test(`${tag} run ${run}`, async (s) => {
      const page = await chrome.page(s);
      await page.init(milestones);
      await page.init(tracer);
      results.push(await measure(page, `${tag} cold ${run}`, () => page.goto('/')));
      let settled = await markers(page);
      for (const [index, step] of steps.entries()) {
        await idle(page);
        const touched = step.before ? await step.before(page) : null;
        const before = await markers(page);
        const label = `${tag} warm ${run}.${index + 1} ${step.name}`;
        const result = await measure(page, label, () => page.reload());
        results.push(result);
        const trace = await page.evaluate(() => window.sliccBootTrace);
        const timed = await timing(page);
        const file = label.replace(/\W+/g, '-');
        await writeFile(new URL(`${file}-trace.json`, page.dir), JSON.stringify(trace, null, 2));
        await writeFile(new URL(`${file}-timing.json`, page.dir), JSON.stringify(timed, null, 2));
        const summary = {
          ...phases(result, trace, timed),
          touched,
          markersChanged: changed(settled, before),
        };
        result.phases = summary;
        console.log(`BOOT-PHASES ${JSON.stringify(summary)}`);
        settled = await markers(page);
      }
      assert.deepEqual(page.errors, []);
    });
  }
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test(`boot weight: why the first reload after a cold install is slower than a steady one`, {
  timeout: (RUNS + PROFILED) * 2 * BOUND,
}, async (t) => {
  console.log(
    `BOOT-WEIGHT host ${JSON.stringify({ runner: env.RUNNER_NAME ?? null, os: env.ImageOS ?? null, cpus: cpus().length, cpu: cpus()[0]?.model, memory: totalmem() })}`
  );
  const results = [];
  await series(plain, 'plain', RUNS, t, results);
  if (profiled) await series(profiled, 'profiled', PROFILED, t, results);
  const table = {};
  for (const tag of ['plain', 'profiled']) {
    for (const kind of ['cold', ...steps.map(({ name }) => name)]) {
      const picked = results
        .filter(
          ({ label }) =>
            label.startsWith(`${tag} `) && (label.includes(' cold ') || label.endsWith(` ${kind}`))
        )
        .filter(({ label }) => (kind === 'cold') === label.includes(' cold '));
      if (!picked.length) continue;
      for (const field of ['ui', 'terminal', 'chat']) {
        const values = picked.map((result) => result[field]);
        table[`${tag} ${kind} ${field}`] = { median: median(values), values };
      }
      const navs = picked.filter(({ phases }) => phases).map(({ phases }) => phases.navStart);
      if (navs.length) table[`${tag} ${kind} navStart`] = { median: median(navs), values: navs };
    }
  }
  console.log(`BOOT-WEIGHT table ${JSON.stringify(table)}`);
  for (const warm of results.filter(({ label }) => label.includes(' warm '))) {
    assert.equal(warm.spectrum.network, 0, `${warm.label}: spectrum from the network`);
  }
});
