import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROTECTED, guardProtected as stockGuard } from '../../src/seed/guard.js';
import { flush, ordinary, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) await flush();
};

const lazy = (id, parentId) => ({
  id,
  parentId,
  loaderId: `${id}-initial`,
  url: '',
  securityOrigin: '://',
});

const SEVEN = 'https://seven.sliccy.ai/os/home';
const VAULT = 'https://vault.sliccy.ai/unlock';
const guardSource = fileURLToPath(new URL('../../src/seed/guard.js', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const seedDir = fileURLToPath(new URL('../../src/seed/', import.meta.url));

function rewriteSeedImports(text) {
  return text.replace(/from ['"]\.\/([^'"]+)['"]/g, (_, file) => {
    const href = pathToFileURL(join(seedDir, file)).href;
    return `from '${href}'`;
  });
}

function scratchGuard(t, name, transform) {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-iframes-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const text = readFileSync(guardSource, 'utf8');
  const patched = rewriteSeedImports(transform(text));
  const path = join(dir, name);
  writeFileSync(path, patched);
  return `${pathToFileURL(path).href}?t=${Date.now()}`;
}

async function loadScratch(t, name, transform) {
  return (await import(scratchGuard(t, name, transform))).guardProtected;
}

async function page(t, id, protect = stockGuard) {
  const wire = protocol(t, protect);
  t.after(() => {
    wire.hold(() => false);
    for (const message of [...wire.held]) wire.release(message);
  });
  const entry = wire.target(id);
  entry.tree.frame.loaderId = `${id}-loader`;
  const session = await wire.attach(id);
  assert.equal((await wire.send('Runtime.enable', {}, session)).error, undefined);
  entry.tree.childFrames = ['lazy-a', 'lazy-b', 'lazy-c'].map((child) => ({
    frame: lazy(child, id),
  }));
  for (const child of entry.tree.childFrames)
    wire.emit({
      method: 'Page.frameAttached',
      sessionId: `guard-${id}`,
      params: { frameId: child.frame.id, parentFrameId: id },
    });
  await settle();
  return { wire, entry, session };
}

const lookups = (message) => message.id >= 2 ** 30 && message.method === 'Target.getTargetInfo';

const retitle = (wire, entry, title) =>
  wire.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { ...entry.info, title, attached: true } },
  });

async function slowHint(t, wire, entry, title) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.hold(lookups);
  retitle(wire, entry, title);
  await settle();
  for (let step = 0; step < 14; step += 1) {
    t.mock.timers.tick(500);
    await settle(20);
  }
  wire.hold(() => false);
  for (const message of [...wire.held]) wire.release(message);
  await settle(80);
  t.mock.timers.reset();
}

const detached = (wire, session) =>
  wire.sent.some(
    (message) =>
      message.method === 'Target.detachFromTarget' && message.params?.sessionId === session
  );

const laterCommitRow = async (t, id, url, protect = stockGuard) => {
  const { wire, entry, session } = await page(t, id, protect);
  await slowHint(t, wire, entry, 'Top 100 Most Visited Websites');
  assert.equal(detached(wire, session), false);
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error,
    undefined
  );
  const child = entry.tree.childFrames[0].frame;
  Object.assign(child, {
    url,
    securityOrigin: new URL(url).origin,
    loaderId: `${id}-commit`,
  });
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame: { ...child }, type: 'Navigation' },
  });
  await settle(80);
  const read = await wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
  const document = await wire.send('DOM.getDocument', {}, session);
  const shot = await wire.send('Page.captureScreenshot', {}, session);
  return {
    detached: detached(wire, session),
    read: read.error?.message,
    document: document.error?.message,
    shot: shot.error?.message,
  };
};

const laterCommitHolds = (row) =>
  row.detached === true &&
  row.read === PROTECTED &&
  row.document === PROTECTED &&
  row.shot === PROTECTED;

const staleOrdinaryRow = async (t, id, protect = stockGuard) => {
  const { wire, entry, session } = await page(t, id, protect);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.hold(lookups);
  retitle(wire, entry, 'Top 100 Most Visited Websites');
  await settle();
  const ordinaryLookup = wire.held.find(lookups);
  assert.ok(ordinaryLookup, 'the ordinary target check is held');
  const before = wire.delivered.length;

  Object.assign(entry.info, { url: SEVEN, title: 'seven' });
  Object.assign(entry.tree.frame, {
    url: SEVEN,
    securityOrigin: new URL(SEVEN).origin,
    loaderId: `${id}-protected`,
  });
  entry.tree.childFrames = [];
  wire.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { ...entry.info, attached: true } },
  });
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame: { ...entry.tree.frame }, type: 'Navigation' },
  });
  await settle(40);

  wire.held.splice(wire.held.indexOf(ordinaryLookup), 1);
  wire.emit({
    id: ordinaryLookup.id,
    result: {
      targetInfo: {
        targetId: entry.info.targetId,
        type: 'page',
        url: ordinary,
        title: 'Top 100 Most Visited Websites',
        attached: true,
      },
    },
  });
  await settle(40);

  const staleApplied = wire.delivered
    .slice(before)
    .some(
      (message) =>
        message.method === 'Target.targetInfoChanged' &&
        message.params?.targetInfo?.url === ordinary &&
        message.params?.targetInfo?.title === 'Top 100 Most Visited Websites'
    );

  wire.hold(() => false);
  for (const message of [...wire.held]) wire.release(message);
  await settle(80);
  for (let step = 0; step < 14; step += 1) {
    t.mock.timers.tick(500);
    await settle(20);
  }
  t.mock.timers.reset();
  await settle(80);

  const read = await wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
  const document = await wire.send('DOM.getDocument', {}, session);
  return {
    staleApplied,
    detached: detached(wire, session),
    read: read.error?.message,
    document: document.error?.message,
  };
};

const staleOrdinaryHolds = (row) =>
  row.staleApplied === false &&
  row.detached === true &&
  row.read === PROTECTED &&
  row.document === PROTECTED;

test('an unanswered target check on a page whose lazy iframes never loaded leaves the page drivable', async (t) => {
  const { wire, entry, session } = await page(t, 'lazy-slow');
  await slowHint(t, wire, entry, 'Top 100 Most Visited Websites');
  assert.equal(detached(wire, session), false);
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error,
    undefined
  );
  assert.equal((await wire.send('Fetch.disable', {}, session)).error, undefined);
  for (const method of ['DOM.getDocument', 'Page.captureScreenshot']) {
    const before = wire.sent.length;
    assert.match((await wire.send(method, {}, session)).error?.message ?? '', /^slicc: refused:/);
    assert.deepEqual(wire.clients(before), []);
  }
});

test('a lazy iframe that commits on seven while the page is checked again still cuts it', async (t) => {
  const { wire, entry, session } = await page(t, 'lazy-seven');
  Object.assign(entry.tree.childFrames[0].frame, {
    url: `${protectedOrigin}/controller/lazy`,
    securityOrigin: protectedOrigin,
    loaderId: 'lazy-seven-commit',
  });
  await slowHint(t, wire, entry, 'seven inside');
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error?.message,
    PROTECTED
  );
});

test('lazy iframes under a root that moved to seven do not keep the page open', async (t) => {
  const { wire, entry, session } = await page(t, 'lazy-root');
  Object.assign(entry.tree.frame, {
    url: `${protectedOrigin}/controller/root`,
    securityOrigin: protectedOrigin,
    loaderId: 'lazy-root-commit',
  });
  await slowHint(t, wire, entry, 'seven');
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error?.message,
    PROTECTED
  );
});

test('a target check that answers late does not refuse reads that were in flight', async (t) => {
  const { wire, entry, session } = await page(t, 'lazy-late');
  const reads = new Set(['Runtime.evaluate', 'Network.getAllCookies']);
  let slow;
  wire.hold((message) => {
    if (lookups(message) && !slow) return Boolean((slow = message));
    return message.id < 2 ** 30 && reads.has(message.method);
  });
  retitle(wire, entry, 'Top 100 Most Visited Websites');
  await settle();
  const read = wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
  const cookies = wire.send('Network.getAllCookies', {}, session);
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  wire.hold(() => false);
  for (const message of wire.held.filter((held) => held.id < 2 ** 30)) wire.release(message);
  for (const message of [...wire.held]) wire.release(message);
  assert.equal((await read).error, undefined);
  assert.equal((await cookies).error, undefined);
  await settle(80);
  assert.equal(detached(wire, session), false);
  assert.equal((await wire.send('Fetch.disable', {}, session)).error, undefined);
});

for (const [name, url] of [
  ['seven', SEVEN],
  ['vault', VAULT],
]) {
  test(`twin: after re-admission, a lazy child that commits on ${name} cuts the session`, async (t) => {
    const row = await laterCommitRow(t, `lazy-later-${name}`, url);
    console.log(
      `ROW-OBSERVED lazy-later-${name} ${JSON.stringify({
        id: `lazy-later-${name}`,
        ...row,
        holds: laterCommitHolds(row),
      })}`
    );
    assert.equal(laterCommitHolds(row), true);
  });
}

test('mutant: without the walked frameNavigated cut, the later-commit twin fails', async (t) => {
  const protect = await loadScratch(t, 'no-walked-cut.js', (text) => {
    const from = 'if (this.walked({ ...message, method })) return this.cut(sessionId);';
    assert.ok(text.includes(from), 'walked cut site');
    return text.replace(from, 'if (false) return this.cut(sessionId);');
  });
  const results = [];
  for (const [name, url] of [
    ['seven', SEVEN],
    ['vault', VAULT],
  ]) {
    const row = await laterCommitRow(t, `lazy-later-mutant-${name}`, url, protect);
    const holds = laterCommitHolds(row);
    results.push({ id: `lazy-later-${name}`, ...row, holds });
    assert.equal(holds, false, `mutant must turn lazy-later-${name} red`);
  }
  console.log(
    `ROW-OBSERVED lazy-later-mutant-no-walked-cut ${JSON.stringify({
      formula: 'drop walked frameNavigated cut',
      rows: results,
    })}`
  );
});

test('twin: a stale ordinary target check is not applied after the target moves to a protected URL', async (t) => {
  const row = await staleOrdinaryRow(t, 'lazy-stale-ordinary');
  console.log(
    `ROW-OBSERVED lazy-stale-ordinary ${JSON.stringify({
      id: 'lazy-stale-ordinary',
      ...row,
      holds: staleOrdinaryHolds(row),
    })}`
  );
  assert.equal(staleOrdinaryHolds(row), true);
});

test('mutant: without the hints revision check, the stale ordinary twin fails', async (t) => {
  const protect = await loadScratch(t, 'no-hints-revision.js', (text) => {
    const from =
      'const guarded = await this.hintCurrent(info);\n    if (this.hints.get(targetId) !== message) return;';
    assert.ok(text.includes(from), 'hints revision site');
    return text.replace(
      from,
      'const guarded = await this.hintCurrent(info);\n    if (false) return;'
    );
  });
  const row = await staleOrdinaryRow(t, 'lazy-stale-ordinary-mutant', protect);
  const holds = staleOrdinaryHolds(row);
  console.log(
    `ROW-OBSERVED lazy-stale-ordinary-mutant-no-hints-revision ${JSON.stringify({
      formula: 'drop hints revision check',
      ...row,
      holds,
    })}`
  );
  assert.equal(holds, false, 'mutant must turn lazy-stale-ordinary red');
});
