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
      rows: [],
      controls: [],
      topology: { arming: 'route transport below bios', observerArmed: false },
    };
    const root = process.env.SLICC_PROOF_TRACE_DIR;
    t.after(async () => {
      if (!root) return;
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `diagnostic-675-${route}.json`), JSON.stringify(trace, null, 2));
    });
    const site = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<!doctype html><title>ordinary</title><main>diagnostic</main><script>globalThis.diagnostic675Reached = true;</script>'
      );
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      site.closeAllConnections();
      site.close();
    });
    const url = `http://localhost:${site.address().port}/ordinary`;
    const chrome = route === 'extension' ? await realExtension() : await launch({ tools: false });
    t.after(() => chrome.close());
    const page = await chrome.page(t);
    await page.init(() => {
      globalThis.sliccKernelDebug = true;
    });
    if (route === 'extension') {
      await page.goto(SEVEN);
      await ready(page, undefined, { tools: false });
      assert.equal(await page.evaluate(() => globalThis.sliccLinkedBrowsers().length), 0);
      assert.equal(
        await page.evaluate(() => typeof globalThis.sliccExtension.cdp.send),
        'function'
      );
      await page.evaluate(installWire, { route });
    } else {
      await boot(page, undefined, { tools: false });
      assert.equal(await page.evaluate(() => typeof globalThis.sliccExtension), 'undefined');
      const runtimes = await linkNode(t, page, (await devtools(chrome)).port, 'diagnostic-675');
      assert.ok(runtimes.length > 0);
      await page.evaluate(installWire, { route, runtime: runtimes[0] });
    }
    const raw = chrome.cdp;
    const { targetId } = await raw.send('Target.createTarget', { url });
    t.after(() => raw.send('Target.closeTarget', { targetId }).catch(() => {}));
    const { sessionId: observer } = await raw.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await raw.send('Page.enable', {}, observer);
    const observerEvents = [];
    const stopObserving = raw.on((event) => {
      if (
        event.sessionId !== observer ||
        !['Page.frameNavigated', 'Page.loadEventFired'].includes(event.method)
      )
        return;
      observerEvents.push({
        method: event.method,
        url: event.params.frame?.url,
        frameId: event.params.frame?.id,
        loaderId: event.params.frame?.loaderId,
      });
    });
    t.after(stopObserving);
    const targets = await page.evaluate(() => diagnostic675.send('Target.getTargets'));
    assert.ok(!targets.deadline && !targets.error, 'diagnostic discovery completed');
    const target = targets.result.targetInfos.find((target) => target.url === url);
    assert.ok(target, 'ordinary document was discovered');
    const attached = await page.evaluate(
      (targetId) => diagnostic675.send('Target.attachToTarget', { targetId, flatten: true }),
      target.targetId
    );
    assert.ok(!attached.deadline && !attached.error, 'diagnostic attachment completed');
    const session = attached.result.sessionId;
    await page.evaluate((session) => diagnostic675.setSession(session), session);
    const below = (method, params = {}, sessionId = session) =>
      page.evaluate(
        ({ method, params, sessionId }) => diagnostic675.transport(method, params, sessionId),
        { method, params, sessionId }
      );
    const required = async (method, params = {}, sessionId = session) => {
      const reply = await below(method, params, sessionId);
      assert.ok(!reply.deadline && !reply.error, `${method} completed through route transport`);
      return reply.result;
    };
    const guarded = () =>
      page.evaluate((sessionId) => diagnostic675.send('Page.getFrameTree', {}, sessionId), session);
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable'])
      await required(method);
    await required('Target.setDiscoverTargets', { discover: true }, null);
    const warm = await guarded();
    assert.equal(warm.result?.frameTree?.frame?.url, url);
    const noBreakpoint = `${url}?document=control`;
    await page.evaluate(() => diagnostic675.reset('no-breakpoint'));
    const sequence = await page.evaluate(() => diagnostic675.sequence());
    const navigation = below('Page.navigate', { url: noBreakpoint });
    const frame = await page.evaluate(
      (sequence) => diagnostic675.wait('Page.frameNavigated', sequence),
      sequence
    );
    assert.equal(frame.deadline, undefined, 'control navigation was observed');
    const unpaused = await guarded();
    trace.controls.push({
      kind: 'navigation-no-breakpoint',
      ...summarize(unpaused),
      ownedReads: await page.evaluate(() => diagnostic675.snapshot()),
    });
    assert.equal(unpaused.deadline, undefined, 'unpaused control did not deadlock');
    assert.ok(!(await navigation).deadline, 'control navigate returned');
    const loaded = await page.evaluate(
      (sequence) => diagnostic675.wait('Page.loadEventFired', sequence),
      sequence
    );
    assert.equal(loaded.deadline, undefined, 'control document loaded');
    await required('Debugger.enable');
    trace.topology.routeDebuggerEnabled = true;
    trace.phase = 'proof';
    let breakpoint;
    t.after(async () => {
      if (breakpoint)
        await below('Debugger.removeBreakpoint', { breakpointId: breakpoint }).catch(() => {});
      await below('Debugger.resume').catch(() => {});
      await page.evaluate(() => diagnostic675.close()).catch(() => {});
    });
    const positives = [];
    const perform = async ({ kind, fault = false, destination, navigate = true }) => {
      await page.evaluate(({ kind, fault }) => diagnostic675.reset(kind, fault), { kind, fault });
      breakpoint = (
        await required('Debugger.setInstrumentationBreakpoint', {
          instrumentation: 'beforeScriptExecution',
        })
      ).breakpointId;
      const after = await page.evaluate(() => diagnostic675.sequence());
      const observedAfter = observerEvents.length;
      const executing = navigate
        ? below('Page.navigate', { url: destination })
        : below('Runtime.evaluate', {
            expression: 'globalThis.diagnostic675Loaded = true',
            returnByValue: true,
          });
      const pause = await page.evaluate(
        (after) => diagnostic675.wait('Debugger.paused', after),
        after
      );
      const row = {
        kind,
        fault,
        routePause: !pause.deadline,
        pauseReason: pause.reason,
        callFrames: pause.frames?.length,
      };
      if (navigate) trace.rows.push(row);
      else trace.controls.push(row);
      assert.equal(pause.deadline, undefined, 'route transport observed the instrumentation pause');
      assert.equal(pause.reason, 'instrumentation');
      assert.ok(pause.frames.length > 0, 'instrumentation supplied a call frame');
      row.observerAtPause = observerEvents.slice(observedAfter);
      row.observerLoadPending =
        navigate && !row.observerAtPause.some((event) => event.method === 'Page.loadEventFired');
      const correlation = await page.evaluate(
        ({ pause, expected }) => diagnostic675.correlate(pause, expected),
        { pause, expected: destination }
      );
      row.eventVerdict = correlation;
      if (navigate && !fault) positives.push(correlation.fourEvents.yes);
      const evaluated = await below('Debugger.evaluateOnCallFrame', {
        callFrameId: pause.frames[0].id,
        expression: '1 + 1',
        returnByValue: true,
        silent: true,
      });
      row.evaluateOnCallFrame = {
        ...summarize(evaluated),
        returnedTwo: evaluated.result?.result?.value === 2,
      };
      const [tree, info] = await Promise.all([
        below('Page.getFrameTree'),
        below('Target.getTargetInfo', { targetId: target.targetId }, null),
      ]);
      row.transportFrameTree = {
        ...summarize(tree),
        urlMatched: tree.result?.frameTree?.frame?.url === destination,
      };
      row.transportTargetInfo = {
        ...summarize(info),
        urlMatched: info.result?.targetInfo?.url === destination,
      };
      const answer = await guarded();
      Object.assign(row, summarize(answer), {
        ownedReads: await page.evaluate(() => diagnostic675.snapshot()),
      });
      const removed = await below('Debugger.removeBreakpoint', { breakpointId: breakpoint });
      breakpoint = undefined;
      const resumed = await below('Debugger.resume');
      row.removeBreakpoint = summarize(removed);
      row.resume = summarize(resumed);
      row.deadlock = Boolean(
        answer.deadline || removed.deadline || resumed.deadline || resumed.error
      );
      if (row.deadlock) {
        row.failureCleanup = 'raw observer rescue only after proof failure';
        await raw.send('Debugger.enable', {}, observer).catch(() => {});
        await raw.send('Debugger.resume', {}, observer).catch(() => {});
      }
      row.observerAfterResume = observerEvents.slice(observedAfter);
      row.navigationCommand = summarize(await executing);
      assert.equal(answer.deadline, undefined, 'guard returned or refused before client deadline');
      assert.equal(row.deadlock, false, 'route resumed without deadlock or observer rescue');

      if (fault) {
        assert.ok(row.ownedReads.held > 0, 'an actual owned read reply was held');
        assert.ok(answer.error, 'the unavailable owned read refused');
        assert.equal(answer.result, undefined, 'unavailable read never counted safe');
      }
      if (answer.result) assert.equal(answer.result.frameTree.frame.url, destination);
      if (navigate) {
        const finished = await page.evaluate(
          (sequence) => diagnostic675.wait('Page.loadEventFired', sequence),
          pause.sequence
        );
        row.loadedAfterResume = !finished.deadline;
        assert.equal(finished.deadline, undefined, 'document loaded after route resume');
      }
    };
    await perform({ kind: 'loaded-document-paused', destination: noBreakpoint, navigate: false });
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
