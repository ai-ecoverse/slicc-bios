import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected, NO_WORKERS } from '../../src/seed/guard.js';

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
      queueMicrotask(() =>
        connection.emit({
          id: command.id,
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
          result: answer,
        })
      );
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
      listed.result.targetInfos.some((info) => info.type.endsWith('worker')),
      'workers stay listed'
    );
  });
}
