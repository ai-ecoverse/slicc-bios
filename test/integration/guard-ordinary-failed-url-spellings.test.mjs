import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import {
  guardProtected as stockGuard,
  ordinaryFailedUrl as stockOrdinaryFailedUrl,
  protection as stockProtection,
} from '../../src/seed/guard.js';

const own = 'https://seven.sliccy.ai';
const vault = 'https://vault.sliccy.ai';
const errorPage = 'chrome-error://chromewebdata/';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const SEED = new URL('../../src/seed/', import.meta.url);
const fullwidth = (host) =>
  [...host]
    .map((ch) => (/[a-z]/.test(ch) ? String.fromCodePoint(0xff00 + ch.charCodeAt(0) - 0x20) : ch))
    .join('');

const protectedSpellings = [
  ['percent-encoded seven', 'https://%73even.sliccy.ai/doc?path=/private'],
  ['fullwidth seven', `https://${fullwidth('seven')}.sliccy.ai/doc?path=/private`],
  ['IDN domain labels', 'https://seven.ｓｌｉｃｃｙ.ai/doc?path=/private'],
  ['punycode under sliccy.ai', 'https://xn--fsq.sliccy.ai/doc?path=/private'],
  ['percent-encoded vault', 'https://%76ault.sliccy.ai/x?path=/private'],
  ['plain seven', `${own}/doc?path=/private`],
  ['plain vault', `${vault}/x?path=/private`],
];

const ordinarySpellings = [
  ['percent-encoded ordinary', 'https://%6frdinary.invalid/unreachable'],
  ['fullwidth ordinary', `https://${fullwidth('ordinary')}.invalid/unreachable`],
  ['IDN ordinary', 'https://例子.invalid/unreachable'],
  ['punycode ordinary', 'https://xn--fsq.invalid/unreachable'],
  ['plain ordinary', 'https://ordinary.invalid/unreachable'],
];

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link', version: '1.60.0' }],
  ['extension', { kind: 'extension', version: '7.12.0' }],
];

const MUTANTS = {
  'ignore-protected-host': [
    'guard.js',
    '  if (parsed.username || parsed.password) return false;\n  return !is.url(failed);\n}',
    '  if (parsed.username || parsed.password) return false;\n  return true;\n}',
  ],
  'skip-history-failed-url-hide': [
    'guard.js',
    "    if (!this.unsafeUrl(entry.url) && !this.hides(entry) && !entry.url.startsWith('chrome-error:'))\n      return entry;\n    return { ...entry, url: ERROR_PAGE, userTypedURL: ERROR_PAGE, title: '' };",
    "    if (!entry.url.startsWith('chrome-error:'))\n      return entry;\n    return { ...entry, url: ERROR_PAGE, userTypedURL: ERROR_PAGE, title: '' };",
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
    const [file, from, to] = MUTANTS[mutant];
    const source = String(loaded.source);
    assert.ok(url.split('?')[0].endsWith(`/${file}`));
    assert.ok(source.includes(from), `mutant ${mutant}: ${from} is not in the source`);
    return { ...loaded, source: source.replace(from, to) };
  },
});

const load = async (mutant) => {
  if (!mutant) {
    return {
      guardProtected: stockGuard,
      ordinaryFailedUrl: stockOrdinaryFailedUrl,
      protection: stockProtection,
    };
  }
  return import(`${new URL('guard.js', SEED).href}?mutant=${mutant}`);
};

const plainFrame = (id, url = 'https://ordinary.invalid/page') => ({
  id,
  url,
  securityOrigin: new URL(url).origin,
  loaderId: `${id}-loader`,
});

const errorFrame = (id, unreachableUrl) => ({
  id,
  url: errorPage,
  securityOrigin: '://',
  unreachableUrl,
  loaderId: `${id}-error`,
});

function protocol(t, route, guardProtected = stockGuard) {
  const targets = new Map();
  const sessions = new Map();
  const pending = new Map();
  let next = 0;
  const key = (id, sessionId) => JSON.stringify([sessionId ?? null, id]);
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      queueMicrotask(() => respond(message));
    },
    close() {},
  };
  const guard = guardProtected(raw, own, new Map(), route);
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    pending.get(key(message.id, message.sessionId))?.(message);
    pending.delete(key(message.id, message.sessionId));
  };
  t.after(() => guard.close());
  const emit = (message) => raw.onmessage(JSON.stringify(message));
  function respond(message) {
    const { id, method, params = {}, sessionId } = message;
    const targetId = params.targetId ?? sessions.get(sessionId);
    const entry = targets.get(targetId);
    let result = {};
    if (method === 'Target.getTargetInfo') result = { targetInfo: entry?.info ?? { targetId } };
    if (method === 'Target.attachToTarget') {
      const attached = id >= 2 ** 30 ? `guard-${targetId}` : `client-${targetId}-${id}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Page.getFrameTree') result = { frameTree: entry.tree };
    if (method === 'Page.getNavigationHistory')
      result = entry.history ?? {
        currentIndex: 0,
        entries: [{ id: 1, url: entry.info.url, userTypedURL: entry.info.url, title: '' }],
      };
    if (method === 'DOM.getDocument')
      result = { root: { nodeId: 1, nodeName: '#document', children: [] } };
    emit({ id, ...(sessionId ? { sessionId } : {}), result });
  }
  return {
    emit,
    send(method, params = {}, sessionId) {
      const id = ++next;
      const answer = new Promise((resolve) => pending.set(key(id, sessionId), resolve));
      guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return answer;
    },
    target(id, frame = plainFrame(id)) {
      const entry = {
        info: { targetId: id, type: 'page', url: frame.url, title: '' },
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

function markers(failed) {
  const parsed = new URL(failed);
  return [failed, parsed.pathname, parsed.search, 'path=/private', '/private'].filter(
    (mark) => typeof mark === 'string' && mark.length > 0 && mark !== '/'
  );
}

async function surfaceAfterFailedLoad(wire, entry, failed, title) {
  const attached = await wire.send('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  assert.equal(attached.error, undefined);
  await wire.drain(10);
  entry.info.url = errorPage;
  entry.info.title = title;
  entry.tree = { frame: errorFrame(entry.info.targetId, failed) };
  entry.tree.frame.name = title;
  entry.history = {
    currentIndex: 0,
    entries: [{ id: 1, url: failed, userTypedURL: failed, title }],
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: attached.result.sessionId,
    params: { frame: entry.tree.frame },
  });
  await wire.drain(10);
  const tree = await wire.send('Page.getFrameTree', {}, attached.result.sessionId);
  const history = await wire.send('Page.getNavigationHistory', {}, attached.result.sessionId);
  return { tree, history, blob: JSON.stringify({ tree, history }) };
}

for (const [label, failed] of protectedSpellings) {
  test(`ordinaryFailedUrl treats protected ${label} as unproven`, async () => {
    const { ordinaryFailedUrl, protection } = await load();
    assert.equal(ordinaryFailedUrl(failed, protection(own)), false, label);
  });
}

for (const [label, failed] of ordinarySpellings) {
  test(`ordinaryFailedUrl treats ordinary ${label} as ordinary`, async () => {
    const { ordinaryFailedUrl, protection } = await load();
    assert.equal(ordinaryFailedUrl(failed, protection(own)), true, label);
  });
}

for (const [label, failed] of protectedSpellings) {
  for (const [routeName, route] of routes) {
    test(`protected failed ${label} blanks url path and title (${routeName})`, async (t) => {
      const wire = protocol(t, route);
      const entry = wire.target(`prot-${label}-${routeName}`);
      const title = new URL(failed).hostname;
      const { tree, history, blob } = await surfaceAfterFailedLoad(wire, entry, failed, title);
      assert.equal(tree.error, undefined, JSON.stringify(tree));
      assert.equal(history.error, undefined, JSON.stringify(history));
      assert.equal(tree.result.frameTree.frame.url, errorPage);
      const name = tree.result.frameTree.frame.name;
      assert.equal(name === undefined || name === '', true, 'frame.name is blank');
      assert.equal(history.result.entries[0].title, '');
      for (const mark of markers(failed)) {
        assert.equal(blob.includes(mark), false, `${label}: ${mark}`);
      }
      assert.equal(blob.includes(title), false, `${label}: host title`);
    });
  }
}

for (const [label, failed] of ordinarySpellings) {
  for (const [routeName, route] of routes) {
    test(`ordinary failed ${label} keeps history title (${routeName})`, async (t) => {
      const wire = protocol(t, route);
      const entry = wire.target(`ord-${label}-${routeName}`);
      const title = 'ordinary-title';
      const { history, blob } = await surfaceAfterFailedLoad(wire, entry, failed, title);
      assert.equal(history.result.entries[0].title, title);
      assert.equal(blob.includes(title), true);
    });
  }
}

test('mutant: ignoring the protected-host check treats protected spellings as ordinary', async () => {
  const { ordinaryFailedUrl, protection } = await load('ignore-protected-host');
  const is = protection(own);
  const flipped = protectedSpellings.filter(([, failed]) => ordinaryFailedUrl(failed, is));
  assert.equal(
    flipped.length,
    protectedSpellings.length,
    `mutant must flip protected spellings to ordinary: ${JSON.stringify(flipped.map(([label]) => label))}`
  );
});

test('mutant: skipping the history failed-url hide lets a protected spelling reach the client', {
  timeout: 5000,
}, async (t) => {
  const { guardProtected } = await load('skip-history-failed-url-hide');
  const wire = protocol(t, undefined, guardProtected);
  const [, failed] = protectedSpellings[0];
  const entry = wire.target('mutant-percent');
  const { blob } = await surfaceAfterFailedLoad(wire, entry, failed, new URL(failed).hostname);
  assert.ok(
    markers(failed).some((mark) => blob.includes(mark)) || blob.includes(new URL(failed).hostname),
    'mutant must turn the protected percent-encoded blanking row red'
  );
});
