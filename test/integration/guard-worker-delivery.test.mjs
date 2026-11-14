import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';

const SEVEN = 'https://seven.invalid';
const IDP = 'https://idp.example/authorize?state=s3cret&code_challenge=c0de&client_id=cl1ent';
const IDP_TITLE = 'Sign in to Example';
const VAULT = 'https://vault.sliccy.ai/unlock';
const VAULT_TITLE = 'Vault: unlock';
const ORDINARY = 'https://ordinary.invalid/page';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function chrome(
  infos,
  { silent = new Set(), failing = new Set(), slow = new Map(), throwing = new Set() } = {}
) {
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
      if (silent.has(key)) return;
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
              targetInfos: Object.entries(infos).map(([targetId, info]) => ({
                targetId,
                attached: false,
                ...info,
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
            return { result: { value: infos[owner]?.url } };
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

function client(infos, route, faults) {
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
  const leaked = (...values) => values.filter((value) => JSON.stringify(got).includes(value));
  const detached = (sessionId) =>
    raw.sent.some(
      (command) =>
        command.method === 'Target.detachFromTarget' && command.params.sessionId === sessionId
    );
  return { raw, got, send, attach, settle, leaked, detached };
}

const attachedTo = (got, sessionId) =>
  got.find(
    (message) =>
      message.method === 'Target.attachedToTarget' && message.params.sessionId === sessionId
  );

function popupWithWorker(name, route, extra = {}) {
  const pageId = `popup-${name}-${Math.random().toString(36).slice(2)}`;
  const workerId = `${pageId}-worker`;
  const infos = {
    'shop-opener': { type: 'page', url: 'https://shop.example/app', title: 'Shop' },
    [pageId]: { type: 'page', url: ORDINARY, title: 'Popup', openerId: 'shop-opener' },
    [workerId]: { type: 'worker', url: 'https://ordinary.invalid/worker.js', title: '' },
  };
  const slow = new Map();
  const harness = client(infos, route, {
    failing: new Set([`Page.getFrameTree:${workerId}`]),
    slow,
    ...extra,
  });
  return { ...harness, infos, slow, pageId, workerId };
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

for (const route of [undefined, { kind: 'link' }]) {
  const name = route?.kind ?? 'devtools';

  test(`on the ${name} route, a worker event parked on a slow opener read is dropped when the page is held during the wait`, async () => {
    const harness = popupWithWorker(name, route);
    const { raw, got, settle, infos, slow, pageId } = harness;
    const { worker } = await shownWorker(harness);
    slow.set('Target.getTargetInfo:shop-opener', 300);
    infos[pageId] = { ...infos[pageId], title: 'Popup, renamed' };
    raw.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { targetId: pageId, attached: true, ...infos[pageId] } },
    });
    said(raw, worker, `IN-FLIGHT-${name}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    hold(pageId);
    await settle(() => detachesOf(raw, worker) > 0, 200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(!JSON.stringify(got).includes(`IN-FLIGHT-${name}`), 'the parked event was dropped');
    assert.equal(detachesOf(raw, worker), 1, 'one real detach for the worker');
    assert.ok((await harness.send('Runtime.evaluate', { expression: '1' }, worker)).error);
  });

  test(`on the ${name} route, a forwarded evaluate whose answer arrives after a hold is refused`, async () => {
    const harness = popupWithWorker(name, route);
    const { raw, got, slow, pageId, workerId } = harness;
    const { worker } = await shownWorker(harness);
    slow.set(`Runtime.evaluate:${workerId}`, 200);
    const pending = harness.send(
      'Runtime.evaluate',
      { expression: '"worker-token-after-hold"' },
      worker
    );
    for (
      let n = 0;
      n < 40 && !raw.sent.some((c) => c.method === 'Runtime.evaluate' && c.sessionId === worker);
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(
      raw.sent.some((c) => c.method === 'Runtime.evaluate' && c.sessionId === worker),
      'forwarded while ordinary'
    );
    hold(pageId);
    const answer = await pending;
    assert.equal(answer.error?.message, PROTECTED, JSON.stringify(answer));
    assert.equal(answer.result, undefined, 'no result from the worker reaches the client');
    assert.equal(detachesOf(raw, worker), 1, 'one real detach for the worker');
  });

  test(`on the ${name} route, the worker's own ordinary targetInfoChanged after a hold is dropped`, async () => {
    const harness = popupWithWorker(name, route);
    const { raw, got, settle, pageId, workerId } = harness;
    const { worker } = await shownWorker(harness);
    hold(pageId);
    raw.emit({
      method: 'Target.targetInfoChanged',
      params: {
        targetInfo: {
          targetId: workerId,
          type: 'worker',
          url: 'https://ordinary.invalid/worker.js?after',
          title: 'worker-title-after-hold',
          attached: true,
        },
      },
    });
    await settle(() => detachesOf(raw, worker) > 0, 200);
    assert.ok(
      !JSON.stringify(got).includes('worker-title-after-hold'),
      'nothing about the worker after the hold'
    );
    assert.equal(detachesOf(raw, worker), 1, 'one real detach for the worker');
    assert.ok((await harness.send('Runtime.evaluate', { expression: '1' }, worker)).error);
  });

  test(`on the ${name} route, worker events of a page with an opener cost no Target.getTargetInfo after attach`, async () => {
    const harness = popupWithWorker(name, route);
    const { raw, got, settle } = harness;
    const { worker } = await shownWorker(harness);
    raw.emit({
      method: 'Target.targetInfoChanged',
      params: {
        targetInfo: {
          targetId: 'unrelated-page',
          type: 'page',
          url: ORDINARY,
          title: 'Other',
          attached: false,
        },
      },
    });
    raw.emit({ method: 'Target.targetDestroyed', params: { targetId: 'unrelated-page' } });
    const listed = await harness.send('Target.getTargetInfo', { targetId: harness.pageId });
    assert.ok(listed.result?.targetInfo, 'a page target info still reaches the client');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = raw.sent.filter((c) => c.method === 'Target.getTargetInfo').length;
    for (let n = 0; n < 4; n++) said(raw, worker, `COUNT-${name}-${n}`);
    await settle(() => JSON.stringify(got).includes(`COUNT-${name}-3`), 200);
    assert.ok(JSON.stringify(got).includes(`COUNT-${name}-3`), 'the events are delivered');
    assert.equal(raw.sent.filter((c) => c.method === 'Target.getTargetInfo').length, before);
  });

  test(`on the ${name} route, a worker event in the same tick as its creator session's detach is dropped`, async () => {
    const harness = popupWithWorker(name, route);
    const { raw, got, settle, pageId } = harness;
    const { page, worker } = await shownWorker(harness);
    said(raw, worker, `SAME-TICK-${name}`);
    raw.emit({
      method: 'Target.detachedFromTarget',
      params: { sessionId: page, targetId: pageId },
    });
    await settle(() => detachesOf(raw, worker) > 0, 200);
    assert.ok(!JSON.stringify(got).includes(`SAME-TICK-${name}`));
    assert.ok(detachesOf(raw, worker) >= 1);
  });

  for (const turn of ['grand', 'mid', 'mid-to-vault']) {
    test(`on the ${name} route, a worker is cut when an ancestor of its creator turns (${turn})`, async () => {
      const id = Math.random().toString(36).slice(2);
      const grand = `grand-${id}`;
      const mid = `mid-${id}`;
      const popup = `popup-${id}`;
      const workerId = `${popup}-worker`;
      const infos = {
        [grand]: { type: 'page', url: 'https://shop.example/grand', title: 'Grand' },
        [mid]: { type: 'page', url: 'https://shop.example/mid', title: 'Mid', openerId: grand },
        [popup]: { type: 'page', url: 'https://shop.example/popup', title: 'Popup', openerId: mid },
        [workerId]: { type: 'worker', url: 'https://shop.example/worker.js', title: '' },
      };
      const harness = client(infos, route, { failing: new Set([`Page.getFrameTree:${workerId}`]) });
      const { raw, got, settle } = harness;
      const { worker } = await shownWorker({ ...harness, pageId: popup, workerId });
      said(raw, worker, `BEFORE-${turn}`);
      await settle(() => JSON.stringify(got).includes(`BEFORE-${turn}`), 100);
      assert.ok(JSON.stringify(got).includes(`BEFORE-${turn}`));
      if (turn === 'grand') hold(grand);
      if (turn === 'mid') hold(mid);
      if (turn === 'mid-to-vault') {
        infos[mid] = { ...infos[mid], url: 'https://vault.sliccy.ai/unlock', title: 'Vault' };
        raw.emit({
          method: 'Target.targetInfoChanged',
          params: { targetInfo: { targetId: mid, attached: false, ...infos[mid] } },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      said(raw, worker, `AFTER-${name}-${turn}`);
      await settle(() => detachesOf(raw, worker) > 0, 200);
      assert.ok(
        !JSON.stringify(got).includes(`AFTER-${name}-${turn}`),
        'no worker event after the turn'
      );
      assert.equal(detachesOf(raw, worker), 1, 'one real detach');
      assert.ok((await harness.send('Runtime.evaluate', { expression: '1' }, worker)).error);
      assert.ok(!JSON.stringify(got).includes('vault.sliccy.ai'));
    });
  }

  test(`on the ${name} route, a rejected verdict cuts the worker with no unhandled rejection`, async () => {
    const unhandled = [];
    const record = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      const harness = popupWithWorker(name, route, { throwing: new Set() });
      const { raw, got, settle, infos, pageId, workerId } = harness;
      const throwing = new Set(['Target.getTargetInfo:shop-opener']);
      const { worker } = await shownWorker(harness);
      raw.send = ((send) => (text) => {
        const command = JSON.parse(text);
        if (throwing.has(`${command.method}:${command.params?.targetId}`))
          throw new Error('the fake connection broke');
        return send(text);
      })(raw.send);
      infos[pageId] = { ...infos[pageId], title: 'Popup, renamed' };
      raw.emit({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: { targetId: pageId, attached: true, ...infos[pageId] } },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      raw.emit({
        method: 'Target.targetInfoChanged',
        params: {
          targetInfo: {
            targetId: workerId,
            type: 'worker',
            url: 'https://ordinary.invalid/worker.js',
            title: 'reject-worker-title',
            attached: true,
          },
        },
      });
      await settle(() => detachesOf(raw, worker) > 0, 200);
      assert.ok(!JSON.stringify(got).includes('reject-worker-title'));
      assert.equal(detachesOf(raw, worker), 1, 'one real detach');
      const evaluated = await harness.send('Runtime.evaluate', { expression: '1' }, worker);
      assert.equal(evaluated.error?.message, PROTECTED, JSON.stringify(evaluated));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  test(`on the ${name} route, Target.getTargets after a hold lists no worker of the held page`, async () => {
    const harness = popupWithWorker(name, route);
    const { raw, got, settle, infos, pageId, workerId } = harness;
    const { worker } = await shownWorker(harness);
    infos[workerId] = { ...infos[workerId], title: 'list-worker-title' };
    hold(pageId);
    const listed = await harness.send('Target.getTargets');
    assert.ok(Array.isArray(listed.result?.targetInfos));
    assert.ok(
      !listed.result.targetInfos.some((info) => info.targetId === workerId),
      'the worker is not listed'
    );
    assert.ok(!JSON.stringify(got).includes('list-worker-title'));
    await settle(() => detachesOf(raw, worker) > 0, 200);
    assert.equal(detachesOf(raw, worker), 1, 'one real detach');
    assert.ok((await harness.send('Runtime.evaluate', { expression: '1' }, worker)).error);
    raw.emit({ method: 'Target.targetDestroyed', params: { targetId: workerId } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      !got.some(
        (message) =>
          message.method === 'Target.targetDestroyed' && message.params?.targetId === workerId
      )
    );
  });

  test(`on the ${name} route, discovery never names a worker of a held page the client did not attach`, async () => {
    const id = Math.random().toString(36).slice(2);
    const held = `held-discovery-${id}`;
    const workerId = `${held}-worker`;
    const infos = {
      [held]: { type: 'page', url: 'https://idp.example/authorize', title: 'IdP' },
      [workerId]: {
        type: 'worker',
        url: 'https://idp.example/discovered-worker.js',
        title: 'discovered-worker-title',
      },
    };
    hold(held);
    const { raw, got, send } = client(infos, route);
    assert.ok((await send('Target.setDiscoverTargets', { discover: true })).result);
    for (const method of ['Target.targetCreated', 'Target.targetInfoChanged'])
      raw.emit({
        method,
        params: { targetInfo: { targetId: workerId, attached: false, ...infos[workerId] } },
      });
    raw.emit({ method: 'Target.targetDestroyed', params: { targetId: workerId } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!JSON.stringify(got).includes('discovered-worker'), 'no URL or title of the worker');
    assert.ok(
      !got.some(
        (message) =>
          message.params?.targetInfo?.targetId === workerId || message.params?.targetId === workerId
      )
    );
  });

  test(`on the ${name} route, a nested worker whose parent is itself a worker turns with its root page on hold`, async () => {
    const id = Math.random().toString(36).slice(2);
    const pageId = `nest-page-${id}`;
    const midId = `nest-mid-${id}`;
    const nestedId = `nest-leaf-${id}`;
    const infos = {
      [pageId]: { type: 'page', url: ORDINARY, title: 'Ordinary' },
      [midId]: { type: 'worker', url: 'https://ordinary.invalid/mid.js', title: '' },
      [nestedId]: { type: 'worker', url: 'https://ordinary.invalid/leaf.js', title: '' },
    };
    const harness = client(infos, route, {
      failing: new Set([`Page.getFrameTree:${midId}`, `Page.getFrameTree:${nestedId}`]),
    });
    const { raw, got, send, attach, settle } = harness;
    const page = (await send('Target.attachToTarget', { targetId: pageId, flatten: true })).result
      ?.sessionId;
    assert.ok(page);
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
    const mid = `${midId}-session`;
    const nested = `${nestedId}-session`;
    attach(mid, midId, page);
    await settle(() => attachedTo(got, mid), 400);
    assert.ok(attachedTo(got, mid), 'the mid worker is shown');
    await send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: 'worker' }],
      },
      mid
    );
    attach(nested, nestedId, mid);
    await settle(() => attachedTo(got, nested), 400);
    assert.ok(attachedTo(got, nested), 'the nested worker is shown');
    assert.ok((await send('Runtime.enable', {}, nested)).result);
    said(raw, nested, `NESTED-BEFORE-${name}`);
    await settle(() => JSON.stringify(got).includes(`NESTED-BEFORE-${name}`), 100);
    hold(pageId);
    said(raw, nested, `NESTED-AFTER-${name}`);
    await settle(() => detachesOf(raw, nested) > 0, 200);
    assert.ok(
      !JSON.stringify(got).includes(`NESTED-AFTER-${name}`),
      'no nested worker event after the root page is held'
    );
    assert.ok(detachesOf(raw, nested) >= 1, 'the nested worker is detached');
    assert.ok((await send('Runtime.evaluate', { expression: '1' }, nested)).error);
  });

  test(`on the ${name} route, a worker target cut for its creator stays cut when reattached on the browser session`, async () => {
    const harness = popupWithWorker(name, route);
    const { raw, got, settle, pageId, workerId, attach, send } = harness;
    const { worker } = await shownWorker(harness);
    hold(pageId);
    said(raw, worker, `REATTACH-BEFORE-${name}`);
    await settle(() => detachesOf(raw, worker) > 0, 200);
    assert.equal(detachesOf(raw, worker), 1, 'the first session is cut');
    const again = `${workerId}-browser-reattach`;
    attach(again, workerId, undefined);
    await settle(() => detachesOf(raw, again) > 0, 400);
    assert.ok(detachesOf(raw, again) >= 1, 'the browser-level reattach is cut');
    assert.equal(attachedTo(got, again), undefined, 'and never shown');
    assert.ok((await send('Runtime.evaluate', { expression: '1' }, again)).error);
    assert.ok(!JSON.stringify(got).includes(`REATTACH-BEFORE-${name}`));
  });
}
