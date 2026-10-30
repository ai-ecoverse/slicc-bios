import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { join } from 'node:path';
import { test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { devtools, launch } from './chrome.mjs';
import { linkNode } from './linked-node.mjs';
import { certificate, realExtension, SEVEN } from './real-extension.mjs';

async function installWire({ route, runtime }) {
  const module = await import(new URL('guard.js', location.href).href);
  const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const entry =
    route === 'link'
      ? globalThis.sliccLinkedBrowsers().find((entry) => entry.runtime === runtime)
      : undefined;
  const raw =
    route === 'extension'
      ? extensionConnection(globalThis.sliccExtension.cdp)
      : await entry?.open();
  if (!raw) throw new Error('diagnostic transport unavailable');
  const constants = new Set(
    Object.values(module).filter(
      (value) => typeof value === 'string' && value.startsWith('slicc: refused:')
    )
  );
  for (const value of [
    'slicc: refused: navigation not settled, retry',
    "slicc: refused: target is on seven's origin",
    'slicc: refused: that execution context belongs to a browser extension',
    'slicc: refused: that execution context is not exposed',
    "slicc: refused: slicc can't keep seven's origin out of this target",
  ])
    constants.add(value);
  const constant = (message) => {
    const text = typeof message?.error === 'string' ? message.error : message?.error?.message;
    if (!text) return null;
    return (
      [...constants].find((value) => text === value || text.startsWith(value + ':')) ??
      'unmapped fixed error'
    );
  };
  let active;
  let sequence = 0;
  let below = 2 ** 29;
  const pendingBelow = new Map();
  const inFlightBelow = new Map();
  const issuedBelow = new Set();
  const owned = new Map();
  const events = [];
  const waiters = new Set();
  const readMethods = new Set([
    'Page.getFrameTree',
    'Page.getResourceTree',
    'Page.getNavigationHistory',
    'Target.getTargetInfo',
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'DOM.getDocument',
    'DOM.getFrameOwner',
  ]);
  let report = { label: 'setup', fault: false, sent: 0, completed: 0, held: 0, reads: [] };
  const wire = {
    onmessage: null,
    onclose: null,
    send(text) {
      const message = JSON.parse(text);
      if (message.id >= 2 ** 30 && readMethods.has(message.method)) {
        const record = {
          method: message.method,
          session: message.sessionId,
          started: performance.now(),
          state: 'pending',
          label: report.label,
        };
        owned.set(message.id, record);
        report.reads.push(record);
        if (message.method === 'Page.getFrameTree') report.sent += 1;
      }
      raw.send(text);
    },
    close: () => raw.close(),
  };
  const note = (message) => {
    const p = message.params ?? {};
    const event = { sequence: ++sequence, method: message.method, session: message.sessionId };
    if (message.method === 'Page.frameNavigated') {
      const f = p.frame;
      event.frame = {
        id: f.id,
        loaderId: f.loaderId,
        url: f.url,
        origin: f.securityOrigin,
        parentId: f.parentId,
        unreachable: Boolean(f.unreachableUrl),
      };
    } else if (message.method === 'Runtime.executionContextCreated') {
      const c = p.context;
      event.context = {
        id: c.id,
        uniqueId: c.uniqueId,
        origin: c.origin,
        frameId: c.auxData?.frameId,
        isDefault: c.auxData?.isDefault,
      };
    } else if (message.method === 'Target.targetInfoChanged') {
      const i = p.targetInfo;
      event.target = { id: i.targetId, url: i.url, type: i.type };
    } else if (message.method === 'Network.responseReceived' && p.type === 'Document') {
      event.response = {
        frameId: p.frameId,
        loaderId: p.loaderId,
        url: p.response.url,
        status: p.response.status,
      };
    } else if (message.method === 'Debugger.scriptParsed') {
      event.script = { id: p.scriptId, contextId: p.executionContextId, url: p.url };
    } else if (message.method === 'Debugger.paused') {
      event.reason = p.reason;
      event.frames = (p.callFrames ?? []).map((f) => ({
        id: f.callFrameId,
        scriptId: f.location?.scriptId,
        url: f.url,
      }));
      event.before = events.slice();
    }
    events.push(event);
    if (events.length > 2048) events.shift();
    for (const waiter of waiters) waiter(event);
  };
  raw.onmessage = (text) => {
    const message = JSON.parse(text);
    if (issuedBelow.has(message.id)) {
      inFlightBelow.delete(message.id);
      pendingBelow.get(message.id)?.(message);
      pendingBelow.delete(message.id);
      return;
    }
    const record = owned.get(message.id);
    if (record) {
      owned.delete(message.id);
      record.elapsedMs = Math.round(performance.now() - record.started);
      record.refusalConstant = constant(message);
      if (report.fault && record.method === 'Page.getFrameTree') {
        record.state = 'held-real-reply';
        report.held += 1;
        return;
      }
      record.state = message.error ? 'error' : 'completed';
      if (record.method === 'Page.getFrameTree' && !message.error) report.completed += 1;
    }
    if (message.method) note(message);
    wire.onmessage?.(text);
  };
  raw.onclose = (why) => wire.onclose?.(why);
  const connection = module.guardProtected(wire, self.origin);
  let next = 0;
  const pending = new Map();
  const published = [];
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.method === 'Debugger.paused')
      published.push({ session: message.sessionId, reason: message.params?.reason });
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const transport = (method, params = {}, sessionId, bound = 3000) =>
    new Promise((resolve) => {
      const id = ++below;
      issuedBelow.add(id);
      inFlightBelow.set(id, { method, sessionId });
      const started = performance.now();
      const finish = (message) =>
        resolve({
          ...message,
          elapsedMs: Math.round(performance.now() - started),
          refusalConstant: constant(message),
        });
      const timer = setTimeout(() => {
        pendingBelow.delete(id);
        finish({ deadline: true });
      }, bound);
      pendingBelow.set(id, (message) => {
        clearTimeout(timer);
        finish(message);
      });
      raw.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const snapshot = () => ({
    label: report.label,
    fault: report.fault,
    sent: report.sent,
    completed: report.completed,
    held: report.held,
    reads: report.reads.map(({ started, ...read }) => ({
      ...read,
      elapsedMs: read.elapsedMs ?? Math.round(performance.now() - started),
      state: read.state === 'pending' ? 'pending-at-verdict' : read.state,
    })),
  });
  globalThis.diagnostic675 = {
    transport,
    snapshot,
    constant,
    published: () => published.slice(),
    pendingTransport: () =>
      [...inFlightBelow.values()]
        .filter((request) => request.sessionId === active)
        .map((request) => request.method),
    setSession(session) {
      active = session;
    },
    close: () => connection.close(),
    reset(label, fault = false) {
      report = { label, fault, sent: 0, completed: 0, held: 0, reads: [] };
    },
    wait(method, after = 0, bound = 10000) {
      return new Promise((resolve) => {
        const found = events.find(
          (e) => e.sequence > after && e.method === method && (!e.session || e.session === active)
        );
        if (found) return resolve(found);
        const listener = (e) => {
          if (e.sequence <= after || e.method !== method || (e.session && e.session !== active))
            return;
          clearTimeout(timer);
          waiters.delete(listener);
          resolve(e);
        };
        const timer = setTimeout(() => {
          waiters.delete(listener);
          resolve({ deadline: true });
        }, bound);
        waiters.add(listener);
      });
    },
    sequence: () => sequence,
    send(method, params = {}, sessionId) {
      return new Promise((resolve) => {
        const id = ++next;
        const started = performance.now();
        const finish = (answer) =>
          resolve({
            ...answer,
            elapsedMs: Math.round(performance.now() - started),
            refusalConstant: constant(answer),
          });
        const timer = setTimeout(() => {
          pending.delete(id);
          finish({ deadline: true });
        }, 14000);
        pending.set(id, (answer) => {
          clearTimeout(timer);
          finish(answer);
        });
        connection.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      });
    },
    correlate(pause, expected) {
      const first = pause.frames?.[0];
      let contextId;
      let encoding = 'opaque';
      try {
        const decoded = JSON.parse(first?.id);
        if (Number.isSafeInteger(decoded.injectedScriptId)) {
          contextId = decoded.injectedScriptId;
          encoding = 'legacy injectedScriptId';
        }
      } catch {}
      const dotted = /^-?\d+\.(-?\d+)\.-?\d+$/.exec(first?.id ?? '');
      if (dotted) {
        contextId = Number(dotted[1]);
        encoding = 'dotted context component';
      }
      const before = pause.before ?? [];
      const script = before.findLast(
        (e) => e.session === active && e.script?.id === first?.scriptId
      );
      const context = before.findLast((e) => e.session === active && e.context?.id === contextId);
      const supplementalContext = before.findLast(
        (e) => e.session === active && e.context?.id === script?.script?.contextId
      );
      const check = (c) => {
        const frame = before.findLast(
          (e) => e.session === active && e.frame?.id === c?.context?.frameId
        );
        const target = before.findLast((e) => e.target?.url === expected);
        const response = before.findLast(
          (e) =>
            e.session === active &&
            e.response?.frameId === frame?.frame?.id &&
            e.response.loaderId === frame?.frame?.loaderId
        );
        const fields = {
          pauseSequence: pause.sequence,
          scriptId: first?.scriptId,
          contextEncoding: encoding,
          contextId: c?.context?.id,
          contextUniqueId: c?.context?.uniqueId,
          contextSequence: c?.sequence,
          frameId: frame?.frame?.id,
          loaderId: frame?.frame?.loaderId,
          frameSequence: frame?.sequence,
          targetSequence: target?.sequence,
          responseSequence: response?.sequence,
          contextOrigin: c?.context?.origin,
          frameOrigin: frame?.frame?.origin,
          frameUrl: frame?.frame?.url,
          responseUrl: response?.response?.url,
        };
        const yes = Boolean(
          first &&
            c &&
            frame &&
            target &&
            response &&
            c.context.isDefault === true &&
            c.context.uniqueId &&
            frame.frame.loaderId &&
            !frame.frame.parentId &&
            !frame.frame.unreachable &&
            frame.frame.url === expected &&
            response.response.url === expected &&
            response.response.status >= 200 &&
            response.response.status < 300 &&
            c.context.origin === new URL(expected).origin &&
            frame.frame.origin === c.context.origin &&
            frame.sequence < c.sequence &&
            c.sequence < pause.sequence &&
            target.sequence < pause.sequence &&
            response.sequence < pause.sequence
        );
        return { yes, fields };
      };
      return {
        fourEvents: check(context),
        withScriptParsed: check(supplementalContext),
        observedBeforePause: before
          .filter(
            (e) =>
              [
                'Page.frameNavigated',
                'Runtime.executionContextCreated',
                'Target.targetInfoChanged',
                'Network.responseReceived',
                'Debugger.scriptParsed',
              ].includes(e.method) &&
              (!e.session || e.session === active)
          )
          .slice(-32),
      };
    },
  };
}

const summarize = (reply) => ({
  elapsedMs: reply.elapsedMs,
  deadline: Boolean(reply.deadline),
  refused: Boolean(reply.error),
  refusalConstant: reply.refusalConstant,
  safe: Boolean(reply.result),
});

for (const route of ['extension', 'link']) {
  test(`diagnostic 675: ${route}`, { timeout: 900000 }, async (t) => {
    const trace = {
      route,
      phase: 'setup',
      step: 'start',
      rows: [],
      controls: [],
      steps: [],
      topology: {
        arming: 'route transport below bios',
        rawDebuggerOwned: false,
        rawInstrumentationArmed: false,
      },
    };
    const root = process.env.SLICC_PROOF_TRACE_DIR;
    const persist = async () => {
      if (!root) return;
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `diagnostic-675-${route}.json`), JSON.stringify(trace, null, 2));
    };
    const step = async (name, operation) => {
      trace.step = name;
      const record = { name, state: 'started' };
      trace.steps.push(record);
      await persist();
      try {
        const value = await operation();
        record.state = 'completed';
        await persist();
        return value;
      } catch (error) {
        record.state = 'failed';
        trace.failure ??= { step: name, errorName: error.name };
        await persist();
        throw error;
      }
    };
    t.after(persist);
    const firstScripts = [];
    const fixture = (request, response) => {
      const incoming = new URL(request.url, 'http://fixture');
      if (incoming.pathname === '/first') {
        firstScripts.push({
          document: incoming.searchParams.get('document'),
          marker: incoming.searchParams.get('marker') === 'true',
        });
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<!doctype html><title>ordinary</title><script>globalThis.diagnostic675FirstSawMarker = globalThis.__slicc675PinnedMarker === "diagnostic-675-v1"; fetch("/first?document=" + new URL(location.href).searchParams.get("document") + "&marker=" + globalThis.diagnostic675FirstSawMarker); globalThis.diagnostic675Reached = true;</script>'
      );
    };
    const site = createServer(fixture);
    const secure = createSecureServer(
      await step('setup.fixture-certificate', certificate),
      fixture
    );
    await step('setup.fixture-listen', async () => {
      await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
      await new Promise((resolve) => secure.listen(0, '127.0.0.1', resolve));
    });
    t.after(() => {
      site.closeAllConnections();
      site.close();
      secure.closeAllConnections();
      secure.close();
    });
    const url = `http://localhost:${site.address().port}/ordinary`;
    const ordinaryMapping = `MAP echo.sliccy.ai 127.0.0.1:${secure.address().port}`;
    const vaultMapping = `MAP vault.sliccy.ai 127.0.0.1:${secure.address().port}`;
    const chrome = await step('setup.launch', () =>
      route === 'extension'
        ? realExtension({ rules: [ordinaryMapping, vaultMapping] })
        : launch({
            tools: false,
            args: [
              '--ignore-certificate-errors',
              `--host-resolver-rules=${ordinaryMapping}, ${vaultMapping}, MAP seven.sliccy.ai 127.0.0.1:${secure.address().port}`,
            ],
          })
    );
    t.after(() => chrome.close());
    const page = await step('setup.page', () => chrome.page(t));
    await step('setup.page-init', () =>
      page.init(() => {
        globalThis.sliccKernelDebug = true;
      })
    );
    if (route === 'extension') {
      await step('setup.seven-navigation', () => page.goto(SEVEN));
      await step('setup.seven-ready', () => ready(page, undefined, { tools: false }));
      await step('setup.extension-topology', async () => {
        assert.equal(await page.evaluate(() => globalThis.sliccLinkedBrowsers().length), 0);
        assert.equal(
          await page.evaluate(() => typeof globalThis.sliccExtension.cdp.send),
          'function'
        );
      });
      await step('setup.wire', () => page.evaluate(installWire, { route }));
    } else {
      await step('setup.boot', () => boot(page, undefined, { tools: false }));
      await step('setup.link-topology', async () => {
        assert.equal(await page.evaluate(() => typeof globalThis.sliccExtension), 'undefined');
      });
      const runtimes = await step('setup.link', async () =>
        linkNode(t, page, (await devtools(chrome)).port, 'diagnostic-675')
      );
      await step('setup.link-runtimes', () => assert.ok(runtimes.length > 0));
      await step('setup.wire', () => page.evaluate(installWire, { route, runtime: runtimes[0] }));
    }
    const raw = chrome.cdp;
    const { targetId } = await step('setup.raw-target', () =>
      raw.send('Target.createTarget', { url })
    );
    t.after(() => raw.send('Target.closeTarget', { targetId }).catch(() => {}));
    const { sessionId: observer } = await step('setup.raw-attachment', () =>
      raw.send('Target.attachToTarget', { targetId, flatten: true })
    );
    await step('setup.raw-page-events', () => raw.send('Page.enable', {}, observer));
    const observerEvents = [];
    const rawPauses = [];
    const rawWaiters = new Set();
    const rawPending = new Set();
    const native = async (method, params = {}) => {
      const started = Date.now();
      const record = { method };
      rawPending.add(record);
      const actual = raw
        .send(method, params, observer)
        .then(
          (result) => ({ result, elapsedMs: Date.now() - started }),
          (error) => ({ error: true, errorName: error.name, elapsedMs: Date.now() - started })
        )
        .finally(() => rawPending.delete(record));
      let timer;
      const reply = await Promise.race([
        actual,
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ deadline: true, elapsedMs: Date.now() - started }),
            3000
          );
        }),
      ]);
      clearTimeout(timer);
      return reply;
    };
    const stopObserving = raw.on((event) => {
      if (event.sessionId !== observer) return;
      if (['Page.frameNavigated', 'Page.loadEventFired'].includes(event.method)) {
        const value = {
          method: event.method,
          url: event.params.frame?.url,
          frameId: event.params.frame?.id,
          loaderId: event.params.frame?.loaderId,
        };
        observerEvents.push(value);
        for (const waiter of rawWaiters) waiter();
      }
      if (event.method === 'Debugger.paused') {
        rawPauses.push({
          reason: event.params.reason,
          frames: event.params.callFrames.map((frame) => ({
            id: frame.callFrameId,
            scriptId: frame.location?.scriptId,
            url: frame.url,
            location: frame.location,
          })),
        });
        for (const waiter of rawWaiters) waiter();
      }
    });
    t.after(stopObserving);
    const rawWait = (find, bound = 10000) =>
      new Promise((resolve) => {
        const found = find();
        if (found) return resolve(found);
        const listener = () => {
          const result = find();
          if (!result) return;
          clearTimeout(timer);
          rawWaiters.delete(listener);
          resolve(result);
        };
        const timer = setTimeout(() => {
          rawWaiters.delete(listener);
          resolve({ deadline: true });
        }, bound);
        rawWaiters.add(listener);
      });
    const targets = await step('setup.route-discovery', () =>
      page.evaluate(() => diagnostic675.send('Target.getTargets'))
    );
    const target = await step('setup.route-discovery-result', () => {
      assert.ok(!targets.deadline && !targets.error, 'diagnostic discovery completed');
      const target = targets.result.targetInfos.find((target) => target.url === url);
      assert.ok(target, 'ordinary document was discovered');
      return target;
    });
    const attached = await step('setup.route-attachment', () =>
      page.evaluate(
        (targetId) => diagnostic675.send('Target.attachToTarget', { targetId, flatten: true }),
        target.targetId
      )
    );
    await step('setup.route-attachment-result', () => {
      assert.ok(!attached.deadline && !attached.error, 'diagnostic attachment completed');
    });
    const session = attached.result.sessionId;
    await step('setup.route-session', () =>
      page.evaluate((session) => diagnostic675.setSession(session), session)
    );
    const below = (method, params = {}, sessionId = session) =>
      page.evaluate(
        ({ method, params, sessionId }) => diagnostic675.transport(method, params, sessionId),
        { method, params, sessionId }
      );
    const required = async (method, params = {}, sessionId = session) =>
      step(`route.${method}`, async () => {
        const reply = await below(method, params, sessionId);
        trace.lastRequiredReply = { method, ...summarize(reply) };
        await persist();
        assert.ok(!reply.deadline && !reply.error, `${method} completed through route transport`);
        return reply.result;
      });
    const guarded = () =>
      page.evaluate((sessionId) => diagnostic675.send('Page.getFrameTree', {}, sessionId), session);
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable'])
      await required(method);
    await required('Target.setDiscoverTargets', { discover: true }, null);
    const warm = await step('setup.warm-tree', guarded);
    await step('setup.warm-tree-result', () =>
      assert.equal(warm.result?.frameTree?.frame?.url, url)
    );
    const noBreakpoint = `${url}?document=control`;
    await page.evaluate(() => diagnostic675.reset('no-breakpoint'));
    const sequence = await page.evaluate(() => diagnostic675.sequence());
    const controlObservedAfter = observerEvents.length;
    const navigation = below('Page.navigate', { url: noBreakpoint });
    const frame = await step('setup.control-frame', () =>
      page.evaluate((sequence) => diagnostic675.wait('Page.frameNavigated', sequence), sequence)
    );
    await step('setup.control-frame-result', () => {
      assert.equal(frame.deadline, undefined, 'control navigation was observed');
    });
    const unpaused = await step('setup.control-read', guarded);
    trace.controls.push({
      kind: 'navigation-no-breakpoint',
      ...summarize(unpaused),
      ownedReads: await page.evaluate(() => diagnostic675.snapshot()),
    });
    await step('setup.control-read-result', () => {
      assert.equal(unpaused.deadline, undefined, 'unpaused control did not deadlock');
    });
    await step('setup.control-navigation-result', async () => {
      const reply = await navigation;
      assert.ok(!reply.deadline && !reply.error, 'control navigate returned');
    });
    const loaded = await step('setup.control-raw-load', () =>
      rawWait(() =>
        observerEvents
          .slice(controlObservedAfter)
          .find((event) => event.method === 'Page.loadEventFired')
      )
    );
    await step('setup.control-raw-load-result', () => {
      assert.equal(loaded.deadline, undefined, 'control document loaded');
    });
    await step('setup.route-debugger-enable', () => required('Debugger.enable'));
    trace.topology.routeDebuggerEnabled = true;
    await step('setup.raw-debugger-enable', () =>
      native('Debugger.enable').then((reply) => {
        assert.ok(!reply.deadline && !reply.error);
      })
    );
    trace.topology.rawDebuggerOwned = true;
    trace.phase = 'proof';
    let breakpoint;
    t.after(async () => {
      if (breakpoint)
        await below('Debugger.removeBreakpoint', { breakpointId: breakpoint }).catch(() => {});
      await below('Debugger.resume').catch(() => {});
      await page.evaluate(() => diagnostic675.close()).catch(() => {});
    });
    const perform = async ({ kind, fault = false, destination }) =>
      step(kind, async () => {
        await page.evaluate(({ kind, fault }) => diagnostic675.reset(kind, fault), { kind, fault });
        breakpoint = (
          await required('Debugger.setInstrumentationBreakpoint', {
            instrumentation: 'beforeScriptExecution',
          })
        ).breakpointId;
        const after = await page.evaluate(() => diagnostic675.sequence());
        const rawAfter = rawPauses.length;
        const observedAfter = observerEvents.length;
        const executing = below('Page.navigate', { url: destination });
        const initial = await step(kind + '.instrumentation-pause', () =>
          page.evaluate((after) => diagnostic675.wait('Debugger.paused', after), after)
        );
        const row = {
          kind,
          fault,
          paths: {
            arm: route + ' guard, below bios; no Rust',
            convert: route + ' guard, below bios; no Rust',
            read: 'bios + ' + route + ' guard; no Rust',
            evaluate: route + ' guard, below bios; no Rust',
            marker: route + ' guard, below bios; no Rust',
          },
          initialReason: initial.reason,
        };
        trace.rows.push(row);
        await persist();
        assert.equal(initial.deadline, undefined);
        assert.equal(initial.reason, 'instrumentation');
        assert.equal((await rawWait(() => rawPauses[rawAfter])).deadline, undefined);
        const normalAfter = await page.evaluate(() => diagnostic675.sequence());
        const rawNormalAfter = rawPauses.length;
        const paused = await step(kind + '.request-normal-pause', () => below('Debugger.pause'));
        row.pause = summarize(paused);
        const resumed = await step(kind + '.instrumentation-resume', () =>
          below('Debugger.resume')
        );
        row.instrumentationResume = summarize(resumed);
        await persist();
        const normal = await step(kind + '.normal-pause', () =>
          page.evaluate((after) => diagnostic675.wait('Debugger.paused', after), normalAfter)
        );
        const rawNormal = await rawWait(() => rawPauses[rawNormalAfter]);
        row.normalReason = normal.reason;
        row.normalDeadline = Boolean(normal.deadline);
        row.sameScript = normal.frames?.[0]?.scriptId === initial.frames?.[0]?.scriptId;
        row.supportingEvents = normal.deadline
          ? undefined
          : await page.evaluate(({ pause, expected }) => diagnostic675.correlate(pause, expected), {
              pause: normal,
              expected: destination,
            });
        await persist();
        assert.ok(!normal.deadline && !rawNormal.deadline && normal.reason !== 'instrumentation');
        const removed = await below('Debugger.removeBreakpoint', { breakpointId: breakpoint });
        breakpoint = undefined;
        row.removeBreakpoint = summarize(removed);
        const answer = await step(kind + '.guarded-read', guarded);
        Object.assign(row, summarize(answer), {
          ownedReads: await page.evaluate(() => diagnostic675.snapshot()),
          urlMatched: answer.result?.frameTree?.frame?.url === destination,
        });
        await persist();
        if (!fault) {
          const evaluated = await step(kind + '.route-evaluate', () =>
            below('Debugger.evaluateOnCallFrame', {
              callFrameId: normal.frames[0].id,
              expression: '1 + 1',
              returnByValue: true,
              silent: true,
            })
          );
          row.evaluateOnCallFrame = {
            ...summarize(evaluated),
            returnedTwo: evaluated.result?.result?.value === 2,
          };
          if (
            row.urlMatched &&
            !answer.error &&
            !answer.deadline &&
            row.evaluateOnCallFrame.returnedTwo
          ) {
            const installed = await step(kind + '.pinned-marker', () =>
              below('Debugger.evaluateOnCallFrame', {
                callFrameId: normal.frames[0].id,
                expression:
                  'Object.defineProperty(globalThis, "__slicc675PinnedMarker", {value: "diagnostic-675-v1"}); globalThis.__slicc675PinnedMarker === "diagnostic-675-v1"',
                returnByValue: true,
                silent: true,
              })
            );
            row.marker = {
              ...summarize(installed),
              installed:
                installed.result?.result?.value === true && !installed.result?.exceptionDetails,
            };
          }
        }
        const release = await step(kind + '.normal-resume', () => below('Debugger.resume'));
        row.resume = summarize(release);
        row.deadlock = Boolean(
          answer.deadline || removed.deadline || removed.error || release.deadline || release.error
        );
        if (row.deadlock) {
          row.failureCleanup = 'raw rescue only after recorded proof failure';
          await native('Debugger.resume');
        }
        row.navigation = summarize(await executing);
        const loaded = await rawWait(() =>
          observerEvents.slice(observedAfter).find((e) => e.method === 'Page.loadEventFired')
        );
        row.loaded = !loaded.deadline;
        const observed = await native('Runtime.evaluate', {
          expression: 'globalThis.diagnostic675FirstSawMarker === true',
          returnByValue: true,
        });
        row.firstScript = {
          ...summarize(observed),
          sawMarker: observed.result?.result?.value === true,
          observationPath: 'raw post-resume observation of first page script result',
        };
        row.firstScriptBeacons = firstScripts.filter(
          (entry) => entry.document === new URL(destination).searchParams.get('document')
        );
        await persist();
        assert.equal(row.deadlock, false);
        if (fault) {
          assert.ok(row.ownedReads.held > 0);
          assert.ok(answer.error);
          assert.equal(answer.result, undefined);
        }
      });
    await perform({ kind: 'positive-normal-pause', destination: url + '?document=positive' });
    await perform({
      kind: 'held-read-normal-pause',
      destination: url + '?document=held',
      fault: true,
    });
    const pendingRows = [];
    trace.pendingPauses = pendingRows;
    for (const siteRelation of ['same-site', 'cross-site']) {
      for (const protectedKind of ['seven', 'vault']) {
        const row = {
          kind: 'pending-pause',
          siteRelation,
          protectedKind,
          phase: 'setup',
          steeringPath:
            'raw observer navigation; real guards remain attached; not client admission',
        };
        pendingRows.push(row);
        let ownedTarget;
        let pendingSession;
        let privateSession;
        let pendingBreakpoint;
        const attempt = (method, params = {}) => below(method, params, pendingSession);
        const privateCall = async (method, params = {}) => {
          const started = Date.now();
          let timer;
          const result = await Promise.race([
            raw.send(method, params, privateSession).then(
              (result) => ({ result, elapsedMs: Date.now() - started }),
              (error) => ({ error: true, errorName: error.name, elapsedMs: Date.now() - started })
            ),
            new Promise((resolve) => {
              timer = setTimeout(
                () => resolve({ deadline: true, elapsedMs: Date.now() - started }),
                3000
              );
            }),
          ]);
          clearTimeout(timer);
          return result;
        };
        const rawEvents = [];
        const rawScripts = new Map();
        const privateWaiters = new Set();
        const stop = raw.on((event) => {
          if (event.sessionId !== privateSession) return;
          if (event.method === 'Debugger.scriptParsed')
            rawScripts.set(event.params.scriptId, event.params.url);
          if (['Debugger.paused', 'Page.frameNavigated'].includes(event.method)) {
            rawEvents.push(event);
            for (const waiter of privateWaiters) waiter();
          }
        });
        const waitPrivate = (after) =>
          new Promise((resolve) => {
            const find = () =>
              rawEvents.slice(after).find((event) => event.method === 'Debugger.paused');
            if (find()) return resolve(find());
            const listener = () => {
              const found = find();
              if (!found) return;
              clearTimeout(timer);
              privateWaiters.delete(listener);
              resolve(found);
            };
            const timer = setTimeout(() => {
              privateWaiters.delete(listener);
              resolve({ deadline: true });
            }, 3000);
            privateWaiters.add(listener);
          });
        try {
          await step('pending.' + siteRelation + '.' + protectedKind + '.setup', async () => {
            const source = siteRelation === 'same-site' ? 'https://echo.sliccy.ai/ordinary' : url;
            row.setupStep = 'raw.create-target';
            ownedTarget = (await raw.send('Target.createTarget', { url: source })).targetId;
            row.setupStep = 'raw.attach';
            privateSession = (
              await raw.send('Target.attachToTarget', { targetId: ownedTarget, flatten: true })
            ).sessionId;
            await privateCall('Page.enable');
            row.setupStep = 'route.discovery';
            const discovered = await page.evaluate(() => diagnostic675.send('Target.getTargets'));
            const found = discovered.result?.targetInfos.find((target) => target.url === source);
            assert.ok(found);
            row.setupStep = 'route.attachment';
            const attached = await page.evaluate(
              (targetId) =>
                diagnostic675.send('Target.attachToTarget', { targetId, flatten: true }),
              found.targetId
            );
            pendingSession = attached.result?.sessionId;
            assert.ok(pendingSession);
            await page.evaluate((session) => diagnostic675.setSession(session), pendingSession);
            for (const method of ['Page.enable', 'Runtime.enable', 'Debugger.enable']) {
              row.setupStep = 'route.' + method;
              const reply = await step(
                'pending.' + siteRelation + '.' + protectedKind + '.' + method,
                async () => {
                  const reply = await attempt(method);
                  row.lastSetupReply = { method, ...summarize(reply) };
                  assert.ok(!reply.deadline && !reply.error);
                  return reply;
                }
              );
              assert.ok(reply.result);
            }
            row.setupStep = 'raw.Debugger.enable';
            const enabled = await privateCall('Debugger.enable');
            assert.ok(!enabled.deadline && !enabled.error);
            row.setupStep = 'raw.Runtime.getIsolateId';
            row.beforeIsolate = (await privateCall('Runtime.getIsolateId')).result?.id;
            row.setupStep = 'route.instrumentation-arm';
            pendingBreakpoint = (
              await attempt('Debugger.setInstrumentationBreakpoint', {
                instrumentation: 'beforeScriptExecution',
              })
            ).result?.breakpointId;
            assert.ok(pendingBreakpoint);
            row.setupStep = 'route.instrumented-navigation';
            const after = await page.evaluate(() => diagnostic675.sequence());
            await attempt('Page.navigate', { url: source + '?document=pending' });
            row.setupStep = 'route.instrumentation-pause';
            const paused = await page.evaluate(
              (after) => diagnostic675.wait('Debugger.paused', after),
              after
            );
            assert.equal(paused.reason, 'instrumentation');
          });
          row.phase = 'proof';
          const after = await page.evaluate(() => diagnostic675.sequence());
          const rawAfter = rawEvents.length;
          row.pause = summarize(await attempt('Debugger.pause'));
          const destination = protectedKind === 'seven' ? SEVEN : 'https://vault.sliccy.ai/';
          const navigation = privateCall('Page.navigate', { url: destination });
          row.resume = summarize(await attempt('Debugger.resume'));
          row.navigation = summarize(await navigation);
          const routePause = await page.evaluate(
            (after) => diagnostic675.wait('Debugger.paused', after, 3000),
            after
          );
          row.routePausePublished = !routePause.deadline;
          row.routePauseReason = routePause.reason;
          const rawPause = rawEvents
            .slice(rawAfter)
            .find((event) => event.method === 'Debugger.paused');
          row.rawPauseReason = rawPause?.params.reason;
          row.rawPauseScript = rawPause?.params.callFrames?.[0]?.location?.scriptId;
          row.rawPauseUrl = rawScripts.get(row.rawPauseScript);
          row.protectedPause = row.rawPauseUrl?.startsWith(destination);
          const frameTree = await privateCall('Page.getFrameTree');
          row.rawTree = summarize(frameTree);
          row.landingUrl = frameTree.result?.frameTree?.frame?.url;
          row.afterIsolate = (await privateCall('Runtime.getIsolateId')).result?.id;
          row.sameProcess =
            row.beforeIsolate && row.afterIsolate
              ? row.beforeIsolate === row.afterIsolate
              : undefined;
          row.protectedLanding = row.landingUrl?.startsWith(destination);
          row.biosPausePublications = await page.evaluate(() => diagnostic675.published());
          row.rawNavigationEvents = rawEvents
            .slice(rawAfter)
            .filter((event) => event.method === 'Page.frameNavigated')
            .map((event) => ({
              url: event.params.frame?.url,
              frameId: event.params.frame?.id,
              loaderId: event.params.frame?.loaderId,
            }));
          row.requiredRescue = Boolean(row.protectedPause);
          row.pendingSafetyNotClaimed = true;
          row.phase = 'complete';
        } catch (error) {
          row.failure = {
            step:
              row.phase === 'setup'
                ? 'pending.' + siteRelation + '.' + protectedKind + '.' + row.setupStep
                : trace.step,
            errorName: error.name,
          };
        } finally {
          if (pendingBreakpoint)
            row.remove = summarize(
              await attempt('Debugger.removeBreakpoint', { breakpointId: pendingBreakpoint })
            );
          if (privateSession) {
            row.failureCleanup =
              'diagnostic raw cleanup after landing and publication measurements; not guard-owned rescue';
            const beforeCleanup = rawEvents.length;
            const beforeCleanupRoute = await page.evaluate(() => diagnostic675.sequence());
            row.rawCleanupResume = summarize(await privateCall('Debugger.resume'));
            const laterPause = await waitPrivate(beforeCleanup);
            row.pauseAfterDiagnosticCleanup = {
              deadline: Boolean(laterPause.deadline),
              reason: laterPause.params?.reason,
              scriptUrl: rawScripts.get(laterPause.params?.callFrames?.[0]?.location?.scriptId),
              diagnosticCleanupNotGuardRescue: true,
            };
            if (!laterPause.deadline) {
              const finalTree = await privateCall('Page.getFrameTree');
              row.finalRawTree = {
                ...summarize(finalTree),
                url: finalTree.result?.frameTree?.frame?.url,
              };
              row.finalRoutePublication = !(
                await page.evaluate(
                  (after) => diagnostic675.wait('Debugger.paused', after, 3000),
                  beforeCleanupRoute
                )
              ).deadline;
              await privateCall('Debugger.resume');
            }
          }
          if (ownedTarget)
            await raw.send('Target.closeTarget', { targetId: ownedTarget }).catch(() => {});
          stop();
          await page.evaluate((session) => diagnostic675.setSession(session), session);
          await persist();
        }
      }
    }
    const positive = trace.rows.find((row) => !row.fault);
    trace.phase = 'complete';
    trace.passedSafety = trace.rows.every((row) => !row.deadlock);
    await persist();
    assert.ok(
      positive.urlMatched && positive.safe && !positive.refused && !positive.deadline,
      'bios live read verified the paused new document'
    );
    assert.equal(
      positive.evaluateOnCallFrame?.returnedTwo,
      true,
      'route evaluation completed at the verified pause'
    );
    assert.equal(positive.marker?.installed, true, 'pinned marker installed through route');
    assert.equal(
      positive.firstScript?.sawMarker,
      true,
      'first page script saw the marker before running'
    );
    trace.passed = true;
    t.diagnostic(`diagnostic-675 ${route} passed`);
  });
}

test('diagnostic 675: extension with other content script', { timeout: 900000 }, async (t) => {
  const trace = { route: 'extension', kind: 'other-extension', phase: 'setup', steps: [] };
  const persist = async () => {
    const root = process.env.SLICC_PROOF_TRACE_DIR;
    if (!root) return;
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'diagnostic-675-extension-foreign.json'),
      JSON.stringify(trace, null, 2)
    );
  };
  t.after(persist);
  const step = async (name, operation) => {
    trace.step = name;
    await persist();
    try {
      const result = await operation();
      trace.steps.push({ name, state: 'completed' });
      await persist();
      return result;
    } catch (error) {
      trace.failure = { step: name, errorName: error.name };
      await persist();
      throw error;
    }
  };
  const previous = process.env.SLICC_HARNESS_EXTENSION;
  process.env.SLICC_HARNESS_EXTENSION = '1';
  let chrome;
  try {
    chrome = await step('setup.launch-with-harness-extension', () => realExtension());
  } finally {
    if (previous === undefined) delete process.env.SLICC_HARNESS_EXTENSION;
    else process.env.SLICC_HARNESS_EXTENSION = previous;
  }
  t.after(() => chrome.close());
  trace.harnessExtension = chrome.extension?.id;
  const page = await step('setup.page', () => chrome.page(t));
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await step('setup.seven-navigation', () => page.goto(SEVEN));
  await step('setup.seven-ready', () => ready(page, undefined, { tools: false }));
  await step('setup.topology', async () => {
    assert.equal(await page.evaluate(() => globalThis.sliccLinkedBrowsers().length), 0);
    assert.equal(trace.harnessExtension, 'ankmbodmgimjemnojmeddfcdlbocolob');
  });
  await step('setup.wire', () => page.evaluate(installWire, { route: 'extension' }));
  const site = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>ordinary</title>');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    site.closeAllConnections();
    site.close();
  });
  const url = 'http://localhost:' + site.address().port + '/ordinary';
  const { targetId } = await step('setup.ordinary-target', () =>
    chrome.cdp.send('Target.createTarget', { url })
  );
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  const targets = await step('setup.discovery', () =>
    page.evaluate(() => diagnostic675.send('Target.getTargets'))
  );
  const target = targets.result?.targetInfos.find((target) => target.url === url);
  assert.ok(target);
  const attached = await step('setup.attachment', () =>
    page.evaluate(
      (targetId) => diagnostic675.send('Target.attachToTarget', { targetId, flatten: true }),
      target.targetId
    )
  );
  const sessionId = attached.result?.sessionId;
  assert.ok(sessionId);
  await step('setup.runtime', async () => {
    const reply = await page.evaluate(
      (sessionId) => diagnostic675.transport('Runtime.enable', {}, sessionId),
      sessionId
    );
    assert.ok(!reply.error && !reply.deadline);
  });
  trace.phase = 'proof';
  const reply = await step('proof.Debugger.enable', () =>
    page.evaluate(
      (sessionId) => diagnostic675.transport('Debugger.enable', {}, sessionId),
      sessionId
    )
  );
  trace.reply = summarize(reply);
  trace.path =
    'extension guard below bios; actual builtin content-script extension ON; no linked CLI or Rust';
  await persist();
  assert.ok(reply.error && !reply.deadline && !reply.result);
  assert.equal(
    reply.refusalConstant,
    'slicc: refused: a browser extension runs scripts in this page, and profiling it would expose them'
  );
  trace.phase = 'complete';
  trace.passed = true;
  await persist();
});
