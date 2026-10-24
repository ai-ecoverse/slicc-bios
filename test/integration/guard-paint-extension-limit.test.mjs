import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ready } from './bios.mjs';
import { markerPixels } from './guard-paint-pixels.mjs';
import { EXTENSIONS, realExtension, SEVEN } from './real-extension.mjs';

test('an extension without child attachment keeps an ordinary cross-site frame page closed', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const real = await realExtension({
    extension: EXTENSIONS.find(({ version }) => version === '7.6.4'),
    args: ['--site-per-process'],
  });
  t.after(() => real.close());
  const seven = await real.page(t);
  await seven.goto(SEVEN);
  await ready(seven);
  const plain = await seven.tab();
  const child = new URL('/ordinary-child', real.url).href;
  const outer = new URL('/ordinary-parent', real.url);
  outer.hostname = 'localhost';
  real.overrides.set(
    '/ordinary-child',
    '<!doctype html><style>html,body{margin:0;height:100%;background:#ff00ff}</style><button>ordinary marker</button><script>addEventListener("mousedown",()=>parent.postMessage("clicked","*"));parent.postMessage("loaded","*")</script>'
  );
  real.overrides.set(
    '/ordinary-parent',
    `<!doctype html><style>body{margin:0}iframe{width:400px;height:300px;border:0}</style><script>globalThis.clicks=0;addEventListener("message",({data})=>{if(data==="loaded")globalThis.loaded=true;if(data==="clicked")globalThis.clicks++})</script><iframe src="${child}"></iframe>`
  );
  await plain.send('Page.navigate', { url: outer.href });
  await plain.within(15000, () => globalThis.loaded);
  const infos = (await real.cdp.send('Target.getTargets', { filter: [{}] })).targetInfos;
  assert.ok(
    infos.some((info) => info.type === 'iframe' && info.url === child),
    'the ordinary child is cross-process'
  );
  const info = infos.find((info) => info.type === 'page' && info.url === outer.href);
  assert.ok(info, 'the ordinary parent exists');
  await real.cdp.send('Target.activateTarget', { targetId: info.targetId });
  const control = {
    shot: markerPixels((await plain.send('Page.captureScreenshot', { format: 'png' })).data),
  };
  const observer = (
    await real.cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
  ).sessionId;
  let timer;
  const castReady = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('the ordinary marker did not cast')), 15000);
    const off = real.cdp.on((event) => {
      if (event.sessionId !== observer || event.method !== 'Page.screencastFrame') return;
      void real.cdp
        .send('Page.screencastFrameAck', { sessionId: event.params.sessionId }, observer)
        .catch(() => {});
      const pixels = markerPixels(event.params.data);
      if (pixels > 0) {
        off();
        resolve(pixels);
      }
    });
    t.after(off);
  });
  try {
    await real.cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }, observer);
    control.cast = await castReady;
  } finally {
    clearTimeout(timer);
    await real.cdp.send('Page.stopScreencast', {}, observer);
    await real.cdp.send('Target.detachFromTarget', { sessionId: observer });
  }
  for (const type of ['mousePressed', 'mouseReleased'])
    await plain.send('Input.dispatchMouseEvent', {
      type,
      x: 100,
      y: 100,
      button: 'left',
      clickCount: 1,
    });
  await plain.within(10000, () => globalThis.clicks === 1);
  control.input = await plain.evaluate(() => globalThis.clicks);
  await seven.evaluate(async () => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const connection = guardProtected(
      extensionConnection(globalThis.sliccExtension.cdp),
      location.origin
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
    globalThis.frameLimit = {
      events,
      close: () => connection.close(),
      send: (method, params = {}, sessionId) =>
        new Promise((resolve) => {
          const id = ++next;
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ error: { message: 'no answer' } });
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
  try {
    const row = await seven.evaluate(async (url) => {
      const client = globalThis.frameLimit;
      const infos = (await client.send('Target.getTargets')).result.targetInfos;
      const info = infos.find((info) => info.url === url);
      if (!info) throw new Error('ordinary parent not listed');
      const attached = await client.send('Target.attachToTarget', {
        targetId: info.targetId,
        flatten: true,
      });
      const session = attached.result?.sessionId;
      if (!session) return { attached };
      let capability;
      try {
        await globalThis.sliccExtension.cdp.send(
          'Target.setAutoAttach',
          { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
          session
        );
      } catch (error) {
        capability = error.message;
      }
      const screenshot = await client.send('Page.captureScreenshot', { format: 'png' }, session);
      const cast = await client.send('Page.startScreencast', { format: 'png' }, session);
      const input = await client.send(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 },
        session
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const frames = client.events.filter(
        (event) => event.method === 'Page.screencastFrame'
      ).length;
      const closed =
        [screenshot, cast, input].every((answer) =>
          answer.error?.message?.startsWith('slicc: refused:')
        ) && frames === 0;
      return { capability, screenshot, cast, input, frames, state: closed ? 'closed' : 'failed' };
    }, outer.href);
    process.stdout.write(
      `GUARD-PAINT extension-7.6.4 ordinary ${JSON.stringify({ control, ...row })}\n`
    );
    assert.ok(
      control.shot > 0 && control.cast > 0 && control.input === 1,
      'the ordinary frame paints, casts and accepts input without the guard'
    );
    assert.equal(
      row.capability,
      'slicc: refused: Target.setAutoAttach is not supported: attach to each target'
    );
    for (const vector of ['screenshot', 'cast', 'input'])
      assert.match(
        row[vector]?.error?.message ?? '',
        /^slicc: refused:/,
        `${vector} stays closed for an unplaced remote owner`
      );
    assert.equal(row.frames, 0);
    assert.equal(
      await plain.evaluate(() => globalThis.clicks),
      1,
      'guarded input never reaches the ordinary frame'
    );
  } finally {
    await seven.evaluate(() => globalThis.frameLimit.close()).catch(() => {});
  }
});
