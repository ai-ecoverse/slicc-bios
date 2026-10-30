import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { devtools, launch } from './chrome.mjs';
import { linkNode } from './linked-node.mjs';
import { realExtension, SEVEN } from './real-extension.mjs';

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
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
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
    const site = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<!doctype html><title>ordinary</title><main>diagnostic</main><script>globalThis.diagnostic675Reached = true;</script>'
      );
    });
    await step(
      'setup.fixture-listen',
      () => new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
    );
    t.after(() => {
      site.closeAllConnections();
      site.close();
    });
    const url = `http://localhost:${site.address().port}/ordinary`;
    const chrome = await step('setup.launch', () =>
      route === 'extension' ? realExtension() : launch({ tools: false })
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
    const positives = [];
    const perform = async ({ kind, fault = false, destination, navigate = true }) =>
      step(kind, async () => {
        await page.evaluate(({ kind, fault }) => diagnostic675.reset(kind, fault), { kind, fault });
        breakpoint = (
          await required('Debugger.setInstrumentationBreakpoint', {
            instrumentation: 'beforeScriptExecution',
          })
        ).breakpointId;
        const after = await page.evaluate(() => diagnostic675.sequence());
        const observedAfter = observerEvents.length;
        const rawPausedAfter = rawPauses.length;
        const executing = navigate
          ? below('Page.navigate', { url: destination })
          : below('Runtime.evaluate', {
              expression: 'globalThis.diagnostic675Loaded = true',
              returnByValue: true,
            });
        const pause = await step(kind + '.route-pause', () =>
          page.evaluate((after) => diagnostic675.wait('Debugger.paused', after), after)
        );
        const rawPause = await step(kind + '.raw-pause', () =>
          rawWait(() => rawPauses[rawPausedAfter])
        );
        const row = {
          kind,
          fault,
          routePause: !pause.deadline,
          pauseReason: pause.reason,
          callFrames: pause.frames?.length,
          breakpointOwner: 'route',
          rawControlOwnDebugger: true,
          routeSession: session,
          rawControlSession: observer,
        };
        if (navigate) trace.rows.push(row);
        else trace.controls.push(row);
        await persist();
        assert.equal(pause.deadline, undefined, 'route instrumentation pause was observed');
        assert.equal(rawPause.deadline, undefined, 'raw debugger observed the same pause');
        assert.equal(pause.reason, 'instrumentation');
        assert.ok(pause.frames.length > 0 && rawPause.frames.length > 0);
        row.observerAtPause = observerEvents.slice(observedAfter);
        row.observerLoadPending =
          navigate && !row.observerAtPause.some((event) => event.method === 'Page.loadEventFired');
        const correlation = await page.evaluate(
          ({ pause, expected }) => diagnostic675.correlate(pause, expected),
          { pause, expected: destination }
        );
        row.eventVerdict = correlation;
        if (navigate && !fault) positives.push(correlation.fourEvents.yes);
        row.pendingBeforeEvaluateFirst = {
          route: await page.evaluate(() => diagnostic675.pendingTransport()),
          raw: [...rawPending].map((request) => request.method),
          ownedReads: await page.evaluate(() => diagnostic675.snapshot()),
        };
        const routeParams = {
          callFrameId: pause.frames[0].id,
          expression: '1 + 1',
          returnByValue: true,
          silent: true,
        };
        const rawParams = { ...routeParams, callFrameId: rawPause.frames[0].id };
        const [routeFirst, rawFirst] = await step(kind + '.evaluate-first', () =>
          Promise.all([
            below('Debugger.evaluateOnCallFrame', routeParams),
            native('Debugger.evaluateOnCallFrame', rawParams),
          ])
        );
        row.routeEvaluateFirst = {
          ...summarize(routeFirst),
          returnedTwo: routeFirst.result?.result?.value === 2,
        };
        row.rawEvaluateFirst = {
          ...summarize(rawFirst),
          returnedTwo: rawFirst.result?.result?.value === 2,
        };
        row.evaluateOnCallFrame = row.routeEvaluateFirst;
        await persist();
        const [tree, rawTree, info] = await step(kind + '.tree-reads', () =>
          Promise.all([
            below('Page.getFrameTree'),
            native('Page.getFrameTree'),
            below('Target.getTargetInfo', { targetId: target.targetId }, null),
          ])
        );
        row.transportFrameTree = {
          ...summarize(tree),
          urlMatched: tree.result?.frameTree?.frame?.url === destination,
        };
        row.rawFrameTree = {
          ...summarize(rawTree),
          urlMatched: rawTree.result?.frameTree?.frame?.url === destination,
        };
        row.transportTargetInfo = {
          ...summarize(info),
          urlMatched: info.result?.targetInfo?.url === destination,
        };
        await persist();
        const [routeAfter, rawAfter] = await step(kind + '.evaluate-after-read', () =>
          Promise.all([
            below('Debugger.evaluateOnCallFrame', routeParams),
            native('Debugger.evaluateOnCallFrame', rawParams),
          ])
        );
        row.routeEvaluateAfterTree = {
          ...summarize(routeAfter),
          returnedTwo: routeAfter.result?.result?.value === 2,
        };
        row.rawEvaluateAfterTree = {
          ...summarize(rawAfter),
          returnedTwo: rawAfter.result?.result?.value === 2,
        };
        await persist();
        const answer = await step(kind + '.guarded-read', guarded);
        Object.assign(row, summarize(answer), {
          ownedReads: await page.evaluate(() => diagnostic675.snapshot()),
        });
        await persist();
        const removed = await step(kind + '.remove', () =>
          below('Debugger.removeBreakpoint', { breakpointId: breakpoint })
        );
        breakpoint = undefined;
        const resumed = await step(kind + '.resume', () => below('Debugger.resume'));
        row.removeBreakpoint = summarize(removed);
        row.resume = summarize(resumed);
        row.deadlock = Boolean(
          answer.deadline || removed.deadline || removed.error || resumed.deadline || resumed.error
        );
        if (row.deadlock) {
          row.failureCleanup = 'raw debugger rescue after proof failure only';
          await native('Debugger.resume');
        }
        row.observerAfterResume = observerEvents.slice(observedAfter);
        row.navigationCommand = summarize(await executing);
        await persist();
        assert.equal(answer.deadline, undefined, 'guard returned or refused before deadline');
        assert.equal(row.deadlock, false, 'route resumed without raw rescue');
        if (fault) {
          assert.ok(row.ownedReads.held > 0, 'an actual owned reply was held');
          assert.ok(answer.error);
          assert.equal(answer.result, undefined);
        }
        if (answer.result) assert.equal(answer.result.frameTree.frame.url, destination);
        if (navigate) {
          const finished = await step(kind + '.raw-loaded', () =>
            rawWait(() =>
              observerEvents
                .slice(observedAfter)
                .find((event) => event.method === 'Page.loadEventFired')
            )
          );
          row.loadedAfterResume = !finished.deadline;
          await persist();
          assert.equal(finished.deadline, undefined, 'document loaded after route resume');
        }
      });
    await perform({ kind: 'evaluate-first-fresh-pause', destination: `${url}?document=fresh` });
    const loadedDestination = `${url}?document=fresh`;
    await perform({
      kind: 'loaded-document-paused',
      destination: loadedDestination,
      navigate: false,
    });
    await perform({ kind: 'new-document-paused', destination: `${url}?document=read` });
    await perform({
      kind: 'new-document-held-reply',
      destination: `${url}?document=stall`,
      fault: true,
    });
    trace.positiveVerdict = positives.some(Boolean);
    trace.passedSafety = true;
    trace.phase = 'complete';
    assert.equal(
      trace.positiveVerdict,
      true,
      'new document has a positive four-event verdict at the pause'
    );
    const normal = trace.rows.find((row) => !row.fault);
    assert.equal(
      normal.evaluateOnCallFrame.returnedTwo,
      true,
      'call-frame evaluation completed while paused'
    );
    trace.passed = true;
    t.diagnostic(`diagnostic-675 ${route} passed`);
  });
}
