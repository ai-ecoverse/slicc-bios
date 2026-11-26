import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import * as guard from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';
import { flush, ordinary, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const { DOCUMENT_MS, PROTECTED, RELOAD_MS, RELOADED, RELOADS_FULL, TURN_MS, TURNS_KEPT } = guard;
const { UNANSWERED } = guard;
const GUARD = 2 ** 30;
const SEVEN_PAGE = `${protectedOrigin}/os/`;
const VAULT_PAGE = 'https://vault.sliccy.ai/';
const OTHER = 'https://ordinary.invalid/other';
const SIGN_IN = 'https://ordinary.invalid/page?client_id=experience-catalyst-prod';
const NAVIGATED = 'Reload was discarded because the page already navigated';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (id, url, loaderId = `loader-${id}`) => ({
  id,
  url,
  securityOrigin: new URL(url).origin,
  loaderId,
});
const frozen = (message) =>
  message.id >= GUARD && ['Page.enable', 'Page.getFrameTree'].includes(message.method);
const guardRead = (targetId) => (message) =>
  message.id >= GUARD &&
  message.method === 'Target.getTargetInfo' &&
  message.params?.targetId === targetId;
const ownCall = (method) => (message) => message.id >= GUARD && message.method === method;
const guardSession = (p, targetId) =>
  [...p.sessions].findLast(([id, target]) => target === targetId && id.startsWith('guard'))?.[0];
const reloadsSent = (p, since = 0) =>
  p.sent.slice(since).filter((message) => message.method === 'Page.reload');
const ownReloads = (p, since = 0) => reloadsSent(p, since).filter((message) => message.id >= GUARD);

const MUTANTS = {
  'skip-fresh-check': [
    [
      'const { refusal, record } = await this.reloadRefusal(targetId, nav);',
      'const record = recordedDocument(targetId); const refusal = null;',
    ],
  ],
  'admit-extra-params': [
    ['if (Object.keys(params).some((key) => !REVIVES.has(key))) return false;', ''],
  ],
  'no-loader': [['{ ignoreCache }), loaderId: record.loaderId },', '{ ignoreCache }) },']],
  'visible-url-only': [
    [
      'if (!record || shown !== record.url || url !== record.url)',
      'if (!record || url !== record.url)',
    ],
  ],
  'record-unmatched': [
    ['if (!record || shown !== record.url || url !== record.url)', 'if (!record || shown !== url)'],
  ],
  'split-reservation': [
    [
      'const busy = this.reloadShielded(targetId) ? PROTECTED : reserveReload(targetId);',
      'const busy = this.reloadShielded(targetId) ? PROTECTED : (reloads.get(targetId) ?? -Infinity) > Date.now() ? RELOADED : null;',
    ],
    ['    nav.revived = true;\n', '    nav.revived = true;\n    reserveReload(targetId);\n'],
  ],
  'evict-live': [
    [
      '  if (reloads.size >= TURNS_KEPT) return RELOADS_FULL;',
      '  if (reloads.size >= TURNS_KEPT) reloads.delete(reloads.keys().next().value);',
    ],
  ],
  'reserve-first': [
    [
      'const busy = this.reloadShielded(targetId) ? PROTECTED : reserveReload(targetId);',
      'const busy = reserveReload(targetId) ?? (this.reloadShielded(targetId) ? PROTECTED : null);',
    ],
  ],
  'shared-turn': [['    while (this.turnBusy(targetId))\n', '    if (this.turnBusy(targetId))\n']],
  'iframe-writer': [['        frame?.id === targetId &&\n        !frame.parentId &&\n', '']],
  'no-rewrite': [
    [
      '  documents.set(targetId, { ...record, at: now });',
      '  if (!documents.has(targetId)) documents.set(targetId, { ...record, at: now });',
    ],
  ],
  'protected-recorded': [
    ['      !this.is.url(url) &&\n      !isHeld(targetId) &&', '      !isHeld(targetId) &&'],
  ],
  'stale-admitted': [
    ['return record && now - record.at < DOCUMENT_MS ? record : undefined;', 'return record;'],
    ['sweep(documents, (old) => now - old.at >= DOCUMENT_MS);', 'sweep(documents, () => false);'],
  ],
  'no-sweep': [
    [
      'function sweep(map, gone) {\n',
      'function sweep(map, gone) {\n  if (map.size < TURNS_KEPT) return;\n',
    ],
  ],
  'forward-private': [
    [
      'return this.navEvent(message, this.navSessions.get(sessionId));',
      'return this.deliver(message);',
    ],
  ],
};

registerHooks({
  load(url, context, next) {
    const mutant = URL.parse(url)?.searchParams.get('mutant');
    const loaded = next(url, context);
    if (!mutant || !MUTANTS[mutant] || !url.split('?')[0].endsWith('/guard.js')) return loaded;
    let source = String(loaded.source);
    for (const [from, to] of MUTANTS[mutant]) {
      assert.equal(source.split(from).length, 2, `mutant ${mutant}: one patch site for ${from}`);
      source = source.replace(from, to);
    }
    return { ...loaded, source };
  },
});

const mutantGuard = (mutant) =>
  import(`${new URL('../../src/seed/guard.js', import.meta.url).href}?mutant=${mutant}`);

async function seen(t, targetId, mod = guard, url = ordinary) {
  const p = protocol(t, mod.guardProtected);
  const entry = p.target(targetId, 'page', at(targetId, url));
  const sessionId = await p.attach(targetId);
  return { p, entry, sessionId };
}

async function frozenConnection(t, targetId, mod = guard) {
  const p = protocol(t, mod.guardProtected);
  const entry = p.target(targetId, 'page', at(targetId, ordinary));
  p.hold(frozen);
  const answer = await p.send('Target.attachToTarget', { targetId, flatten: true });
  assert.equal(answer.error?.message, UNANSWERED, JSON.stringify(answer));
  return { p, entry };
}

async function unanswered(t, targetId, mod = guard) {
  await seen(t, targetId, mod);
  return frozenConnection(t, targetId, mod);
}

async function heldCall(p, match, since) {
  for (let n = 0; n < 400; n += 1) {
    const found = p.held.find((message) => p.sent.indexOf(message) >= since && match(message));
    if (found) return found;
    await pause(5);
  }
  assert.fail('the guard did not send the expected call');
}

async function readHeld(p, targetId, release) {
  const since = p.sent.length;
  p.hold((message) => frozen(message) || guardRead(targetId)(message));
  const reloading = p.send('Page.reload', { targetId });
  release(await heldCall(p, guardRead(targetId), since));
  return { answer: await reloading, sent: ownReloads(p, since).length };
}

async function racedTurn(t, mod) {
  const targetId = 'turn-raced';
  const { p } = await unanswered(t, targetId, mod);
  const first = mod.fly(targetId, 'answer', 60000);
  let second;
  t.after(() => {
    first.land();
    second?.land();
  });
  const since = p.sent.length;
  const reloading = p.send('Page.reload', { targetId });
  await pause(300);
  const turn = mod.tabTurn(targetId);
  let armed = true;
  class Racing extends Set {
    *[Symbol.iterator]() {
      const flights = [...this.values()];
      yield* flights;
      if (!armed || flights.length) return;
      armed = false;
      second = mod.fly(targetId, 'answer', 60000);
    }
  }
  turn.flying = new Racing(turn.flying);
  first.land();
  const reply = await reloading;
  return reply.error?.message === UNANSWERED && ownReloads(p, since).length === 0;
}

const CHECKED = [
  [
    'no-loader',
    'an unanswered tab reloads pinned to the recorded document’s loader',
    async (t, mod) => {
      const { p } = await unanswered(t, 'pinned', mod);
      const since = p.sent.length;
      const answer = await p.send('Page.reload', { targetId: 'pinned' });
      const sent = ownReloads(p, since);
      return (
        answer.error === undefined &&
        sent.length === 1 &&
        sent[0].params.loaderId === 'loader-pinned'
      );
    },
  ],
  [
    'skip-fresh-check',
    'a tab that moved onto seven before the fresh read is not reloaded',
    async (t, mod) => {
      const { p, entry } = await unanswered(t, 'skip-moved', mod);
      entry.info.url = SEVEN_PAGE;
      entry.tree.frame = at('skip-moved', SEVEN_PAGE);
      const since = p.sent.length;
      p.hold((message) => frozen(message) || guardRead('skip-moved')(message));
      const answer = await p.send('Page.reload', { targetId: 'skip-moved' });
      return answer.error?.message === PROTECTED && ownReloads(p, since).length === 0;
    },
  ],
  [
    'admit-extra-params',
    'a script for the next load is never sent with a reload',
    async (t, mod) => {
      const { p } = await unanswered(t, 'extra-params', mod);
      const since = p.sent.length;
      await p.send('Page.reload', { targetId: 'extra-params', scriptToEvaluateOnLoad: 'x' });
      return ownReloads(p, since).length === 0;
    },
  ],
  [
    'visible-url-only',
    'an ordinary pending entry over a protected committed entry is refused as protected',
    async (t, mod) => {
      const { p } = await unanswered(t, 'masked', mod);
      const since = p.sent.length;
      p.hold((message) => frozen(message) || ownCall('Page.getNavigationHistory')(message));
      const reloading = p.send('Page.reload', { targetId: 'masked' });
      const history = await heldCall(p, ownCall('Page.getNavigationHistory'), since);
      p.release(history, {
        result: {
          currentIndex: 1,
          entries: [
            { id: 1, url: ordinary, title: 'ordinary' },
            { id: 2, url: SEVEN_PAGE, title: 'seven' },
          ],
        },
      });
      const answer = await reloading;
      return answer.error?.message === PROTECTED && ownReloads(p, since).length === 0;
    },
  ],
  [
    'record-unmatched',
    'a record that no longer names the visible and current document is refused as protected',
    async (t, mod) => {
      const { p, entry } = await unanswered(t, 'unmatched', mod);
      entry.info.url = OTHER;
      const { answer, sent } = await readHeld(p, 'unmatched', (read) =>
        p.release(read, { result: { targetInfo: entry.info } })
      );
      return answer.error?.message === PROTECTED && sent === 0;
    },
  ],
  [
    'stale-admitted',
    'an expired record does not admit a reload',
    async (t, mod) => {
      const { p } = await unanswered(t, 'expired', mod);
      mod.recordedDocument('expired').at -= DOCUMENT_MS;
      const since = p.sent.length;
      const answer = await p.send('Page.reload', { targetId: 'expired' });
      return ownReloads(p, since).length === 0 && answer.result === undefined;
    },
  ],
  [
    'split-reservation',
    'a second connection’s reload during the first one’s read gets the busy answer',
    async (t, mod) => {
      const { p } = await unanswered(t, 'two-connections', mod);
      const { p: q } = await frozenConnection(t, 'two-connections', mod);
      const since = p.sent.length;
      p.hold((message) => frozen(message) || guardRead('two-connections')(message));
      const first = p.send('Page.reload', { targetId: 'two-connections' });
      const read = await heldCall(p, guardRead('two-connections'), since);
      const second = q.send('Page.reload', { targetId: 'two-connections' });
      await pause(100);
      p.release(read, { result: { targetInfo: p.targets.get('two-connections').info } });
      const answers = [await first, await second];
      return (
        answers[0].error === undefined &&
        answers[1].error?.message === RELOADED &&
        ownReloads(p).length + ownReloads(q).length === 1
      );
    },
  ],
  [
    'evict-live',
    'a full cooldown map keeps a live entry and refuses a new tab',
    async (_t, mod) => {
      const base = Date.now() - RELOAD_MS - 1;
      const first = mod.reserveReload('live-slot', base);
      const answers = [];
      for (let n = 0; n < TURNS_KEPT; n += 1) answers.push(mod.reserveReload(`slot-${n}`, base));
      const kept = mod.reserveReload('live-slot', base);
      const late = mod.reserveReload('slot-late', base + RELOAD_MS + 1);
      return first === null && answers.at(-1) === RELOADS_FULL && kept === RELOADED && !late;
    },
  ],
  [
    'reserve-first',
    'a tab that became held while its slot is taken is refused as protected, not busy',
    async (t, mod, tag) => {
      const targetId = `held-later${tag}`;
      const { p } = await unanswered(t, targetId, mod);
      mod.reserveReload(targetId);
      hold(targetId);
      const since = p.sent.length;
      const answer = await p.send('Page.reload', { targetId });
      return answer.error?.message === PROTECTED && ownReloads(p, since).length === 0;
    },
  ],
  [
    'shared-turn',
    'the reload takes the tab’s turn only when no other flight took it first',
    racedTurn,
  ],
  [
    'iframe-writer',
    'an iframe commit leaves the tab’s record untouched',
    async (t, mod) => {
      const { p, sessionId } = await seen(t, 'iframe-commit', mod);
      p.emit({
        method: 'Page.frameNavigated',
        sessionId,
        params: { frame: { ...at('child', OTHER, 'iframe-loader'), parentId: 'iframe-commit' } },
      });
      const right = mod.recordedDocument('iframe-commit')?.loaderId === 'loader-iframe-commit';
      await flush();
      return right && mod.recordedDocument('iframe-commit')?.loaderId === 'loader-iframe-commit';
    },
  ],
  [
    'no-rewrite',
    'a later ordinary commit and a same-document move rewrite the tab’s record',
    async (t, mod) => {
      const { p, entry, sessionId } = await seen(t, 'rewritten', mod);
      entry.tree.frame = at('rewritten', OTHER, 'loader-two');
      p.emit({
        method: 'Page.frameNavigated',
        sessionId,
        params: { frame: at('rewritten', OTHER, 'loader-two'), type: 'Navigation' },
      });
      await flush();
      const committed = { ...mod.recordedDocument('rewritten') };
      entry.tree.frame.urlFragment = '#moved';
      p.emit({
        method: 'Page.navigatedWithinDocument',
        sessionId,
        params: { frameId: 'rewritten', url: `${OTHER}#moved`, navigationType: 'fragment' },
      });
      await flush();
      const moved = mod.recordedDocument('rewritten');
      return (
        committed.loaderId === 'loader-two' &&
        committed.url === OTHER &&
        moved?.loaderId === 'loader-two' &&
        moved.url === `${OTHER}#moved`
      );
    },
  ],
  [
    'protected-recorded',
    'a commit to seven is recorded as no admission',
    async (t, mod) => {
      const { p, entry, sessionId } = await seen(t, 'seven-commit', mod);
      entry.tree.frame = at('seven-commit', SEVEN_PAGE, 'loader-seven');
      p.emit({
        method: 'Page.frameNavigated',
        sessionId,
        params: { frame: at('seven-commit', SEVEN_PAGE, 'loader-seven') },
      });
      await flush();
      return mod.recordedDocument('seven-commit') === undefined;
    },
  ],
  [
    'no-sweep',
    'expired records and slots are swept on every insert, without a full map',
    async (_t, mod) => {
      const record = { loaderId: 'L', url: OTHER };
      const old = Date.now() - DOCUMENT_MS - 1;
      mod.keepDocument('swept-record', record, old);
      mod.keepDocument('fresh-record', record);
      const slot = Date.now() - RELOAD_MS - 1;
      mod.reserveReload('swept-slot', slot);
      mod.reserveReload('fresh-slot');
      return (
        mod.recordedDocument('swept-record', old) === undefined &&
        mod.reserveReload('swept-slot', slot) === null
      );
    },
  ],
  [
    'forward-private',
    'with an observer on the same tab, no event of a guard’s own session reaches either client, and the tab’s ordinary events reach both',
    async (t, mod, tag) => {
      const targetId = `observed${tag}`;
      const observer = await seen(t, targetId, mod);
      const { p } = await frozenConnection(t, targetId, mod);
      for (const wire of [observer.p, p])
        await wire.send('Target.setDiscoverTargets', { discover: true });
      await observer.p.send('Page.enable', {}, observer.sessionId);
      const privates = [guardSession(p, targetId), guardSession(observer.p, targetId)];
      const marks = [p.delivered.length, observer.p.delivered.length];
      const since = p.sent.length;
      p.hold((message) => frozen(message) || ownCall('Page.reload')(message));
      const reloading = p.request('Page.reload', { targetId });
      const reload = await heldCall(p, ownCall('Page.reload'), since);
      const started = {
        frameId: targetId,
        url: ordinary,
        loaderId: 'next',
        navigationType: 'reload',
      };
      const request = {
        requestId: 'r',
        loaderId: 'next',
        frameId: targetId,
        documentURL: ordinary,
        request: { url: ordinary, method: 'GET', headers: {} },
        type: 'Document',
      };
      const emitPrivate = () => {
        for (const [wire, sessionId] of [
          [p, privates[0]],
          [observer.p, privates[1]],
        ]) {
          wire.emit({ method: 'Page.frameStartedNavigating', sessionId, params: started });
          wire.emit({ method: 'Network.requestWillBeSent', sessionId, params: request });
        }
      };
      emitPrivate();
      observer.p.emit({
        method: 'Page.frameStartedNavigating',
        sessionId: observer.sessionId,
        params: started,
      });
      const info = { ...p.targets.get(targetId).info, title: 'reloading', attached: true };
      for (const wire of [p, observer.p])
        wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: info } });
      p.release(reload, { result: {} });
      const answer = await reloading.answer;
      emitPrivate();
      await pause(200);
      const mine = p.delivered.slice(marks[0]);
      const theirs = observer.p.delivered.slice(marks[1]);
      const leaked = [...mine, ...theirs].some((message) => privates.includes(message.sessionId));
      const changed = (list) =>
        list.some(
          (message) =>
            message.method === 'Target.targetInfoChanged' &&
            message.params?.targetInfo?.targetId === targetId
        );
      const watched = theirs.some(
        (message) =>
          message.method === 'Page.frameStartedNavigating' &&
          message.sessionId === observer.sessionId
      );
      const replies = mine.filter((message) => message.id !== undefined);
      return (
        answer.error === undefined &&
        !leaked &&
        changed(mine) &&
        changed(theirs) &&
        watched &&
        replies.length === 1 &&
        replies[0].id === reloading.id
      );
    },
  ],
];

for (const [mutant, title, row] of CHECKED) {
  test(title, { timeout: 60000 }, async (t) => {
    assert.equal(await row(t, guard, ''), true);
  });
  test(`mutant ${mutant} turns “${title}” red`, { timeout: 60000 }, async (t) => {
    assert.equal(await row(t, await mutantGuard(mutant), '-mutant'), false);
  });
}

test('an unanswered tab reloads through the guard’s own session and then attaches with a full setup', {
  timeout: 60000,
}, async (t) => {
  const { p } = await unanswered(t, 'recover');
  const before = guardSession(p, 'recover');
  const since = p.sent.length;
  const reloaded = await p.send('Page.reload', { targetId: 'recover' });
  assert.deepEqual(reloaded, { id: reloaded.id, result: {} });
  const sent = reloadsSent(p, since);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, before);
  assert.deepEqual(sent[0].params, { loaderId: 'loader-recover' });
  assert.ok(sent[0].id >= GUARD, 'the reload goes out as the guard’s own command');
  await flush();
  assert.ok(
    p.sent
      .slice(since)
      .some(
        (message) =>
          message.method === 'Target.detachFromTarget' && message.params?.sessionId === before
      ),
    'the guard drops its session for the tab'
  );
  p.hold(() => false);
  const setupFrom = p.sent.length;
  const attached = await p.send('Target.attachToTarget', { targetId: 'recover', flatten: true });
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  const armed = p.sent
    .slice(setupFrom)
    .filter(
      (message) =>
        message.id >= GUARD &&
        ['Target.attachToTarget', 'Fetch.enable', 'Page.enable'].includes(message.method)
    )
    .map((message) => message.method);
  assert.deepEqual(
    [...new Set(armed)],
    ['Target.attachToTarget', 'Fetch.enable', 'Page.enable'],
    'the next attach armed the tab again from the start'
  );
});

test('a record written by another connection admits the reload on one whose own read never answered', {
  timeout: 60000,
}, async (t) => {
  await seen(t, 'across');
  assert.equal(guard.recordedDocument('across').loaderId, 'loader-across');
  const { p } = await frozenConnection(t, 'across');
  const since = p.sent.length;
  assert.equal((await p.send('Page.reload', { targetId: 'across' })).error, undefined);
  assert.deepEqual(reloadsSent(p, since)[0].params, { loaderId: 'loader-across' });
});

test('a tab no guarded connection read before it froze is not reloaded through the guard', {
  timeout: 60000,
}, async (t) => {
  const { p } = await frozenConnection(t, 'never-read');
  const since = p.sent.length;
  const answer = await p.send('Page.reload', { targetId: 'never-read' });
  assert.equal(answer.result, undefined);
  assert.equal(ownReloads(p, since).length, 0);
});

test('ignoreCache reaches the guard’s reload as sent', { timeout: 60000 }, async (t) => {
  const { p } = await unanswered(t, 'ignore-cache');
  const since = p.sent.length;
  const reloaded = await p.send('Page.reload', { targetId: 'ignore-cache', ignoreCache: true });
  assert.equal(reloaded.error, undefined);
  assert.deepEqual(reloadsSent(p, since)[0].params, {
    ignoreCache: true,
    loaderId: 'loader-ignore-cache',
  });
});

for (const [label, params, sessionId] of [
  ['a script for the next load', { scriptToEvaluateOnLoad: 'window.x = 1' }],
  ['a loader id', { loaderId: 'L' }],
  ['an unknown key', { other: true }],
  ['an ignoreCache that is not a boolean', { ignoreCache: 'yes' }],
  ['a session id', {}, 'client-params'],
]) {
  test(`a reload with ${label} is not admitted as a recovery`, { timeout: 60000 }, async (t) => {
    const targetId = `params-${label.replaceAll(' ', '-')}`;
    const { p } = await unanswered(t, targetId);
    const before = guardSession(p, targetId);
    const since = p.sent.length;
    const answer = await p.send('Page.reload', { targetId, ...params }, sessionId);
    assert.ok(
      !reloadsSent(p, since).some((message) => message.sessionId === before),
      `nothing reached the guard’s session: ${JSON.stringify(answer)}`
    );
    assert.notDeepEqual(answer.result, {}, 'it was not answered as a recovery');
    assert.equal(p.inner().navs.get(targetId)?.session, before, 'the nav was not retired');
  });
}

for (const [label, url] of [
  ['seven', SEVEN_PAGE],
  ['the vault', VAULT_PAGE],
]) {
  test(`a reload of a tab on ${label} is refused as protected and sends nothing`, async (t) => {
    const p = protocol(t);
    p.target('shielded', 'page', at('shielded', url));
    p.hold(frozen);
    const attached = await p.send('Target.attachToTarget', { targetId: 'shielded', flatten: true });
    assert.equal(attached.error?.message, PROTECTED);
    const since = p.sent.length;
    const answer = await p.send('Page.reload', { targetId: 'shielded' });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(reloadsSent(p, since).length, 0);
  });
}

test('a reload of a held sign-in tab is refused as protected and sends nothing', async (t) => {
  const p = protocol(t);
  p.target('reload-held', 'page', at('reload-held', 'https://ordinary.invalid/login'));
  hold('reload-held');
  p.hold(frozen);
  const since = p.sent.length;
  const answer = await p.send('Page.reload', { targetId: 'reload-held' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(reloadsSent(p, since).length, 0);
});

for (const [label, url] of [
  ['seven', SEVEN_PAGE],
  ['the vault', VAULT_PAGE],
]) {
  test(`an unanswered tab that moved onto ${label} is refused as protected and not reloaded`, {
    timeout: 60000,
  }, async (t) => {
    const targetId = `moved-${url.length}`;
    const { p, entry } = await unanswered(t, targetId);
    entry.info.url = url;
    entry.tree.frame = at(targetId, url);
    p.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    await flush();
    const since = p.sent.length;
    const answer = await p.send('Page.reload', { targetId });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(reloadsSent(p, since).length, 0);
  });
}

for (const [label, url] of [
  ['seven', SEVEN_PAGE],
  ['the vault', VAULT_PAGE],
  ['an ordinary page', OTHER],
]) {
  test(`an unanswered tab whose navigation to ${label} started is refused as protected`, {
    timeout: 60000,
  }, async (t) => {
    const targetId = `loading-${url.length}`;
    const { p } = await unanswered(t, targetId);
    p.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: guardSession(p, targetId),
      params: { frameId: targetId, url, loaderId: 'next', navigationType: 'differentDocument' },
    });
    await flush();
    const since = p.sent.length;
    const answer = await p.send('Page.reload', { targetId });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(reloadsSent(p, since).length, 0);
  });
}

for (const how of ['flips to seven', 'sees an ordinary target event', 'errors', 'times out']) {
  test(`a reload whose fresh target read ${how} is refused as protected and sends nothing`, {
    timeout: 60000,
  }, async (t) => {
    const targetId = `race-${how.replaceAll(' ', '-')}`;
    const { p, entry } = await unanswered(t, targetId);
    const stale = structuredClone(entry.info);
    const { answer, sent } = await readHeld(p, targetId, (read) => {
      if (how === 'flips to seven') {
        entry.info.url = SEVEN_PAGE;
        entry.tree.frame = at(targetId, SEVEN_PAGE);
      }
      if (how === 'flips to seven' || how === 'sees an ordinary target event') {
        p.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
        p.release(read, { result: { targetInfo: stale } });
      }
      if (how === 'errors')
        p.release(read, { error: { code: -32000, message: 'synthetic read failure' } });
    });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(sent, 0);
  });
}

test('a reload the browser discards because the page navigated is answered as protected, once', {
  timeout: 60000,
}, async (t) => {
  const { p } = await unanswered(t, 'navigated');
  const since = p.sent.length;
  p.hold((message) => frozen(message) || ownCall('Page.reload')(message));
  const reloading = p.send('Page.reload', { targetId: 'navigated' });
  const reload = await heldCall(p, ownCall('Page.reload'), since);
  p.release(reload, { error: { code: -32602, message: NAVIGATED } });
  assert.equal((await reloading).error?.message, PROTECTED);
  await pause(200);
  assert.equal(reloadsSent(p, since).length, 1, 'nothing was retried');
});

test('a private reload still unanswered when the tab’s turn runs out is answered and dropped then', {
  timeout: 60000,
}, async (t) => {
  const { p } = await unanswered(t, 'bounded');
  const since = p.sent.length;
  p.hold((message) => frozen(message) || ownCall('Page.reload')(message));
  const started = Date.now();
  const reloading = p.send('Page.reload', { targetId: 'bounded' });
  const reload = await heldCall(p, ownCall('Page.reload'), since);
  const answer = await reloading;
  const took = Date.now() - started;
  assert.equal(answer.error?.message, UNANSWERED);
  assert.ok(took <= TURN_MS + 500, `answered after ${took} ms`);
  assert.ok(!p.inner().internal.has(reload.id), 'the private call is no longer outstanding');
  const delivered = p.delivered.length;
  p.release(reload, { result: {} });
  await flush();
  assert.equal(p.delivered.length, delivered, 'a late answer reaches no client');
});

test('a reload while another client’s dialog answer is in flight waits for it', {
  timeout: 60000,
}, async (t) => {
  const { p } = await unanswered(t, 'turn-wait');
  const answer = guard.fly('turn-wait', 'answer', 60000);
  t.after(() => answer.land());
  const since = p.sent.length;
  let done = false;
  const reloading = p.send('Page.reload', { targetId: 'turn-wait' }).then((reply) => {
    done = true;
    return reply;
  });
  await pause(500);
  assert.equal(done, false);
  assert.equal(reloadsSent(p, since).length, 0, 'nothing was sent while the answer was in flight');
  answer.land();
  assert.equal((await reloading).error, undefined);
  assert.equal(reloadsSent(p, since).length, 1);
});

test('a reload while another client’s dialog answer never lands is refused and sends nothing', {
  timeout: 60000,
}, async (t) => {
  const { p } = await unanswered(t, 'turn-stuck');
  const answer = guard.fly('turn-stuck', 'answer', 60000);
  t.after(() => answer.land());
  const since = p.sent.length;
  const started = Date.now();
  const reply = await p.send('Page.reload', { targetId: 'turn-stuck' });
  assert.equal(reply.error?.message, UNANSWERED);
  assert.ok(Date.now() - started >= TURN_MS - 100);
  assert.equal(reloadsSent(p, since).length, 0);
});

test('a refused reload still holds the tab’s slot for the rate limit', {
  timeout: 60000,
}, async (t) => {
  const { p } = await unanswered(t, 'failed-slot');
  const since = p.sent.length;
  const { answer } = await readHeld(p, 'failed-slot', (read) =>
    p.release(read, { error: { code: -32000, message: 'synthetic read failure' } })
  );
  assert.equal(answer.error?.message, PROTECTED);
  p.hold(frozen);
  const again = await p.send('Page.reload', { targetId: 'failed-slot' });
  assert.equal(again.error?.message, RELOADED);
  assert.equal(reloadsSent(p, since).length, 0);
});

test('a second reload of the same tab within the rate limit is refused and sends nothing', {
  timeout: 90000,
}, async (t) => {
  const { p } = await unanswered(t, 'twice');
  const first = await p.send('Page.reload', { targetId: 'twice' });
  assert.equal(first.error, undefined);
  const again = await p.send('Target.attachToTarget', { targetId: 'twice', flatten: true });
  assert.equal(again.error?.message, UNANSWERED);
  const since = p.sent.length;
  const second = await p.send('Page.reload', { targetId: 'twice' });
  assert.equal(second.error?.message, RELOADED);
  assert.equal(reloadsSent(p, since).length, 0);
});

test('a worker’s events and a client’s own messages leave the tab’s record untouched', {
  timeout: 60000,
}, async (t) => {
  const { p, sessionId } = await seen(t, 'writers');
  p.target('writers-worker', 'worker', at('writers-worker', OTHER));
  const worker = p.attached('writers-worker');
  for (const id of ['writers', 'writers-worker'])
    p.emit({
      method: 'Page.frameNavigated',
      sessionId: worker,
      params: { frame: at(id, OTHER, 'worker-loader') },
    });
  await p.send('Page.frameNavigated', { frame: at('writers', OTHER, 'forged-loader') });
  await p.send('Page.navigatedWithinDocument', { frameId: 'writers', url: OTHER }, sessionId);
  await flush();
  const record = guard.recordedDocument('writers');
  assert.equal(record?.loaderId, 'loader-writers');
  assert.equal(record.url, ordinary);
});

for (const [label, frame] of [
  [
    'an error page',
    {
      ...at('no-admission', 'chrome-error://chromewebdata/', 'loader-error'),
      securityOrigin: '://',
      unreachableUrl: OTHER,
    },
  ],
  ['a data URL', at('no-admission', 'data:text/html,x', 'loader-data')],
]) {
  test(`a commit to ${label} is recorded as no admission until an ordinary commit`, {
    timeout: 60000,
  }, async (t) => {
    const { p, entry, sessionId } = await seen(t, 'no-admission');
    entry.tree.frame = frame;
    p.emit({ method: 'Page.frameNavigated', sessionId, params: { frame } });
    await flush();
    assert.equal(guard.recordedDocument('no-admission'), undefined);
    entry.tree.frame = at('no-admission', OTHER, 'loader-back');
    p.emit({
      method: 'Page.frameNavigated',
      sessionId,
      params: { frame: at('no-admission', OTHER, 'loader-back') },
    });
    await flush();
    assert.equal(guard.recordedDocument('no-admission')?.loaderId, 'loader-back');
  });
}

test('a held tab’s commit and a same-document move onto seven are recorded as no admission', {
  timeout: 60000,
}, async (t) => {
  const { p, entry, sessionId } = await seen(t, 'held-commit');
  const second = await seen(t, 'moved-within');
  second.entry.tree.frame.url = SEVEN_PAGE;
  second.p.emit({
    method: 'Page.navigatedWithinDocument',
    sessionId: second.sessionId,
    params: { frameId: 'moved-within', url: SEVEN_PAGE, navigationType: 'historyApi' },
  });
  hold('held-commit');
  entry.tree.frame = at('held-commit', OTHER, 'loader-held');
  p.emit({
    method: 'Page.frameNavigated',
    sessionId,
    params: { frame: at('held-commit', OTHER, 'loader-held') },
  });
  await flush();
  assert.equal(guard.recordedDocument('held-commit'), undefined);
  assert.equal(guard.recordedDocument('moved-within'), undefined);
});

test('a destroyed target’s record is dropped', { timeout: 60000 }, async (t) => {
  const { p } = await seen(t, 'destroyed');
  assert.ok(guard.recordedDocument('destroyed'));
  p.emit({ method: 'Target.targetDestroyed', params: { targetId: 'destroyed' } });
  await flush();
  assert.equal(guard.recordedDocument('destroyed'), undefined);
});

test('a same-document move onto a sign-in url after the match reloads that url; the next attach is refused as protected', {
  timeout: 60000,
}, async (t) => {
  const { p, entry } = await unanswered(t, 'same-doc-limit');
  const privateSession = guardSession(p, 'same-doc-limit');
  const deliveredMark = p.delivered.length;
  const since = p.sent.length;
  p.hold((message) => frozen(message) || ownCall('Page.reload')(message));
  const reloading = p.send('Page.reload', { targetId: 'same-doc-limit' });
  const reload = await heldCall(p, ownCall('Page.reload'), since);
  entry.info.url = SIGN_IN;
  entry.tree.frame = { ...entry.tree.frame, url: SIGN_IN };
  p.emit({
    method: 'Page.navigatedWithinDocument',
    sessionId: privateSession,
    params: { frameId: 'same-doc-limit', url: SIGN_IN, navigationType: 'historyApi' },
  });
  await flush();
  p.release(reload, { result: {} });
  const answer = await reloading;
  assert.deepEqual(answer, { id: answer.id, result: {} });
  const delivered = p.delivered.slice(deliveredMark);
  assert.equal(delivered.length, 1, 'only the reload reply reaches the client');
  assert.equal(delivered[0].id, answer.id);
  assert.equal(delivered[0].sessionId, undefined);
  assert.equal(
    delivered.some((message) => message.sessionId === privateSession),
    false,
    'no event of the guard’s session reaches the client'
  );
  p.hold(() => false);
  const attached = await p.send('Target.attachToTarget', {
    targetId: 'same-doc-limit',
    flatten: true,
  });
  assert.equal(attached.error?.message, PROTECTED);
});

test('a missed destroy leaves a resurrectable record; a reload with that record is refused as protected', {
  timeout: 60000,
}, async (t) => {
  await seen(t, 'missed-destroy');
  const { p } = await frozenConnection(t, 'missed-destroy');
  assert.ok(guard.recordedDocument('missed-destroy'));
  const killer = protocol(t, guard.guardProtected);
  killer.target('missed-destroy', 'page', at('missed-destroy', ordinary, 'loader-old'));
  await killer.attach('missed-destroy');
  killer.emit({ method: 'Target.targetDestroyed', params: { targetId: 'missed-destroy' } });
  await flush();
  assert.equal(guard.recordedDocument('missed-destroy'), undefined);
  const late = protocol(t, guard.guardProtected);
  late.target('missed-destroy', 'page', at('missed-destroy', ordinary, 'loader-old'));
  late.hold((message) => message.id >= GUARD && message.method === 'Page.getFrameTree');
  const attaching = late.send('Target.attachToTarget', {
    targetId: 'missed-destroy',
    flatten: true,
  });
  const tree = await heldCall(late, (message) => message.method === 'Page.getFrameTree', 0);
  late.release(tree, {
    result: { frameTree: { frame: at('missed-destroy', ordinary, 'loader-old') } },
  });
  await flush();
  assert.equal(guard.recordedDocument('missed-destroy')?.loaderId, 'loader-old');
  await attaching;
  const since = p.sent.length;
  p.hold((message) => frozen(message) || ownCall('Page.reload')(message));
  const reloading = p.send('Page.reload', { targetId: 'missed-destroy' });
  const reload = await heldCall(p, ownCall('Page.reload'), since);
  assert.equal(reload.params.loaderId, 'loader-old');
  p.release(reload, { error: { code: -32602, message: NAVIGATED } });
  assert.equal((await reloading).error?.message, PROTECTED);
  assert.equal(ownReloads(p, since).length, 1);
});

test('a late destroy after a successor’s write drops the record; a reload is refused', {
  timeout: 60000,
}, async (t) => {
  const { p, entry, sessionId } = await seen(t, 'late-destroy');
  entry.tree.frame = at('late-destroy', ordinary, 'loader-successor');
  p.emit({
    method: 'Page.frameNavigated',
    sessionId,
    params: { frame: at('late-destroy', ordinary, 'loader-successor'), type: 'Navigation' },
  });
  await flush();
  assert.equal(guard.recordedDocument('late-destroy')?.loaderId, 'loader-successor');
  p.emit({ method: 'Target.targetDestroyed', params: { targetId: 'late-destroy' } });
  await flush();
  assert.equal(guard.recordedDocument('late-destroy'), undefined);
  const { p: q } = await frozenConnection(t, 'late-destroy');
  q.target('late-destroy', 'page', at('late-destroy', ordinary, 'loader-successor'));
  const since = q.sent.length;
  const answer = await q.send('Page.reload', { targetId: 'late-destroy' });
  assert.ok(answer.error?.message === PROTECTED || answer.result === undefined);
  assert.equal(ownReloads(q, since).length, 0);
});

test('a one-sided destroy during an outstanding reload is answered as protected', {
  timeout: 60000,
}, async (t) => {
  const { p } = await unanswered(t, 'one-sided');
  const { p: q } = await frozenConnection(t, 'one-sided');
  const since = p.sent.length;
  p.hold((message) => frozen(message) || ownCall('Page.reload')(message));
  const reloading = p.send('Page.reload', { targetId: 'one-sided' });
  const reload = await heldCall(p, ownCall('Page.reload'), since);
  q.emit({ method: 'Target.targetDestroyed', params: { targetId: 'one-sided' } });
  await flush();
  assert.equal(guard.recordedDocument('one-sided'), undefined);
  p.release(reload, { error: { code: -32000, message: 'Inspected target navigated or closed' } });
  assert.equal((await reloading).error?.message, PROTECTED);
  assert.equal(ownReloads(p, since).length, 1);
});

test('a full record map evicts only expired records', () => {
  const base = Date.now() - DOCUMENT_MS - 1;
  const record = { loaderId: 'L', url: OTHER };
  guard.keepDocument('live-record', record);
  guard.keepDocument('old-record', record, base);
  for (let n = 0; n < TURNS_KEPT; n += 1) guard.keepDocument(`record-${n}`, record, base);
  assert.equal(guard.recordedDocument('old-record', base)?.loaderId, 'L');
  assert.equal(guard.recordedDocument(`record-${TURNS_KEPT - 1}`, base), undefined);
  guard.keepDocument('record-late', record);
  assert.ok(guard.recordedDocument('record-late'));
  assert.ok(guard.recordedDocument('live-record'), 'a live record is kept');
  assert.equal(guard.recordedDocument('old-record', base), undefined, 'an expired one is not');
});
