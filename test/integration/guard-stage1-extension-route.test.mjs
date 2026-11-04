import assert from 'node:assert/strict';
import test from 'node:test';
import { DEBUGGER_ROUTE_UPDATE } from '../../src/seed/debugger.js';
import { ready } from './bios.mjs';
import { CURRENT_EXTENSION, realExtension, SEVEN } from './real-extension.mjs';

test(`real slicc-extension ${CURRENT_EXTENSION.version}: Stage 1 admits Debugger on an ordinary page, publishes a page-only pause, and resumes it`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const real = await realExtension({ extension: CURRENT_EXTENSION });
  t.after(() => real.close());
  const seven = await real.page(t);
  await seven.goto(SEVEN);
  await ready(seven);
  assert.equal(
    await seven.evaluate(() => globalThis.sliccExtension.version),
    CURRENT_EXTENSION.version
  );
  assert.equal(await seven.evaluate(() => typeof globalThis.sliccExtension.frames), 'function');
  real.overrides.set(
    '/stage1.html',
    '<!doctype html><title>stage1</title><h1>Stage 1 ordinary</h1><script>document.documentElement.setAttribute("data-stage1","armed")</script>'
  );
  const target = new URL('/stage1.html', real.url);
  target.hostname = 'localhost';
  await seven.evaluate(async () => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const extension = globalThis.sliccExtension;
    const connection = guardProtected(
      extensionConnection(extension.cdp),
      location.origin,
      new Map(),
      { kind: 'extension', version: extension.version },
      (targetId) => extension.frames(Number(targetId))
    );
    const pending = new Map();
    const events = [];
    let next = 0;
    connection.onmessage = (text) => {
      const message = JSON.parse(text);
      if (message.id === undefined) events.push(message);
      else {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    };
    globalThis.stage1 = {
      events,
      close: () => connection.close(),
      send: (method, params = {}, sessionId) =>
        new Promise((resolve) => {
          const id = ++next;
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ error: { message: `${method} got no answer` } });
          }, 20000);
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          connection.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
          );
        }),
    };
  });
  t.after(() => seven.evaluate(() => globalThis.stage1?.close()));
  const row = await seven.evaluate(async (url) => {
    const client = globalThis.stage1;
    const created = await client.send('Target.createTarget', { url });
    if (created.error) return { step: 'create', created };
    const targetId = created.result.targetId;
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
    if (attached.error) return { step: 'attach', attached };
    const session = attached.result.sessionId;
    const enable = await client.send('Debugger.enable', {}, session);
    if (enable.error) return { step: 'enable', enable, targetId, session };
    const breakpoint = await client.send(
      'Debugger.setInstrumentationBreakpoint',
      { instrumentation: 'beforeScriptExecution' },
      session
    );
    if (breakpoint.error) return { step: 'breakpoint', breakpoint, targetId, session };
    const before = client.events.length;
    const navigated = await client.send('Page.navigate', { url: `${url}?reload=1` }, session);
    if (navigated.error) return { step: 'navigate', navigated, targetId, session };
    const deadline = Date.now() + 15000;
    let pause;
    while (Date.now() < deadline) {
      pause = client.events
        .slice(before)
        .find((event) => event.method === 'Debugger.paused' && event.sessionId === session);
      if (pause) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!pause) {
      return {
        step: 'pause',
        targetId,
        session,
        seen: client.events.slice(before).map((event) => event.method),
      };
    }
    const frames = pause.params?.callFrames ?? [];
    const origins = frames.map((frame) => {
      try {
        return frame.url ? new URL(frame.url).origin : '';
      } catch {
        return frame.url ?? '';
      }
    });
    const objectIds = JSON.stringify(pause.params);
    const resume = await client.send('Debugger.resume', {}, session);
    await client.send('Target.closeTarget', { targetId });
    return {
      step: 'done',
      enable,
      breakpoint,
      resume,
      reason: pause.params?.reason,
      frameCount: frames.length,
      origins,
      objectIds,
      pageOrigin: new URL(url).origin,
    };
  }, target.href);
  assert.equal(row.step, 'done', JSON.stringify(row));
  assert.equal(row.enable.error, undefined, JSON.stringify(row.enable));
  assert.equal(row.breakpoint.error, undefined, JSON.stringify(row.breakpoint));
  assert.equal(row.resume.error, undefined, JSON.stringify(row.resume));
  assert.ok(row.frameCount >= 1, JSON.stringify(row));
  assert.ok(
    row.origins.every((origin) => origin === '' || origin === row.pageOrigin),
    `pause carried a non-page origin: ${JSON.stringify(row)}`
  );
  assert.doesNotMatch(row.objectIds, /chrome-extension:/i, row.objectIds);
});

test(`real slicc-extension ${CURRENT_EXTENSION.version}: Stage 1 still needs the private frame callback on the extension route`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const real = await realExtension({ extension: CURRENT_EXTENSION });
  t.after(() => real.close());
  const seven = await real.page(t);
  await seven.goto(SEVEN);
  await ready(seven);
  real.overrides.set(
    '/stage1-route.html',
    '<!doctype html><title>stage1-route</title><h1>needs frames</h1>'
  );
  const target = new URL('/stage1-route.html', real.url);
  target.hostname = 'localhost';
  const refused = await seven.evaluate(async (url) => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const extension = globalThis.sliccExtension;
    const connection = guardProtected(
      extensionConnection(extension.cdp),
      location.origin,
      new Map(),
      { kind: 'extension', version: extension.version }
    );
    const pending = new Map();
    let next = 0;
    connection.onmessage = (text) => {
      const message = JSON.parse(text);
      if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    };
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ error: { message: `${method} got no answer` } });
        }, 20000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        connection.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      });
    try {
      const created = await send('Target.createTarget', { url });
      const attached = await send('Target.attachToTarget', {
        targetId: created.result.targetId,
        flatten: true,
      });
      return await send('Debugger.enable', {}, attached.result.sessionId);
    } finally {
      connection.close();
    }
  }, target.href);
  assert.equal(refused.error?.message, DEBUGGER_ROUTE_UPDATE, JSON.stringify(refused));
});
