import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { PROTECTED, guardProtected as stockGuard } from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';

const SEVEN = 'https://seven.invalid';
const SEVEN_PAGE = `${SEVEN}/os/`;
const VAULT = 'https://vault.sliccy.ai/unlock';
const ORDINARY = 'https://ordinary.invalid/page';
const CREATOR_FRESH_MS = 1000;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const SEED = new URL('../../src/seed/', import.meta.url);

const MUTANTS = {
  'rejudge-every-creator-event': [
    'guard.js',
    `  creatorChainRejudge(method, params, targetId) {
    if (method !== 'Target.targetInfoChanged') return true;
    const known = this.targets.get(targetId)?.info;
    const next = params.targetInfo;
    if (!known || !next) return true;
    return !this.onlySkippableTargetChange(known, next);
  }`,
    `  creatorChainRejudge() {
    return true;
  }`,
  ],
  'skip-url-rejudge': [
    'guard.js',
    `  creatorChainRejudge(method, params, targetId) {
    if (method !== 'Target.targetInfoChanged') return true;
    const known = this.targets.get(targetId)?.info;
    const next = params.targetInfo;
    if (!known || !next) return true;
    return !this.onlySkippableTargetChange(known, next);
  }`,
    `  creatorChainRejudge(method) {
    return method !== 'Target.targetInfoChanged';
  }`,
  ],
  'skip-can-access-opener': [
    'guard.js',
    `const SKIPPABLE_TARGET_INFO = new Set(['title']);`,
    `const SKIPPABLE_TARGET_INFO = new Set(['title', 'canAccessOpener']);`,
  ],
  'refresh-at-on-skip': [
    'guard.js',
    `    const keepAt = known?.info && this.onlySkippableTargetChange(known.info, info);
    this.targets.set(info.targetId, {
      url: failed ? ERROR_PAGE : (info.url ?? ''),
      type: info.type ?? known?.type,
      openerId,
      openerVerdict: this.recordedOpenerVerdict(openerId, known?.openerVerdict),
      parentId: info.parentId ?? known?.parentId,
      parentFrameId: info.parentFrameId ?? known?.parentFrameId,
      was: known?.was || known?.guarded || false,
      guarded: known?.guarded || false,
      real: known?.real || false,
      context: info.browserContextId ?? known?.context,
      reported: info.url ?? known?.reported,
      at: keepAt ? known.at : Date.now(),
      info,
    });`,
    `    this.targets.set(info.targetId, {
      url: failed ? ERROR_PAGE : (info.url ?? ''),
      type: info.type ?? known?.type,
      openerId,
      openerVerdict: this.recordedOpenerVerdict(openerId, known?.openerVerdict),
      parentId: info.parentId ?? known?.parentId,
      parentFrameId: info.parentFrameId ?? known?.parentFrameId,
      was: known?.was || known?.guarded || false,
      guarded: known?.guarded || false,
      real: known?.real || false,
      context: info.browserContextId ?? known?.context,
      reported: info.url ?? known?.reported,
      at: Date.now(),
      info,
    });`,
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
        `mutant ${mutant}: patch site missing: ${from.slice(0, 80)}`
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

function chrome(infos, { failing = new Set(), slow = new Map(), throwing = new Set() } = {}) {
  const sent = [];
  const owners = new Map();
  let sessions = 0;
  const own = (sessionId) => owners.get(sessionId) ?? sessionId?.split('~')[0];
  const origin = (url) => (URL.canParse(url) ? new URL(url).origin : '://');
  const connection = {
    sent,
    owners,
    onmessage: null,
    onclose: null,
    close() {},
    emit(message) {
      connection.onmessage?.(JSON.stringify(message));
    },
    send(text) {
      const command = JSON.parse(text);
      sent.push(command);
      const owner = own(command.sessionId);
      const key = `${command.method}:${command.params?.targetId ?? owner}`;
      if (throwing.has(key)) throw new Error('the fake connection broke');
      if (failing.has(key)) {
        queueMicrotask(() =>
          connection.emit({
            id: command.id,
            ...(command.sessionId ? { sessionId: command.sessionId } : {}),
            error: { code: -32000, message: 'refused by the fake' },
          })
        );
        return;
      }
      const info = (targetId) => ({ targetId, attached: true, ...infos[targetId] });
      const answer = (() => {
        switch (command.method) {
          case 'Target.getTargetInfo':
            return { targetInfo: info(command.params?.targetId ?? owner) };
          case 'Target.attachToTarget':
            sessions += 1;
            return { sessionId: `${command.params.targetId}~${sessions}` };
          case 'Target.getTargets':
            return {
              targetInfos: Object.entries(infos).map(([targetId, entry]) => ({
                targetId,
                attached: false,
                ...entry,
              })),
            };
          case 'Page.getFrameTree':
            return {
              frameTree: {
                frame: {
                  id: `frame-${owner}`,
                  loaderId: 'loader',
                  url: infos[owner]?.url ?? ORDINARY,
                  securityOrigin: origin(infos[owner]?.url ?? ORDINARY),
                },
              },
            };
          case 'Page.getNavigationHistory':
            return {
              currentIndex: 0,
              entries: [
                { id: 0, url: infos[owner]?.url, userTypedURL: infos[owner]?.url, title: '' },
              ],
            };
          case 'DOM.getDocument':
            return { root: { nodeId: 1, nodeName: '#document', children: [] } };
          case 'Runtime.evaluate':
            return { result: { value: 'worker-token' } };
          default:
            return {};
        }
      })();
      const reply = () =>
        connection.emit({
          id: command.id,
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
          result: answer,
        });
      if (slow.has(key)) setTimeout(reply, slow.get(key));
      else queueMicrotask(reply);
    },
  };
  return connection;
}

function client(infos, route, faults, guardProtected = stockGuard) {
  const raw = chrome(infos, faults);
  const guarded = guardProtected(raw, [SEVEN], new Map(), route);
  const got = [];
  guarded.onmessage = (text) => got.push(JSON.parse(text));
  let id = 0;
  const send = async (method, params = {}, sessionId) => {
    id += 1;
    const mine = id;
    guarded.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
    for (let n = 0; n < 400 && !got.some((message) => message.id === mine); n++) await tick();
    return got.find((message) => message.id === mine);
  };
  const attach = (sessionId, targetId, parent, waitingForDebugger = false) => {
    raw.owners.set(sessionId, targetId);
    raw.emit({
      method: 'Target.attachedToTarget',
      ...(parent ? { sessionId: parent } : {}),
      params: {
        sessionId,
        targetInfo: { targetId, attached: true, ...infos[targetId] },
        waitingForDebugger,
      },
    });
  };
  const settle = async (done, rounds = 200) => {
    for (let n = 0; n < rounds && !done(); n++) await tick();
  };
  return { raw, got, send, attach, settle, infos };
}

const attachedTo = (got, sessionId) =>
  got.find(
    (message) =>
      message.method === 'Target.attachedToTarget' && message.params.sessionId === sessionId
  );

function popupWithWorker(name, route, extra = {}, guardProtected = stockGuard) {
  const pageId = `popup-${name}-${Math.random().toString(36).slice(2)}`;
  const workerId = `${pageId}-worker`;
  const infos = {
    'shop-opener': { type: 'page', url: 'https://shop.example/app', title: 'Shop' },
    [pageId]: {
      type: 'page',
      url: ORDINARY,
      title: 'Popup',
      openerId: 'shop-opener',
      canAccessOpener: false,
      attached: true,
    },
    [workerId]: { type: 'worker', url: 'https://ordinary.invalid/worker.js', title: '' },
  };
  const slow = new Map();
  const harness = client(
    infos,
    route,
    {
      failing: new Set([`Page.getFrameTree:${workerId}`]),
      slow,
      ...extra,
    },
    guardProtected
  );
  return { ...harness, slow, pageId, workerId };
}

async function shownWorker(harness) {
  const { send, attach, settle, got, pageId, workerId } = harness;
  const page = (await send('Target.attachToTarget', { targetId: pageId, flatten: true })).result
    ?.sessionId;
  assert.ok(page, 'the popup is shown');
  await send(
    'Target.setAutoAttach',
    {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'worker' }],
    },
    page
  );
  const worker = `${workerId}-session`;
  attach(worker, workerId, page);
  await settle(() => attachedTo(got, worker), 400);
  assert.ok(attachedTo(got, worker), 'the worker is shown');
  assert.ok((await send('Runtime.enable', {}, worker)).result);
  return { page, worker };
}

const said = (raw, worker, text) =>
  raw.emit({
    method: 'Runtime.consoleAPICalled',
    sessionId: worker,
    params: {
      type: 'log',
      args: [{ type: 'string', value: text }],
      executionContextId: 1,
      timestamp: 1,
    },
  });

const detachesOf = (raw, session) =>
  raw.sent.filter(
    (command) =>
      command.method === 'Target.detachFromTarget' && command.params.sessionId === session
  ).length;

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link' }],
];

for (const [name, route] of routes) {
  test(`on the ${name} route, a title-only creator change keeps a recorded worker open`, async () => {
    const harness = popupWithWorker(name, route);
    const { raw, got, settle, infos, slow, pageId } = harness;
    const { worker } = await shownWorker(harness);
    slow.set('Target.getTargetInfo:shop-opener', 5000);
    infos[pageId] = { ...infos[pageId], title: 'Popup, renamed' };
    raw.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { targetId: pageId, attached: true, ...infos[pageId] } },
    });
    said(raw, worker, `TITLE-KEEP-${name}`);
    await settle(() => JSON.stringify(got).includes(`TITLE-KEEP-${name}`), 40);
    assert.ok(
      JSON.stringify(got).includes(`TITLE-KEEP-${name}`),
      'a title-only creator change must not park worker events on a re-judge'
    );
    const evaluate = await harness.send('Runtime.evaluate', { expression: '1' }, worker);
    assert.equal(evaluate.error, undefined, JSON.stringify(evaluate));
    assert.equal(evaluate.result?.result?.value, 'worker-token');
    assert.equal(detachesOf(raw, worker), 0, 'the worker stays attached');
  });

  for (const [label, url] of [
    ['seven', SEVEN_PAGE],
    ['vault', VAULT],
  ]) {
    test(`on the ${name} route, a creator move onto ${label} still cuts the worker`, async () => {
      const harness = popupWithWorker(`${name}-${label}`, route);
      const { raw, got, settle, infos, pageId } = harness;
      const { worker } = await shownWorker(harness);
      said(raw, worker, `BEFORE-${label}-${name}`);
      await settle(() => JSON.stringify(got).includes(`BEFORE-${label}-${name}`), 100);
      infos[pageId] = { ...infos[pageId], url, title: label };
      raw.emit({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: { targetId: pageId, attached: true, ...infos[pageId] } },
      });
      said(raw, worker, `AFTER-${label}-${name}`);
      await settle(() => detachesOf(raw, worker) > 0, 200);
      assert.ok(
        !JSON.stringify(got).includes(`AFTER-${label}-${name}`),
        `no worker event after the creator moved onto ${label}`
      );
      assert.equal(detachesOf(raw, worker), 1, 'one real detach');
      const evaluate = await harness.send('Runtime.evaluate', { expression: '1' }, worker);
      assert.equal(evaluate.error?.message, PROTECTED, JSON.stringify(evaluate));
    });
  }

  test(`on the ${name} route, a creator URL change still re-judges the worker`, async () => {
    const harness = popupWithWorker(`${name}-url`, route);
    const { raw, got, settle, infos, slow, pageId } = harness;
    const { worker } = await shownWorker(harness);
    slow.set('Target.getTargetInfo:shop-opener', 300);
    infos[pageId] = { ...infos[pageId], url: `${ORDINARY}?next`, title: 'Popup' };
    raw.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { targetId: pageId, attached: true, ...infos[pageId] } },
    });
    said(raw, worker, `URL-PARK-${name}`);
    await settle(() => JSON.stringify(got).includes(`URL-PARK-${name}`), 40);
    assert.ok(
      !JSON.stringify(got).includes(`URL-PARK-${name}`),
      'a creator URL change must re-judge and park worker events until the verdict settles'
    );
    await settle(() => JSON.stringify(got).includes(`URL-PARK-${name}`), 200);
    assert.ok(
      JSON.stringify(got).includes(`URL-PARK-${name}`),
      'the event lands once the ordinary URL re-judge finishes'
    );
    assert.equal(detachesOf(raw, worker), 0, 'an ordinary URL change does not cut the worker');
  });

  test(`on the ${name} route, a canAccessOpener flip still re-judges the worker`, async () => {
    const harness = popupWithWorker(`${name}-opener`, route);
    const { raw, got, settle, infos, slow, pageId } = harness;
    const { worker } = await shownWorker(harness);
    slow.set('Target.getTargetInfo:shop-opener', 300);
    infos[pageId] = { ...infos[pageId], canAccessOpener: true };
    raw.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { targetId: pageId, ...infos[pageId] } },
    });
    said(raw, worker, `OPENER-PARK-${name}`);
    await settle(() => JSON.stringify(got).includes(`OPENER-PARK-${name}`), 40);
    assert.ok(
      !JSON.stringify(got).includes(`OPENER-PARK-${name}`),
      'a canAccessOpener flip must re-judge and park worker events until the verdict settles'
    );
    await settle(() => JSON.stringify(got).includes(`OPENER-PARK-${name}`), 200);
    assert.ok(
      JSON.stringify(got).includes(`OPENER-PARK-${name}`),
      'the event lands once the ordinary opener flip re-judge finishes'
    );
    assert.equal(detachesOf(raw, worker), 0);
  });

  test(`on the ${name} route, a title-only change on a stale creator still re-reads it`, async () => {
    const harness = popupWithWorker(`${name}-stale`, route);
    const { raw, got, settle, infos, pageId } = harness;
    const { worker } = await shownWorker(harness);
    await new Promise((resolve) => setTimeout(resolve, CREATOR_FRESH_MS + 100));
    infos[pageId] = { ...infos[pageId], title: 'Popup, renamed' };
    raw.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { targetId: pageId, ...infos[pageId] } },
    });
    await settle(() => false, 20);
    infos[pageId] = { ...infos[pageId], url: SEVEN_PAGE };
    said(raw, worker, `STALE-READ-${name}`);
    await settle(() => detachesOf(raw, worker) > 0, 200);
    assert.ok(
      !JSON.stringify(got).includes(`STALE-READ-${name}`),
      'a stale creator that already moved onto seven is re-read despite title-only noise'
    );
    assert.equal(detachesOf(raw, worker), 1, 'one real detach');
    const evaluate = await harness.send('Runtime.evaluate', { expression: '1' }, worker);
    assert.equal(evaluate.error?.message, PROTECTED, JSON.stringify(evaluate));
  });

  test(`on the ${name} route, a title-only change while the creator is held still cuts the worker`, async () => {
    const harness = popupWithWorker(`${name}-held`, route);
    const { raw, got, settle, infos, pageId } = harness;
    const { worker } = await shownWorker(harness);
    hold(pageId);
    infos[pageId] = { ...infos[pageId], title: 'Popup, renamed' };
    raw.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { targetId: pageId, ...infos[pageId] } },
    });
    said(raw, worker, `HELD-TITLE-${name}`);
    await settle(() => detachesOf(raw, worker) > 0, 200);
    assert.ok(
      !JSON.stringify(got).includes(`HELD-TITLE-${name}`),
      'no worker event after the held creator'
    );
    assert.equal(detachesOf(raw, worker), 1, 'one real detach');
    const evaluate = await harness.send('Runtime.evaluate', { expression: '1' }, worker);
    assert.equal(evaluate.error?.message, PROTECTED, JSON.stringify(evaluate));
  });
}

test('mutant: re-judging on every creator event parks the title-only row', {
  concurrency: false,
}, async () => {
  const guardProtected = await loadGuard('rejudge-every-creator-event');
  const harness = popupWithWorker('mutant-every', undefined, {}, guardProtected);
  const { raw, got, settle, infos, slow, pageId } = harness;
  const { worker } = await shownWorker(harness);
  slow.set('Target.getTargetInfo:shop-opener', 5000);
  infos[pageId] = { ...infos[pageId], title: 'Popup, renamed' };
  raw.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { targetId: pageId, attached: true, ...infos[pageId] } },
  });
  said(raw, worker, 'MUTANT-EVERY-TITLE');
  await settle(() => JSON.stringify(got).includes('MUTANT-EVERY-TITLE'), 40);
  assert.ok(
    !JSON.stringify(got).includes('MUTANT-EVERY-TITLE'),
    'mutant must turn the title-only row red'
  );
});

test('mutant: skipping re-judge on URL changes fails to park the URL twin', {
  concurrency: false,
}, async () => {
  const guardProtected = await loadGuard('skip-url-rejudge');
  const harness = popupWithWorker('mutant-url', undefined, {}, guardProtected);
  const { raw, got, settle, infos, slow, pageId } = harness;
  const { worker } = await shownWorker(harness);
  slow.set('Target.getTargetInfo:shop-opener', 5000);
  infos[pageId] = { ...infos[pageId], url: `${ORDINARY}?next`, title: 'Popup' };
  raw.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { targetId: pageId, attached: true, ...infos[pageId] } },
  });
  said(raw, worker, 'MUTANT-URL-PARK');
  await settle(() => JSON.stringify(got).includes('MUTANT-URL-PARK'), 40);
  assert.ok(
    JSON.stringify(got).includes('MUTANT-URL-PARK'),
    'mutant must turn the creator-URL re-judge twin red'
  );
});

test('mutant: skipping canAccessOpener fails to park the opener flip row', {
  concurrency: false,
}, async () => {
  const guardProtected = await loadGuard('skip-can-access-opener');
  const harness = popupWithWorker('mutant-opener', undefined, {}, guardProtected);
  const { raw, got, settle, infos, slow, pageId } = harness;
  const { worker } = await shownWorker(harness);
  slow.set('Target.getTargetInfo:shop-opener', 5000);
  infos[pageId] = { ...infos[pageId], canAccessOpener: true };
  raw.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { targetId: pageId, ...infos[pageId] } },
  });
  said(raw, worker, 'MUTANT-OPENER-PARK');
  await settle(() => JSON.stringify(got).includes('MUTANT-OPENER-PARK'), 40);
  assert.ok(
    JSON.stringify(got).includes('MUTANT-OPENER-PARK'),
    'mutant must turn the canAccessOpener flip row red'
  );
});

test('mutant: refreshing at on a title-only skip skips the stale re-read', {
  concurrency: false,
}, async () => {
  const guardProtected = await loadGuard('refresh-at-on-skip');
  const harness = popupWithWorker('mutant-stale', undefined, {}, guardProtected);
  const { raw, got, settle, infos, pageId } = harness;
  const { worker } = await shownWorker(harness);
  await new Promise((resolve) => setTimeout(resolve, CREATOR_FRESH_MS + 100));
  infos[pageId] = { ...infos[pageId], title: 'Popup, renamed' };
  raw.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { targetId: pageId, ...infos[pageId] } },
  });
  await settle(() => false, 20);
  infos[pageId] = { ...infos[pageId], url: SEVEN_PAGE };
  said(raw, worker, 'MUTANT-STALE-READ');
  await settle(() => JSON.stringify(got).includes('MUTANT-STALE-READ'), 40);
  assert.ok(
    JSON.stringify(got).includes('MUTANT-STALE-READ'),
    'mutant must turn the stale-creator re-read row red'
  );
  assert.equal(detachesOf(raw, worker), 0);
});
