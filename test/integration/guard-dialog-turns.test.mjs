import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import * as stock from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';
import { ownerSnapshot, treeDocument } from './guard-owner-snapshot.mjs';

const SEED = new URL('../../src/seed/', import.meta.url);
const OWN = 'https://seven.sliccy.ai';
const SEVEN_PAGE = `${OWN}/os/`;
const VAULT_PAGE = 'https://vault.sliccy.ai/';
const PAGE = 'https://ordinary.invalid';
const NO_DIALOG = 'No dialog is showing';
const GUARD = 2 ** 30;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MUTANTS = {
  'skip-registry-check': [
    'const turn = this.turnRefusal(message);',
    'const turn = message.method === "Page.handleJavaScriptDialog" ? null : this.turnRefusal(message);',
  ],
  'skip-turn': [
    `    const kind = message.method === 'Page.handleJavaScriptDialog' ? 'answer' : 'move';
    this.flyTurn(targetId, kind, requestKey(message));`,
    '    return;',
  ],
  'drop-bound': ['export const TURN_MS = 5000;', 'export const TURN_MS = 1e9;'],
  'answer-unseen': [
    `    if (!record) return state.discarded ? DIALOG_GONE : DIALOG_UNSEEN;`,
    `    if (!record) return state.discarded ? DIALOG_GONE : null;`,
  ],
  'gone-for-protected': [
    'if (this.dialogProtected(sessionId, targetId, state?.record)) return PROTECTED;',
    'if (this.dialogProtected(sessionId, targetId, state?.record)) return DIALOG_GONE;',
  ],
  'skip-fresh-read': [
    `    const fresh = await this.within(
      this.current(tab).catch(() => true),
      ANSWER_MS
    );
    return fresh === false ? null : PROTECTED;`,
    '    return null;',
  ],
  'unbounded-fresh-read': [
    `      this.current(tab).catch(() => true),
      ANSWER_MS`,
    `      this.current(tab).catch(() => true),
      1e9`,
  ],
  'gate-admits-dialogs': [
    `      method === 'Page.handleJavaScriptDialog' &&
      !this.pendingCommit.has(sessionId) &&
      !this.settled.get(sessionId)?.protected
    ) {`,
    `      method === 'Page.handleJavaScriptDialog'
    ) {`,
  ],
  'unguarded-in-refusal': [
    `    const state = this.navs.get(targetId)?.dialog;
    if (this.dialogProtected(`,
    `    const nav = this.navs.get(targetId);
    if (!nav?.session || !nav.done || nav.failed || !nav.dialog) return this.unguarded(nav);
    const state = this.navs.get(targetId)?.dialog;
    if (this.dialogProtected(`,
  ],
};

registerHooks({
  resolve(specifier, context, next) {
    const mutant = context.parentURL && URL.parse(context.parentURL)?.searchParams.get('mutant');
    const resolved = next(specifier, context);
    if (!mutant || specifier !== './guard.js') return resolved;
    return { ...resolved, url: `${resolved.url}?mutant=${mutant}` };
  },
  load(url, context, next) {
    const mutant = URL.parse(url)?.searchParams.get('mutant');
    const loaded = next(url, context);
    if (!mutant || !url.split('?')[0].endsWith('/guard.js')) return loaded;
    let source = String(loaded.source);
    for (const name of mutant.split(',')) {
      const [from, to] = MUTANTS[name];
      assert.ok(source.includes(from), `mutant ${name}: patch site missing`);
      source = source.replace(from, to);
    }
    return { ...loaded, source };
  },
});

const load = async (mutant) =>
  mutant ? import(`${new URL('guard.js', SEED).href}?mutant=${mutant}`) : stock;

function browser() {
  const targets = new Map();
  const sessions = new Map();
  const pauses = new Map();
  const stuck = new Set();
  const failing = new Set();
  let ids = 0;
  const post = (session, message) =>
    queueMicrotask(() =>
      session.wire.onmessage?.(JSON.stringify({ ...message, sessionId: session.id }))
    );
  const to = (targetId, domain, method, params) => {
    for (const session of sessions.values())
      if (session.targetId === targetId && session[domain]) post(session, { method, params });
  };
  const frame = (target) => ({
    id: target.id,
    loaderId: target.loader,
    url: target.url,
    securityOrigin: URL.canParse(target.url) ? new URL(target.url).origin : '',
    mimeType: 'text/html',
  });
  const info = (target) => ({
    targetId: target.id,
    type: 'page',
    url: target.url,
    title: target.url,
    attached: true,
    canAccessOpener: false,
  });
  function tab(id, url = `${PAGE}/plain/${id}`) {
    const target = { id, url, loader: `${id}-0`, loads: 0, dialog: null, opened: [], closed: [] };
    targets.set(id, target);
    return target;
  }
  function openDialog(target, message, type = 'alert') {
    target.dialog = { message, type };
    target.opened.push(message);
    to(target.id, 'page', 'Page.javascriptDialogOpening', {
      url: target.url,
      frameId: target.id,
      message,
      type,
      hasBrowserHandler: true,
      defaultPrompt: '',
    });
  }
  function closeDialog(target, result) {
    if (!target.dialog) return false;
    target.closed.push(target.dialog.message);
    target.dialog = null;
    to(target.id, 'page', 'Page.javascriptDialogClosed', { result, userInput: '' });
    return true;
  }
  async function navigate(target, url) {
    const loaderId = `${target.id}-${++ids}`;
    to(target.id, 'page', 'Page.frameStartedNavigating', {
      frameId: target.id,
      url,
      loaderId,
      navigationType: 'differentDocument',
    });
    closeDialog(target, false);
    const asked = url.includes('/hop/') ? VAULT_PAGE : url;
    const waits = [];
    for (const session of sessions.values()) {
      if (session.targetId !== target.id || !session.fetch) continue;
      const requestId = `r${++ids}`;
      waits.push(new Promise((resolve) => pauses.set(requestId, resolve)));
      post(session, {
        method: 'Fetch.requestPaused',
        params: {
          requestId,
          frameId: target.id,
          resourceType: 'Document',
          request: { url: asked, method: 'GET', headers: {} },
        },
      });
    }
    const outcomes = await Promise.all(waits);
    if (outcomes.includes('fail')) {
      to(target.id, 'page', 'Page.frameStoppedLoading', { frameId: target.id });
      return;
    }
    target.url = asked;
    target.loader = loaderId;
    to(target.id, 'page', 'Page.frameNavigated', { frame: frame(target), type: 'Navigation' });
    to(target.id, 'page', 'Page.frameStoppedLoading', { frameId: target.id });
    if (asked.includes('/dialog/')) {
      target.loads += 1;
      setTimeout(() => openDialog(target, `${target.loads === 1 ? 'one' : 'two'}`), 5);
    }
  }
  function answer(session, message) {
    const { id, method, params = {} } = message;
    const target = targets.get(params.targetId ?? session?.targetId);
    const reply = (payload) =>
      queueMicrotask(() =>
        message.wire.onmessage?.(
          JSON.stringify({
            id,
            ...(message.sessionId ? { sessionId: message.sessionId } : {}),
            ...payload,
          })
        )
      );
    if (id >= GUARD && stuck.has(method)) return;
    if (id >= GUARD && failing.has(method))
      return reply({ error: { code: -32000, message: 'synthetic read failure' } });
    if (method === 'Target.setAutoAttach' && !message.sessionId) {
      for (const each of targets.values()) {
        const sessionId = `client-${++ids}`;
        sessions.set(sessionId, { id: sessionId, wire: message.wire, targetId: each.id });
        queueMicrotask(() =>
          message.wire.onmessage?.(
            JSON.stringify({
              method: 'Target.attachedToTarget',
              params: { sessionId, targetInfo: info(each), waitingForDebugger: false },
            })
          )
        );
      }
      return reply({ result: {} });
    }
    if (method === 'Target.attachToTarget') {
      const sessionId = `${id >= GUARD ? 'guard' : 'client'}-${++ids}`;
      sessions.set(sessionId, { id: sessionId, wire: message.wire, targetId: target.id });
      return reply({ result: { sessionId } });
    }
    if (method === 'Target.detachFromTarget') {
      sessions.delete(params.sessionId);
      return reply({ result: {} });
    }
    if (method === 'Target.getTargets')
      return reply({ result: { targetInfos: [...targets.values()].map(info) } });
    if (method === 'Target.getTargetInfo') return reply({ result: { targetInfo: info(target) } });
    if (method === 'Page.enable') session.page = true;
    if (method === 'Fetch.enable') session.fetch = true;
    if (method === 'Page.getFrameTree')
      return reply({ result: { frameTree: { frame: frame(target) } } });
    if (method === 'Page.getNavigationHistory')
      return reply({
        result: { currentIndex: 0, entries: [{ id: 1, url: target.url, title: '' }] },
      });
    if (method === 'DOM.getDocument')
      return reply({ result: { root: treeDocument({ frame: frame(target) }) } });
    if (method === 'DOMSnapshot.captureSnapshot')
      return reply({ result: ownerSnapshot(treeDocument({ frame: frame(target) }), target.id) });
    if (method === 'Runtime.evaluate')
      return reply({ result: { result: { type: 'string', value: target.url } } });
    if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') {
      pauses.get(params.requestId)?.(method === 'Fetch.failRequest' ? 'fail' : 'go');
      pauses.delete(params.requestId);
    }
    if (method === 'Page.handleJavaScriptDialog') {
      if (!closeDialog(target, params.accept !== false))
        return reply({ error: { code: -32602, message: NO_DIALOG } });
      return reply({ result: {} });
    }
    if (method === 'Page.navigate' || method === 'Page.reload') {
      void navigate(target, method === 'Page.reload' ? target.url : params.url);
      return reply({ result: { frameId: target.id, loaderId: target.loader } });
    }
    return reply({ result: {} });
  }
  function connect() {
    const held = [];
    let holding = () => false;
    const wire = {
      send(text) {
        const message = { ...JSON.parse(text), wire };
        if (holding(message)) return void held.push(message);
        answer(sessions.get(message.sessionId), message);
      },
      close() {
        queueMicrotask(() => wire.onclose?.('closed'));
      },
      captureGuard(guard) {
        wire.guard = guard;
      },
      holdNext(match) {
        holding = (message) => {
          if (!match(message)) return false;
          holding = () => false;
          return true;
        };
      },
      release() {
        for (const message of held.splice(0)) answer(sessions.get(message.sessionId), message);
      },
      held,
    };
    return wire;
  }
  return { targets, sessions, stuck, failing, tab, connect, openDialog, closeDialog, navigate };
}

function client(t, chrome, guardProtected) {
  const wire = chrome.connect();
  const connection = guardProtected ? guardProtected(wire, OWN) : wire;
  t.after(() => connection.close());
  const pending = new Map();
  const events = [];
  const sent = [];
  let next = 0;
  const raw = wire.send;
  wire.send = (text) => {
    sent.push(JSON.parse(text));
    raw(text);
  };
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.id === undefined) return void events.push(message);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const attach = async (targetId, page = true) => {
    const answer = await send('Target.attachToTarget', { targetId, flatten: true });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    const { sessionId } = answer.result;
    if (page) assert.equal((await send('Page.enable', {}, sessionId)).error, undefined);
    return sessionId;
  };
  const forwarded = (method, since = 0) =>
    sent.slice(since).filter((message) => message.id < GUARD && message.method === method);
  return { wire, connection, send, attach, events, sent, forwarded };
}

async function until(check, ms = 3000, what = 'the condition') {
  for (const end = Date.now() + ms; Date.now() < end; await pause(5)) if (check()) return;
  assert.fail(`waited ${ms} ms for ${what}`);
}

async function dialogTab(t, guard, key) {
  const chrome = browser();
  const target = chrome.tab(key);
  const a = client(t, chrome, guard.guardProtected);
  const sa = await a.attach(key);
  await chrome.navigate(target, `${PAGE}/dialog/${key}`);
  await until(() => target.dialog?.message === 'one', 3000, 'dialog one');
  await until(
    () => a.events.some((message) => message.method === 'Page.javascriptDialogOpening'),
    3000,
    'the opening at the client'
  );
  return { chrome, target, a, sa };
}

const rows = {
  async answerFirst(t, guard) {
    const { chrome, target, a, sa } = await dialogTab(t, guard, 'answer-first');
    const b = client(t, chrome, guard.guardProtected);
    const sb = await b.attach('answer-first');
    a.wire.holdNext((message) => message.method === 'Page.handleJavaScriptDialog');
    const answering = a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
    await until(() => a.wire.held.length === 1, 3000, 'the answer in the transport');
    const reloading = b.send('Page.reload', {}, sb);
    await pause(300);
    const reloadWaited = b.forwarded('Page.reload').length === 0;
    a.wire.release();
    const answer = await answering;
    await reloading;
    await until(() => target.opened.includes('two'), 3000, 'dialog two');
    await pause(100);
    return {
      reloadWaited,
      answer: answer.error?.message ?? 'answered',
      secondOpen: target.dialog?.message === 'two',
    };
  },
  async reloadFirst(t, guard) {
    const { chrome, target, a, sa } = await dialogTab(t, guard, 'reload-first');
    const b = client(t, chrome, guard.guardProtected);
    const sb = await b.attach('reload-first');
    const reloading = b.send('Page.reload', {}, sb);
    await until(() => b.forwarded('Page.reload').length === 1, 3000, 'the reload');
    a.wire.holdNext((message) => message.method === 'Page.handleJavaScriptDialog');
    const since = a.sent.length;
    const answering = a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
    await reloading;
    await until(() => target.opened.includes('two'), 3000, 'dialog two');
    a.wire.release();
    const answer = await answering;
    await pause(100);
    return {
      answer: answer.error?.message ?? 'answered',
      forwarded: a.forwarded('Page.handleJavaScriptDialog', since).length,
      secondOpen: target.dialog?.message === 'two',
    };
  },
  async unseen(t, guard) {
    const { target, a, sa } = await dialogTab(t, guard, 'unseen');
    const first = await a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
    await until(() => !target.dialog, 3000, 'the close');
    await pause(20);
    const since = a.sent.length;
    a.wire.holdNext((message) => message.method === 'Page.handleJavaScriptDialog');
    const blind = a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
    await pause(50);
    const held = a.wire.held.length;
    if (held) target.dialog = { message: 'later', type: 'alert' };
    a.wire.release();
    const answer = await blind;
    await pause(50);
    return {
      first: first.error?.message ?? 'answered',
      answer: answer.error?.message ?? 'answered',
      forwarded: a.forwarded('Page.handleJavaScriptDialog', since).length,
      laterClosed: held > 0 && target.dialog === null,
    };
  },
  async protectedMove(t, guard) {
    const { chrome, target, a, sa } = await dialogTab(t, guard, 'protected-move');
    const b = client(t, chrome, guard.guardProtected);
    const sb = await b.attach('protected-move');
    const moved = await b.send('Page.navigate', { url: `${PAGE}/hop/protected-move` }, sb);
    await pause(50);
    const since = a.sent.length;
    const answer = await a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
    return {
      move: moved.error?.message ?? 'sent',
      answer: answer.error?.message ?? 'answered',
      forwarded: a.forwarded('Page.handleJavaScriptDialog', since).length,
      vault: target.url === VAULT_PAGE,
    };
  },
  async bound(t, guard) {
    const { chrome, a, sa } = await dialogTab(t, guard, 'bound');
    const b = client(t, chrome, guard.guardProtected);
    const sb = await b.attach('bound');
    a.wire.holdNext((message) => message.method === 'Page.handleJavaScriptDialog');
    void a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
    await until(() => a.wire.held.length === 1, 3000, 'the answer in the transport');
    const started = Date.now();
    void b.send('Page.reload', {}, sb);
    for (const end = started + 8000; Date.now() < end && !b.forwarded('Page.reload').length; )
      await pause(20);
    const forwarded = b.forwarded('Page.reload').length === 1;
    return {
      forwarded,
      inBound: forwarded && Date.now() - started >= 4500 && Date.now() - started < 6500,
    };
  },
};

const release = {
  async reply(t, guard) {
    const { chrome, a, sa } = await dialogTab(t, guard, 'release-reply');
    const b = client(t, chrome, guard.guardProtected);
    const sb = await b.attach('release-reply');
    await a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
    const started = Date.now();
    await b.send('Page.reload', {}, sb);
    return Date.now() - started;
  },
  async close(t, guard) {
    const { chrome, a, sa } = await dialogTab(t, guard, 'release-close');
    const b = client(t, chrome, guard.guardProtected);
    const sb = await b.attach('release-close');
    a.wire.holdNext((message) => message.method === 'Page.handleJavaScriptDialog');
    void a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
    await until(() => a.wire.held.length === 1, 3000, 'the answer in the transport');
    const reloading = b.send('Page.reload', {}, sb);
    const started = Date.now();
    a.connection.close();
    await reloading;
    return Date.now() - started;
  },
  async destroy(t, guard) {
    const { chrome, a, sa } = await dialogTab(t, guard, 'release-destroy');
    const b = client(t, chrome, guard.guardProtected);
    const sb = await b.attach('release-destroy');
    a.wire.holdNext((message) => message.method === 'Page.handleJavaScriptDialog');
    void a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
    await until(() => a.wire.held.length === 1, 3000, 'the answer in the transport');
    const reloading = b.send('Page.reload', {}, sb);
    const started = Date.now();
    a.wire.onmessage(
      JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId: 'release-destroy' } })
    );
    await reloading;
    return Date.now() - started;
  },
};

test('two guarded clients: a reload waits for the answer in flight, then the new dialog stays open', async (t) => {
  assert.deepEqual(await rows.answerFirst(t, stock), {
    reloadWaited: true,
    answer: 'answered',
    secondOpen: true,
  });
});

test('mutant: without the turn, the reload passes the held answer, which then closes the new dialog', async (t) => {
  const row = await rows.answerFirst(t, await load('skip-turn'));
  assert.equal(row.reloadWaited, false);
  assert.equal(row.secondOpen, false);
});

test('a reload sent first: the answer that follows gets DIALOG_GONE and never reaches Chrome', async (t) => {
  assert.deepEqual(await rows.reloadFirst(t, stock), {
    answer: stock.DIALOG_GONE,
    forwarded: 0,
    secondOpen: true,
  });
});

test('mutant: without the registry check, that answer reaches Chrome and closes the new dialog', async (t) => {
  const row = await rows.reloadFirst(t, await load('skip-registry-check'));
  assert.equal(row.forwarded, 1);
  assert.equal(row.secondOpen, false);
});

test('after its dialog closes, another answer gets DIALOG_UNSEEN and never reaches Chrome', async (t) => {
  assert.deepEqual(await rows.unseen(t, stock), {
    first: 'answered',
    answer: stock.DIALOG_UNSEEN,
    forwarded: 0,
    laterClosed: false,
  });
});

test('mutant: answering a dialog the guard never saw open lands on whatever opens next', async (t) => {
  const row = await rows.unseen(t, await load('answer-unseen'));
  assert.equal(row.forwarded, 1);
  assert.equal(row.laterClosed, true);
});

test('a guarded move into the vault: the vault never commits, and the answer meant for the old dialog gets DIALOG_GONE', async (t) => {
  assert.deepEqual(await rows.protectedMove(t, stock), {
    move: 'sent',
    answer: stock.DIALOG_GONE,
    forwarded: 0,
    vault: false,
  });
});

test('a stuck answer holds another client’s reload for the 5 s bound, no longer', {
  timeout: 20000,
}, async (t) => {
  assert.deepEqual(await rows.bound(t, stock), { forwarded: true, inBound: true });
});

test('mutant: without the bound, the reload waits behind the stuck answer past it', {
  timeout: 20000,
}, async (t) => {
  const row = await rows.bound(t, await load('drop-bound'));
  assert.equal(row.forwarded, false);
});

for (const [how, run] of Object.entries(release))
  test(`the answer’s turn is released on ${how}, and the waiting reload goes at once`, async (t) => {
    assert.ok((await run(t, stock)) < 1000);
  });

test('the registry waits for every flight, then the next one takes the turn', async () => {
  const first = stock.fly('Q', 'answer');
  const second = stock.fly('Q', 'move');
  let quiet = false;
  const waiting = stock.quietTurn('Q', 2000).then((value) => {
    quiet = value;
  });
  first.land();
  await pause(20);
  assert.equal(quiet, false);
  second.land();
  await waiting;
  assert.equal(quiet, true);
  const next = stock.fly('Q', 'move');
  assert.equal(stock.tabTurn('Q').flying.has(next), true);
  assert.equal(next.serial, second.serial + 1);
  next.land();
});

test('idle turns are evicted down to the cap, busy ones are kept until they land', () => {
  const busy = stock.fly('busy', 'move');
  for (let i = 0; i < stock.TURNS_KEPT + 200; i += 1) stock.tabTurn(`idle-${i}`);
  assert.ok(stock.turnCount() <= stock.TURNS_KEPT, `${stock.turnCount()} turns kept`);
  assert.equal(stock.tabTurn('busy').flying.has(busy), true);
  busy.land();
  assert.ok(stock.turnCount() <= stock.TURNS_KEPT);
});

const PROTECTED_TABS = {
  'moved onto seven': (chrome, target, a) => {
    target.url = SEVEN_PAGE;
    a.wire.onmessage(
      JSON.stringify({
        method: 'Target.targetInfoChanged',
        params: {
          targetInfo: { targetId: target.id, type: 'page', url: SEVEN_PAGE, attached: true },
        },
      })
    );
  },
  'moved onto the vault': (chrome, target, a) => {
    target.url = VAULT_PAGE;
    a.wire.onmessage(
      JSON.stringify({
        method: 'Target.targetInfoChanged',
        params: {
          targetInfo: { targetId: target.id, type: 'page', url: VAULT_PAGE, attached: true },
        },
      })
    );
  },
  'loading the vault': (chrome, target) => {
    for (const session of chrome.sessions.values())
      if (session.targetId === target.id && session.page)
        session.wire.onmessage(
          JSON.stringify({
            method: 'Page.frameStartedNavigating',
            sessionId: session.id,
            params: {
              frameId: target.id,
              url: VAULT_PAGE,
              loaderId: 'v',
              navigationType: 'differentDocument',
            },
          })
        );
  },
  'a held sign-in tab': (chrome, target) => hold(target.id),
};

const LAYER_MUTANTS = [
  'gone-for-protected',
  'skip-fresh-read,gone-for-protected',
  'gate-admits-dialogs,gone-for-protected',
  'gate-admits-dialogs,skip-fresh-read',
];
const P = stock.PROTECTED;
const G = stock.DIALOG_GONE;
const LAYERS = {
  'moved onto seven': [P, P, P, P],
  'moved onto the vault': [P, P, P, P],
  'loading the vault': [P, P, G, P],
  'a held sign-in tab': [P, G, P, P],
};

const DIALOG_STATES = {
  'its dialog open': async () => {},
  'its dialog answered': async (a, sa, target) => {
    await a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
    await until(() => !target.dialog, 3000, 'the close');
  },
};

async function protectedRow(t, guard, tabState, dialogState, key) {
  const { chrome, target, a, sa } = await dialogTab(t, guard, key);
  await DIALOG_STATES[dialogState](a, sa, target);
  PROTECTED_TABS[tabState](chrome, target, a);
  await pause(20);
  const since = a.sent.length;
  const answer = await a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
  return {
    answer: answer.error?.message ?? 'answered',
    forwarded: a.forwarded('Page.handleJavaScriptDialog', since).length,
  };
}

let keys = 0;
for (const tabState of Object.keys(PROTECTED_TABS))
  for (const dialogState of Object.keys(DIALOG_STATES)) {
    test(`a tab ${tabState} with ${dialogState} gets PROTECTED, never a dialog text`, async (t) => {
      assert.deepEqual(await protectedRow(t, stock, tabState, dialogState, `p${++keys}`), {
        answer: stock.PROTECTED,
        forwarded: 0,
      });
    });
    test(`mutants: a tab ${tabState} with ${dialogState} shows which layer answers PROTECTED`, async (t) => {
      const seen = [];
      for (const mutant of LAYER_MUTANTS)
        seen.push(
          (await protectedRow(t, await load(mutant), tabState, dialogState, `m${++keys}`)).answer
        );
      assert.deepEqual(seen, LAYERS[tabState]);
    });
  }

async function unansweredRow(t, readFails) {
  const chrome = browser();
  const target = chrome.tab(readFails ? 'fresh-fails' : 'fresh-reads');
  target.dialog = { message: 'waiting', type: 'alert' };
  chrome.stuck.add('Page.enable');
  if (readFails) chrome.failing.add('Target.getTargetInfo');
  const a = client(t, chrome, stock.guardProtected);
  const auto = await a.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  assert.equal(auto.error, undefined, JSON.stringify(auto));
  await until(
    () =>
      a.events.some((message) =>
        ['Target.attachedToTarget', 'Target.targetDestroyed'].includes(message.method)
      ),
    15000,
    'the guard’s word on the auto-attached tab'
  );
  const sessionId = [...chrome.sessions.keys()].find((id) => id.startsWith('client-'));
  const since = a.sent.length;
  const answer = await a.send('Page.handleJavaScriptDialog', { accept: true }, sessionId);
  return {
    shown: a.events.some((message) => message.method === 'Target.attachedToTarget'),
    answer: answer.error?.message ?? 'answered',
    forwarded: a.forwarded('Page.handleJavaScriptDialog', since).length,
    open: target.dialog?.message === 'waiting',
  };
}

for (const readFails of [true, false])
  test(`a tab whose guard setup never answers, ${readFails ? 'and whose fresh target read fails' : 'though its target reads'}, is hidden, and an answer on its session gets PROTECTED, never a dialog text or not answering`, {
    timeout: 45000,
  }, async (t) => {
    assert.deepEqual(await unansweredRow(t, readFails), {
      shown: false,
      answer: stock.PROTECTED,
      forwarded: 0,
      open: true,
    });
  });

test('the unguarded refusal the guard gives a tab it couldn’t set up never reaches dialogRefusal: adding it there changes no answer above', {
  timeout: 60000,
}, async (t) => {
  const mutant = await load('unguarded-in-refusal');
  for (const [name, row] of Object.entries(rows)) {
    if (name === 'bound') continue;
    assert.deepEqual(await row(t, mutant), await row(t, stock), name);
  }
  for (const tabState of Object.keys(PROTECTED_TABS))
    for (const dialogState of Object.keys(DIALOG_STATES))
      assert.equal(
        (await protectedRow(t, mutant, tabState, dialogState, `u${++keys}`)).answer,
        stock.PROTECTED,
        `${tabState}, ${dialogState}`
      );
});

async function silentRow(t, guard, kind) {
  const chrome = browser();
  const target = chrome.tab(`silent-${kind}`);
  const a = client(t, chrome, guard.guardProtected);
  const sa = await a.attach(target.id);
  if (kind === 'vault') target.url = VAULT_PAGE;
  target.dialog = { message: 'silent', type: 'confirm' };
  if (kind === 'read errors') chrome.failing.add('Target.getTargetInfo');
  if (kind === 'read times out') chrome.stuck.add('Target.getTargetInfo');
  const since = a.sent.length;
  const answer = await a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
  return {
    answer: answer.error?.message ?? 'answered',
    forwarded: a.forwarded('Page.handleJavaScriptDialog', since).length,
    open: target.dialog?.message === 'silent',
  };
}

const SILENT = {
  vault: { answer: stock.PROTECTED, forwarded: 0, open: true },
  'read errors': { answer: stock.PROTECTED, forwarded: 0, open: true },
  'read times out': { answer: stock.PROTECTED, forwarded: 0, open: true },
  ordinary: { answer: 'answered', forwarded: 1, open: false },
};

for (const [kind, expected] of Object.entries(SILENT))
  test(`an answer that reaches the guard before any event about a dialog the browser opened silently (${kind}) is decided by a fresh target read`, async (t) => {
    assert.deepEqual(await silentRow(t, stock, kind), expected);
  });

test('mutant: without the fresh read, an answer reaches a vault dialog the guard heard nothing about', async (t) => {
  assert.deepEqual(await silentRow(t, await load('skip-fresh-read'), 'vault'), {
    answer: 'answered',
    forwarded: 1,
    open: false,
  });
});

async function emptyRow(t, guard) {
  const chrome = browser();
  const target = chrome.tab('empty-url');
  const a = client(t, chrome, guard.guardProtected);
  const sa = await a.attach(target.id);
  target.url = '';
  target.dialog = { message: 'empty', type: 'confirm' };
  chrome.stuck.add('Page.enable');
  a.wire.guard.navs.delete(target.id);
  const started = Date.now();
  const answer = await a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
  return {
    answer: answer.error?.message ?? 'answered',
    fast: Date.now() - started < 2000,
    open: target.dialog?.message === 'empty',
  };
}

test('an answer on an empty-URL tab whose guard session is being set up again gets PROTECTED within about a second', {
  timeout: 30000,
}, async (t) => {
  assert.deepEqual(await emptyRow(t, stock), { answer: stock.PROTECTED, fast: true, open: true });
});

test('mutant: without the bound on the fresh read, that answer waits far longer', {
  timeout: 30000,
}, async (t) => {
  const row = await emptyRow(t, await load('unbounded-fresh-read'));
  assert.equal(row.fast, false);
});
