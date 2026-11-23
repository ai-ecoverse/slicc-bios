import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { PROTECTED, guardProtected as stockGuard } from '../../src/seed/guard.js';

const ordinary = 'https://ordinary.invalid/page';
const protectedUrl = 'https://seven.sliccy.ai/doc';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const SEED = new URL('../../src/seed/', import.meta.url);

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link', version: '1.60.0' }],
  ['extension', { kind: 'extension', version: '7.12.0' }],
];

const MUTANTS = {
  'skip-pending-commit': [
    'guard.js',
    '    if (this.is.url(url)) {\n      this.pendingCommit.add(id);\n      open.commit = frameId;\n    } else this.pendingCommit.delete(id);',
    '    this.pendingCommit.delete(id);',
  ],
  'skip-started-hold': [
    'guard.js',
    '    if (NAVIGATED.has(method)) return !this.armed(sessionId) && this.is.url(params.url);',
    '    if (NAVIGATED.has(method)) return false;',
    '    if (sessionId && this.naming({ ...message, method })) return;\n',
    '    if (false && sessionId && this.naming({ ...message, method })) return;\n',
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
  const guard = guardProtected(raw, 'https://seven.sliccy.ai', new Map(), route);
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    delivered.push(message);
    if (message.id !== undefined) {
      pending.get(key(message.id, message.sessionId))?.(message);
      pending.delete(key(message.id, message.sessionId));
    }
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
      result = {
        currentIndex: 0,
        entries: [{ id: 1, url: entry.info.url, userTypedURL: entry.info.url, title: '' }],
      };
    if (method === 'Page.enable' || method === 'Page.navigate') result = {};
    if (method === 'Runtime.evaluate')
      result = { result: { type: 'number', value: 1, description: '1' } };
    if (method === 'Page.captureScreenshot')
      result = { data: Buffer.from('shot').toString('base64') };
    if (method === 'Input.dispatchKeyEvent') result = {};
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

async function armProtectedStart(wire, entry) {
  wire.emit({ method: 'Target.targetCreated', params: { targetInfo: entry.info } });
  await wire.drain(4);
  const attached = await wire.send('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  const session = attached.result.sessionId;
  await wire.send('Page.enable', {}, session);
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Page.frameStartedNavigating',
    sessionId: session,
    params: {
      frameId: entry.info.targetId,
      url: protectedUrl,
      loaderId: `${entry.info.targetId}-pending`,
      navigationType: 'differentDocument',
    },
  });
  await wire.drain(12);
  return { session, mark };
}

for (const [routeName, route] of routes) {
  test(`armed frameStartedNavigating to a protected URL withholds the event and refuses content while pendingCommit (${routeName})`, async (t) => {
    const wire = protocol(t, route);
    const entry = wire.target(`f8-${routeName}`);
    const { session, mark } = await armProtectedStart(wire, entry);
    const started = wire.delivered
      .slice(mark)
      .filter((message) => message.method === 'Page.frameStartedNavigating');
    assert.equal(started.length, 0, 'protected frameStartedNavigating stays held');
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error?.message,
      PROTECTED
    );
    assert.equal(
      (await wire.send('Page.captureScreenshot', {}, session)).error?.message,
      PROTECTED
    );
    assert.equal(
      (await wire.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, session)).error
        ?.message,
      PROTECTED
    );
    assert.equal(
      (await wire.send('Page.navigate', { url: ordinary }, session)).error,
      undefined,
      'navigate remains allowed during pendingCommit'
    );
  });
}

test('mutant: skipping pendingCommit arming lets content reach the browser during a protected start', {
  timeout: 5000,
}, async (t) => {
  const guardProtected = await loadGuard('skip-pending-commit');
  const wire = protocol(t, undefined, guardProtected);
  const entry = wire.target('f8-mutant-commit');
  const { session } = await armProtectedStart(wire, entry);
  const answer = await wire.send('Runtime.evaluate', { expression: '1' }, session);
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  assert.equal(answer.result?.result?.value, 1);
});

test('mutant: skipping the started-navigating hold delivers a protected frameStartedNavigating', {
  timeout: 5000,
}, async (t) => {
  const guardProtected = await loadGuard('skip-started-hold');
  const wire = protocol(t, undefined, guardProtected);
  const entry = wire.target('f8-mutant-hold');
  const { mark } = await armProtectedStart(wire, entry);
  const started = wire.delivered
    .slice(mark)
    .filter((message) => message.method === 'Page.frameStartedNavigating');
  assert.ok(started.length >= 1, 'mutant must turn the held-event row red');
  assert.ok(
    started.some(
      (message) =>
        typeof message.params?.url === 'string' && message.params.url.includes('seven.sliccy.ai')
    ),
    JSON.stringify(started)
  );
});
