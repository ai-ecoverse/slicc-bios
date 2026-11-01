import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { devtools, launch } from './chrome.mjs';
import { installWire, safeError, summarize } from './guard-diagnostic-675.test.mjs';
import { linkNode } from './linked-node.mjs';
import { realExtension, SEVEN } from './real-extension.mjs';

const SHIM_HASH = '911b9c665b7bf8183de1d4eeebb4a96d72ddcfe7b6b222316998c595b410fe53';
const OTHER_EXTENSION =
  'slicc: refused: a browser extension runs scripts in this page, and profiling it would expose them';
const HARNESS_ID = 'ankmbodmgimjemnojmeddfcdlbocolob';
const PARSING_MESSAGE =
  'WebMCP was unavailable while this page parsed; the late-install fallback cannot recover its tools.';
const moduleSource =
  'await fetch("/pending?fixture=opspile"); globalThis.registerTools(); globalThis.diagnostic675ModuleDone = true; dispatchEvent(new Event("diagnostic-675-module-ready"));';
const parsingSource =
  'globalThis.diagnostic675ParsingSawWebMCP = Boolean(document.modelContext); if (globalThis.diagnostic675ParsingSawWebMCP) globalThis.registerTools();';
const pageSource = (mode) =>
  `<!doctype html><title>fallback</title><script>globalThis.diagnostic675ParsingSawWebMCP = Boolean(document.modelContext); globalThis.diagnostic675Registrations = 0; globalThis.registerTools = function registerTools() { globalThis.diagnostic675Registrations += 1; if (!document.modelContext) { globalThis.diagnostic675RegistrationError = "modelContext absent"; return; } document.modelContext.registerTool({name:"diagnostic_echo",description:"Own diagnostic echo",inputSchema:{type:"object",properties:{value:{type:"integer"}},required:["value"]},annotations:{readOnly:true},execute:({value})=>({echo:value})}); }; ${mode === 'parsing' ? parsingSource : ''}</script>${mode === 'opspile' ? `<script type="module">${moduleSource}</script>` : ''}`;

for (const route of ['extension', 'link']) {
  test(`diagnostic 675: fallback ${route}`, { timeout: 900000 }, async (t) => {
    const trace = {
      route,
      phase: 'setup',
      steps: [],
      rawRequests: [],
      rows: [],
      scope:
        'diagnostic exact existing shim through bios and real route; no Rust client or shipped fallback implementation',
      fetchControl:
        'Own fixture fetch response is held during reload until successful plain install; proves the pending-fetch case, not a latency-independent guarantee',
      methodAssertionScope:
        'All diagnostic client, bios-boundary forwarded/owned and explicit raw observer sends; private extension/CLI internal transport is not tapped',
    };
    const root = process.env.SLICC_PROOF_TRACE_DIR;
    let page;
    let wireReady = false;
    const persist = async () => {
      if (wireReady) {
        try {
          trace.methods = await page.evaluate(() => diagnostic675.sent());
        } catch {}
      }
      if (!root) return;
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, `diagnostic-675-fallback-${route}.json`),
        JSON.stringify(trace, null, 2)
      );
    };
    t.after(persist);
    const step = async (name, operation) => {
      trace.step = name;
      const record = { name, state: 'started' };
      trace.steps.push(record);
      await persist();
      try {
        const result = await operation();
        record.state = 'completed';
        await persist();
        return result;
      } catch (error) {
        record.state = 'failed';
        trace.failure ??= { step: name, errorName: error.name, errorMessage: safeError(error) };
        await persist();
        throw error;
      }
    };
    const shim = await step('setup.pinned-shim', async () => {
      const source = await readFile(
        new URL('./fixtures/diagnostic-675-webmcp-shim.js', import.meta.url),
        'utf8'
      );
      const hash = createHash('sha256').update(source).digest('hex');
      trace.shimHash = hash;
      assert.equal(hash, SHIM_HASH);
      return source;
    });
    const gate = { hold: false, requests: 0, responses: [], waiters: new Set() };
    const releaseFetch = () => {
      gate.hold = false;
      for (const response of gate.responses.splice(0))
        if (!response.destroyed)
          response
            .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            .end('{}');
    };
    const site = createServer((request, response) => {
      const url = new URL(request.url, 'http://fixture');
      if (url.pathname === '/pending') {
        gate.requests += 1;
        for (const waiter of gate.waiters) waiter();
        if (gate.hold) {
          gate.responses.push(response);
          return;
        }
        response
          .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      response.end(pageSource(url.pathname === '/parsing' ? 'parsing' : 'opspile'));
    });
    await step(
      'setup.fixture-listen',
      () => new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
    );
    t.after(() => {
      releaseFetch();
      site.closeAllConnections();
      site.close();
    });
    const fixtureOrigin = `http://localhost:${site.address().port}`;
    const waitFetch = () =>
      new Promise((resolve) => {
        if (gate.requests > 0) return resolve({ requested: true });
        const listener = () => {
          clearTimeout(timer);
          gate.waiters.delete(listener);
          resolve({ requested: true });
        };
        const timer = setTimeout(() => {
          gate.waiters.delete(listener);
          resolve({ deadline: true });
        }, 5000);
        gate.waiters.add(listener);
      });
    const chrome = await step('setup.launch', () =>
      route === 'extension' ? realExtension() : launch({ tools: false })
    );
    t.after(() => chrome.close());
    trace.harnessExtension = chrome.extension?.id;
    await step('setup.harness-extension-on', () =>
      assert.equal(trace.harnessExtension, HARNESS_ID)
    );
    page = await step('setup.page', () => chrome.page(t));
    await page.init(() => {
      globalThis.sliccKernelDebug = true;
    });
    if (route === 'extension') {
      await step('setup.seven-navigation', () => page.goto(SEVEN));
      await step('setup.seven-ready', () => ready(page, undefined, { tools: false }));
      await step('setup.extension-only', async () =>
        assert.equal(await page.evaluate(() => globalThis.sliccLinkedBrowsers().length), 0)
      );
      await step('setup.wire', () => page.evaluate(installWire, { route }));
    } else {
      await step('setup.boot', () => boot(page, undefined, { tools: false }));
      await step('setup.no-slicc-extension', async () =>
        assert.equal(await page.evaluate(() => typeof globalThis.sliccExtension), 'undefined')
      );
      const runtimes = await step('setup.link', async () =>
        linkNode(t, page, (await devtools(chrome)).port, 'diagnostic-675-fallback')
      );
      await step('setup.link-runtime', () => assert.ok(runtimes.length > 0));
      await step('setup.wire', () => page.evaluate(installWire, { route, runtime: runtimes[0] }));
    }
    wireReady = true;
    const raw = chrome.cdp;
    const rawCall = async (method, params = {}, sessionId) => {
      trace.rawRequests.push({
        method,
        session: sessionId,
        label: trace.phase,
        boundary: 'diagnostic raw observer -> Chrome, no guard',
      });
      const start = Date.now();
      let timer;
      const result = await Promise.race([
        raw.send(method, params, sessionId).then(
          (result) => ({ result, elapsedMs: Date.now() - start }),
          (error) => ({
            error: true,
            errorName: error.name,
            errorMessage: safeError(error),
            elapsedMs: Date.now() - start,
          })
        ),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ deadline: true, elapsedMs: Date.now() - start }),
            5000
          );
        }),
      ]);
      clearTimeout(timer);
      return result;
    };
    trace.browser = (await rawCall('Browser.getVersion')).result?.product;
    const rawEvents = [];
    const rawWaiters = new Set();
    const stop = raw.on((event) => {
      if (
        !['Page.frameNavigated', 'Page.loadEventFired', 'Runtime.executionContextCreated'].includes(
          event.method
        )
      )
        return;
      rawEvents.push({
        method: event.method,
        session: event.sessionId,
        frame:
          event.method === 'Page.frameNavigated'
            ? { url: event.params.frame?.url, loaderId: event.params.frame?.loaderId }
            : undefined,
        context:
          event.method === 'Runtime.executionContextCreated'
            ? {
                origin: event.params.context?.origin,
                name: event.params.context?.name,
                isDefault: event.params.context?.auxData?.isDefault,
              }
            : undefined,
      });
      for (const waiter of rawWaiters) waiter();
    });
    t.after(stop);
    const rawWait = (method, session, after) =>
      new Promise((resolve) => {
        const find = () =>
          rawEvents
            .slice(after)
            .find((event) => event.method === method && event.session === session);
        if (find()) return resolve(find());
        const listener = () => {
          const found = find();
          if (!found) return;
          clearTimeout(timer);
          rawWaiters.delete(listener);
          resolve(found);
        };
        const timer = setTimeout(() => {
          rawWaiters.delete(listener);
          resolve({ deadline: true });
        }, 10000);
        rawWaiters.add(listener);
      });
    const guarded = (method, params = {}, session) =>
      page.evaluate(({ method, params, session }) => diagnostic675.send(method, params, session), {
        method,
        params,
        session,
      });
    const below = (method, params = {}, session) =>
      page.evaluate(
        ({ method, params, session }) => diagnostic675.transport(method, params, session),
        { method, params, session }
      );
    const requireGuarded = async (method, params, session) => {
      const reply = await guarded(method, params, session);
      trace.lastGuardedReply = { method, ...summarize(reply) };
      await persist();
      assert.ok(!reply.deadline && !reply.error, `${method} completed through bios and route`);
      return reply.result;
    };
    const evaluate = async (expression, session) => {
      const reply = await requireGuarded(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        session
      );
      if (reply.exceptionDetails) {
        trace.lastEvaluationException = {
          message: safeError({
            message: reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text,
          }),
        };
        await persist();
      }
      assert.ok(!reply.exceptionDetails, 'main-world evaluation had no exception');
      return reply.result?.value;
    };
    const install = async (session) =>
      evaluate(
        `(() => { const bridge = ${shim}\n return { installed: document.modelContext?.__slicc_webmcp_shim === true, mainWorld: typeof globalThis.registerTools === 'function', parsingSawWebMCP: globalThis.diagnostic675ParsingSawWebMCP }; })()`,
        session
      );
    const list = async (session) =>
      evaluate(
        '(async () => (await document.modelContext.getTools()).map(tool => ({name:tool.name,description:tool.description,inputSchema:tool.inputSchema,origin:tool.origin})))()',
        session
      );
    const call = async (session) =>
      evaluate(
        '(async () => document.modelContext.executeTool("diagnostic_echo", {value:7}))()',
        session
      );
    const rows = [];
    for (const mode of ['opspile', 'parsing']) {
      trace.phase = 'setup-' + mode;
      await page.evaluate((label) => diagnostic675.reset(label, false), trace.phase);
      const row = {
        mode,
        phase: 'setup',
        paths: {
          probe: route + ' guard below bios, no Rust',
          reloadInstallListCall: 'bios + ' + route + ' guard, no Rust',
          observer: 'raw diagnostics only',
        },
      };
      trace.rows.push(row);
      rows.push(row);
      let targetId;
      try {
        const created = await step(mode + '.setup.raw-target', () =>
          rawCall('Target.createTarget', { url: 'about:blank' })
        );
        targetId = created.result?.targetId;
        assert.ok(targetId);
        t.after(() => rawCall('Target.closeTarget', { targetId }).catch(() => {}));
        const attached = await step(mode + '.setup.raw-attachment', () =>
          rawCall('Target.attachToTarget', { targetId, flatten: true })
        );
        const observer = attached.result?.sessionId;
        assert.ok(observer);
        await rawCall('Page.enable', {}, observer);
        await rawCall('Runtime.enable', {}, observer);
        const after = rawEvents.length;
        const url = fixtureOrigin + '/' + mode;
        const navigation = await step(mode + '.setup.ordinary-navigation', () =>
          rawCall('Page.navigate', { url }, observer)
        );
        assert.ok(!navigation.deadline && !navigation.error);
        await step(mode + '.setup.ordinary-load', async () =>
          assert.equal((await rawWait('Page.loadEventFired', observer, after)).deadline, undefined)
        );
        row.extensionWorlds = rawEvents
          .filter((event) => event.session === observer && event.context?.isDefault === false)
          .map((event) => event.context);
        const tree = await rawCall('Page.getFrameTree', {}, observer);
        assert.equal(tree.result?.frameTree?.frame?.url, url);
        const targets = await step(mode + '.setup.discovery', () => guarded('Target.getTargets'));
        row.discovery = summarize(targets);
        const found = targets.result?.targetInfos.find((target) => target.url === url);
        assert.ok(found);
        const routeAttached = await step(mode + '.setup.route-attachment', () =>
          guarded('Target.attachToTarget', { targetId: found.targetId, flatten: true })
        );
        row.attachment = summarize(routeAttached);
        const session = routeAttached.result?.sessionId;
        assert.ok(session);
        await page.evaluate((session) => diagnostic675.setSession(session), session);
        for (const method of ['Page.enable', 'Runtime.enable'])
          await requireGuarded(method, {}, session);
        const native = await step(mode + '.setup.main-world-and-foreign-script', () =>
          evaluate(
            '({native:"modelContext" in Document.prototype,nativeNavigator:"modelContext" in navigator,secure:isSecureContext,foreignContent:document.documentElement.dataset.sliccHarnessExtension,parsingSawWebMCP:globalThis.diagnostic675ParsingSawWebMCP})',
            session
          )
        );
        row.preflightDocument = native;
        assert.equal(native.native, false);
        assert.equal(native.nativeNavigator, false);
        assert.equal(native.secure, true);
        assert.equal(native.foreignContent, HARNESS_ID);
        trace.phase = 'probe-' + mode;
        await page.evaluate((label) => diagnostic675.reset(label, false), trace.phase);
        const debug = await step(mode + '.probe.Debugger.enable', () =>
          below('Debugger.enable', {}, session)
        );
        row.debuggerProbe = summarize(debug);
        await persist();
        if (route === 'extension') {
          assert.ok(debug.error && !debug.deadline);
          assert.equal(debug.refusalConstant, OTHER_EXTENSION);
        } else assert.equal(debug.deadline, undefined);
        if (!debug.error && !debug.deadline) {
          const disabled = await step(mode + '.probe.Debugger.disable', () =>
            below('Debugger.disable', {}, session)
          );
          row.debuggerDisableBeforeFallback = summarize(disabled);
          assert.ok(!disabled.error && !disabled.deadline);
          row.fallbackSelection =
            'forced diagnostic plain path; CLI accepted probe, Rust refusal is not traversed or claimed';
        } else
          row.fallbackSelection = 'plain path after observed downstream refusal; no guard change';
        trace.phase = 'fallback-' + mode;
        row.phase = 'fallback';
        await page.evaluate((label) => diagnostic675.reset(label, false), trace.phase);
        const sentBefore = (await page.evaluate(() => diagnostic675.sent())).length;
        const rawBefore = trace.rawRequests.length;
        const reloadAfter = rawEvents.length;
        gate.requests = 0;
        gate.hold = mode === 'opspile';
        const reloaded = await step(mode + '.fallback.reload', () =>
          requireGuarded('Page.reload', { ignoreCache: true }, session)
        );
        row.reloadCompleted = Boolean(reloaded);
        await step(mode + '.fallback.new-document', async () =>
          assert.equal(
            (await rawWait('Page.frameNavigated', observer, reloadAfter)).deadline,
            undefined
          )
        );
        if (mode === 'opspile')
          await step(mode + '.fallback.await-fetch', async () =>
            assert.equal((await waitFetch()).requested, true)
          );
        else
          await step(mode + '.fallback.parsing-complete', async () =>
            assert.equal(
              (await rawWait('Page.loadEventFired', observer, reloadAfter)).deadline,
              undefined
            )
          );
        const installStart = Date.now();
        row.install = await step(mode + '.fallback.plain-main-world-install', () =>
          install(session)
        );
        row.installMs = Date.now() - installStart;
        assert.equal(row.install.installed, true);
        assert.equal(row.install.mainWorld, true);
        if (mode === 'opspile') {
          row.pendingFetchAtInstall = gate.responses.some((response) => !response.destroyed);
          assert.equal(row.pendingFetchAtInstall, true);
          releaseFetch();
          row.fetchReleasedAfterInstall = true;
          await step(mode + '.fallback.module-complete', async () =>
            assert.equal(
              (await rawWait('Page.loadEventFired', observer, reloadAfter)).deadline,
              undefined
            )
          );
        }
        const status =
          '({calls:globalThis.diagnostic675Registrations,error:globalThis.diagnostic675RegistrationError ?? null,done:globalThis.diagnostic675ModuleDone ?? false,parsingSawWebMCP:globalThis.diagnostic675ParsingSawWebMCP})';
        const statusExpression =
          mode === 'opspile'
            ? `new Promise(resolve => { const done = () => resolve(${status}); if (globalThis.diagnostic675ModuleDone) done(); else addEventListener("diagnostic-675-module-ready",done,{once:true}); })`
            : status;
        row.registration = await step(mode + '.fallback.registration-status', () =>
          evaluate(statusExpression, session)
        );
        const listStart = Date.now();
        row.tools = await step(mode + '.fallback.list-tools', () => list(session));
        row.listMs = Date.now() - listStart;
        if (mode === 'opspile') {
          assert.equal(row.registration.calls, 1);
          assert.equal(row.registration.error, null);
          assert.equal(row.registration.done, true);
          assert.deepEqual(
            row.tools.map((tool) => tool.name),
            ['diagnostic_echo']
          );
          const callStart = Date.now();
          row.callResult = await step(mode + '.fallback.call-tool', () => call(session));
          row.callMs = Date.now() - callStart;
          assert.deepEqual(JSON.parse(row.callResult), { echo: 7 });
        } else {
          row.clearMessage = PARSING_MESSAGE;
          row.toolsOutOfReach =
            row.tools.length === 0 &&
            row.registration.calls === 0 &&
            row.registration.parsingSawWebMCP === false;
          assert.equal(row.toolsOutOfReach, true);
        }
        row.methods = await page.evaluate((after) => diagnostic675.sent(after), sentBefore);
        row.rawMethods = trace.rawRequests.slice(rawBefore);
        row.debuggerMethodsInFallback = [...row.methods, ...row.rawMethods]
          .filter((request) => request.method?.startsWith('Debugger.'))
          .map((request) => request.method);
        row.ownedReads = await page.evaluate(() => diagnostic675.snapshot());
        assert.deepEqual(row.debuggerMethodsInFallback, []);
        row.phase = 'complete';
        row.passed = true;
        await persist();
      } catch (error) {
        trace.failure ??= {
          step: trace.step,
          errorName: error.name,
          errorMessage: safeError(error),
        };
        row.failure = trace.failure;
        row.phase = row.phase === 'setup' ? 'setup-failed' : 'proof-failed';
        await persist();
        throw error;
      } finally {
        trace.phase = 'cleanup-' + mode;
        releaseFetch();
        await page
          .evaluate((label) => diagnostic675.reset(label, false), trace.phase)
          .catch(() => {});
        if (targetId) await rawCall('Target.closeTarget', { targetId });
        await persist();
      }
    }
    trace.methods = await page.evaluate(() => diagnostic675.sent());
    trace.phase = 'complete';
    trace.passed = rows.every((row) => row.passed);
    await persist();
    assert.equal(trace.passed, true);
  });
}
