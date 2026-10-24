import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { markerPixels } from './guard-paint-pixels.mjs';
import { guardHost } from './guard-set.mjs';

const hits = [];
const pages = {
  '/marker': (p) =>
    `<!doctype html><title>marker</title><style>html,body{margin:0;height:100%;background:#ff00ff;color:#ff00ff;--marker:paint-marker-${p.get('n')}}</style><button aria-label="paint-marker-${p.get('n')}">paint-marker-${p.get('n')}</button><script>const n=${JSON.stringify(p.get('n'))};for(const k of ['mousedown','keydown'])addEventListener(k,()=>navigator.sendBeacon('/hit?n='+n+'&k='+k))</script>`,
  '/frame': (p) =>
    `<!doctype html><title>frame</title><style>html,body{margin:0;height:100%;background:#fff}iframe{position:absolute;left:0;top:0;width:600px;height:400px;border:0}</style><iframe src="${p.get('src').replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`,
  '/empty': () =>
    '<!doctype html><title>empty</title><style>html,body{margin:0;height:100%;background:#fff}</style>',
};
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/hit') {
    hits.push({ host: url.hostname, n: url.searchParams.get('n'), k: url.searchParams.get('k') });
    res.writeHead(204, { 'access-control-allow-origin': '*' });
    return res.end();
  }
  const page = pages[url.pathname];
  res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  return res.end(page ? page(url.searchParams) : 'missing');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const port = server.address().port;
const at = (host, path = '') => `http://${host}:${port}${path}`;
const OWN = at('client.example.test');
const framing = (host, src) => at(host, `/frame?src=${encodeURIComponent(src)}`);
const marker = (host, n) => at(host, `/marker?n=${n}`);

export const LAYOUTS = {
  local: (n) => framing('ordinary.example.test', marker('client.example.test', n)),
  remote: (n) => framing('ordinary.example.test', marker('seven.sliccy.ai', n)),
  nested: (n) =>
    framing('localhost', framing('middle.example.test', marker('client.example.test', n))),
  ordinary: (n) => framing('ordinary.example.test', marker('localhost', n)),
};
const LATE = ['late-local', 'late-remote', 'late-nested'];
export const GUARDED = ['local', 'remote', 'nested'];

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REFUSED = /^slicc: refused:/;
const MARKED = 1000;

async function outcome(promise) {
  try {
    return { ok: true, result: await promise };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

const verdict = (answer, shows) =>
  !answer.ok
    ? REFUSED.test(answer.error)
      ? 'refused'
      : `error: ${answer.error.slice(0, 80)}`
    : shows(answer.result)
      ? 'shown'
      : 'none';

async function until(check, ms) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await pause(200);
  }
  return last;
}

async function shot(client, session) {
  const answer = await outcome(client.send('Page.captureScreenshot', { format: 'png' }, session));
  if (!answer.ok) return REFUSED.test(answer.error) ? 'refused' : `error: ${answer.error}`;
  return markerPixels(answer.result.data);
}

async function cast(client, session, ms, during) {
  const frames = [];
  let read = client.events.length;
  let since = null;
  const start = await outcome(
    client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }, session)
  );
  const collect = () => {
    for (; read < client.events.length; read += 1) {
      const event = client.events[read];
      if (event.method !== 'Page.screencastFrame' || event.sessionId !== session) continue;
      frames.push(markerPixels(event.params.data));
      void outcome(
        client.send('Page.screencastFrameAck', { sessionId: event.params.sessionId }, session)
      );
    }
  };
  const end = Date.now() + ms;
  while (Date.now() < end) {
    collect();
    if (during && since === null && Date.now() > end - ms / 2) {
      since = frames.length;
      await during(() => {
        collect();
        since = frames.length;
      });
    }
    await pause(100);
  }
  collect();
  await outcome(client.send('Page.stopScreencast', {}, session));
  const later = frames.slice(since ?? 0);
  return {
    before: since ?? frames.length,
    start: start.ok ? 'ok' : REFUSED.test(start.error) ? 'refused' : `error: ${start.error}`,
    frames: later.length,
    marked: frames.filter((pixels) => pixels >= MARKED).length,
  };
}

const printable = (text) =>
  text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (found, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

async function reads(client, session, n, frameId) {
  const text = `paint-marker-${n}`;
  const shows = (result) => JSON.stringify(result).includes(text);
  const out = {};
  out.dom = verdict(
    await outcome(client.send('DOM.getDocument', { depth: -1, pierce: true }, session)),
    shows
  );
  out.ax = verdict(
    await outcome(client.send('Accessibility.getFullAXTree', { frameId }, session)),
    shows
  );
  out.snapshot = verdict(
    await outcome(
      client.send('DOMSnapshot.captureSnapshot', { computedStyles: ['background-color'] }, session)
    ),
    (result) => shows(result) || JSON.stringify(result).includes('rgb(255, 0, 255)')
  );
  out.mhtml = verdict(
    await outcome(client.send('Page.captureSnapshot', { format: 'mhtml' }, session)),
    (result) => printable(result.data ?? '').includes(text)
  );
  const read = client.events.length;
  await outcome(client.send('DOM.enable', {}, session));
  const enabled = await outcome(client.send('CSS.enable', {}, session));
  const sheets = () =>
    client.events
      .slice(read)
      .filter((event) => event.method === 'CSS.styleSheetAdded' && event.sessionId === session);
  if (enabled.ok)
    await until(
      async () => sheets().some((event) => event.params.header.frameId === frameId),
      5000
    );
  out.sheets = sheets().map((event) => ({
    frameId: event.params.header.frameId,
    sourceURL: event.params.header.sourceURL,
  }));
  const texts = [];
  for (const sheet of sheets()) {
    const answer = await outcome(
      client.send(
        'CSS.getStyleSheetText',
        { styleSheetId: sheet.params.header.styleSheetId },
        session
      )
    );
    if (!answer.ok) texts.push(answer);
    else if (answer.result.text.includes(text)) texts.push({ ok: true, result: { shown: text } });
  }
  out.css = !enabled.ok
    ? verdict(enabled, () => false)
    : texts.some((answer) => answer.ok)
      ? 'shown'
      : texts.some((answer) => REFUSED.test(answer.error))
        ? 'refused'
        : 'none';
  return out;
}

const PROBES = [
  ['LayerTree.enable', {}],
  ['LayerTree.makeSnapshot', { layerId: 'missing' }],
  ['LayerTree.replaySnapshot', { snapshotId: 'missing' }],
  ['HeadlessExperimental.beginFrame', { screenshot: { format: 'png' } }],
  ['Cast.enable', {}],
  ['Cast.startTabMirroring', { sinkName: 'missing' }],
];

async function probes(client, session) {
  const out = {};
  for (const [method, params] of PROBES) {
    const answer = await outcome(client.send(method, params, session));
    out[method] = answer.ok ? 'passed' : REFUSED.test(answer.error) ? 'refused' : 'chrome error';
  }
  return out;
}

const hitsOf = (n) => hits.filter((hit) => hit.n === n).length;

async function click(client, session, n) {
  const before = hitsOf(n);
  const mouse = (type) =>
    client.send(
      'Input.dispatchMouseEvent',
      { type, x: 300, y: 200, button: 'left', clickCount: 1 },
      session
    );
  const sent = await outcome(
    (async () => {
      await mouse('mouseMoved');
      await mouse('mousePressed');
      await mouse('mouseReleased');
      await client.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'x', code: 'KeyX', text: 'x' },
        session
      );
      await client.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'x', code: 'KeyX' },
        session
      );
    })()
  );
  if (!sent.ok) return REFUSED.test(sent.error) ? 'refused' : `error: ${sent.error}`;
  return (await until(async () => hitsOf(n) > before, 3000)) ? 'reached' : 'none';
}

const evaluate = (client, session, expression) =>
  outcome(client.send('Runtime.evaluate', { expression, awaitPromise: true }, session));

async function frames(unguarded) {
  const { targetInfos } = await unguarded.send('Target.getTargets');
  return targetInfos
    .filter((info) => info.type === 'iframe' && info.url.includes(`:${port}/`))
    .map((info) => new URL(info.url).hostname);
}

async function guardedRow(factory, own, targetId, row, options = {}) {
  const { client, close } = await factory({ own, ...options });
  const attach = await outcome(client.send('Target.attachToTarget', { targetId, flatten: true }));
  if (!attach.ok) {
    row.attach = REFUSED.test(attach.error) ? 'refused' : `error: ${attach.error}`;
    await close();
    return null;
  }
  row.attach = 'ok';
  const session = attach.result.sessionId;
  await outcome(client.send('Page.enable', {}, session));
  return { client, session, close };
}

async function markerFrame(client, raw, n) {
  const targets = (await client.send('Target.getTargets')).targetInfos;
  let session = raw;
  const info = targets.find(
    (info) =>
      info.type === 'iframe' &&
      (info.url === marker('seven.sliccy.ai', n) ||
        info.url === marker('localhost', n) ||
        info.url === framing('middle.example.test', marker('client.example.test', n)))
  );
  if (info)
    session = (
      await client.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
    ).sessionId;
  const tree = (await client.send('Page.getFrameTree', {}, session)).frameTree;
  const walk = (tree) => [tree.frame, ...(tree.childFrames ?? []).flatMap(walk)];
  const frame = walk(tree).find((frame) => frame.url.includes(`/marker?n=${n}`));
  assert.ok(frame, 'the marker frame is placed in its renderer');
  return { session, frameId: frame.id, remote: Boolean(info) };
}

function driveState(row) {
  if (
    typeof row.shot === 'number' &&
    row.shot >= MARKED &&
    row.cast.marked > 0 &&
    row.input === 'reached'
  )
    return 'drivable';
  if (
    row.shot === 'refused' &&
    row.cast.frames === 0 &&
    row.cast.start === 'refused' &&
    row.input === 'refused'
  )
    return 'closed';
  return 'failed';
}

async function drive(client, session, n) {
  const ready = await until(async () => {
    const pixels = await shot(client, session);
    return typeof pixels === 'number' && pixels >= MARKED ? { pixels } : null;
  }, 10000);
  const row = {
    shot: ready ? ready.pixels : await shot(client, session),
    cast: await cast(client, session, 1500),
    input: await click(client, session, n),
  };
  row.state = driveState(row);
  return row;
}

async function ordinaryFrames(unguarded, raw, client, session, n) {
  const added = randomBytes(6).toString('hex');
  await evaluate(
    unguarded,
    raw,
    `new Promise((done) => { const f = document.createElement('iframe'); f.id = 'added-frame'; f.src = ${JSON.stringify(marker('localhost', added))}; f.onload = done; document.body.append(f); })`
  );
  const control = {
    shot: await shot(unguarded, raw),
    cast: await cast(unguarded, raw, 1500),
    input: await click(unguarded, raw, added),
    frames: await frames(unguarded),
  };
  const inserted = { control, ...(await drive(client, session, added)) };
  inserted.snapshot = verdict(
    await outcome(client.send('DOM.getDocument', { depth: 1 }, session)),
    (result) => result.root?.nodeName === '#document'
  );
  await evaluate(unguarded, raw, "document.querySelector('#added-frame').remove()");
  const removed = {
    control: {
      shot: await shot(unguarded, raw),
      cast: await cast(unguarded, raw, 1500),
      input: await click(unguarded, raw, n),
    },
    ...(await drive(client, session, n)),
  };
  return { added: inserted, removed };
}

async function measure(factory, unguarded, own, route, layout) {
  const n = randomBytes(6).toString('hex');
  const row = { route, layout };
  const { targetId } = await unguarded.send('Target.createTarget', { url: LAYOUTS[layout](n) });
  try {
    const { sessionId: raw } = await unguarded.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await unguarded.send('Target.activateTarget', { targetId });
    row.control = {
      shot: await until(async () => {
        const pixels = await shot(unguarded, raw);
        return pixels >= MARKED ? pixels : 0;
      }, 20000),
    };
    row.frames = await frames(unguarded);
    row.control.cast = await cast(unguarded, raw, 1500);
    const leaf = await markerFrame(unguarded, raw, n);
    row.placement = { remote: leaf.remote, frameId: leaf.frameId };
    row.control.reads = await reads(unguarded, leaf.session, n, leaf.frameId);
    row.control.input = await click(unguarded, raw, n);
    const guarded = await guardedRow(factory, own, targetId, row);
    if (!guarded) return row;
    const { client, session, close } = guarded;
    try {
      row.shot = await shot(client, session);
      row.cast = await cast(client, session, 2000);
      row.reads = await reads(client, session, n, leaf.frameId);
      row.probes = await probes(client, session);
      row.input = await click(client, session, n);
      if (layout === 'ordinary') {
        row.state = driveState(row);
        Object.assign(row, await ordinaryFrames(unguarded, raw, client, session, n));
      }
      if (layout === 'remote' || layout === 'nested') {
        await evaluate(unguarded, raw, "document.querySelector('iframe').remove()");
        await until(async () => (await shot(unguarded, raw)) === 0, 10000);
        row.again = await until(async () => {
          const pixels = await shot(client, session);
          return pixels === 0 ? { pixels } : null;
        }, 10000);
      }
    } finally {
      await close();
    }
    return row;
  } finally {
    await outcome(unguarded.send('Target.closeTarget', { targetId }));
  }
}

async function measureLate(factory, unguarded, own, route, layout) {
  const n = randomBytes(6).toString('hex');
  const row = { route, layout };
  const url = LAYOUTS[layout.slice(5)](n);
  const { targetId } = await unguarded.send('Target.createTarget', { url });
  try {
    const { sessionId: raw } = await unguarded.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await unguarded.send('Page.enable', {}, raw);
    if (layout === 'late-local') await unguarded.send('Runtime.enable', {}, raw);
    await unguarded.send('Target.activateTarget', { targetId });
    row.preloaded = await until(async () => {
      const pixels = await shot(unguarded, raw);
      return pixels >= MARKED ? pixels : 0;
    }, 20000);
    const history = await unguarded.send('Page.getNavigationHistory', {}, raw);
    const entry = history.entries.find((entry) => entry.url === url);
    assert.ok(entry, 'the preloaded page has a history entry');
    await unguarded.send(
      'Page.navigate',
      { url: at(layout === 'late-local' ? 'localhost' : 'ordinary.example.test', '/empty') },
      raw
    );
    await until(
      async () =>
        (await unguarded.send('Page.getFrameTree', {}, raw)).frameTree.frame.url.endsWith('/empty'),
      10000
    );
    const guarded = await guardedRow(factory, own, targetId, row, { paintDelay: 1500 });
    if (!guarded) return row;
    const { client, session, close } = guarded;
    try {
      if (layout === 'late-local') await client.send('Runtime.enable', {}, session);
      const mark = unguarded.events.length;
      let pendingShot;
      let settled = false;
      row.cast = await cast(client, session, 6000, async (mark) => {
        pendingShot = shot(client, session).then((result) => {
          settled = true;
          return result;
        });
        await pause(100);
        row.pending = !settled;
        await unguarded.send('Page.navigateToHistoryEntry', { entryId: entry.id }, raw);
        row.locked = await shot(client, session);
        mark();
      });
      row.lateShot = await pendingShot;
      row.restore = unguarded.events
        .slice(mark)
        .find(
          (event) =>
            event.sessionId === raw &&
            event.method === 'Page.frameNavigated' &&
            event.params.frame.url === url
        )?.params.type;
      row.control = {
        shot: await until(async () => {
          const pixels = await shot(unguarded, raw);
          return pixels >= MARKED ? pixels : 0;
        }, 10000),
      };
      row.frames = await frames(unguarded);
      row.shot = await shot(client, session);
      if (layout === 'late-local') {
        const context = await until(
          async () =>
            unguarded.events
              .slice(mark)
              .find(
                (event) =>
                  event.sessionId === raw &&
                  event.method === 'Runtime.executionContextCreated' &&
                  event.params.context.origin.startsWith(OWN)
              ),
          5000
        );
        assert.ok(context, 'a protected local context was created after attach');
        row.contextShown = client.events.some(
          (event) =>
            event.method === 'Runtime.executionContextCreated' &&
            event.params.context.origin.startsWith(OWN)
        );
        row.cut = verdict(
          await outcome(
            client.send('Runtime.evaluate', { expression: '42', returnByValue: true }, session)
          ),
          () => true
        );
        const before = hitsOf(n);
        row.runtime = verdict(
          await outcome(
            client.send(
              'Runtime.evaluate',
              {
                contextId: context.params.context.id,
                expression: `navigator.sendBeacon('/hit?n=${n}&k=runtime')`,
                returnByValue: true,
              },
              session
            )
          ),
          () => true
        );
        row.runtimeReached = Boolean(await until(async () => hitsOf(n) > before, 2000));
      }
    } finally {
      await close();
    }
    return row;
  } finally {
    await outcome(unguarded.send('Target.closeTarget', { targetId }));
  }
}

const cell = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value));

function table(rows) {
  const lines = [];
  for (const row of rows) {
    const { route, layout, ...rest } = row;
    for (const [vector, value] of Object.entries(rest)) {
      lines.push(`GUARD-PAINT ${route} ${layout} ${vector} ${cell(value)}`);
    }
  }
  return lines.join('\n');
}

const leaked = (row) => {
  const found = [];
  if (row.attach !== 'ok') return found;
  if (typeof row.shot === 'number' && row.shot > 0) found.push(`shot ${row.shot}px`);
  if (row.cast && (row.cast.frames > 0 || row.cast.marked > 0))
    found.push(`cast ${row.cast.frames} frames, ${row.cast.marked} marked`);
  for (const [read, value] of Object.entries(row.reads ?? {}))
    if (value === 'shown') found.push(read);
  for (const [probe, value] of Object.entries(row.probes ?? {}))
    if (value !== 'refused') found.push(`${probe} ${value}`);
  if (row.input && row.input !== 'refused') found.push(`input ${row.input}`);
  return found;
};

function ordinary(row, route, label) {
  assert.ok(row.control.shot >= MARKED, `${label}: the ordinary marker paints without the guard`);
  assert.ok(row.control.cast.marked > 0, `${label}: the ordinary marker casts without the guard`);
  assert.equal(
    row.control.input,
    'reached',
    `${label}: input reaches the ordinary frame without the guard`
  );
  if (route === 'link' && row.state === 'closed') {
    assert.equal(row.shot, 'refused', `${label}: unplaced link frames close paint`);
    assert.equal(row.cast.frames, 0, `${label}: unplaced link frames close casts`);
    assert.equal(row.input, 'refused', `${label}: unplaced link frames close input`);
    if (row.snapshot !== undefined)
      assert.equal(row.snapshot, 'refused', `${label}: unplaced link frames close DOM`);
  } else {
    assert.equal(
      row.state,
      'drivable',
      `${label}: the ordinary page is fully drivable once placed`
    );
    assert.ok(row.shot >= MARKED, `${label}: the ordinary marker paints through the guard`);
    assert.ok(row.cast.marked > 0, `${label}: the ordinary marker casts through the guard`);
    if (row.snapshot !== undefined)
      assert.equal(
        row.snapshot,
        'shown',
        `${label}: the placed ordinary page remains snapshot-readable`
      );
    assert.equal(
      row.input,
      'reached',
      `${label}: input reaches the ordinary frame through the guard`
    );
  }
}

export function paint(route) {
  test(`a page that holds a protected frame is locked for paint, DOM and input on the ${route} path`, {
    timeout: 30 * 60 * 1000,
  }, async (t) => {
    const { clientFactory, vault } = await guardHost(t, route);
    const factory = clientFactory(route);
    const own = [OWN, vault];
    const { unguarded } = await factory({ own });
    const rows = [];
    for (const layout of Object.keys(LAYOUTS))
      rows.push(await measure(factory, unguarded, own, route, layout));
    for (const layout of LATE) rows.push(await measureLate(factory, unguarded, own, route, layout));
    if (route !== 'link') {
      const { targetInfos } = await unguarded.send('Target.getTargets');
      rows.push({
        route,
        layout: 'seven',
        vaultFramed: targetInfos.some(
          (info) => info.type === 'iframe' && info.url.startsWith(vault)
        ),
      });
    }
    process.stdout.write(`${table(rows)}\n`);
    const by = Object.fromEntries(rows.map((row) => [row.layout, row]));
    for (const layout of GUARDED) {
      const row = by[layout];
      assert.ok(row.control.shot >= MARKED, `${layout}: the marker paints without the guard`);
      assert.ok(
        row.control.cast.marked > 0,
        `${layout}: a cast without the guard shows the marker`
      );
      assert.equal(row.control.input, 'reached', `${layout}: a click without the guard reaches`);
      for (const read of ['dom', 'ax', 'css'])
        assert.equal(
          row.control.reads[read],
          'shown',
          `${layout}: ${read} reads the marker without the guard`
        );
      assert.equal(
        row.placement.remote,
        layout !== 'local',
        `${layout}: the renderer layout is established`
      );
      assert.deepEqual(
        leaked(row),
        [],
        `${layout}: nothing of the protected frame reaches the client`
      );
      if (row.attach === 'ok' && layout !== 'local')
        assert.equal(
          row.again?.pixels,
          0,
          `${layout}: the page is drivable once the frame is gone`
        );
    }
    for (const layout of LATE) {
      const row = by[layout];
      assert.equal(
        row.restore,
        'BackForwardCacheRestore',
        `${layout}: the protected page is restored without a new document request`
      );
      assert.ok(row.control.shot >= MARKED, `${layout}: the late frame paints without the guard`);
      assert.equal(row.attach, 'ok', `${layout}: the ordinary page attaches`);
      assert.equal(row.cast.start, 'ok', `${layout}: the cast starts on the ordinary page`);
      assert.equal(row.pending, true, `${layout}: the screenshot was pending before the restore`);
      assert.equal(
        row.locked,
        'refused',
        `${layout}: the page is locked before post-lock frames are counted`
      );
      assert.equal(
        row.lateShot,
        'refused',
        `${layout}: a delayed screenshot answer is refused after the page locks`
      );
      assert.equal(row.cast.marked, 0, `${layout}: no cast frame shows the late frame`);
      assert.equal(row.cast.frames, 0, `${layout}: the running cast stops when the page locks`);
      assert.ok(
        row.shot === 'refused' || row.shot === 0,
        `${layout}: a screenshot after the frame appeared shows none of it`
      );
    }
    const local = by['late-local'];
    assert.equal(local.contextShown, false, 'a protected local context is not delivered');
    assert.equal(local.cut, 'refused', 'a protected local child cuts its page session');
    assert.equal(local.runtime, 'refused', 'evaluation in the protected local context is refused');
    assert.equal(
      local.runtimeReached,
      false,
      'evaluation in the protected local context never runs'
    );
    const plain = by.ordinary;
    assert.equal(plain.attach, 'ok', 'an ordinary page attaches');
    assert.equal(plain.placement.remote, true, 'the ordinary frame is cross-process');
    assert.ok(
      plain.added.control.frames.filter((host) => host === 'localhost').length >= 2,
      'the added ordinary frame is cross-process too'
    );
    ordinary(plain, route, 'ordinary preloaded');
    ordinary(plain.added, route, 'ordinary added');
    ordinary(plain.removed, route, 'ordinary removed');
    if (plain.state === 'drivable')
      assert.equal(plain.reads.dom, 'none', 'an ordinary page’s DOM reads');
    if (route !== 'link') assert.equal(by.seven.vaultFramed, true, 'seven frames the vault');
  });
}
