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
const origin = 'https://seven.sliccy.ai';
const failed = `${origin}/controller/proof-secret`;
const failedQuery = `${failed}?token=leak`;
const failedFragment = `${failed}#leak`;
const errorPage = 'chrome-error://chromewebdata/';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const link = { kind: 'link', version: '1.70.16' };
const routes = [
  ['devtools', undefined],
  ['extension', { kind: 'extension', version: '1.70.16' }],
  ['link', link],
];
const SEED = new URL('../../src/seed/', import.meta.url);
const MUTANTS = {
  'skip-fresh-before-cut': [
    [
      'return attachmentProofFor(this, sessionId, targetId, raw, guarded, recoverable);',
      'return this.attachmentProofOnce(sessionId, targetId, raw, guarded, recoverable);',
    ],
    [
      'if (STRANDED.has(method) && (guarded || error) && !this.errorPageByProof(params.targetId))\n      await this.freshErrorPageTree(params.targetId);\n',
      '',
    ],
  ],
  'skip-loader-bind': [
    [
      'this.forgetProbeFrame(frame.id);\n        this.forgetFailedUrl(targetId);\n        revokeErrorPageProof(this, targetId);',
      'this.forgetProbeFrame(frame.id);\n        this.forgetFailedUrl(targetId);',
    ],
    [
      '(!proof.loader || (proof.frameId && this.frameLoaders.get(proof.frameId) === proof.loader))',
      'true',
    ],
  ],
  'skip-info-match': [
    [
      "if (info.url.startsWith('chrome-error:')) return true;\n    if (!this.is.url(info.url)) return true;\n    return frame.unreachableUrl === info.url;",
      'return true;',
    ],
  ],
  'deny-attach': [
    [
      "'Target.getTargetInfo',\n  'Target.attachToTarget',\n  'Target.closeTarget',\n  'Target.activateTarget',",
      "'Target.getTargetInfo',\n  'Target.closeTarget',\n  'Target.activateTarget',",
    ],
  ],
  'deny-page-enable': [["'Page.enable',\n  'Page.disable',", "'Page.disable',"]],
  'deny-runtime-enable': [
    [
      "runtimeErrorPagePrivilege(sessionId, method) {\n    if (method !== 'Runtime.enable' && method !== 'Runtime.disable') return false;\n    return this.liveErrorPageProof(this.sessions.get(sessionId)?.targetId);",
      "runtimeErrorPagePrivilege(sessionId, method) {\n    if (method !== 'Runtime.enable' && method !== 'Runtime.disable') return false;\n    return false;",
    ],
  ],
  'deny-discovery': [
    [
      "'Target.getTargetInfo',\n  'Target.attachToTarget',\n  'Target.closeTarget',\n  'Target.activateTarget',",
      "'Target.attachToTarget',\n  'Target.closeTarget',\n  'Target.activateTarget',",
    ],
  ],
  'deny-reload': [
    [
      "const NAVIGATES = new Set(['Page.navigate', 'Page.reload', 'Page.stopLoading']);",
      "const NAVIGATES = new Set(['Page.navigate', 'Page.stopLoading']);",
    ],
  ],
  'deny-blank': [
    [
      "const NAVIGATES = new Set(['Page.navigate', 'Page.reload', 'Page.stopLoading']);",
      "const NAVIGATES = new Set(['Page.reload', 'Page.stopLoading']);",
    ],
  ],
  'deny-close': [
    [
      "'Target.getTargetInfo',\n  'Target.attachToTarget',\n  'Target.closeTarget',\n  'Target.activateTarget',",
      "'Target.getTargetInfo',\n  'Target.attachToTarget',\n  'Target.activateTarget',",
    ],
  ],
  'leak-path': [
    [
      'return this.redact(this.masking(info, stranded, fresh)).params;',
      'return this.masking(info, stranded, fresh);',
    ],
    [
      'if (stranded && this.is.url(info.url) && URL.canParse(info.url)) {\n      const { origin } = new URL(info.url);\n      return { ...info, url: origin, title: origin };\n    }',
      'if (stranded && this.is.url(info.url) && URL.canParse(info.url)) {\n      return info;\n    }',
    ],
    [
      'const origin =\n      !this.is.url(failed) && URL.canParse(failed) ? new URL(failed).origin : ERROR_PAGE;\n    return { ...info, url: origin, title: origin };',
      'return info;',
    ],
  ],
  'leak-query': [
    [
      'return this.redact(this.masking(info, stranded, fresh)).params;',
      'return this.masking(info, stranded, fresh);',
    ],
    [
      'if (stranded && this.is.url(info.url) && URL.canParse(info.url)) {\n      const { origin } = new URL(info.url);\n      return { ...info, url: origin, title: origin };\n    }',
      'if (stranded && this.is.url(info.url) && URL.canParse(info.url)) {\n      return info;\n    }',
    ],
    [
      'const origin =\n      !this.is.url(failed) && URL.canParse(failed) ? new URL(failed).origin : ERROR_PAGE;\n    return { ...info, url: origin, title: origin };',
      'return info;',
    ],
  ],
  'leak-fragment': [
    [
      'return this.redact(this.masking(info, stranded, fresh)).params;',
      'return this.masking(info, stranded, fresh);',
    ],
    [
      'if (stranded && this.is.url(info.url) && URL.canParse(info.url)) {\n      const { origin } = new URL(info.url);\n      return { ...info, url: origin, title: origin };\n    }',
      'if (stranded && this.is.url(info.url) && URL.canParse(info.url)) {\n      return info;\n    }',
    ],
    [
      'const origin =\n      !this.is.url(failed) && URL.canParse(failed) ? new URL(failed).origin : ERROR_PAGE;\n    return { ...info, url: origin, title: origin };',
      'return info;',
    ],
  ],
  'leak-unreachable-url': [
    [
      "'Page.enable',\n  'Page.disable',\n]);",
      "'Page.enable',\n  'Page.disable',\n  'Page.getFrameTree',\n]);",
    ],
    [
      'const { unreachableUrl, urlFragment, ...shown } = frame;',
      'const { urlFragment, ...shown } = frame;',
    ],
  ],
};

const mutantPatches = (entry) => (typeof entry[0] === 'string' ? [entry] : entry);

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
      assert.ok(source.includes(from), `mutant ${mutant}: patch site missing`);
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
  { guardProtected = stockGuard, infoUrl = failed, route = link, unreachable = failed } = {}
) {
  const targets = new Map();
  const sessions = new Map();
  const delivered = [];
  const sent = [];
  const pending = new Map();
  let next = 0;
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      sent.push(message);
      queueMicrotask(() => respond(message));
    },
    close() {},
  };
  const guard = guardProtected(raw, origin, new Map(), route);
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
      result = { targetInfos: [...targets.values()].map((entry) => ({ ...entry.info })) };
    if (method === 'Page.getFrameTree') result = { frameTree: target.tree };
    if (method === 'Page.getNavigationHistory')
      result = {
        currentIndex: 0,
        entries: [{ id: 1, url: target.info.url, title: target.info.title ?? '' }],
      };
    if (method === 'Runtime.enable' || method === 'Page.enable' || method === 'Page.reload')
      result = {};
    if (method === 'Page.navigate') {
      if (params.url === BLANKED || params.url === 'about:blank') {
        target.info = { ...target.info, url: params.url, title: '' };
        target.tree = { frame: { id: targetId, url: params.url, securityOrigin: 'null' } };
      }
      result = { frameId: targetId };
    }
    if (method === 'Runtime.evaluate')
      result = { result: { type: 'string', value: 'proof-secret-content' } };
    if (method === 'DOM.getDocument')
      result = { root: { nodeId: 1, nodeName: '#document', children: [] } };
    if (method === 'DOMSnapshot.captureSnapshot') result = { documents: [], strings: [] };
    if (method === 'Target.closeTarget') {
      targets.delete(params.targetId);
      result = { success: true };
    }
    emit({ id, ...(sessionId ? { sessionId } : {}), result });
  }
  function target(
    id,
    { unreachableUrl = unreachable, loader = `${id}-error`, url = infoUrl } = {}
  ) {
    const frame = {
      id,
      url: errorPage,
      securityOrigin: '://',
      unreachableUrl,
      loaderId: loader,
    };
    const entry = {
      info: { targetId: id, type: 'page', url, title: url },
      tree: { frame },
    };
    targets.set(id, entry);
    emit({ method: 'Target.targetCreated', params: { targetInfo: { ...entry.info } } });
    return entry;
  }
  const send = (method, params = {}, sessionId) => {
    const id = ++next;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  };
  const guardSession = (id) => [...sessions].find(([, targetId]) => targetId === id)?.[0];
  return { target, send, emit, sessions, targets, sent, delivered, guardSession, guard };
}

async function settle() {
  for (let turn = 0; turn < 12; turn += 1) await flush();
}

async function admitErrorPage(t, opts = {}) {
  const wire = protocol(t, opts);
  const id = opts.id ?? 'proof';
  wire.target(id, opts);
  await settle();
  const attached = await wire.send('Target.attachToTarget', { targetId: id, flatten: true });
  assert.equal(attached.error, undefined, attached.error?.message);
  return { wire, session: attached.result.sessionId, id };
}

function refused(answer) {
  return Boolean(answer?.error?.message?.startsWith('slicc: refused:'));
}

test('link: fresh getFrameTree proof admits attach when getTargetInfo names the failed URL', async (t) => {
  const { wire, session } = await admitErrorPage(t);
  assert.equal((await wire.send('Page.enable', {}, session)).error, undefined);
  assert.equal((await wire.send('Runtime.enable', {}, session)).error, undefined);
  const info = await wire.send('Target.getTargetInfo', { targetId: 'proof' });
  assert.equal(info.result.targetInfo.url, origin);
  assert.equal(JSON.stringify(info).includes('proof-secret'), false);
  assert.match(
    (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error?.message ?? '',
    /^slicc: refused:/
  );
});

test('link: ordinary unreachableUrl on chrome-error gets no error-page privileges', async (t) => {
  const wire = protocol(t, { unreachable: ordinary });
  wire.target('fake', { unreachableUrl: ordinary });
  await settle();
  const attached = await wire.send('Target.attachToTarget', { targetId: 'fake', flatten: true });
  assert.ok(attached.error?.message === UNGUARDED || attached.error?.message === PROTECTED);
});

test('link: getTargetInfo URL mismatch with unreachableUrl keeps the cut', async (t) => {
  const wire = protocol(t, { infoUrl: `${origin}/other` });
  wire.target('mismatch');
  await settle();
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'mismatch',
    flatten: true,
  });
  assert.ok(attached.error?.message === UNGUARDED || attached.error?.message === PROTECTED);
});

for (const [name, route] of routes) {
  test(`${name}: stale-proof race — new loaderId revokes and cuts before later answers`, async (t) => {
    const wire = protocol(t, { route });
    const entry = wire.target('stale');
    await settle();
    const attached = await wire.send('Target.attachToTarget', { targetId: 'stale', flatten: true });
    assert.equal(attached.error, undefined, attached.error?.message);
    const session = attached.result.sessionId;
    assert.equal((await wire.send('Page.enable', {}, session)).error, undefined);
    entry.tree.frame = {
      ...entry.tree.frame,
      loaderId: 'stale-next',
      unreachableUrl: failed,
    };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: wire.guardSession('stale'),
      params: { frame: entry.tree.frame },
    });
    await flush();
    const later = await wire.send('Page.reload', {}, session);
    assert.ok(
      refused(later),
      `stale-proof race on ${name} must cut, got ${later.error?.message ?? 'admitted'}`
    );
  });

  test(`${name}: reload into a live protected page is cut at commit`, async (t) => {
    const wire = protocol(t, { route });
    const entry = wire.target('live');
    await settle();
    const attached = await wire.send('Target.attachToTarget', { targetId: 'live', flatten: true });
    assert.equal(attached.error, undefined, attached.error?.message);
    const session = attached.result.sessionId;
    assert.equal((await wire.send('Page.enable', {}, session)).error, undefined);
    entry.info = { targetId: 'live', type: 'page', url: failed, title: failed };
    entry.tree = {
      frame: {
        id: 'live',
        url: failed,
        securityOrigin: origin,
        loaderId: 'live-committed',
      },
    };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: wire.guardSession('live'),
      params: { frame: entry.tree.frame },
    });
    await flush();
    const later = await wire.send('Runtime.evaluate', { expression: '1' }, session);
    assert.ok(
      refused(later),
      `live protected commit on ${name} must cut, got ${later.error?.message ?? 'admitted'}`
    );
    assert.equal(
      wire.delivered.some((message) => JSON.stringify(message).includes('proof-secret')),
      false,
      `${name}: no content event may name the failed URL`
    );
  });
}

for (const [secret, label] of [
  [failed, 'path'],
  [failedQuery, 'query'],
  [failedFragment, 'fragment'],
]) {
  test(`link: redaction keeps ${label} of the failed URL out of info and list`, async (t) => {
    const { wire } = await admitErrorPage(t, {
      infoUrl: secret,
      unreachable: secret,
      id: `redact-${label}`,
    });
    const info = await wire.send('Target.getTargetInfo', { targetId: `redact-${label}` });
    const listed = await wire.send('Target.getTargets', {});
    const blob = JSON.stringify({ info, listed });
    assert.equal(info.result.targetInfo.url, origin);
    assert.equal(blob.includes('proof-secret'), false);
    assert.equal(blob.includes('token=leak'), false);
    assert.equal(blob.includes('#leak'), false);
  });
}

for (const [name, expect] of [
  ['skip-fresh-before-cut', 'cut'],
  ['skip-loader-bind', 'stale-open'],
  ['skip-info-match', 'mismatch-open'],
  ['deny-attach', 'privilege-attach'],
  ['deny-page-enable', 'privilege-page-enable'],
  ['deny-runtime-enable', 'privilege-runtime-enable'],
  ['deny-discovery', 'privilege-discovery'],
  ['deny-reload', 'privilege-reload'],
  ['deny-blank', 'privilege-blank'],
  ['deny-close', 'privilege-close'],
  ['leak-path', 'leak-path'],
  ['leak-query', 'leak-query'],
  ['leak-fragment', 'leak-fragment'],
  ['leak-unreachable-url', 'leak-tree'],
]) {
  test(`mutant ${name} is red against the old cut`, async (t) => {
    const guardProtected = await loadGuard(name);
    if (expect === 'cut') {
      const wire = protocol(t, { guardProtected });
      wire.target('mutant');
      await settle();
      const attached = await wire.send('Target.attachToTarget', {
        targetId: 'mutant',
        flatten: true,
      });
      assert.ok(
        attached.error?.message === UNGUARDED || attached.error?.message === PROTECTED,
        `mutant ${name} must keep the cut`
      );
      return;
    }
    if (expect === 'mismatch-open') {
      const wire = protocol(t, { guardProtected, infoUrl: `${origin}/other` });
      wire.target('mutant-mismatch');
      await settle();
      const attached = await wire.send('Target.attachToTarget', {
        targetId: 'mutant-mismatch',
        flatten: true,
      });
      assert.equal(attached.error, undefined, `mutant ${name} wrongly admits a mismatched target`);
      return;
    }
    if (expect === 'stale-open') {
      const wire = protocol(t, { guardProtected });
      const entry = wire.target('mutant-stale');
      await settle();
      const attached = await wire.send('Target.attachToTarget', {
        targetId: 'mutant-stale',
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      const session = attached.result.sessionId;
      entry.tree.frame = { ...entry.tree.frame, loaderId: 'mutant-stale-next' };
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: wire.guardSession('mutant-stale'),
        params: { frame: entry.tree.frame },
      });
      await flush();
      const later = await wire.send('Page.reload', {}, session);
      assert.equal(later.error, undefined, `mutant ${name} must leave stale privileges open`);
      return;
    }
    if (expect === 'privilege-attach') {
      const wire = protocol(t, { guardProtected });
      wire.target(`priv-${name}`);
      await settle();
      assert.ok(
        refused(
          await wire.send('Target.attachToTarget', {
            targetId: `priv-${name}`,
            flatten: true,
          })
        ),
        `mutant ${name} must refuse attach`
      );
      return;
    }
    if (expect.startsWith('privilege-')) {
      const { wire, session, id } = await admitErrorPage(t, {
        guardProtected,
        id: `priv-${name}`,
      });
      if (expect === 'privilege-page-enable') {
        assert.ok(refused(await wire.send('Page.enable', {}, session)));
        return;
      }
      if (expect === 'privilege-runtime-enable') {
        assert.equal((await wire.send('Page.enable', {}, session)).error, undefined);
        assert.ok(refused(await wire.send('Runtime.enable', {}, session)));
        return;
      }
      if (expect === 'privilege-discovery') {
        assert.ok(refused(await wire.send('Target.getTargetInfo', { targetId: id })));
        return;
      }
      if (expect === 'privilege-reload') {
        assert.equal((await wire.send('Page.enable', {}, session)).error, undefined);
        assert.ok(refused(await wire.send('Page.reload', {}, session)));
        return;
      }
      if (expect === 'privilege-blank') {
        assert.equal((await wire.send('Page.enable', {}, session)).error, undefined);
        assert.ok(refused(await wire.send('Page.navigate', { url: BLANKED }, session)));
        return;
      }
      if (expect === 'privilege-close') {
        assert.ok(refused(await wire.send('Target.closeTarget', { targetId: id })));
        return;
      }
    }
    if (expect === 'leak-path') {
      const { wire, id } = await admitErrorPage(t, {
        guardProtected,
        infoUrl: failed,
        unreachable: failed,
        id: 'leak-path',
      });
      const info = await wire.send('Target.getTargetInfo', { targetId: id });
      assert.ok(
        JSON.stringify(info).includes('proof-secret'),
        `mutant ${name} must forward the failed path`
      );
      return;
    }
    if (expect === 'leak-query') {
      const { wire, id } = await admitErrorPage(t, {
        guardProtected,
        infoUrl: failedQuery,
        unreachable: failedQuery,
        id: 'leak-query',
      });
      const info = await wire.send('Target.getTargetInfo', { targetId: id });
      assert.ok(
        JSON.stringify(info).includes('token=leak'),
        `mutant ${name} must forward the failed query`
      );
      return;
    }
    if (expect === 'leak-fragment') {
      const { wire, id } = await admitErrorPage(t, {
        guardProtected,
        infoUrl: failedFragment,
        unreachable: failedFragment,
        id: 'leak-fragment',
      });
      const info = await wire.send('Target.getTargetInfo', { targetId: id });
      assert.ok(
        JSON.stringify(info).includes('#leak') || JSON.stringify(info).includes('proof-secret'),
        `mutant ${name} must forward the failed fragment`
      );
      return;
    }
    if (expect === 'leak-tree') {
      const { wire, session } = await admitErrorPage(t, {
        guardProtected,
        id: 'leak-tree',
      });
      const tree = await wire.send('Page.getFrameTree', {}, session);
      assert.ok(
        JSON.stringify(tree).includes('proof-secret'),
        `mutant ${name} must forward unreachableUrl through the tree`
      );
    }
  });
}
