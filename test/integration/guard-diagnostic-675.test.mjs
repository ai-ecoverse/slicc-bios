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
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
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
  const report = { sent: 0, completed: 0, held: 0, fault: false };
  const reads = new Set();
  const wire = {
    onmessage: null,
    onclose: null,
    send(text) {
      const message = JSON.parse(text);
      if (message.id >= 2 ** 30 && message.method === 'Page.getFrameTree') {
        reads.add(message.id);
        report.sent += 1;
      }
      raw.send(text);
    },
    close: () => raw.close(),
  };
  raw.onmessage = (text) => {
    const message = JSON.parse(text);
    if (reads.delete(message.id)) {
      if (report.fault) {
        report.held += 1;
        return;
      }
      report.completed += 1;
    }
    wire.onmessage?.(text);
  };
  raw.onclose = (why) => wire.onclose?.(why);
  const connection = guardProtected(wire, self.origin);
  let next = 0;
  const pending = new Map();
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  globalThis.diagnostic675 = {
    report,
    close: () => connection.close(),
    reset(fault) {
      report.sent = 0;
      report.completed = 0;
      report.held = 0;
      report.fault = fault;
    },
    send(method, params = {}, sessionId) {
      return new Promise((resolve) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ deadline: true });
        }, 14000);
        pending.set(id, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        connection.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      });
    },
  };
}

for (const route of ['extension', 'link']) {
  test(`diagnostic 675: ${route}`, { timeout: 900000 }, async (t) => {
    const trace = { route, rows: [] };
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
      const port = (await devtools(chrome)).port;
      const runtimes = await linkNode(t, page, port, 'diagnostic-675');
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
    await raw.send('Runtime.enable', {}, observer);
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
    const warm = await page.evaluate(
      (sessionId) => diagnostic675.send('Page.getFrameTree', {}, sessionId),
      session
    );
    assert.equal(warm.result?.frameTree?.frame?.url, url);
    await raw.send('Debugger.enable', {}, observer);
    const breakpoint = await raw.send(
      'Debugger.setInstrumentationBreakpoint',
      { instrumentation: 'beforeScriptExecution' },
      observer
    );
    t.after(async () => {
      await raw
        .send('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }, observer)
        .catch(() => {});
      await raw.send('Debugger.resume', {}, observer).catch(() => {});
      await page.evaluate(() => diagnostic675.close()).catch(() => {});
    });
    for (const fault of [false, true]) {
      await page.evaluate((fault) => diagnostic675.reset(fault), fault);
      let off;
      let timer;
      const paused = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('diagnostic pause was not observed')), 10000);
        off = raw.on((event) => {
          if (event.sessionId !== observer || event.method !== 'Debugger.paused') return;
          if (event.params.reason !== 'instrumentation') return;
          clearTimeout(timer);
          resolve(event.params.callFrames.length);
        });
      });
      const destination = `${url}?document=${fault ? 'stall' : 'read'}`;
      const executing = raw.send('Page.navigate', { url: destination }, observer).catch(() => null);
      let frames;
      try {
        frames = await paused;
      } finally {
        clearTimeout(timer);
        off?.();
      }
      assert.ok(frames > 0, 'instrumentation supplied a call frame');
      const started = Date.now();
      let result;
      try {
        result = await page.evaluate(
          (sessionId) => diagnostic675.send('Page.getFrameTree', {}, sessionId),
          session
        );
        const reads = await page.evaluate(() => ({ ...diagnostic675.report }));
        trace.rows.push({
          fault,
          elapsedMs: Date.now() - started,
          deadline: Boolean(result.deadline),
          refused: Boolean(result.error),
          safe: Boolean(result.result),
          ...reads,
        });
        assert.equal(
          result.deadline,
          undefined,
          'guard completed or refused before the client deadline'
        );
        assert.ok(reads.sent > 0, 'the guard issued its own document read');
        if (fault) {
          assert.ok(reads.held > 0, 'an actual transport reply was held');
          assert.match(result.error?.message ?? '', /refused/);
          assert.equal(result.result, undefined, 'the unavailable read was not safe');
        } else {
          assert.ok(reads.completed > 0 || result.error, 'the owned read completed or refused');
          if (result.result) assert.equal(result.result.frameTree.frame.url, destination);
          else assert.match(result.error.message, /refused/);
        }
      } finally {
        await raw
          .send('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }, observer)
          .catch(() => {});
        await raw.send('Debugger.resume', {}, observer).catch(() => {});
        await executing;
      }
      if (!fault) {
        const rearmed = await raw.send(
          'Debugger.setInstrumentationBreakpoint',
          { instrumentation: 'beforeScriptExecution' },
          observer
        );
        breakpoint.breakpointId = rearmed.breakpointId;
      }
    }
    trace.passed = true;
    t.diagnostic(`diagnostic-675 ${route} passed`);
  });
}
