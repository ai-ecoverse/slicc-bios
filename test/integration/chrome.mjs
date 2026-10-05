import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { artifacts, raw, slug, source } from './artifacts.mjs';
import { connect } from './cdp.mjs';
import { serve } from './server.mjs';

const CDN = 'https://cdn.jsdelivr.net/';
const cache = new URL('../../node_modules/.cache/slicc-bios-cdn/', import.meta.url);
const profiled = new Set(['page', 'service_worker', 'shared_worker']);
const cors = [{ name: 'access-control-allow-origin', value: '*' }];
const flags = [
  '--headless',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-sandbox',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--hide-scrollbars',
  '--mute-audio',
  '--window-size=1280,800',
];

async function download(url) {
  const file = new URL(url.slice(CDN.length), cache);
  const hit = await readFile(file).catch(() => null);
  if (hit) return hit;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(file.pathname), { recursive: true });
  const partial = new URL(`${file.href}.${process.pid}`);
  await writeFile(partial, body);
  await rename(partial, file);
  return body;
}

async function start(profile) {
  const args = [...flags, `--user-data-dir=${profile}`, 'about:blank'];
  const child = spawn(chromium.executablePath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  const url = await new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.once('exit', (code) => reject(new Error(`Chromium exited with ${code}\n${log}`)));
  });
  return { child, url };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function page(cdp, sessionId, server) {
  const send = (method, params) => cdp.send(method, params, sessionId);
  const errors = [];
  const responses = [];
  const bindings = new Map();
  const dispose = cdp.on(({ method, params, sessionId: from }) => {
    if (from !== sessionId) return;
    if (method === 'Runtime.exceptionThrown') {
      const { exception, text } = params.exceptionDetails;
      errors.push(exception?.description ?? text);
    }
    if (method === 'Runtime.bindingCalled') bindings.get(params.name)?.(JSON.parse(params.payload));
    if (method === 'Network.responseReceived') responses.push(params.response);
  });

  async function evaluate(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description);
    return result.value;
  }

  return {
    errors,
    responses,
    dispose,
    evaluate,
    goto: (path) => send('Page.navigate', { url: new URL(path, server.url).href }),
    reload: () => send('Page.reload'),
    init: (fn) => send('Page.addScriptToEvaluateOnNewDocument', { source: `(${fn})()` }),
    async expose(name, handler) {
      bindings.set(name, handler);
      await send('Runtime.addBinding', { name });
    },
    async until(fn, ...args) {
      const deadline = Date.now() + 15000;
      let last;
      while (Date.now() < deadline) {
        last = await evaluate(fn, ...args).catch((error) => error.message);
        if (last === true) return;
        await sleep(25);
      }
      throw new Error(`Timed out waiting for ${fn}\nlast result: ${JSON.stringify(last)}`);
    },
    async screenshot(file) {
      await evaluate(() => {
        const finite = document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().endTime < Infinity);
        return Promise.all(finite.map((animation) => animation.finished.catch(() => {})));
      });
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(file, Buffer.from(data, 'base64'));
    },
  };
}

export async function launch() {
  const server = await serve();
  const profile = await mkdtemp(join(tmpdir(), 'slicc-bios-'));
  const { child, url } = await start(profile);
  const cdp = await connect(url);
  const sessions = new Map();
  const tabs = new Map();
  const cdn = { status: 0 };
  let run = null;

  async function checkpoint() {
    const current = [...sessions].filter(([, target]) => target.browserContextId === run?.context);
    const taken = current.map(async ([sessionId, target]) => {
      const coverage = cdp.send('Profiler.takePreciseCoverage', {}, sessionId);
      const cpu = cdp.send('Profiler.stop', {}, sessionId);
      const [{ result }, { profile }] = await Promise.all([coverage, cpu]).catch(() => [{}, {}]);
      if (!result || !run) return;
      cdp.send('Profiler.start', {}, sessionId).catch(() => {});
      run.scripts.push(...result.filter((script) => script.url.startsWith(server.url)));
      const name = target.type === 'page' ? 'page' : basename(target.url);
      const file = new URL(`${String(++run.dumps).padStart(2, '0')}-${name}.cpuprofile`, run.dir);
      await writeFile(file, JSON.stringify(profile));
    });
    await Promise.all(taken);
  }

  function attach({ sessionId, targetInfo, waitingForDebugger }) {
    const commands = [];
    if (profiled.has(targetInfo.type)) {
      sessions.set(sessionId, targetInfo);
      commands.push(
        ['Profiler.enable'],
        ['Profiler.setSamplingInterval', { interval: 100 }],
        ['Profiler.startPreciseCoverage', { callCount: true, detailed: true }],
        ['Profiler.start']
      );
    }
    if (targetInfo.type === 'page') {
      commands.push(
        ['Runtime.enable'],
        ['Network.enable'],
        ['Debugger.enable'],
        ['Page.enable'],
        [
          'Page.addScriptToEvaluateOnNewDocument',
          { source: "addEventListener('beforeunload', () => { debugger; })" },
        ]
      );
    }
    if (waitingForDebugger) commands.push(['Runtime.runIfWaitingForDebugger']);
    const ready = Promise.all(
      commands.map(([method, params]) => cdp.send(method, params, sessionId))
    );
    if (targetInfo.type === 'page') tab(targetInfo.targetId).resolve(ready.then(() => sessionId));
    return ready;
  }

  function tab(targetId) {
    if (!tabs.has(targetId)) {
      const slot = {};
      slot.session = new Promise((resolve) => {
        slot.resolve = resolve;
      });
      tabs.set(targetId, slot);
    }
    return tabs.get(targetId);
  }

  async function intercept({ requestId, request }) {
    const failure = { requestId, responseCode: cdn.status, responseHeaders: cors };
    if (cdn.status) return cdp.send('Fetch.fulfillRequest', failure);
    const body = await download(request.url).catch(() => null);
    if (!body) return cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
    return cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: cors,
      body: body.toString('base64'),
    });
  }

  cdp.on(async ({ method, params, sessionId }) => {
    if (method === 'Target.attachedToTarget') await attach(params).catch(() => {});
    if (method === 'Target.detachedFromTarget') sessions.delete(params.sessionId);
    if (method === 'Fetch.requestPaused') await intercept(params);
    if (method === 'Debugger.paused') {
      await checkpoint();
      await cdp.send('Debugger.resume', {}, sessionId).catch(() => {});
    }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${CDN}*` }] });
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  async function open(browserContextId) {
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const sessionId = await tab(targetId).session;
    tabs.delete(targetId);
    return page(cdp, sessionId, server);
  }

  async function finish(pages, browserContextId) {
    const shots = pages.map((opened, i) => opened.screenshot(new URL(`tab-${i + 1}.png`, run.dir)));
    await Promise.all(shots);
    await checkpoint();
    const entries = run.scripts.map(async (script) => {
      const file = source(script.url);
      return { ...script, url: pathToFileURL(file).href, source: await readFile(file, 'utf8') };
    });
    await mkdir(raw, { recursive: true });
    await writeFile(new URL(`${run.name}.json`, raw), JSON.stringify(await Promise.all(entries)));
    for (const opened of pages) opened.dispose();
    run = null;
    cdn.status = 0;
    await cdp.send('Target.disposeBrowserContext', { browserContextId });
  }

  return {
    cdn,
    requests: server.requests,
    async page(t) {
      const suite = slug(basename(t.filePath, '.test.mjs'));
      const dir = new URL(`${suite}/${slug(t.name)}/`, artifacts);
      await mkdir(dir, { recursive: true });
      const { browserContextId } = await cdp.send('Target.createBrowserContext');
      run = {
        dir,
        name: `${suite}-${slug(t.name)}`,
        context: browserContextId,
        scripts: [],
        dumps: 0,
      };
      server.requests.length = 0;
      const pages = [];
      t.after(() => finish(pages, browserContextId));
      const another = async () => {
        const opened = await open(browserContextId);
        pages.push(opened);
        return Object.assign(opened, { tab: another });
      };
      return another();
    },
    async close() {
      await cdp.send('Browser.close').catch(() => {});
      cdp.close();
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
      await rm(profile, { recursive: true, force: true });
      await server.close();
    },
  };
}
