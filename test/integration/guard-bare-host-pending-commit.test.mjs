import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { guardProtected as stockGuard } from '../../src/seed/guard.js';

const own = 'https://seven.sliccy.ai';
const vault = 'https://vault.sliccy.ai';
const ordinary = 'https://ordinary.invalid/page';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const SEED = new URL('../../src/seed/', import.meta.url);
const fullwidth = (host) =>
  [...host]
    .map((ch) => (/[a-z]/.test(ch) ? String.fromCodePoint(0xff00 + ch.charCodeAt(0) - 0x20) : ch))
    .join('');

const hosts = [
  ['seven', 'seven.sliccy.ai', `${own}/doc`],
  ['vault', 'vault.sliccy.ai', `${vault}/x`],
  ['fullwidth-seven', `${fullwidth('seven')}.sliccy.ai`, `${own}/doc`],
  ['punycode-seven', 'xn--fsq.sliccy.ai', `${own}/doc`],
  ['idn-seven', 'seven.ｓｌｉｃｃｙ.ai', `${own}/doc`],
];

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link', version: '1.60.0' }],
  ['extension', { kind: 'extension', version: '7.12.0' }],
];

const MUTANTS = {
  'skip-pending-carrier-blanking': [
    'guard.js',
    `      this.errorDocument(message.sessionId, message.method) ||
      (ERROR_METADATA.has(message.method) && this.pendingCarrier(message))
    );`,
    `      this.errorDocument(message.sessionId, message.method)
    );`,
  ],
};

registerHooks({
  resolve(specifier, context, next) {
    const mutant = context.parentURL && URL.parse(context.parentURL)?.searchParams.get('mutant');
    const resolved = next(specifier, context);
    if (
      !mutant ||
      !MUTANTS[mutant] ||
      !specifier.startsWith('./') ||
      specifier.slice(2) !== 'guard.js'
    )
      return resolved;
    return { ...resolved, url: `${resolved.url}?mutant=${mutant}` };
  },
  load(url, context, next) {
    const mutant = URL.parse(url)?.searchParams.get('mutant');
    const loaded = next(url, context);
    if (!mutant || !MUTANTS[mutant] || !url.split('?')[0].endsWith('/guard.js')) return loaded;
    const patches = MUTANTS[mutant].slice(1);
    let source = String(loaded.source);
    for (let i = 0; i < patches.length; i += 2) {
      const from = patches[i];
      const to = patches[i + 1];
      assert.ok(
        source.includes(from),
        `mutant ${mutant}: patch site missing: ${from.slice(0, 80)}`
      );
      source = source.replace(from, to);
    }
    return { ...loaded, source };
  },
});

const loadGuard = async (mutant) => {
  if (!mutant) return stockGuard;
  return (await import(`${new URL('guard.js', SEED).href}?mutant=${mutant}`)).guardProtected;
};

function protocol(t, route, guardProtected = stockGuard) {
  const targets = new Map();
  const sessions = new Map();
  const pending = new Map();
  const delivered = [];
  let next = 0;
  const key = (id, sessionId) => JSON.stringify([sessionId ?? null, id]);
  const raw = {
    send(text) {
      queueMicrotask(() => respond(JSON.parse(text)));
    },
    close() {},
  };
  const guard = guardProtected(raw, own, new Map(), route);
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.id !== undefined) {
      pending.get(key(message.id, message.sessionId))?.(message);
      pending.delete(key(message.id, message.sessionId));
    } else delivered.push(message);
  };
  t.after(() => guard.close());
  const emit = (message) => raw.onmessage(JSON.stringify(message));
  function respond(message) {
    const { id, method, params = {}, sessionId } = message;
    const targetId = params.targetId ?? sessions.get(sessionId);
    const entry = targets.get(targetId);
    let result = {};
    if (method === 'Target.getTargetInfo') result = { targetInfo: { ...entry?.info, targetId } };
    if (method === 'Target.getTargets')
      result = { targetInfos: [...targets.values()].map((item) => ({ ...item.info })) };
    if (method === 'Target.attachToTarget') {
      const attached = id >= 2 ** 30 ? `guard-${targetId}` : `client-${targetId}-${id}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Page.getFrameTree') result = { frameTree: entry.tree };
    if (method === 'Page.enable') result = {};
    emit({ id, ...(sessionId ? { sessionId } : {}), result });
  }
  return {
    delivered,
    emit,
    send(method, params = {}, sessionId) {
      const id = ++next;
      const answer = new Promise((resolve) => pending.set(key(id, sessionId), resolve));
      guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return answer;
    },
    target(id) {
      const frame = {
        id,
        url: ordinary,
        securityOrigin: new URL(ordinary).origin,
        loaderId: `${id}-loader`,
        name: '',
      };
      const entry = {
        info: {
          targetId: id,
          type: 'page',
          url: frame.url,
          title: '',
          attached: true,
          canAccessOpener: false,
          browserContextId: 'context',
        },
        tree: { frame },
      };
      targets.set(id, entry);
      return entry;
    },
    async drain(n = 8) {
      for (let i = 0; i < n; i++) await flush();
    },
  };
}

async function attachEnabled(wire, entry) {
  wire.emit({ method: 'Target.targetCreated', params: { targetInfo: entry.info } });
  await wire.drain(4);
  const attached = await wire.send('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  const session = attached.result.sessionId;
  await wire.send('Page.enable', {}, session);
  return session;
}

async function armPending(wire, entry, session, pendingUrl) {
  wire.emit({
    method: 'Page.frameStartedNavigating',
    sessionId: session,
    params: {
      frameId: entry.info.targetId,
      url: pendingUrl,
      loaderId: `${entry.info.targetId}-pending`,
      navigationType: 'differentDocument',
    },
  });
  await wire.drain(8);
}

function emitCarriers(wire, entry, session, host) {
  wire.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { ...entry.info, title: host, url: ordinary } },
  });
  wire.emit({
    method: 'Page.windowOpen',
    sessionId: session,
    params: {
      url: ordinary,
      windowName: host,
      windowFeatures: [],
      userGesture: true,
    },
  });
  wire.emit({
    method: 'Page.downloadWillBegin',
    sessionId: session,
    params: {
      frameId: entry.info.targetId,
      guid: `dl-${entry.info.targetId}`,
      url: ordinary,
      suggestedFilename: `${host}.bin`,
    },
  });
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: {
      frame: {
        id: entry.info.targetId,
        url: ordinary,
        securityOrigin: new URL(ordinary).origin,
        loaderId: `${entry.info.targetId}-other`,
        name: host,
      },
    },
  });
}

for (const [label, host, pendingUrl] of hosts) {
  for (const [routeName, route] of routes) {
    test(`while pendingCommit to ${label}, blanks bare-host carriers on windowOpen download title and frame.name (${routeName})`, async (t) => {
      const wire = protocol(t, route);
      const entry = wire.target(`pending-${label}-${routeName}`);
      const session = await attachEnabled(wire, entry);
      await armPending(wire, entry, session, pendingUrl);
      const mark = wire.delivered.length;
      emitCarriers(wire, entry, session, host);
      await wire.drain(12);
      const events = wire.delivered.slice(mark);
      const windowOpen = events.find((message) => message.method === 'Page.windowOpen');
      const download = events.find((message) => message.method === 'Page.downloadWillBegin');
      const info = events.find((message) => message.method === 'Target.targetInfoChanged');
      const navigated = events.find((message) => message.method === 'Page.frameNavigated');
      assert.ok(windowOpen, 'windowOpen reaches the client');
      assert.equal(windowOpen.params.windowName, '');
      assert.ok(download, 'downloadWillBegin reaches the client');
      assert.equal(download.params.suggestedFilename, '');
      assert.ok(info, 'targetInfoChanged reaches the client');
      assert.equal(
        info.params.targetInfo.title === '' ||
          info.params.targetInfo.title === ordinary ||
          new URL(ordinary).origin === info.params.targetInfo.title ||
          !String(info.params.targetInfo.title).includes(host),
        true,
        `title blanks the host: ${info.params.targetInfo.title}`
      );
      assert.ok(navigated, 'frameNavigated reaches the client');
      const name = navigated.params.frame?.name;
      assert.equal(name === undefined || name === '', true, 'frame.name is blank');
      const blob = JSON.stringify(events);
      assert.equal(blob.includes(host), false, blob);
    });
  }
}

for (const [routeName, route] of routes) {
  test(`an ordinary commit clears pendingCommit bare-host blanking (${routeName})`, async (t) => {
    const wire = protocol(t, route);
    const entry = wire.target(`clear-${routeName}`);
    const session = await attachEnabled(wire, entry);
    const pendingLoader = `${entry.info.targetId}-pending`;
    const pendingUrl = hosts[0][2];
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: session,
      params: {
        frameId: entry.info.targetId,
        url: pendingUrl,
        loaderId: pendingLoader,
        navigationType: 'differentDocument',
      },
    });
    await wire.drain(8);
    const whilePending = wire.delivered.length;
    wire.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { ...entry.info, title: hosts[0][1] } },
    });
    await wire.drain(8);
    const pendingTitle = wire.delivered
      .slice(whilePending)
      .find((message) => message.method === 'Target.targetInfoChanged')?.params?.targetInfo?.title;
    assert.equal(
      pendingTitle === '' ||
        pendingTitle === ordinary ||
        pendingTitle === new URL(ordinary).origin ||
        !String(pendingTitle).includes(hosts[0][1]),
      true,
      `title blanks while pending: ${pendingTitle}`
    );

    entry.info.url = ordinary;
    entry.tree.frame = {
      id: entry.info.targetId,
      url: ordinary,
      securityOrigin: new URL(ordinary).origin,
      loaderId: pendingLoader,
      name: '',
    };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: entry.tree.frame },
    });
    await wire.drain(8);

    const mark = wire.delivered.length;
    wire.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { ...entry.info, title: 'ordinary-title' } },
    });
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: {
        frame: {
          id: entry.info.targetId,
          url: ordinary,
          securityOrigin: new URL(ordinary).origin,
          loaderId: `${entry.info.targetId}-after`,
          name: 'ordinary-frame',
        },
      },
    });
    await wire.drain(12);
    const later = wire.delivered.slice(mark);
    assert.equal(
      later.find((message) => message.method === 'Target.targetInfoChanged')?.params.targetInfo
        .title,
      'ordinary-title'
    );
    assert.equal(
      later.find((message) => message.method === 'Page.frameNavigated')?.params.frame.name,
      'ordinary-frame'
    );
  });

  test(`ordinary page keeps ordinary windowName and title without pendingCommit (${routeName})`, async (t) => {
    const wire = protocol(t, route);
    const entry = wire.target(`ordinary-${routeName}`);
    const session = await attachEnabled(wire, entry);
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Page.windowOpen',
      sessionId: session,
      params: {
        url: ordinary,
        windowName: 'ordinary-window',
        windowFeatures: [],
        userGesture: true,
      },
    });
    wire.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { ...entry.info, title: 'ordinary-title' } },
    });
    wire.emit({
      method: 'Page.downloadWillBegin',
      sessionId: session,
      params: {
        frameId: entry.info.targetId,
        guid: `dl-ordinary-${routeName}`,
        url: ordinary,
        suggestedFilename: 'ordinary-download.bin',
      },
    });
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: {
        frame: {
          id: entry.info.targetId,
          url: ordinary,
          securityOrigin: new URL(ordinary).origin,
          loaderId: `${entry.info.targetId}-ordinary`,
          name: 'ordinary-frame',
        },
      },
    });
    await wire.drain(12);
    const events = wire.delivered.slice(mark);
    assert.equal(
      events.find((message) => message.method === 'Page.windowOpen')?.params.windowName,
      'ordinary-window'
    );
    assert.equal(
      events.find((message) => message.method === 'Target.targetInfoChanged')?.params.targetInfo
        .title,
      'ordinary-title'
    );
    assert.equal(
      events.find((message) => message.method === 'Page.downloadWillBegin')?.params
        .suggestedFilename,
      'ordinary-download.bin'
    );
    assert.equal(
      events.find((message) => message.method === 'Page.frameNavigated')?.params.frame.name,
      'ordinary-frame'
    );
  });
}

test('mutant: skipping pending-commit carrier blanking lets a protected bare host reach the client', {
  timeout: 5000,
}, async (t) => {
  const guardProtected = await loadGuard('skip-pending-carrier-blanking');
  const wire = protocol(t, undefined, guardProtected);
  const [, host, pendingUrl] = hosts[0];
  const entry = wire.target('mutant-pending-carrier');
  const session = await attachEnabled(wire, entry);
  await armPending(wire, entry, session, pendingUrl);
  const mark = wire.delivered.length;
  emitCarriers(wire, entry, session, host);
  await wire.drain(12);
  const events = wire.delivered.slice(mark);
  const blob = JSON.stringify(events);
  assert.ok(
    events.some((message) => message.params?.windowName === host) ||
      events.some((message) => message.params?.suggestedFilename?.includes(host)) ||
      events.some((message) => message.params?.targetInfo?.title === host) ||
      events.some((message) => message.params?.frame?.name === host) ||
      blob.includes(host),
    'mutant must turn the pending-commit bare-host blanking row red'
  );
});
