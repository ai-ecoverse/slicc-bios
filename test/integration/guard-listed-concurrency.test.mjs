import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FAILED } from '../../src/seed/guard.js';

const ordinary = 'https://ordinary.invalid/page';
const protectedOrigin = 'https://protected.invalid';
const secret = `${protectedOrigin}/secret`;
const failed = `${protectedOrigin}/controller/synthetic-listed-id`;
const LISTED_CHECKS = 8;
const guardSource = fileURLToPath(new URL('../../src/seed/guard.js', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));

const serialListedSource = `async listed(message, result) {
    const targetInfos = [];
    for (const info of result.targetInfos) {
      this.learn(info);
      const guarded = (await this.current(info.targetId)) || this.is.url(info.url);
      const proof = guarded ? await this.stranded(info.targetId) : null;
      if (!guarded || this.fresh(proof)) targetInfos.push(this.masked(info, Boolean(proof)));
    }
    return this.deliver({ ...message, result: { ...result, targetInfos } });
  }`;

function serialOracleModule() {
  const dir = join(root, 'test/unit');
  mkdirSync(dir, { recursive: true });
  const text = readFileSync(guardSource, 'utf8');
  const replaced = text.replace(
    /async listed\(message, result\) \{[\s\S]*?\n {2}\}\n\n {2}pageAnswer/,
    `${serialListedSource}\n\n  pageAnswer`
  );
  assert.notEqual(replaced, text, 'serial oracle must replace listed()');
  const patched = replaced
    .replaceAll("from './", "from '../../src/seed/")
    .replaceAll('from "./', 'from "../../src/seed/');
  const path = join(dir, 'listed-serial-oracle-guard.js');
  writeFileSync(path, patched);
  return `${pathToFileURL(path).href}?serial=${Date.now()}`;
}

function spyGuardModule() {
  const dir = join(root, 'test/unit');
  mkdirSync(dir, { recursive: true });
  const text = readFileSync(guardSource, 'utf8');
  const patched = text
    .replace(
      'learn(info) {\n    if (!info?.targetId) return;',
      `learn(info) {
    globalThis.__listedLearnSpy?.(info);
    if (!info?.targetId) return;`
    )
    .replaceAll("from './", "from '../../src/seed/")
    .replaceAll('from "./', 'from "../../src/seed/');
  assert.match(patched, /__listedLearnSpy/);
  const path = join(dir, 'listed-spy-guard.js');
  writeFileSync(path, patched);
  return `${pathToFileURL(path).href}?spy=${Date.now()}`;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plainFrame = (id, url = ordinary) => ({
  id,
  url,
  securityOrigin: URL.canParse(url) ? new URL(url).origin : '://',
});
const errorFrame = (id) => ({
  id,
  url: 'chrome-error://chromewebdata/',
  securityOrigin: '://',
  unreachableUrl: failed,
});

async function protocol(t, options = {}) {
  const { guardProtected } = await import(options.guardSource ?? '../../src/seed/guard.js');
  const targets = new Map();
  const sessions = new Map();
  const sent = [];
  const held = [];
  const pending = new Map();
  const delivered = [];
  const stats = { inFlight: 0, peak: 0, overlaps: 0, phase1: 0, phase2: 0 };
  let listingOrder;
  let next = 0;
  let hold = () => false;
  let latency = () => 0;
  let failInfo = () => null;
  let liveInfo = () => null;
  let onSend = () => {};
  let phase = 'idle';
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      sent.push(message);
      onSend(message);
      if (hold(message)) return void held.push(message);
      const delay = message.method === 'Target.getTargetInfo' ? latency(message) : 0;
      const fail = message.method === 'Target.getTargetInfo' ? failInfo(message) : null;
      if (message.method === 'Target.getTargetInfo') {
        stats.inFlight++;
        stats.peak = Math.max(stats.peak, stats.inFlight);
        if (stats.inFlight > 1) stats.overlaps++;
        if (phase === 'phase1') stats.phase1++;
        if (phase === 'phase2') stats.phase2++;
      }
      if (message.method === 'Target.getTargets') phase = 'phase1';
      const finish = () => {
        if (message.method === 'Target.getTargetInfo') {
          stats.inFlight--;
          if (
            phase === 'phase1' &&
            stats.inFlight === 0 &&
            stats.phase1 >= (listingOrder?.length ?? 0)
          )
            phase = 'phase2';
        }
        respond(message, fail);
      };
      if (delay > 0) setTimeout(finish, delay);
      else queueMicrotask(finish);
    },
    close() {},
  };
  const guard = guardProtected(raw, protectedOrigin);
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    delivered.push(message);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  t.after(() => guard.close());
  const emit = (message) => raw.onmessage(JSON.stringify(message));
  function respond(message, payload) {
    const { id, method, params = {}, sessionId } = message;
    const targetId = params.targetId ?? sessions.get(sessionId);
    const target = targets.get(targetId);
    let result = {};
    if (method === 'Target.getTargetInfo') {
      const live = liveInfo(message);
      if (live) result = live.result ? live.result : live;
      else if (!target?.info) result = {};
      else result = { targetInfo: target.live ?? target.info };
    }
    if (method === 'Target.getTargets') {
      const infos = listingOrder
        ? listingOrder.map((entry) => entry.info)
        : [...targets.values()].map((entry) => entry.info);
      result = { targetInfos: infos };
      phase = 'phase1';
      stats.phase1 = 0;
      stats.phase2 = 0;
    }
    if (method === 'Target.attachToTarget') {
      const attached = `${id >= 2 ** 30 ? 'guard' : 'client'}-${targetId}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Page.getFrameTree') result = { frameTree: target.tree };
    if (method === 'Page.getNavigationHistory') {
      result = { currentIndex: 0, entries: [{ id: 1, url: target.info.url, title: 'ordinary' }] };
    }
    if (method === 'Runtime.evaluate') {
      result = { result: { type: 'string', value: 'synthetic-content' } };
    }
    emit({ id, ...(sessionId ? { sessionId } : {}), ...(payload ?? { result }) });
  }
  function request(method, params = {}, sessionId, id = ++next) {
    const answer = new Promise((resolve) => pending.set(id, resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return { id, answer };
  }
  const send = (method, params, sessionId) => request(method, params, sessionId).answer;
  function target(id, type = 'page', frame = plainFrame(id)) {
    const entry = { info: { targetId: id, type, url: frame.url }, tree: { frame } };
    targets.set(id, entry);
    return entry;
  }
  async function attach(id) {
    const answer = await send('Target.attachToTarget', { targetId: id, flatten: true });
    assert.equal(answer.error, undefined);
    await flush();
    return answer.result.sessionId;
  }
  function release(message, payload) {
    assert.ok(message, 'a protocol answer is pending');
    held.splice(held.indexOf(message), 1);
    respond(message, payload);
  }
  return {
    targets,
    sent,
    held,
    delivered,
    stats,
    emit,
    send,
    request,
    target,
    attach,
    release,
    respond,
    order(entries) {
      listingOrder = entries;
    },
    hold(fn) {
      hold = fn;
    },
    latency(fn) {
      latency = fn;
    },
    failInfo(fn) {
      failInfo = fn;
    },
    liveInfo(fn) {
      liveInfo = fn;
    },
    onSend(fn) {
      onSend = fn;
    },
  };
}

function seedMix(wire, count = 45) {
  const kinds = [];
  for (let i = 0; i < count; i++) {
    const id = `t${i}`;
    const roll = i % 7;
    if (roll === 0) {
      const entry = wire.target(id, 'page', plainFrame(id, failed));
      entry.info.url = failed;
      kinds.push('protected');
    } else if (roll === 2) {
      const entry = wire.target(id);
      entry.info = { targetId: id, type: 'page' };
      kinds.push('no-info-url');
    } else if (roll === 3) {
      wire.target(id);
      kinds.push('error-info');
    } else {
      wire.target(id);
      kinds.push('ordinary');
    }
  }
  return kinds;
}

async function strandedSetup(wire, id = 'stranded') {
  const entry = wire.target(id, 'page', plainFrame(id));
  await wire.attach(id);
  entry.tree.frame = errorFrame(id);
  entry.info.url = `${failed}?private=query#fragment`;
  entry.info.title = 'private error title';
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${id}`,
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  return entry;
}

function openerPair(wire, childFirst) {
  const parent = wire.target('P', 'page', plainFrame('P', ordinary));
  parent.info.url = ordinary;
  parent.live = { targetId: 'P', type: 'page', url: secret };
  const child = wire.target('C', 'page', plainFrame('C', 'about:blank'));
  child.info.url = 'about:blank';
  child.info.openerId = 'P';
  wire.order(childFirst ? [child, parent] : [parent, child]);
  return { child, parent };
}

test('listed concurrency matches serial oracle for mixed targets', {
  timeout: 30000,
}, async (t) => {
  const oraclePath = serialOracleModule();
  const count = 45;
  const latencies = Array.from({ length: count }, (_, i) => 1 + ((i * 11) % 17));
  async function run(source) {
    const wire = await protocol(t, { guardSource: source });
    const kinds = seedMix(wire, count);
    await strandedSetup(wire, 'stranded');
    wire.latency((message) => {
      const id = message.params?.targetId ?? '';
      if (id === 'stranded') return 3;
      const index = Number(String(id).replace(/^t/, ''));
      return latencies[index] ?? 2;
    });
    wire.failInfo((message) => {
      const id = message.params?.targetId ?? '';
      const index = Number(String(id).replace(/^t/, ''));
      if (kinds[index] === 'error-info') return { error: { code: -32000, message: 'synthetic' } };
      return null;
    });
    const answer = await wire.send('Target.getTargets');
    assert.equal(answer.error, undefined);
    return answer.result.targetInfos;
  }
  const concurrent = await run(pathToFileURL(guardSource).href);
  const serial = await run(oraclePath);
  assert.deepEqual(concurrent, serial);
  assert.ok(concurrent.some((info) => info.targetId === 'stranded'));
  assert.equal(concurrent.find((info) => info.targetId === 'stranded')?.url, protectedOrigin);
  assert.equal(
    concurrent.some(
      (info) => info.url === failed || JSON.stringify(info).includes('private=query')
    ),
    false
  );
});

test('listed concurrency peak in-flight is bounded for 45 targets', {
  timeout: 30000,
}, async (t) => {
  const wire = await protocol(t);
  seedMix(wire, 45);
  wire.latency(() => 8);
  const answer = await wire.send('Target.getTargets');
  assert.equal(answer.error, undefined);
  assert.ok(wire.stats.peak > 1, `peak in-flight ${wire.stats.peak} should exceed 1`);
  assert.ok(
    wire.stats.peak <= LISTED_CHECKS,
    `peak in-flight ${wire.stats.peak} should be <= ${LISTED_CHECKS}`
  );
  assert.ok(wire.stats.overlaps > 0, 'getTargetInfo calls should overlap');
});

test('listed concurrency overlaps getTargetInfo under fake 8 ms latency', {
  timeout: 30000,
}, async (t) => {
  const wire = await protocol(t);
  seedMix(wire, 45);
  wire.latency(() => 8);
  const answer = await wire.send('Target.getTargets');
  assert.equal(answer.error, undefined);
  const probes = wire.sent.filter((message) => message.method === 'Target.getTargetInfo');
  assert.ok(probes.length >= 45);
  assert.ok(wire.stats.overlaps > 0, 'call overlap proves wall time under serial 45 x 8 ms');
  assert.ok(wire.stats.peak >= 2);
  assert.ok(wire.stats.peak <= LISTED_CHECKS);
});

test('listed concurrency keeps a timed-out check guarded', { timeout: 10000 }, async (t) => {
  const wire = await protocol(t);
  wire.target('ok');
  wire.target('timed');
  wire.latency((message) => (message.params?.targetId === 'timed' ? 2500 : 0));
  const answer = await wire.send('Target.getTargets');
  assert.equal(answer.error, undefined);
  assert.deepEqual(
    answer.result.targetInfos.map((info) => info.targetId),
    ['ok']
  );
});

test('listed concurrency leaves a protected target out', { timeout: 10000 }, async (t) => {
  const wire = await protocol(t);
  wire.target('ok');
  const locked = wire.target('locked', 'page', plainFrame('locked', failed));
  locked.info.url = failed;
  locked.info.title = 'secret';
  const answer = await wire.send('Target.getTargets');
  assert.equal(answer.error, undefined);
  assert.deepEqual(
    answer.result.targetInfos.map((info) => info.targetId),
    ['ok']
  );
  assert.equal(JSON.stringify(answer).includes(failed), false);
});

test('listed concurrency two getTargets in flight stay independent', {
  timeout: 15000,
}, async (t) => {
  const wire = await protocol(t);
  const a = wire.target('a').info;
  const b = wire.target('b').info;
  const locked = wire.target('locked', 'page', plainFrame('locked', failed)).info;
  locked.url = failed;
  wire.hold((message) => message.method === 'Target.getTargets');
  const first = wire.request('Target.getTargets');
  await flush();
  const firstHeld = wire.held.find((message) => message.method === 'Target.getTargets');
  assert.ok(firstHeld);
  wire.targets.delete('locked');
  wire.target('c');
  const second = wire.request('Target.getTargets');
  await flush();
  const secondHeld = wire.held.find(
    (message) => message.method === 'Target.getTargets' && message !== firstHeld
  );
  assert.ok(secondHeld);
  wire.release(firstHeld, { result: { targetInfos: [a, b, locked] } });
  wire.release(secondHeld, {
    result: { targetInfos: [a, b, wire.targets.get('c').info] },
  });
  const [one, two] = await Promise.all([first.answer, second.answer]);
  assert.equal(one.error, undefined);
  assert.equal(two.error, undefined);
  assert.deepEqual(
    one.result.targetInfos.map((info) => info.targetId),
    ['a', 'b']
  );
  assert.deepEqual(
    two.result.targetInfos.map((info) => info.targetId),
    ['a', 'b', 'c']
  );
});

test('listed concurrency throw refuses like serial and does not fail open', {
  timeout: 10000,
}, async (t) => {
  const wire = await protocol(t);
  wire.target('a');
  const locked = wire.target('locked', 'page', plainFrame('locked', failed));
  locked.info.url = failed;
  wire.onSend((message) => {
    if (message.method === 'Target.getTargetInfo' && message.params?.targetId === 'locked')
      throw new Error('synthetic listed throw');
  });
  const answer = await wire.send('Target.getTargets');
  assert.equal(answer.error?.message, FAILED);
  assert.equal(answer.result, undefined);
  assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
});

for (const [order, mode] of [
  ['child-first', 'protected'],
  ['child-first', 'error'],
  ['parent-first', 'protected'],
  ['parent-first', 'error'],
]) {
  test(`listed opener order ${order} live ${mode} matches serial empty list`, {
    timeout: 15000,
  }, async (t) => {
    const oraclePath = serialOracleModule();
    async function run(source) {
      const wire = await protocol(t, { guardSource: source });
      openerPair(wire, order === 'child-first');
      if (mode === 'error') {
        wire.failInfo((message) =>
          message.params?.targetId === 'P'
            ? { error: { code: -32000, message: 'No target with given id found' } }
            : null
        );
      }
      wire.latency((message) => (message.params?.targetId === 'P' ? 20 : 1));
      const answer = await wire.send('Target.getTargets');
      assert.equal(answer.error, undefined);
      return answer.result.targetInfos;
    }
    const concurrent = await run(pathToFileURL(guardSource).href);
    const serial = await run(oraclePath);
    assert.deepEqual(concurrent, serial);
    assert.deepEqual(concurrent, []);
    assert.equal(JSON.stringify(concurrent).includes(secret), false);
  });
}

test('listed throw in prefetch stops serial learn after that target', {
  timeout: 10000,
}, async (t) => {
  const learns = [];
  globalThis.__listedLearnSpy = (info) => learns.push(info?.targetId);
  t.after(() => {
    delete globalThis.__listedLearnSpy;
  });
  const wire = await protocol(t, { guardSource: spyGuardModule() });
  wire.target('a');
  wire.target('b');
  wire.target('k');
  wire.target('after');
  wire.onSend((message) => {
    if (message.method === 'Target.getTargetInfo' && message.params?.targetId === 'k')
      throw new Error('synthetic listed throw');
  });
  const answer = await wire.send('Target.getTargets');
  assert.equal(answer.error?.message, FAILED);
  assert.equal(answer.result, undefined);
  assert.ok(learns.includes('a'));
  assert.ok(learns.includes('b'));
  assert.ok(learns.includes('k'));
  assert.equal(learns.includes('after'), false);
});

test('listed phase1 peak bound and phase2 skips fresh getTargetInfo without opener', {
  timeout: 30000,
}, async (t) => {
  const wire = await protocol(t);
  for (let i = 0; i < 45; i++) wire.target(`t${i}`);
  wire.latency(() => 8);
  const before = wire.sent.length;
  const answer = await wire.send('Target.getTargets');
  assert.equal(answer.error, undefined);
  assert.ok(wire.stats.peak > 1);
  assert.ok(wire.stats.peak <= LISTED_CHECKS);
  const probes = wire.sent
    .slice(before)
    .filter((message) => message.method === 'Target.getTargetInfo');
  assert.equal(probes.length, 45);
  assert.ok(wire.stats.overlaps > 0);
});
