import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { debuggerLifetime } from '../../src/seed/debugger.js';
import { PROTECTED, guardProtected as stockGuard } from '../../src/seed/guard.js';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const SEED = new URL('../../src/seed/', import.meta.url);
const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link', version: '1.60.0' }],
  ['extension', { kind: 'extension', version: '7.12.0' }],
];

const CLEANUP = [
  'Debugger.disable',
  'Debugger.removeBreakpoint',
  'Network.disable',
  'DOM.disable',
  'CSS.disable',
  'Runtime.disable',
  'Page.disable',
  'Fetch.disable',
  'Accessibility.disable',
  'Log.disable',
  'Profiler.disable',
  'HeapProfiler.disable',
  'Audits.disable',
  'DOMSnapshot.disable',
  'Overlay.disable',
  'Animation.disable',
  'Performance.disable',
  'Inspector.disable',
];

const MUTANTS = {
  'leaky-cleanup-when-blocked': [
    [
      `      if (
        (this.blocked.has(message.sessionId) || this.gone.has(message.sessionId)) &&
        !(
          this.blocked.has(message.sessionId) &&
          (OBSERVED.has(message.method) || message.method === 'Page.captureScreenshot')
        )
      )
        return this.refusePass(message, this.blocked.has(message.sessionId) ? 'blocked' : 'gone');`,
      `      if (
        (this.blocked.has(message.sessionId) || this.gone.has(message.sessionId)) &&
        !(
          this.blocked.has(message.sessionId) &&
          (OBSERVED.has(message.method) || message.method === 'Page.captureScreenshot')
        )
      ) {
        if (
          typeof message.method === 'string' &&
          (message.method.endsWith('.disable') || message.method === 'Debugger.removeBreakpoint')
        ) {
          return this.deliver({
            id: message.id,
            sessionId: message.sessionId,
            result: { body: 'https://seven.sliccy.ai/secret' },
          });
        }
        return this.refusePass(message, this.blocked.has(message.sessionId) ? 'blocked' : 'gone');
      }`,
    ],
  ],
};

const mutantPatches = (entry) => (typeof entry[0] === 'string' ? [[entry[1], entry[2]]] : entry);

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

function noPayload(reply) {
  if (reply.error) {
    assert.match(reply.error.message, /^slicc: refused:/);
    assert.equal(reply.result, undefined);
    return;
  }
  assert.deepEqual(reply.result, {});
}

function protectedTarget(p, id = 'blocked') {
  p.target(id, 'page', {
    ...plainFrame(id),
    url: 'https://seven.sliccy.ai/',
    securityOrigin: 'https://seven.sliccy.ai',
  });
}

test('the cleanup set pins Debugger cleanup lifetimes and the domain disables', () => {
  assert.equal(debuggerLifetime('Debugger.disable'), 'cleanup');
  assert.equal(debuggerLifetime('Debugger.removeBreakpoint'), 'cleanup');
  assert.equal(debuggerLifetime('Debugger.enable'), 'persistent');
  const guardSource = readFileSync(
    fileURLToPath(new URL('../../src/seed/guard.js', import.meta.url)),
    'utf8'
  );
  const bridgeSource = readFileSync(
    fileURLToPath(new URL('../../src/seed/bridge-cdp.js', import.meta.url)),
    'utf8'
  );
  for (const method of ['Runtime.disable', 'Page.disable', 'DOM.disable', 'Fetch.disable']) {
    assert.ok(guardSource.includes(`'${method}'`), `${method} stays named in guard.js`);
  }
  assert.ok(
    bridgeSource.includes("'Network.disable'"),
    'Network.disable stays named in bridge-cdp.js'
  );
  for (const method of CLEANUP) {
    assert.ok(
      method.endsWith('.disable') || debuggerLifetime(method) === 'cleanup',
      `${method} is a domain disable or Debugger cleanup`
    );
  }
});

for (const [routeName, route] of routes) {
  for (const method of CLEANUP) {
    test(`cleanup ${method} on a protected page returns no payload (${routeName})`, async (t) => {
      const p = protocol(t, (raw, own) => stockGuard(raw, own, new Map(), route));
      protectedTarget(p);
      const attach = await p.send('Target.attachToTarget', { targetId: 'blocked', flatten: true });
      assert.match(attach.error.message, /slicc: refused:/);
      const session = p.attached('blocked');
      await flush();
      const start = p.sent.length;
      const params = method === 'Debugger.removeBreakpoint' ? { breakpointId: 'x' } : {};
      const reply = await p.send(method, params, session);
      assert.equal(
        p.clients(start).filter((command) => command.method === method).length,
        0,
        `${method} must not be forwarded on a protected page`
      );
      noPayload(reply);
      if (reply.error) assert.equal(reply.error.message, PROTECTED);
    });
  }
}

test('mutant: a leaky blocked cleanup answer carries a payload to the client', {
  timeout: 5000,
}, async (t) => {
  const guardProtected = await loadGuard('leaky-cleanup-when-blocked');
  const p = protocol(t, (raw, own) => guardProtected(raw, own, new Map(), undefined));
  protectedTarget(p, 'leaky');
  await p.send('Target.attachToTarget', { targetId: 'leaky', flatten: true });
  const session = p.attached('leaky');
  await flush();
  const start = p.sent.length;
  const reply = await p.send('Network.disable', {}, session);
  assert.equal(
    p.clients(start).filter((command) => command.method === 'Network.disable').length,
    0
  );
  assert.equal(reply.error, undefined);
  assert.equal(reply.result?.body, 'https://seven.sliccy.ai/secret');
});
