import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ready } from './bios.mjs';
import { markerPixels } from './guard-paint-pixels.mjs';
import { CURRENT_EXTENSION, realExtension, SEVEN } from './real-extension.mjs';

async function measure(t, { frames, childOrigin }) {
  const real = await realExtension({
    extension: CURRENT_EXTENSION,
    args: ['--site-per-process'],
  });
  t.after(() => real.close());
  const seven = await real.page(t);
  await seven.goto(SEVEN);
  await ready(seven);
  const plain = await seven.tab();
  const child = new URL('/ordinary-child.html', childOrigin ?? real.url).href;
  const outer = new URL('/ordinary-parent.html', real.url);
  outer.hostname = 'localhost';
  real.overrides.set(
    '/ordinary-child.html',
    '<!doctype html><style>html,body{margin:0;height:100%;background:#ff00ff}</style><button>ordinary marker</button><script>addEventListener("mousedown",()=>parent.postMessage("clicked","*"));parent.postMessage("loaded","*")</script>'
  );
  real.overrides.set(
    '/ordinary-parent.html',
    `<!doctype html><style>body{margin:0}iframe{width:400px;height:300px;border:0}</style><script>globalThis.clicks=0;addEventListener("message",({data})=>{if(data==="loaded")globalThis.loaded=true;if(data==="clicked")globalThis.clicks++})</script><iframe src="${child}"></iframe>`
  );
  const navigation = await plain.send('Page.navigate', { url: outer.href });
  assert.ok(!navigation.isDownload && !navigation.errorText, JSON.stringify(navigation));
  await plain.within(15000, () => globalThis.loaded);
  const infos = (await real.cdp.send('Target.getTargets', { filter: [{}] })).targetInfos;
  assert.ok(
    infos.some((info) => info.type === 'iframe' && info.url === child),
    `the ${childOrigin ? 'protected' : 'ordinary'} child is cross-process`
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
  await seven.evaluate(async (handFrames) => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const connection = guardProtected(
      extensionConnection(globalThis.sliccExtension.cdp),
      location.origin,
      new Map(),
      { kind: 'extension', version: globalThis.sliccExtension.version },
      handFrames ? (targetId) => globalThis.sliccExtension.frames(Number(targetId)) : undefined
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
  }, frames);
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
      if (!session) return { attached, hook: typeof globalThis.sliccExtension.frames };
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
      return {
        capability,
        hook: typeof globalThis.sliccExtension.frames,
        screenshot,
        cast,
        input,
        frames,
        state: closed ? 'closed' : 'failed',
      };
    }, outer.href);
    const layout = `${frames ? 'frames' : 'frameless'} ${childOrigin ? 'protected' : 'ordinary'}`;
    const childPath = new URL(child).pathname;
    const fixtureHits = real.requests.filter((path) => path === childPath);
    const frontHits = real.front.filter((url) => url === child);
    const childRequested = fixtureHits.length > 0 && frontHits.length > 0;
    const shown = {
      ...row,
      screenshot: row.screenshot?.error ?? (row.screenshot?.result ? 'answered' : null),
      child,
      childRequested,
      fixtureHits,
      frontHits,
    };
    process.stdout.write(
      `GUARD-PAINT extension-${CURRENT_EXTENSION.version} ${layout} ${JSON.stringify({ control, ...shown })}\n`
    );
    return {
      control,
      row,
      clicks: await plain.evaluate(() => globalThis.clicks),
      childRequested,
    };
  } finally {
    await seven.evaluate(() => globalThis.frameLimit.close()).catch(() => {});
  }
}

function controlPassed(control, kind) {
  assert.ok(
    control.shot > 0 && control.cast > 0 && control.input === 1,
    `the ${kind} frame paints, casts and accepts input without the guard`
  );
}

function stayedClosed({ row, clicks }, owner, kind) {
  assert.equal(
    row.capability,
    'slicc: refused: Target.setAutoAttach is not supported: attach to each target'
  );
  for (const vector of ['screenshot', 'cast', 'input'])
    assert.match(
      row[vector]?.error?.message ?? '',
      /^slicc: refused:/,
      `${vector} stays closed for ${owner}`
    );
  assert.equal(row.frames, 0);
  assert.equal(clicks, 1, `guarded input never reaches the ${kind} frame`);
}

test('an extension without child attachment keeps an ordinary cross-site frame page closed', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const measured = await measure(t, { frames: false });
  controlPassed(measured.control, 'ordinary');
  stayedClosed(measured, 'an unplaced remote owner', 'ordinary');
});

test('slicc-extension with frames() leaves an ordinary page with an ordinary cross-site frame drivable', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const { control, row } = await measure(t, { frames: true });
  controlPassed(control, 'ordinary');
  assert.equal(
    row.hook,
    'function',
    `slicc-extension ${CURRENT_EXTENSION.version} offers frames()`
  );
  assert.equal(row.screenshot?.error, undefined, 'the screenshot is answered');
  assert.ok(
    markerPixels(row.screenshot.result.data) > 0,
    'the answered screenshot shows the ordinary frame'
  );
  assert.equal(row.input?.error, undefined, 'input is accepted');
});

test('slicc-extension with frames() keeps a page with a protected cross-site frame closed', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const measured = await measure(t, { frames: true, childOrigin: SEVEN });
  controlPassed(measured.control, 'protected');
  assert.equal(
    measured.row.hook,
    'function',
    `slicc-extension ${CURRENT_EXTENSION.version} offers frames()`
  );
  if (measured.row.attached) {
    assert.match(
      measured.row.attached.error?.message ?? '',
      /^slicc: refused:/,
      'the page that holds the protected frame is refused at attach'
    );
    if (!measured.childRequested) {
      const loaded = await measure(t, { frames: true, childOrigin: SEVEN });
      controlPassed(loaded.control, 'protected');
      assert.ok(loaded.childRequested, 'child never requested');
      assert.equal(
        loaded.row.attached,
        undefined,
        'the parent attaches so the protected frame is loaded and refused'
      );
      stayedClosed(loaded, 'a protected remote owner', 'protected');
    }
  } else {
    assert.ok(measured.childRequested, 'child never requested');
    stayedClosed(measured, 'a protected remote owner', 'protected');
  }
});
