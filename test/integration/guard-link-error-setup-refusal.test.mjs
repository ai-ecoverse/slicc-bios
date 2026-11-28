import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import {
  BLANKED,
  PROTECTED,
  guardProtected as stockGuard,
  UNGUARDED,
} from '../../src/seed/guard.js';

const ordinary = 'https://ordinary.invalid/page';
const nextOrdinary = 'https://ordinary.invalid/moved';
const origin = 'https://seven.sliccy.ai';
const failed = `${origin}/controller/f1-secret`;
const errorPage = 'chrome-error://chromewebdata/';
const HISTORY = "slicc: refused: the target's history may restore a protected document";
const SETUP = new Set([
  'Network.setBypassServiceWorker',
  'Page.enable',
  'DOM.getDocument',
  'DOM.disable',
  'Target.setAutoAttach',
]);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const link = { kind: 'link', version: '1.60.0' };
const routes = [
  ['devtools', undefined],
  ['extension', { kind: 'extension', version: '1.60.0' }],
  ['link', link],
];
const SEED = new URL('../../src/seed/', import.meta.url);
const MUTANTS = {
  'soft-skip-moved': [
    [
      'if (soft && this.revisions.get(targetId) !== revision) soft = false;\n    if (soft) soft = await treeErrorPageProof(this, targetId, nav);\n',
      '',
    ],
    [
      'scope.failed = (soft ? false : broken) || !scope.ownersReady || late || moved;',
      'scope.failed = (soft ? false : broken) || !scope.ownersReady || late;',
    ],
    [
      'this.forgetProbeFrame(frame.id);\n        this.forgetFailedUrl(targetId);\n        revokeErrorPageProof(this, targetId);',
      'this.forgetProbeFrame(frame.id);\n        this.forgetFailedUrl(targetId);',
    ],
  ],
};

const mutantPatches = (entry) => (typeof entry[0] === 'string' ? [[entry[1], entry[2]]] : entry);

registerHooks({
  resolve(specifier, context, next) {
    const mutant = context.parentURL && URL.parse(context.parentURL)?.searchParams.get('mutant');
    const resolved = next(specifier, context);
    if (!mutant || !specifier.startsWith('./') || specifier.slice(2) !== 'guard.js')
      return resolved;
    return { ...resolved, url: `${resolved.url}?mutant=${mutant}` };
  },
  load(url, context, next) {
    const mutant = URL.parse(url)?.searchParams.get('mutant');
    const loaded = next(url, context);
    if (!mutant || !MUTANTS[mutant] || !url.split('?')[0].endsWith('/guard.js')) return loaded;
    let source = String(loaded.source);
    for (const [from, to] of mutantPatches(MUTANTS[mutant])) {
      assert.ok(source.includes(from), `mutant ${mutant}: ${from} is not in the source`);
      source = source.replace(from, to);
    }
    return { ...loaded, source };
  },
});

const loadGuard = async (mutant) => {
  if (!mutant) return stockGuard;
  return (await import(`${new URL('guard.js', SEED).href}?mutant=${mutant}`)).guardProtected;
};

function protocol(
  t,
  {
    refuseSetup = true,
    error = true,
    tabs = new Map(),
    route = link,
    setupDelayMs = 0,
    guardProtected = stockGuard,
  } = {}
) {
  const targets = new Map();
  const sessions = new Map();
  const delivered = [];
  const sent = [];
  const pending = new Map();
  let next = 0;
  let setupDelayLeft = setupDelayMs;
  let afterTree;
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      sent.push(message);
      const delay =
        setupDelayLeft > 0 && message.id >= 2 ** 30 && SETUP.has(message.method)
          ? setupDelayLeft
          : 0;
      if (delay) setupDelayLeft = 0;
      if (delay) setTimeout(() => respond(message), delay);
      else queueMicrotask(() => respond(message));
    },
    close() {},
  };
  const guard = guardProtected(raw, origin, tabs, route);
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    delivered.push(message);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  t.after(() => guard.close());
  const emit = (message) => raw.onmessage(JSON.stringify(message));
  function respond(message) {
    const { id, method, params = {}, sessionId } = message;
    if (refuseSetup && SETUP.has(method) && id >= 2 ** 30) {
      emit({
        id,
        ...(sessionId ? { sessionId } : {}),
        error: { code: -32000, message: HISTORY },
      });
      return;
    }
    const targetId = params.targetId ?? sessions.get(sessionId);
    const target = targets.get(targetId);
    let result = {};
    if (method === 'Target.attachToTarget') {
      const attached = `${id >= 2 ** 30 ? 'guard' : 'client'}-${targetId}-${id}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Target.getTargetInfo') result = { targetInfo: { ...target.info } };
    if (method === 'Target.getTargets')
      result = { targetInfos: [...targets.values()].map((entry) => entry.info) };
    if (method === 'Page.getFrameTree') {
      result = { frameTree: target.tree };
      if (
        afterTree &&
        typeof target?.tree?.frame?.url === 'string' &&
        target.tree.frame.url.startsWith('chrome-error:')
      ) {
        afterTree.seen += 1;
        if (afterTree.seen >= 2) {
          const leave = afterTree.work;
          afterTree = undefined;
          leave();
        }
      }
    }
    if (method === 'Page.getNavigationHistory')
      result = {
        currentIndex: target.history?.currentIndex ?? 0,
        entries: target.history?.entries ?? [
          { id: 1, url: target.info.url, title: target.info.title ?? '' },
        ],
      };
    if (method === 'DOM.getDocument')
      result = { root: { nodeId: 1, nodeName: '#document', children: [] } };
    if (method === 'Runtime.evaluate')
      result = { result: { type: 'string', value: 'f1-secret-content' } };
    if (method === 'Runtime.enable' || method === 'Page.enable' || method === 'Page.reload')
      result = {};
    if (method === 'Page.navigate') {
      if (params.url === BLANKED || params.url === 'about:blank') {
        target.info = { ...target.info, url: params.url, title: '' };
        target.tree = {
          frame: { id: targetId, url: params.url, securityOrigin: 'null' },
        };
      }
      result = { frameId: targetId };
    }
    if (method === 'Page.navigateToHistoryEntry') result = {};
    if (method === 'Target.closeTarget') {
      targets.delete(params.targetId);
      result = { success: true };
    }
    emit({ id, ...(sessionId ? { sessionId } : {}), result });
  }
  function target(id, { asError = error } = {}) {
    const frame = asError
      ? {
          id,
          url: errorPage,
          securityOrigin: '://',
          unreachableUrl: failed,
          loaderId: `${id}-error`,
        }
      : {
          id,
          url: ordinary,
          securityOrigin: new URL(ordinary).origin,
          loaderId: `${id}-ok`,
        };
    const entry = {
      info: { targetId: id, type: 'page', url: frame.url, title: frame.url },
      tree: { frame },
      history: {
        currentIndex: 0,
        entries: [{ id: 1, url: frame.url, title: frame.url }],
      },
    };
    targets.set(id, entry);
    emit({ method: 'Target.targetCreated', params: { targetInfo: { ...entry.info } } });
    return entry;
  }
  function commitError(id) {
    const entry = targets.get(id);
    entry.tree = {
      frame: {
        id,
        url: errorPage,
        securityOrigin: '://',
        unreachableUrl: failed,
        loaderId: `${id}-error`,
      },
    };
    entry.info = { targetId: id, type: 'page', url: errorPage, title: errorPage };
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...entry.info } } });
    emit({
      method: 'Page.frameNavigated',
      sessionId: [...sessions].find(([, targetId]) => targetId === id)?.[0],
      params: { frame: entry.tree.frame },
    });
  }
  function moveOn(id, url = ordinary) {
    const entry = targets.get(id);
    entry.tree = {
      frame: {
        id,
        url,
        securityOrigin: new URL(url).origin,
        loaderId: `${id}-moved`,
      },
    };
    entry.info = { targetId: id, type: 'page', url, title: url };
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...entry.info } } });
    const session = [...sessions].find(([, targetId]) => targetId === id)?.[0];
    if (session)
      emit({
        method: 'Page.frameNavigated',
        sessionId: session,
        params: { frame: entry.tree.frame },
      });
  }
  function changeTarget(id, url) {
    const entry = targets.get(id);
    entry.info = { targetId: id, type: 'page', url, title: url };
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...entry.info } } });
  }
  function navigateFrame(id, url) {
    const entry = targets.get(id);
    entry.tree = {
      frame: {
        id,
        url,
        securityOrigin: url.startsWith('chrome-error:') ? '://' : new URL(url).origin,
        ...(url.startsWith('chrome-error:') ? { unreachableUrl: failed } : {}),
        loaderId: `${id}-${url.startsWith('chrome-error:') ? 'error' : 'moved'}`,
      },
    };
    const session = [...sessions].find(([, targetId]) => targetId === id)?.[0];
    if (session)
      emit({
        method: 'Page.frameNavigated',
        sessionId: session,
        params: { frame: entry.tree.frame },
      });
  }
  function plantErrorTree(id) {
    const entry = targets.get(id);
    entry.tree = {
      frame: {
        id,
        url: errorPage,
        securityOrigin: '://',
        loaderId: `${id}-error-tree`,
      },
    };
  }
  const send = (method, params = {}, sessionId) => {
    const id = ++next;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  };
  return {
    target,
    commitError,
    moveOn,
    changeTarget,
    navigateFrame,
    plantErrorTree,
    afterTree: (work) => {
      afterTree = { work, seen: 0 };
    },
    send,
    delivered,
    sent,
    emit,
    sessions,
    targets,
  };
}

async function proofWaitDocumentCommit(t, order, guardProtected = stockGuard) {
  const wire = protocol(t, { refuseSetup: true, error: false, guardProtected });
  wire.target('moved', { asError: false });
  for (let turn = 0; turn < 4; turn += 1) await flush();
  const attaching = wire.send('Target.attachToTarget', { targetId: 'moved', flatten: true });
  await untilSetup(wire);
  wire.plantErrorTree('moved');
  wire.afterTree(() => {
    if (order === 'target-then-frame') {
      wire.changeTarget('moved', nextOrdinary);
      wire.navigateFrame('moved', nextOrdinary);
    } else {
      wire.navigateFrame('moved', nextOrdinary);
      wire.changeTarget('moved', nextOrdinary);
    }
  });
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await attaching;
  const session = attached.result?.sessionId;
  const evaluate = session
    ? await wire.send('Runtime.evaluate', { expression: '1', returnByValue: true }, session)
    : { error: attached.error };
  const enable = session
    ? await wire.send('Runtime.enable', {}, session)
    : { error: attached.error };
  const document = session
    ? await wire.send('DOM.getDocument', {}, session)
    : { error: attached.error };
  return { wire, attached, session, evaluate, enable, document };
}

function contentRefused(evaluate, enable, document) {
  return [evaluate, document].every((answer) =>
    /^slicc: refused:/.test(answer.error?.message ?? '')
  );
}

async function untilSetup(wire) {
  for (let turn = 0; turn < 80; turn += 1) {
    if (wire.sent.some((message) => message.id >= 2 ** 30 && SETUP.has(message.method))) return;
    await flush();
  }
  assert.fail('bios setup never reached the node');
}

async function refusedContent(wire, session) {
  for (const [method, params] of [
    ['Runtime.evaluate', { expression: '1', returnByValue: true }],
    ['DOM.getDocument', {}],
  ]) {
    const answer = await wire.send(method, params, session);
    assert.match(
      answer.error?.message ?? '',
      /^slicc: refused:/,
      `${method} must stay refused, got ${answer.error?.message ?? 'admitted'}`
    );
    assert.equal(answer.result, undefined, `${method} must not return a result`);
  }
}

test('link: a node history-restore refusal on an ERROR-PAGE target does not block client attach recovery', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t, { refuseSetup: true, error: true });
  wire.target('error');
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', { targetId: 'error', flatten: true });
  const session = attached.result?.sessionId;
  const setup = [
    ...new Set(
      wire.sent
        .filter((message) => message.id >= 2 ** 30 && SETUP.has(message.method))
        .map((m) => m.method)
    ),
  ];
  const row = {
    id: 'F1.error-page-setup-refusal',
    attach: attached.error?.message ?? 'admitted',
    setup,
  };
  console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
  assert.equal(
    attached.error,
    undefined,
    `attached: got false, want true (${attached.error?.message ?? ''})`
  );
  assert.ok(session, 'attached: got false, want true');
  assert.ok(setup.includes('Network.setBypassServiceWorker'), 'bios setup reached the node');

  const info = await wire.send('Target.getTargetInfo', { targetId: 'error' });
  const listed = await wire.send('Target.getTargets', {});
  const listedInfo = listed.result?.targetInfos?.find((entry) => entry.targetId === 'error');
  assert.equal(info.error, undefined);
  assert.equal(info.result.targetInfo.url, errorPage);
  assert.equal(info.result.targetInfo.title, errorPage);
  assert.equal(listedInfo?.url, errorPage);
  assert.equal(listedInfo?.title, errorPage);
  assert.equal(
    JSON.stringify({ info, listed }).includes('f1-secret'),
    false,
    'infoRedacted: got false, want true'
  );

  assert.equal(
    (await wire.send('Runtime.enable', {}, session)).error,
    undefined,
    'Runtime.enable is an admitted error-page privilege'
  );
  await refusedContent(wire, session);
  assert.equal(JSON.stringify(wire.delivered).includes('f1-secret'), false);

  const reload = await wire.send('Page.reload', {}, session);
  assert.equal(reload.error, undefined, 'reload: got false, want true');
  const blank = await wire.send('Page.navigate', { url: BLANKED }, session);
  assert.equal(blank.error, undefined, 'blank: got false, want true');
  const close = await wire.send('Target.closeTarget', { targetId: 'error' });
  assert.equal(close.error, undefined, 'close: got false, want true');
  assert.equal(close.result?.success, true, 'close: got false, want true');
});

test('link: history-restore refusal before the chrome-error proof waits then admits', {
  timeout: 8000,
}, async (t) => {
  const wire = protocol(t, { refuseSetup: true, error: false });
  wire.target('late', { asError: false });
  for (let turn = 0; turn < 4; turn += 1) await flush();
  const attaching = wire.send('Target.attachToTarget', { targetId: 'late', flatten: true });
  await untilSetup(wire);
  wire.commitError('late');
  const attached = await attaching;
  const row = {
    id: 'F1.history-refusal-before-error-proof',
    attach: attached.error?.message ?? 'admitted',
  };
  console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
  assert.equal(
    attached.error,
    undefined,
    `attached after late proof: ${attached.error?.message ?? ''}`
  );
  assert.ok(attached.result?.sessionId);
});

test('twin: history-restore refusal without an error-page proof stays refused after HISTORY_WAIT', {
  timeout: 12000,
}, async (t) => {
  const wire = protocol(t, { refuseSetup: true, error: false });
  wire.target('never', { asError: false });
  for (let turn = 0; turn < 4; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', { targetId: 'never', flatten: true });
  const row = {
    id: 'F1.history-refusal-no-error-proof',
    attach: attached.error?.message ?? 'admitted',
  };
  console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
  assert.equal(attached.error?.message, UNGUARDED);
  assert.equal(attached.result, undefined);
  assert.notEqual(attached.error?.message, PROTECTED);
});

for (const order of ['target-then-frame', 'frame-then-target']) {
  test(`link: a document commit during the history proof wait (${order}) keeps the scope unready and content refused`, {
    timeout: 12000,
  }, async (t) => {
    const { attached, session, evaluate, enable, document } = await proofWaitDocumentCommit(
      t,
      order
    );
    const row = {
      id: `F1.proof-wait-document-commit-${order}`,
      order,
      attach: attached.error?.message ?? 'admitted',
      evaluate: evaluate.error?.message ?? 'admitted',
      enable: enable.error?.message ?? 'admitted',
      document: document.error?.message ?? 'admitted',
    };
    console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
    if (attached.error) {
      assert.ok(
        attached.error.message === UNGUARDED || attached.error.message === PROTECTED,
        `attach refused unexpectedly: ${attached.error.message}`
      );
      return;
    }
    assert.ok(session, 'attach admitted without a session');
    assert.match(
      evaluate.error?.message ?? '',
      /^slicc: refused:/,
      `evaluate must stay refused, got ${evaluate.error?.message ?? 'admitted'}`
    );
    assert.match(
      enable.error?.message ?? '',
      /^slicc: refused:/,
      `Runtime.enable must stay refused, got ${enable.error?.message ?? 'admitted'}`
    );
    assert.match(
      document.error?.message ?? '',
      /^slicc: refused:/,
      `DOM.getDocument must stay refused, got ${document.error?.message ?? 'admitted'}`
    );
  });
}

for (const [name, route] of [
  ['devtools', undefined],
  ['link', link],
]) {
  test(`${name}: an ordinary setup that takes over 5 s still places as on main`, {
    timeout: 20000,
  }, async (t) => {
    const started = Date.now();
    const wire = protocol(t, {
      refuseSetup: false,
      error: false,
      route,
      setupDelayMs: 5500,
    });
    wire.target(`slow-${name}`, { asError: false });
    for (let turn = 0; turn < 4; turn += 1) await flush();
    const attached = await wire.send('Target.attachToTarget', {
      targetId: `slow-${name}`,
      flatten: true,
    });
    const elapsed = Date.now() - started;
    const session = attached.result?.sessionId;
    const enable = session ? await wire.send('Runtime.enable', {}, session) : attached;
    const row = {
      id: `F1.ordinary-setup-over-5s-${name}`,
      route: name,
      elapsed,
      attach: attached.error?.message ?? 'admitted',
      enable: enable.error?.message ?? 'admitted',
    };
    console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
    assert.ok(elapsed >= 5000, `setup must take over 5 s, got ${elapsed}ms`);
    assert.equal(
      attached.error,
      undefined,
      `late must not fail ordinary ${name} placement: ${attached.error?.message ?? ''}`
    );
    assert.ok(session);
    assert.equal(enable.error, undefined, enable.error?.message);
  });
}

function stockCommitRowHolds({ attached, evaluate, enable, document }) {
  if (attached.error) {
    return attached.error.message === UNGUARDED || attached.error.message === PROTECTED;
  }
  return contentRefused(evaluate, enable, document);
}

test('mutant: skipping moved in the soft path is the twin for F1.proof-wait-document-commit', {
  timeout: 20000,
}, async (t) => {
  const guardProtected = await loadGuard('soft-skip-moved');
  const results = [];
  for (const order of ['target-then-frame', 'frame-then-target']) {
    const { attached, evaluate, enable, document } = await proofWaitDocumentCommit(
      t,
      order,
      guardProtected
    );
    const holds = stockCommitRowHolds({ attached, evaluate, enable, document });
    results.push({
      id: `F1.proof-wait-document-commit-${order}`,
      order,
      attach: attached.error?.message ?? 'admitted',
      evaluate: evaluate.error?.message ?? 'admitted',
      enable: enable.error?.message ?? 'admitted',
      document: document.error?.message ?? 'admitted',
      holds,
    });
    assert.equal(
      holds,
      false,
      `mutant soft-skip-moved must turn F1.proof-wait-document-commit-${order} red`
    );
  }
  console.log(
    `ROW-OBSERVED ${JSON.stringify({
      id: 'F1.proof-wait-document-commit-mutant-soft-skip-moved',
      formula: 'drop || moved',
      rows: results,
    })}`
  );
});

test('twin: a HISTORY setup refusal after leaving the error page does not soft-settle on sticky proof', {
  timeout: 12000,
}, async (t) => {
  const wire = protocol(t, { refuseSetup: true, error: true });
  const entry = wire.target('stale');
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const first = await wire.send('Target.attachToTarget', { targetId: 'stale', flatten: true });
  assert.equal(first.error, undefined, first.error?.message);
  const session = first.result.sessionId;
  wire.moveOn('stale', ordinary);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  assert.equal(entry.info.url, ordinary);
  assert.equal(entry.tree.frame.url, ordinary);

  const guardSession = [...wire.sessions].find(([id]) => id.startsWith('guard-'))?.[0];
  assert.ok(guardSession, 'bios must have armed a nav session');
  wire.emit({ method: 'Target.detachedFromTarget', params: { sessionId: guardSession } });
  for (let turn = 0; turn < 8; turn += 1) await flush();

  const reattach = await wire.send('Target.attachToTarget', { targetId: 'stale', flatten: true });
  const row = {
    id: 'F1.stale-error-proof-no-soft-settle',
    attach: reattach.error?.message ?? 'admitted',
    current: entry.info.url,
  };
  console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
  assert.ok(
    reattach.error?.message === UNGUARDED || reattach.error?.message === PROTECTED,
    `stale error proof must not soft-settle, got ${reattach.error?.message ?? 'admitted'}`
  );
  assert.equal(reattach.result, undefined);
  assert.match(
    (await wire.send('Runtime.enable', {}, session)).error?.message ?? '',
    /^slicc: refused:/
  );
});

for (const [name, route] of routes) {
  for (const land of [
    ['chrome-error', errorPage, '://', failed],
    ['blank', BLANKED, 'null', undefined],
  ]) {
    const [kind, url, securityOrigin, unreachableUrl] = land;
    test(`twin: blocked before a history settle onto ${kind} stays blocked for content on ${name}`, {
      timeout: 8000,
    }, async (t) => {
      const wire = protocol(t, { refuseSetup: false, error: false, route });
      const entry = wire.target(`blocked-${name}-${kind}`, { asError: false });
      entry.history = {
        currentIndex: 0,
        entries: [
          { id: 1, url: ordinary, title: ordinary },
          { id: 2, url, title: url },
        ],
      };
      for (let turn = 0; turn < 8; turn += 1) await flush();
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined, attached.error?.message);
      const session = attached.result.sessionId;
      assert.equal((await wire.send('Runtime.enable', {}, session)).error, undefined);

      entry.info.url = failed;
      entry.tree.frame = {
        id: entry.info.targetId,
        url: failed,
        securityOrigin: origin,
      };
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: session,
        params: { frame: entry.tree.frame },
      });
      await flush();
      assert.equal(
        (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error?.message,
        PROTECTED
      );

      const moved = wire.send('Page.navigateToHistoryEntry', { entryId: 2 }, session);
      await flush();
      entry.info = { ...entry.info, url, title: url };
      entry.tree = {
        frame: {
          id: entry.info.targetId,
          url,
          securityOrigin,
          ...(unreachableUrl ? { unreachableUrl } : {}),
        },
      };
      entry.history.currentIndex = 1;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: session,
        params: { frame: entry.tree.frame },
      });
      await moved;

      const row = {
        id: `F1.blocked-history-${kind}-${name}`,
        route: name,
        land: kind,
      };
      console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
      await refusedContent(wire, session);
    });
  }
}
