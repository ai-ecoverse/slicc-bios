import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { guardProtected as stockGuard } from '../../src/seed/guard.js';

const own = 'https://seven.sliccy.ai';
const vault = 'https://vault.sliccy.ai';
const ordinary = 'https://ordinary.invalid/page';
const errorPage = 'chrome-error://chromewebdata/';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const SEED = new URL('../../src/seed/', import.meta.url);

const hosts = [
  ['seven', 'seven.sliccy.ai', `${own}/doc`],
  ['vault', 'vault.sliccy.ai', `${vault}/x`],
];

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link', version: '1.60.0' }],
  ['extension', { kind: 'extension', version: '7.12.0' }],
];

const MUTANTS = {
  'skip-carrier-blanking': [
    'guard.js',
    "            ...(typeof shown.name === 'string' ? { name: '' } : {}),",
    "            ...(typeof shown.name === 'string' ? { name: shown.name } : {}),",
    "    return { ...entry, url: ERROR_PAGE, userTypedURL: ERROR_PAGE, title: '' };",
    '    return { ...entry, url: ERROR_PAGE, userTypedURL: ERROR_PAGE, title: entry.title };',
    "      if (Object.hasOwn(value, key) && typeof value[key] === 'string') safe[key] = '';",
    "      if (Object.hasOwn(value, key) && typeof value[key] === 'string') safe[key] = value[key];",
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
        `mutant ${mutant}: patch site missing: ${from.slice(0, 60)}`
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
    if (method === 'Page.getNavigationHistory') result = entry.history;
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
        history: {
          currentIndex: 0,
          entries: [{ id: 1, url: frame.url, userTypedURL: frame.url, title: '' }],
        },
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

async function learnFailed(wire, entry, session, failed, host) {
  entry.info.url = errorPage;
  entry.info.title = host;
  entry.tree.frame = {
    id: entry.info.targetId,
    url: errorPage,
    securityOrigin: '://',
    unreachableUrl: failed,
    loaderId: `${entry.info.targetId}-failed`,
    name: host,
  };
  entry.history = {
    currentIndex: 0,
    entries: [{ id: 2, url: failed, userTypedURL: failed, title: host }],
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame: entry.tree.frame },
  });
  wire.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: entry.info },
  });
  await wire.drain(12);
}

for (const [label, host, failed] of hosts) {
  for (const [routeName, route] of routes) {
    test(`after learn, failed ${label} blanks bare-host carriers on tree history targetInfo and events (${routeName})`, async (t) => {
      const wire = protocol(t, route);
      const entry = wire.target(`after-${label}-${routeName}`);
      const session = await attachEnabled(wire, entry);
      await learnFailed(wire, entry, session, failed, host);

      const tree = await wire.send('Page.getFrameTree', {}, session);
      const history = await wire.send('Page.getNavigationHistory', {}, session);
      const info = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
      assert.equal(tree.error, undefined, JSON.stringify(tree));
      assert.equal(history.error, undefined, JSON.stringify(history));
      assert.equal(info.error, undefined, JSON.stringify(info));
      const name = tree.result.frameTree.frame.name;
      assert.equal(name === undefined || name === '', true, 'frame.name is blank');
      assert.equal(history.result.entries[0].title, '');
      assert.equal(
        info.result.targetInfo.title === '' ||
          info.result.targetInfo.title === errorPage ||
          !String(info.result.targetInfo.title).includes(host),
        true,
        `targetInfo.title blanks the host: ${info.result.targetInfo.title}`
      );

      const mark = wire.delivered.length;
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
          guid: `dl-${label}`,
          url: ordinary,
          suggestedFilename: `${host}.bin`,
        },
      });
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: session,
        params: { frame: { ...entry.tree.frame, name: host } },
      });
      await wire.drain(12);
      const events = wire.delivered.slice(mark);
      const windowOpen = events.find((message) => message.method === 'Page.windowOpen');
      const download = events.find((message) => message.method === 'Page.downloadWillBegin');
      assert.ok(windowOpen, 'windowOpen reaches the client as scrubbed metadata');
      assert.equal(windowOpen.params.windowName, '');
      assert.ok(download, 'downloadWillBegin reaches the client as scrubbed metadata');
      assert.equal(download.params.suggestedFilename, '');
      const blob = JSON.stringify({ tree, history, info, events });
      assert.equal(blob.includes(host), false, blob);
      assert.equal(blob.includes('/doc'), false);
      assert.equal(blob.includes('/x'), false);
    });
  }
}

test('mutant: skipping carrier blanking lets a failed protected host title and window name reach the client', {
  timeout: 5000,
}, async (t) => {
  const guardProtected = await loadGuard('skip-carrier-blanking');
  const wire = protocol(t, undefined, guardProtected);
  const [, host, failed] = hosts[0];
  const entry = wire.target('mutant-carrier');
  const session = await attachEnabled(wire, entry);
  await learnFailed(wire, entry, session, failed, host);
  const tree = await wire.send('Page.getFrameTree', {}, session);
  const history = await wire.send('Page.getNavigationHistory', {}, session);
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Page.windowOpen',
    sessionId: session,
    params: { url: ordinary, windowName: host, windowFeatures: [], userGesture: true },
  });
  await wire.drain(12);
  const windowOpen = wire.delivered
    .slice(mark)
    .find((message) => message.method === 'Page.windowOpen');
  const blob = JSON.stringify({ tree, history, windowOpen });
  assert.ok(
    tree.result?.frameTree?.frame?.name === host ||
      history.result?.entries?.[0]?.title === host ||
      windowOpen?.params?.windowName === host ||
      blob.includes(host),
    'mutant must turn the after-learn bare-host blanking row red'
  );
});
