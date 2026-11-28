import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROTECTED } from '../../src/seed/guard.js';
import { flush, plainFrame, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';
import {
  errorFrame,
  failed,
  flush as stateFlush,
  plainFrame as statePlain,
  protocol as stateProtocol,
} from './guard-state-fixture.mjs';

let fetchBlocks = 0;
globalThis.fetch = async (...args) => {
  fetchBlocks += 1;
  throw new Error(`unexpected fetch during no-proof differential: ${String(args[0])}`);
};

{
  const { Module } = await import('node:module');
  Module.createRequire ??= undefined;
}

assert.equal(fetchBlocks, 0, 'fetch block counter must be zero before any other line');
const SEVEN = `${protectedOrigin}/controller/oopif-mid`;
const route = { kind: 'link' };
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const mainSource = execFileSync('git', ['show', 'origin/main:src/seed/guard.js'], {
  cwd: repo,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});

registerHooks({
  load(url, context, next) {
    if (url.includes('/src/seed/guard.js') && url.includes('diff=main')) {
      return { format: 'module', source: mainSource, shortCircuit: true };
    }
    return next(url, context);
  },
});

const headGuard = (await import('../../src/seed/guard.js')).guardProtected;
const mainGuard = (await import(`../../src/seed/guard.js?diff=main`)).guardProtected;

const settle = async (rounds = 60) => {
  for (let i = 0; i < rounds; i += 1) await flush();
};

function listing(raw, guard, infos) {
  const send = raw.send.bind(raw);
  raw.send = (text) => {
    const message = JSON.parse(text);
    if (message.method !== 'Target.getTargets') return send(text);
    queueMicrotask(() =>
      raw.onmessage(
        JSON.stringify({ id: message.id, result: { targetInfos: infos().map((i) => i.info) } })
      )
    );
  };
  return guard(raw);
}

async function emptyOopif(t, guardProtected) {
  const p = protocol(t, (raw, owner) =>
    listing(
      raw,
      (wired) => guardProtected(wired, owner, new Map(), route),
      () => [...p.targets.values()]
    )
  );
  const top = p.target('top', 'page', { ...plainFrame('top'), loaderId: 'top-loader' });
  const session = await p.attach('top');
  const mid = p.target(
    'mid',
    'iframe',
    {
      id: 'mid',
      parentId: 'top',
      loaderId: 'mid-loader',
      url: SEVEN,
      securityOrigin: new URL(SEVEN).origin,
    },
    'top'
  );
  Object.assign(mid.info, { url: '' });
  top.tree.childFrames = [
    {
      frame: {
        id: 'mid',
        parentId: 'top',
        loaderId: 'mid-loader',
        url: SEVEN,
        securityOrigin: new URL(SEVEN).origin,
      },
    },
  ];
  const child = 'client-mid';
  p.sessions.set(child, 'mid');
  p.emit({
    method: 'Target.attachedToTarget',
    sessionId: session,
    params: { sessionId: child, targetInfo: { ...mid.info }, waitingForDebugger: false },
  });
  await settle();
  return (await p.send('Runtime.enable', {}, session)).error?.message ?? null;
}

async function wipedBlankPopup(t, guardProtected) {
  const wire = stateProtocol(t, (raw, owner) => guardProtected(raw, owner, new Map(), route));
  wire.target('popup-opener');
  const entry = wire.target('popup-outcome');
  entry.info.openerId = 'popup-opener';
  await wire.attach('popup-outcome');
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
  } catch {
    void 0;
  }
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: 'guard-popup-outcome',
    params: {
      requestId: 'popup-request',
      resourceType: 'Document',
      frameId: 'popup-outcome',
      request: { url: failed },
    },
  });
  entry.tree.frame = { ...errorFrame('popup-outcome'), loaderId: 'error-loader' };
  entry.info.url = entry.tree.frame.url;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-popup-outcome',
    params: { frame: entry.tree.frame },
  });
  await stateFlush();
  t.mock.timers.tick(5000);
  await stateFlush();
  entry.tree.frame = {
    ...statePlain('popup-outcome'),
    url: 'about:blank',
    securityOrigin: '://',
    loaderId: 'blank-loader',
  };
  entry.info.url = 'about:blank';
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-popup-outcome',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await stateFlush();
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'popup-outcome',
    flatten: true,
  });
  return attached.error?.message ?? null;
}

async function unprovenCommit(t, guardProtected) {
  const wire = stateProtocol(t, (raw, owner) => guardProtected(raw, owner, new Map(), route));
  const targetId = 'unproven-commit';
  const entry = wire.target(targetId);
  const first = await wire.attach(targetId);
  entry.tree.frame = { ...errorFrame(targetId), loaderId: 'error-loader' };
  entry.info.url = failed;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${targetId}`,
    params: { frame: entry.tree.frame },
  });
  await stateFlush();
  const frame = { ...statePlain(targetId), loaderId: 'ordinary-loader', id: 'unobserved-root' };
  entry.tree.frame = frame;
  entry.info.url = frame.url;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${targetId}`,
    params: { frame },
  });
  await stateFlush();
  return (await wire.send('Runtime.enable', {}, first)).error?.message ?? null;
}

async function ordinaryProtectedLive(t, guardProtected) {
  const wire = stateProtocol(t, (raw, owner) => guardProtected(raw, owner, new Map(), route));
  const entry = wire.target('live-protected');
  entry.info.url = failed;
  entry.tree.frame = {
    id: 'live-protected',
    url: failed,
    securityOrigin: new URL(failed).origin,
    loaderId: 'live-loader',
  };
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'live-protected',
    flatten: true,
  });
  return attached.error?.message ?? null;
}

async function stockRemoteCdpOrdinary(t, guardProtected) {
  const wire = stateProtocol(t, (raw, owner) => guardProtected(raw, owner, new Map(), route));
  const entry = wire.target('stock-ordinary');
  entry.info.url = 'https://ordinary.invalid/page';
  entry.tree.frame = {
    ...statePlain('stock-ordinary'),
    loaderId: 'stock-loader',
  };
  const session = await wire.attach('stock-ordinary');
  await stateFlush();
  const enable = await wire.send('Runtime.enable', {}, session);
  const evaluate = await wire.send(
    'Runtime.evaluate',
    { expression: '1+1', returnByValue: true },
    session
  );
  return {
    enable: enable.error?.message ?? null,
    evaluate: evaluate.error?.message ?? evaluate.result?.result?.value ?? null,
  };
}

async function stockRemoteCdpSeven(t, guardProtected) {
  const wire = stateProtocol(t, (raw, owner) => guardProtected(raw, owner, new Map(), route));
  const entry = wire.target('stock-seven');
  entry.info.url = failed;
  entry.tree.frame = {
    id: 'stock-seven',
    url: failed,
    securityOrigin: new URL(failed).origin,
    loaderId: 'seven-loader',
  };
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'stock-seven',
    flatten: true,
  });
  const session = attached.result?.sessionId;
  const enable = session
    ? await wire.send('Runtime.enable', {}, session)
    : { error: { message: attached.error?.message ?? null } };
  return {
    attach: attached.error?.message ?? null,
    enable: enable.error?.message ?? null,
  };
}

for (const [name, run] of [
  ['empty-oopif', emptyOopif],
  ['wiped-blank-popup', wipedBlankPopup],
  ['unproven-commit', unprovenCommit],
  ['ordinary-protected-live', ordinaryProtectedLive],
  ['stock-remote-cdp-ordinary', stockRemoteCdpOrdinary],
  ['stock-remote-cdp-seven', stockRemoteCdpSeven],
]) {
  test(`differential no-proof ${name}: head matches main`, async (t) => {
    let mainOut;
    let headOut;
    await t.test(`${name} on main`, async (sub) => {
      mainOut = await run(sub, mainGuard);
    });
    await t.test(`${name} on head`, async (sub) => {
      headOut = await run(sub, headGuard);
    });
    assert.deepEqual(
      headOut,
      mainOut,
      `${name}: head=${JSON.stringify(headOut)} main=${JSON.stringify(mainOut)}`
    );
    assert.equal(fetchBlocks, 0, 'fetch must stay blocked at zero for differential rows');
  });
}

test('differential no-proof empty-oopif still refuses on seven', async (t) => {
  assert.equal(await emptyOopif(t, headGuard), PROTECTED);
});

test('differential no-proof tables: RECOVERS and contentRead match main', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/seed/guard.js', import.meta.url), 'utf8');
  const recoversBlock = (text) => {
    const start = text.indexOf('const RECOVERS = new Set([');
    const end = text.indexOf(']);', start);
    return text.slice(start, end + 3);
  };
  const contentReadBlock = (text) => {
    const start = text.indexOf("const contentRead = (method = '') =>");
    const end = text.indexOf('const STREAMED', start);
    return text.slice(start, end).trim();
  };
  assert.equal(recoversBlock(source), recoversBlock(mainSource));
  assert.equal(contentReadBlock(source), contentReadBlock(mainSource));
  assert.equal(recoversBlock(source).includes('Runtime.enable'), false);
  assert.match(contentReadBlock(source), /Runtime/);
});

test('differential stubs stay quiet', () => {
  assert.equal(fetchBlocks, 0);
  assert.ok(fileURLToPath(import.meta.url).includes('guard-error-page-no-proof-diff'));
});
