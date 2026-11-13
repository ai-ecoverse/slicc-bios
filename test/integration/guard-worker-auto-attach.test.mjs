import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected, NO_WORKERS } from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';

const SEVEN = 'https://seven.invalid';
const IDP = 'https://idp.example/authorize?state=s3cret&code_challenge=c0de&client_id=cl1ent';
const IDP_TITLE = 'Sign in to Example';
const VAULT = 'https://vault.sliccy.ai/unlock';
const VAULT_TITLE = 'Vault: unlock';
const ORDINARY = 'https://ordinary.invalid/page';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function chrome(infos, { silent = new Set(), failing = new Set() } = {}) {
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
      let attached;
      const answer = (() => {
        switch (command.method) {
          case 'Target.getTargetInfo':
            return { targetInfo: info(command.params?.targetId ?? owner) };
          case 'Target.attachToTarget': {
            sessions += 1;
            const sessionId = `${command.params.targetId}~${sessions}`;
            const targetInfo = info(command.params.targetId);
            if (typeof targetInfo.type === 'string' && targetInfo.type.endsWith('worker')) {
              owners.set(sessionId, command.params.targetId);
              attached = {
                method: 'Target.attachedToTarget',
                params: { sessionId, targetInfo, waitingForDebugger: false },
              };
            }
            return { sessionId };
          }
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
      queueMicrotask(() => {
        if (attached) connection.emit(attached);
        connection.emit({
          id: command.id,
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
          result: answer,
        });
      });
    },
  };
  return connection;
}

function client(infos, route, faults, caller) {
  const raw = chrome(infos, faults);
  const guarded = guardProtected(raw, [SEVEN], new Map(), route, undefined, caller);
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
const WORKERLESS = [
  { type: 'worker', exclude: true },
  { type: 'shared_worker', exclude: true },
  { type: 'service_worker', exclude: true },
  { type: 'browser', exclude: true },
  { type: 'tab', exclude: true },
  {},
];
const lastAutoAttach = (raw, session) =>
  raw.sent
    .filter((command) => command.method === 'Target.setAutoAttach' && command.sessionId === session)
    .at(-1);

for (const route of [undefined, { kind: 'link' }]) {
  const name = route?.kind ?? 'devtools';

  const DEVICE = { kind: 'device', id: 'device-1', name: 'phone' };

  async function setup(extra = {}, caller = DEVICE) {
    const infos = {
      'host-page': { type: 'page', url: ORDINARY, title: 'Ordinary' },
      'page-worker': {
        type: 'worker',
        url: 'https://ordinary.invalid/worker.js',
        title: 'page-worker-title',
      },
      'nested-worker': {
        type: 'worker',
        url: 'https://ordinary.invalid/nested.js',
        title: 'nested-worker-title',
      },
      'browser-worker': {
        type: 'service_worker',
        url: 'https://ordinary.invalid/sw.js',
        title: 'sw-title',
      },
      ...extra,
    };
    const workers = Object.keys(infos).filter((id) => infos[id].type.endsWith('worker'));
    const harness = client(
      infos,
      route,
      { failing: new Set(workers.map((id) => `Page.getFrameTree:${id}`)) },
      caller
    );
    const page = (
      await harness.send('Target.attachToTarget', { targetId: 'host-page', flatten: true })
    ).result?.sessionId;
    assert.ok(page, 'an ordinary page session');
    return { ...harness, infos, page };
  }

  test(`on the ${name} route, a remote device's worker-only auto-attach is refused and never forwarded`, async () => {
    const { raw, send, page } = await setup();
    for (const filter of [
      [{ type: 'worker', exclude: false }],
      [{ type: 'shared_worker', exclude: false }],
      [{ type: 'service_worker', exclude: false }],
      [{ type: 'worker' }, { type: 'shared_worker' }, { type: 'service_worker' }],
      [{ type: 'page', exclude: true }, { type: 'iframe', exclude: true }, { type: 'worker' }],
    ])
      for (const session of [page, undefined]) {
        const answer = await send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter },
          session
        );
        assert.equal(answer.error?.message, NO_WORKERS, JSON.stringify(filter));
        assert.ok(
          !raw.sent.some(
            (command) =>
              command.method === 'Target.setAutoAttach' &&
              JSON.stringify(command.params.filter) === JSON.stringify(filter)
          ),
          `${JSON.stringify(filter)} never reached Chrome`
        );
      }
  });

  test(`on the ${name} route, a remote device's omitted filter goes out with workers excluded, mixed filters are narrowed, and the iframe holder and the disable are unchanged`, async () => {
    const { raw, send, page } = await setup();
    for (const session of [page, undefined]) {
      assert.ok(
        (await send('Target.setAutoAttach', { autoAttach: true, flatten: true }, session)).result
      );
      assert.deepEqual(
        lastAutoAttach(raw, session).params.filter,
        WORKERLESS,
        `omitted on ${session ?? 'browser'}`
      );
      for (const filter of [
        [{ type: 'worker' }, { type: 'browser' }],
        [{ type: 'worker' }, { type: 'other' }],
      ]) {
        await send('Target.setAutoAttach', { autoAttach: true, flatten: true, filter }, session);
        assert.deepEqual(lastAutoAttach(raw, session).params.filter, [{ type: 'page' }]);
      }
    }
    const holder = {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }],
    };
    assert.ok((await send('Target.setAutoAttach', holder, page)).result);
    assert.deepEqual(
      lastAutoAttach(raw, page).params,
      holder,
      'the iframe-only holder is forwarded as sent'
    );
    const off = { autoAttach: false, waitForDebuggerOnStart: false, flatten: true };
    assert.ok((await send('Target.setAutoAttach', off, page)).result);
    assert.deepEqual(lastAutoAttach(raw, page).params, off, 'the disable is forwarded as sent');
  });

  test(`on the ${name} route, a worker attachment that reaches a remote device anyway is cut, resumed first, never shown, and refuses evaluate`, async () => {
    const { raw, got, send, attach, settle, detached, leaked, page } = await setup();
    attach('page-worker-session', 'page-worker', page, true);
    attach('nested-worker-session', 'nested-worker', 'page-worker-session', true);
    attach('browser-worker-session', 'browser-worker', undefined, false);
    const sessions = ['page-worker-session', 'nested-worker-session', 'browser-worker-session'];
    await settle(() => sessions.every((session) => detached(session)), 200);
    for (const session of sessions) {
      assert.ok(detached(session), `${session} was cut`);
      assert.equal(attachedTo(got, session), undefined, `${session} was never shown`);
      assert.ok(
        (await send('Runtime.evaluate', { expression: '1' }, session)).error,
        `${session} refuses evaluate`
      );
    }
    for (const session of ['page-worker-session', 'nested-worker-session']) {
      const resumed = raw.sent.findIndex(
        (command) =>
          command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === session
      );
      const cut = raw.sent.findIndex(
        (command) =>
          command.method === 'Target.detachFromTarget' && command.params.sessionId === session
      );
      assert.ok(resumed >= 0 && resumed < cut, `${session} was resumed before its detach`);
    }
    assert.deepEqual(leaked('page-worker-title', 'nested-worker-title', 'sw-title'), []);
  });

  test(`on the ${name} route, a remote device's attachToTarget of a worker is refused, and its lists, target info and discovery carry no worker`, async () => {
    const { raw, got, send } = await setup();
    assert.equal(
      (await send('Target.attachToTarget', { targetId: 'page-worker', flatten: true })).error
        ?.message,
      NO_WORKERS
    );
    assert.ok(
      !raw.sent.some(
        (command) =>
          command.method === 'Target.attachToTarget' && command.params.targetId === 'page-worker'
      )
    );
    const listed = await send('Target.getTargets');
    assert.ok(Array.isArray(listed.result?.targetInfos));
    assert.ok(
      listed.result.targetInfos.some((info) => info.targetId === 'host-page'),
      'pages stay listed'
    );
    assert.ok(
      !listed.result.targetInfos.some((info) => info.type.endsWith('worker')),
      'no worker listed'
    );
    assert.ok(
      (await send('Target.getTargetInfo', { targetId: 'page-worker' })).error,
      'no worker target info'
    );
    assert.ok((await send('Target.setDiscoverTargets', { discover: true })).result);
    for (const method of ['Target.targetCreated', 'Target.targetInfoChanged'])
      raw.emit({
        method,
        params: {
          targetInfo: {
            targetId: 'nested-worker',
            type: 'worker',
            url: 'https://ordinary.invalid/nested.js',
            title: 'nested-worker-title',
            attached: false,
          },
        },
      });
    raw.emit({ method: 'Target.targetDestroyed', params: { targetId: 'nested-worker' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      !got.some(
        (message) =>
          message.params?.targetInfo?.targetId === 'nested-worker' ||
          message.params?.targetId === 'nested-worker'
      )
    );
    assert.ok(!JSON.stringify(got).includes('worker-title'));
  });

  test(`on the ${name} route, a kernel program keeps main's worker behaviour for the same calls`, async () => {
    const { raw, got, send, attach, settle, page } = await setup({}, null);
    const har = {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'worker', exclude: false }],
    };
    assert.ok((await send('Target.setAutoAttach', har, page)).result, 'the HAR shape is answered');
    assert.deepEqual(lastAutoAttach(raw, page).params, har, 'and forwarded unchanged');
    for (const filter of [
      [{ type: 'shared_worker' }],
      [{ type: 'service_worker' }],
      [{ type: 'worker' }, { type: 'browser' }],
    ]) {
      assert.ok(
        (await send('Target.setAutoAttach', { autoAttach: true, flatten: true, filter }, page))
          .result
      );
      assert.deepEqual(
        lastAutoAttach(raw, page).params.filter,
        filter,
        `${JSON.stringify(filter)} is forwarded`
      );
    }
    for (const session of [page, undefined]) {
      assert.ok(
        (await send('Target.setAutoAttach', { autoAttach: true, flatten: true }, session)).result
      );
      assert.equal(
        lastAutoAttach(raw, session).params.filter,
        undefined,
        'an omitted filter stays omitted'
      );
    }
    await send('Target.setAutoAttach', { autoAttach: true, flatten: true, filter: [{}] }, page);
    assert.deepEqual(
      lastAutoAttach(raw, page).params.filter,
      [{ type: 'page' }],
      'a tab-admitting filter is narrowed'
    );
    await send('Target.setAutoAttach', {
      autoAttach: true,
      flatten: true,
      filter: [{ type: 'page', exclude: true }, {}],
    });
    assert.deepEqual(lastAutoAttach(raw, undefined).params.filter, [{ type: 'tab' }]);
    attach('kernel-worker-session', 'page-worker', page, true);
    await settle(() => attachedTo(got, 'kernel-worker-session'), 400);
    assert.ok(attachedTo(got, 'kernel-worker-session'), 'an ordinary worker is shown, as on main');
    assert.equal(
      (await send('Runtime.evaluate', { expression: '1' }, 'kernel-worker-session')).error,
      undefined
    );
    const attached = await send('Target.attachToTarget', {
      targetId: 'nested-worker',
      flatten: true,
    });
    assert.ok(
      attached.result?.sessionId,
      `attachToTarget of an ordinary worker works: ${JSON.stringify(attached)}`
    );
    const listed = await send('Target.getTargets');
    assert.ok(
      listed.result.targetInfos.some((info) => info.targetId === 'page-worker'),
      'a shown ordinary worker stays listed'
    );
  });

  test(`on the ${name} route, a kernel program's worker whose creator is held, protected or cut is cut, resumed and never shown`, async () => {
    hold(`held-page-${name}`);
    const vault = 'https://vault.sliccy.ai/unlock';
    const infos = {
      'host-page': { type: 'page', url: ORDINARY, title: 'Ordinary' },
      'vault-page': { type: 'page', url: vault, title: 'Vault' },
      [`held-page-${name}`]: { type: 'page', url: 'https://idp.example/authorize', title: 'IdP' },
      'vault-frame': { type: 'iframe', url: vault, title: '' },
      'held-worker': { type: 'worker', url: 'https://idp.example/worker.js', title: '' },
      'vault-page-worker': {
        type: 'worker',
        url: 'https://ordinary.invalid/from-vault.js',
        title: '',
      },
      'vault-data-worker': {
        type: 'worker',
        url: 'data:text/javascript,https://vault.sliccy.ai/secret',
        title: 'Vault worker title',
      },
      'frame-worker': { type: 'worker', url: 'https://ordinary.invalid/from-iframe.js', title: '' },
      'parented-worker': {
        type: 'worker',
        url: 'https://ordinary.invalid/from-iframe.js',
        title: '',
        parentId: 'vault-frame',
      },
      'blob-vault-worker': { type: 'worker', url: 'blob:https://vault.sliccy.ai/7c1d', title: '' },
      'own-data-worker': { type: 'worker', url: 'data:text/javascript,postMessage(1)', title: '' },
      'plain-worker': { type: 'worker', url: 'https://ordinary.invalid/worker.js', title: '' },
    };
    const workers = Object.keys(infos).filter((id) => infos[id].type === 'worker');
    const { raw, got, send, attach, settle, leaked, detached } = client(
      infos,
      route,
      { failing: new Set(workers.map((id) => `Page.getFrameTree:${id}`)) },
      null
    );
    const page = (await send('Target.attachToTarget', { targetId: 'host-page', flatten: true }))
      .result?.sessionId;
    assert.ok(page, 'the ordinary page is shown');
    await send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'worker' }],
      },
      page
    );
    attach('vault-session', 'vault-page');
    attach('held-session', `held-page-${name}`);
    attach('vault-frame-session', 'vault-frame', page);
    await settle(
      () =>
        detached('vault-session') && detached('held-session') && detached('vault-frame-session'),
      400
    );
    const unsafe = [
      ['held-worker-session', 'held-worker', 'held-session'],
      ['vault-page-worker-session', 'vault-page-worker', 'vault-session'],
      ['vault-data-worker-session', 'vault-data-worker', 'vault-session'],
      ['frame-worker-session', 'frame-worker', 'vault-frame-session'],
      ['parented-worker-session', 'parented-worker', page],
      ['blob-vault-worker-session', 'blob-vault-worker', page],
    ];
    for (const [session, worker, parent] of unsafe) attach(session, worker, parent, true);
    attach('own-data-worker-session', 'own-data-worker', page, true);
    attach('plain-worker-session', 'plain-worker', page, true);
    await settle(
      () =>
        unsafe.every(([session]) => detached(session)) &&
        attachedTo(got, 'plain-worker-session') &&
        attachedTo(got, 'own-data-worker-session'),
      600
    );
    for (const [session] of unsafe) {
      const resumed = raw.sent.findIndex(
        (command) =>
          command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === session
      );
      const cut = raw.sent.findIndex(
        (command) =>
          command.method === 'Target.detachFromTarget' && command.params.sessionId === session
      );
      assert.ok(cut >= 0, `${session} was cut`);
      assert.ok(resumed >= 0 && resumed < cut, `${session} was resumed as it was cut`);
      assert.equal(attachedTo(got, session), undefined, `${session} was never shown`);
      const evaluated = await send('Runtime.evaluate', { expression: 'location.href' }, session);
      assert.ok(evaluated.error, `${session} answers no evaluate`);
    }
    assert.ok(attachedTo(got, 'plain-worker-session'), 'an ordinary worker is shown');
    const plain = await send('Runtime.evaluate', { expression: '1' }, 'plain-worker-session');
    assert.equal(plain.error, undefined, `an ordinary worker answers: ${JSON.stringify(plain)}`);
    assert.ok(
      attachedTo(got, 'own-data-worker-session'),
      "an ordinary page's own data: worker is shown"
    );
    assert.deepEqual(
      leaked('vault.sliccy.ai', 'Vault worker title', 'idp.example', 'from-vault'),
      []
    );
  });

  async function chromeShapedWorker(label) {
    const pageId = `chrome-shape-page-${name}-${label}`;
    const workerId = `chrome-shape-worker-${name}-${label}`;
    const workerUrl = `http://127.0.0.1:9222/${label}-${name}.js`;
    const infos = {
      [pageId]: { type: 'page', url: ORDINARY, title: 'Ordinary' },
      [workerId]: {
        type: 'worker',
        url: workerUrl,
        title: workerUrl,
        parentId: pageId,
        parentFrameId: pageId,
      },
    };
    const harness = client(
      infos,
      route,
      { failing: new Set([`Page.getFrameTree:${workerId}`]) },
      null
    );
    const page = (await harness.send('Target.attachToTarget', { targetId: pageId, flatten: true }))
      .result?.sessionId;
    assert.ok(page, 'the ordinary creator page is shown');
    await harness.send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'worker' }],
      },
      page
    );
    const workerInfo = { targetId: workerId, attached: true, ...infos[workerId] };
    assert.equal(workerInfo.openerId, undefined, 'Chrome shape: no openerId');
    assert.equal(workerInfo.parentId, pageId, 'Chrome shape: parentId is the creator page');
    assert.equal(
      workerInfo.parentFrameId,
      pageId,
      'Chrome shape: parentFrameId is the creator page'
    );
    harness.raw.emit({
      method: 'Target.targetCreated',
      params: { targetInfo: workerInfo },
    });
    harness.raw.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: workerInfo },
    });
    await tick();
    const worker = `${workerId}-auto`;
    harness.attach(worker, workerId, page, true);
    await harness.settle(() => attachedTo(harness.got, worker), 400);
    assert.ok(
      attachedTo(harness.got, worker),
      'discovery-before-show still lets the ordinary worker be shown'
    );
    return { ...harness, page, pageId, worker, workerId, workerUrl, infos };
  }

  test(`on the ${name} route, discovery before show does not block a browser-level attachToTarget by id of an ordinary Chrome-shaped worker`, async () => {
    const { got, send, settle, workerId, workerUrl, infos } = await chromeShapedWorker('race');
    const before = got.length;
    const attached = await send('Target.attachToTarget', { targetId: workerId, flatten: true });
    assert.equal(attached.error, undefined, `by-id attach answers: ${JSON.stringify(attached)}`);
    const sessionId = attached.result?.sessionId;
    assert.ok(sessionId, `by-id attach returns a session: ${JSON.stringify(attached)}`);
    await settle(
      () =>
        got
          .slice(before)
          .some(
            (message) =>
              message.method === 'Target.attachedToTarget' &&
              message.params?.sessionId === sessionId &&
              message.params?.targetInfo?.targetId === workerId
          ),
      400
    );
    assert.ok(
      got
        .slice(before)
        .some(
          (message) =>
            message.method === 'Target.attachedToTarget' && message.params?.sessionId === sessionId
        ),
      'the by-id worker session is shown'
    );
    assert.equal(
      infos[workerId].parentId,
      infos[workerId].parentFrameId,
      'parentId and parentFrameId stay the creator page id'
    );
    const evaluated = await send(
      'Runtime.evaluate',
      { expression: 'self.location.href', returnByValue: true },
      sessionId
    );
    assert.equal(evaluated.error, undefined, `evaluate answers: ${JSON.stringify(evaluated)}`);
    assert.equal(
      evaluated.result?.result?.value ?? evaluated.result?.value,
      workerUrl,
      `evaluate returns the ordinary worker URL: ${JSON.stringify(evaluated)}`
    );
  });

  test(`on the ${name} route, closing an ordinary auto-attached worker session leaves browser-level by-id attach working while the creator is fine`, async () => {
    const { raw, got, send, settle, detached, worker, workerId, workerUrl } =
      await chromeShapedWorker('closed');
    await send('Target.detachFromTarget', { sessionId: worker });
    raw.emit({
      method: 'Target.detachedFromTarget',
      params: { sessionId: worker, targetId: workerId },
    });
    await settle(() => detached(worker) || !attachedTo(got, worker), 200);
    const before = got.length;
    const attached = await send('Target.attachToTarget', { targetId: workerId, flatten: true });
    assert.equal(
      attached.error,
      undefined,
      `by-id after ordinary close answers: ${JSON.stringify(attached)}`
    );
    const sessionId = attached.result?.sessionId;
    assert.ok(
      sessionId,
      `by-id after ordinary close returns a session: ${JSON.stringify(attached)}`
    );
    await settle(
      () =>
        got
          .slice(before)
          .some(
            (message) =>
              message.method === 'Target.attachedToTarget' &&
              message.params?.sessionId === sessionId
          ),
      400
    );
    assert.ok(
      got
        .slice(before)
        .some(
          (message) =>
            message.method === 'Target.attachedToTarget' && message.params?.sessionId === sessionId
        ),
      'by-id after ordinary close is shown'
    );
    const evaluated = await send(
      'Runtime.evaluate',
      { expression: 'self.location.href', returnByValue: true },
      sessionId
    );
    assert.equal(
      evaluated.error,
      undefined,
      `evaluate after ordinary close: ${JSON.stringify(evaluated)}`
    );
    assert.equal(evaluated.result?.result?.value ?? evaluated.result?.value, workerUrl);
  });

  test(`on the ${name} route, browser-level by-id attach of a Chrome-shaped worker is refused when its creator is held, protected or cut`, async () => {
    const hostId = `chrome-shape-host-${name}`;
    const heldId = `chrome-shape-held-${name}`;
    const vaultId = `chrome-shape-vault-${name}`;
    const heldWorker = `chrome-shape-held-worker-${name}`;
    const vaultWorker = `chrome-shape-vault-worker-${name}`;
    const cutWorker = `chrome-shape-cut-worker-${name}`;
    hold(heldId);
    const infos = {
      [hostId]: { type: 'page', url: ORDINARY, title: 'Ordinary' },
      [heldId]: { type: 'page', url: 'https://idp.example/authorize', title: IDP_TITLE },
      [vaultId]: { type: 'page', url: VAULT, title: VAULT_TITLE },
      [heldWorker]: {
        type: 'worker',
        url: `http://127.0.0.1:9222/held-${name}.js`,
        title: '',
        parentId: heldId,
        parentFrameId: heldId,
      },
      [vaultWorker]: {
        type: 'worker',
        url: `http://127.0.0.1:9222/vault-${name}.js`,
        title: '',
        parentId: vaultId,
        parentFrameId: vaultId,
      },
      [cutWorker]: {
        type: 'worker',
        url: `http://127.0.0.1:9222/cut-${name}.js`,
        title: '',
        parentId: hostId,
        parentFrameId: hostId,
      },
    };
    const workers = [heldWorker, vaultWorker, cutWorker];
    const { raw, got, send, settle, attach, detached } = client(
      infos,
      route,
      { failing: new Set(workers.map((id) => `Page.getFrameTree:${id}`)) },
      null
    );
    const page = (await send('Target.attachToTarget', { targetId: hostId, flatten: true })).result
      ?.sessionId;
    assert.ok(page, 'ordinary host page is shown');
    for (const targetId of [heldId, vaultId]) {
      raw.emit({
        method: 'Target.targetCreated',
        params: { targetInfo: { targetId, attached: false, ...infos[targetId] } },
      });
    }
    await send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'worker' }],
      },
      page
    );
    const cutSession = `${cutWorker}-auto`;
    raw.emit({
      method: 'Target.targetCreated',
      params: { targetInfo: { targetId: cutWorker, attached: true, ...infos[cutWorker] } },
    });
    attach(cutSession, cutWorker, page, true);
    await settle(() => attachedTo(got, cutSession), 400);
    assert.ok(attachedTo(got, cutSession), 'cut case: worker shown before creator detach');
    await send('Target.detachFromTarget', { sessionId: page });
    raw.emit({
      method: 'Target.detachedFromTarget',
      params: { sessionId: page, targetId: hostId },
    });
    await settle(() => detached(page) && detached(cutSession), 400);

    for (const [kind, workerId] of [
      ['held', heldWorker],
      ['protected', vaultWorker],
      ['cut', cutWorker],
    ]) {
      const before = got.length;
      raw.emit({
        method: 'Target.targetCreated',
        params: { targetInfo: { targetId: workerId, attached: true, ...infos[workerId] } },
      });
      const denied = await send('Target.attachToTarget', { targetId: workerId, flatten: true });
      assert.ok(denied.error, `${kind}: by-id refused: ${JSON.stringify(denied)}`);
      assert.ok(
        !got
          .slice(before)
          .some(
            (message) =>
              message.method === 'Target.attachedToTarget' &&
              message.params?.targetInfo?.targetId === workerId &&
              !message.error
          ),
        `${kind}: worker never shown on by-id`
      );
    }

    const vaultSession = `${vaultWorker}-prior`;
    attach('vault-session-prior', vaultId);
    await settle(() => detached('vault-session-prior'), 400);
    attach(vaultSession, vaultWorker, 'vault-session-prior', true);
    await settle(() => detached(vaultSession), 400);
    assert.ok(detached(vaultSession), 'a protected-creator worker is cut');
    raw.emit({ method: 'Target.targetDestroyed', params: { targetId: vaultWorker } });
    await tick();
    const afterDestroy = got.length;
    const stillDenied = await send('Target.attachToTarget', {
      targetId: vaultWorker,
      flatten: true,
    });
    assert.ok(
      stillDenied.error,
      `prior unsafe session still refuses by-id after targetDestroyed cleared the cut set: ${JSON.stringify(stillDenied)}`
    );
    assert.ok(
      !got
        .slice(afterDestroy)
        .some(
          (message) =>
            message.method === 'Target.attachedToTarget' &&
            message.params?.targetInfo?.targetId === vaultWorker &&
            !message.error
        ),
      'prior unsafe session: worker never shown'
    );
  });

  test(`on the ${name} route, a stale workerTargetsCut clears when the creator session is alive again`, async () => {
    const pageId = `stale-cut-page-${name}`;
    const workerId = `stale-cut-worker-${name}`;
    const workerUrl = `http://127.0.0.1:9222/stale-${name}.js`;
    const infos = {
      [pageId]: { type: 'page', url: ORDINARY, title: 'Ordinary' },
      [workerId]: {
        type: 'worker',
        url: workerUrl,
        title: workerUrl,
        parentId: pageId,
        parentFrameId: pageId,
      },
    };
    const { raw, got, send, settle, attach, detached } = client(
      infos,
      route,
      { failing: new Set([`Page.getFrameTree:${workerId}`]) },
      null
    );
    const page = (await send('Target.attachToTarget', { targetId: pageId, flatten: true })).result
      ?.sessionId;
    assert.ok(page, 'creator page is shown');
    await send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'worker' }],
      },
      page
    );
    const worker = `${workerId}-auto`;
    attach(worker, workerId, page, true);
    await settle(() => attachedTo(got, worker), 400);
    assert.ok(attachedTo(got, worker), 'worker shown before creator cut');
    await send('Target.detachFromTarget', { sessionId: page });
    raw.emit({
      method: 'Target.detachedFromTarget',
      params: { sessionId: page, targetId: pageId },
    });
    await settle(() => detached(page) && detached(worker), 400);
    assert.ok(
      (await send('Target.attachToTarget', { targetId: workerId, flatten: true })).error,
      'by-id refused while the creator stays cut'
    );
    const pageAgain = (await send('Target.attachToTarget', { targetId: pageId, flatten: true }))
      .result?.sessionId;
    assert.ok(pageAgain, 'creator page is shown again');
    await send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'worker' }],
      },
      pageAgain
    );
    const underCreator = `${workerId}-under-creator`;
    attach(underCreator, workerId, pageAgain, true);
    await settle(() => attachedTo(got, underCreator) || detached(underCreator), 400);
    assert.ok(
      attachedTo(got, underCreator),
      `stale cut clears for attach under the restored creator: ${JSON.stringify(
        got.filter((message) => message.params?.targetInfo?.targetId === workerId).slice(-3)
      )}`
    );
    assert.equal(
      (await send('Runtime.evaluate', { expression: '1' }, underCreator)).error,
      undefined
    );
    await send('Target.detachFromTarget', { sessionId: underCreator });
    raw.emit({
      method: 'Target.detachedFromTarget',
      params: { sessionId: underCreator, targetId: workerId },
    });
    const before = got.length;
    const byId = await send('Target.attachToTarget', { targetId: workerId, flatten: true });
    assert.equal(byId.error, undefined, `by-id after creator restore: ${JSON.stringify(byId)}`);
    const sessionId = byId.result?.sessionId;
    assert.ok(sessionId);
    await settle(
      () =>
        got
          .slice(before)
          .some(
            (message) =>
              message.method === 'Target.attachedToTarget' &&
              message.params?.sessionId === sessionId
          ),
      400
    );
    assert.ok(
      got
        .slice(before)
        .some(
          (message) =>
            message.method === 'Target.attachedToTarget' && message.params?.sessionId === sessionId
        ),
      'browser-level by-id is shown after the creator returns'
    );
    assert.equal(
      (await send('Runtime.evaluate', { expression: 'self.location.href' }, sessionId)).error,
      undefined
    );
  });

  for (const turn of ['hold', 'navigate', 'infoChanged', 'detached']) {
    test(`on the ${name} route, a kernel program's shown worker is cut when its creator turns (${turn})`, async () => {
      const pageId = `turning-page-${name}-${turn}`;
      const workerId = `turning-worker-${name}-${turn}`;
      const infos = {
        [pageId]: { type: 'page', url: ORDINARY, title: 'Ordinary' },
        [workerId]: { type: 'worker', url: 'https://ordinary.invalid/worker.js', title: '' },
      };
      const { raw, got, send, attach, settle, detached } = client(
        infos,
        route,
        { failing: new Set([`Page.getFrameTree:${workerId}`]) },
        null
      );
      const page = (await send('Target.attachToTarget', { targetId: pageId, flatten: true })).result
        ?.sessionId;
      assert.ok(page, 'the ordinary page is shown');
      await send(
        'Target.setAutoAttach',
        {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: 'worker' }],
        },
        page
      );
      const worker = 'turning-worker-session';
      attach(worker, workerId, page, true);
      await settle(() => attachedTo(got, worker), 400);
      assert.ok(attachedTo(got, worker), 'the ordinary worker is shown');
      assert.ok((await send('Runtime.enable', {}, worker)).result, 'Runtime.enable on the worker');
      const said = (text) =>
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
      said('BEFORE-turn');
      await settle(() => JSON.stringify(got).includes('BEFORE-turn'), 100);
      assert.ok(
        JSON.stringify(got).includes('BEFORE-turn'),
        'worker events reach the client before the turn'
      );
      if (turn === 'hold') hold(pageId);
      if (turn === 'navigate') {
        infos[pageId] = { type: 'page', url: VAULT, title: 'Vault' };
        raw.emit({
          method: 'Page.frameNavigated',
          sessionId: page,
          params: {
            frame: {
              id: `frame-${pageId}`,
              loaderId: 'l2',
              url: VAULT,
              securityOrigin: 'https://vault.sliccy.ai',
            },
            type: 'Navigation',
          },
        });
      }
      if (turn === 'infoChanged') {
        infos[pageId] = { type: 'page', url: VAULT, title: 'Vault' };
        raw.emit({
          method: 'Target.targetInfoChanged',
          params: { targetInfo: { targetId: pageId, attached: true, ...infos[pageId] } },
        });
      }
      if (turn === 'detached')
        raw.emit({
          method: 'Target.detachedFromTarget',
          params: { sessionId: page, targetId: pageId },
        });
      await settle(() => turn === 'hold' || detached(worker), 200);
      said(`AFTER-${name}-${turn}`);
      await settle(() => detached(worker), 200);
      assert.ok(detached(worker), 'a real detach went out for the worker');
      assert.ok(
        !JSON.stringify(got).includes(`AFTER-${name}-${turn}`),
        'no worker event after the turn'
      );
      const evaluated = await send('Runtime.evaluate', { expression: '1' }, worker);
      assert.ok(evaluated.error, `evaluate is refused: ${JSON.stringify(evaluated)}`);
      assert.ok(!JSON.stringify(got).includes('vault.sliccy.ai'));
    });
  }
}
