import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { after, test } from 'node:test';
import { DEBUGGER_ROUTE_UPDATE } from '../../src/seed/debugger.js';
import { ready } from './bios.mjs';
import { CURRENT_EXTENSION, realExtension, SEVEN } from './real-extension.mjs';

const site = createHttp((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    '<!doctype html><title>stage1</title><h1>Stage 1 ordinary</h1><script>document.documentElement.setAttribute("data-stage1","armed")</script>'
  );
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
after(() => site.close());
const page = `http://ordinary.test:${site.address().port}/stage1.html`;

async function guarded(seven, privateFrames) {
  await seven.evaluate(async (useFrames) => {
    globalThis.stage1?.close();
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const extension = globalThis.sliccExtension;
    const connection = guardProtected(
      extensionConnection(extension.cdp),
      location.origin,
      new Map(),
      { kind: 'extension', version: extension.version },
      useFrames ? (targetId) => extension.frames(Number(targetId)) : undefined
    );
    const pending = new Map();
    const events = [];
    let next = 0;
    connection.onmessage = (text) => {
      const message = JSON.parse(text);
      if (message.id === undefined) return void events.push(message);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    };
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ error: { message: `${method} got no answer within 60 s` } });
        }, 60000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        connection.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      });
    const waitFor = async (method, sessionId) => {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const found = events.find((e) => e.method === method && e.sessionId === sessionId);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    };
    globalThis.stage1 = { close: () => connection.close(), send, waitFor, events };
  }, privateFrames);
}

async function open(seven, url) {
  return seven.evaluate(async (pageUrl) => {
    const { send } = globalThis.stage1;
    const created = await send('Target.createTarget', { url: pageUrl });
    const targetId = created.result?.targetId;
    if (!targetId) return { step: 'create', created };
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.result?.sessionId;
    if (!sessionId) return { step: 'attach', attached };
    await send('Page.enable', {}, sessionId);
    const deadline = Date.now() + 60000;
    let state;
    while (Date.now() < deadline) {
      state = await send(
        'Runtime.evaluate',
        {
          expression: 'location.pathname + " " + document.readyState',
          returnByValue: true,
        },
        sessionId
      );
      if (state.result?.result?.value === '/stage1.html complete') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { step: 'open', targetId, sessionId, state };
  }, url);
}

test(`Stage 1 over the real extension ${CURRENT_EXTENSION.version}`, {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const real = await realExtension({
    extension: CURRENT_EXTENSION,
    rules: ['MAP ordinary.test 127.0.0.1'],
  });
  t.after(() => real.close());
  const seven = await real.page(t);
  await seven.goto(SEVEN);
  await ready(seven);
  assert.equal(
    await seven.evaluate(() => globalThis.sliccExtension.version),
    CURRENT_EXTENSION.version
  );
  t.after(() => seven.evaluate(() => globalThis.stage1?.close()));

  await t.test(
    'with a private frame reader an ordinary page publishes a pause the client resumes',
    async () => {
      await guarded(seven, true);
      const opened = await open(seven, page);
      assert.equal(opened.step, 'open', JSON.stringify(opened));
      assert.equal(
        opened.state.result?.result?.value,
        '/stage1.html complete',
        `the page never finished loading: ${JSON.stringify(opened.state)}`
      );
      const steps = await seven.evaluate(async (sessionId) => {
        const { send, waitFor } = globalThis.stage1;
        const enable = await send('Debugger.enable', {}, sessionId);
        const breakpoint = await send(
          'Debugger.setInstrumentationBreakpoint',
          { instrumentation: 'beforeScriptExecution' },
          sessionId
        );
        const reload = await send('Page.reload', {}, sessionId);
        const paused = await waitFor('Debugger.paused', sessionId);
        const resume = await send('Debugger.resume', {}, sessionId);
        return { enable, breakpoint, reload, paused, resume };
      }, opened.sessionId);
      assert.equal(steps.enable.error, undefined, JSON.stringify(steps.enable));
      assert.equal(steps.breakpoint.error, undefined, JSON.stringify(steps.breakpoint));
      assert.equal(steps.reload.error, undefined, JSON.stringify(steps.reload));
      assert.ok(steps.paused, 'no Debugger.paused reached the client after the reload');
      assert.ok(steps.paused.params.callFrames.length >= 1, JSON.stringify(steps.paused));
      assert.equal(steps.resume.error, undefined, JSON.stringify(steps.resume));
      const armed = await seven.evaluate(async (sessionId) => {
        const { send } = globalThis.stage1;
        const deadline = Date.now() + 30000;
        let answer;
        while (Date.now() < deadline) {
          answer = await send(
            'Runtime.evaluate',
            {
              expression: 'document.documentElement.getAttribute("data-stage1")',
              returnByValue: true,
            },
            sessionId
          );
          if (answer.result?.result?.value === 'armed') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return answer;
      }, opened.sessionId);
      assert.equal(armed.result?.result?.value, 'armed', JSON.stringify(armed));
    }
  );

  await t.test(
    'without a private frame reader the same Debugger command asks for an update',
    async () => {
      await guarded(seven, false);
      const opened = await open(seven, page);
      assert.equal(opened.step, 'open', JSON.stringify(opened));
      const enable = await seven.evaluate(
        (sessionId) => globalThis.stage1.send('Debugger.enable', {}, sessionId),
        opened.sessionId
      );
      assert.equal(enable.error?.message, DEBUGGER_ROUTE_UPDATE, JSON.stringify(enable));
    }
  );
});
