import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected, SHARED_WORKERS } from '../../src/seed/guard.js';
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
      const answer = (() => {
        switch (command.method) {
          case 'Target.getTargetInfo':
            return { targetInfo: info(command.params?.targetId ?? owner) };
          case 'Target.attachToTarget':
            sessions += 1;
            return { sessionId: `${command.params.targetId}~${sessions}` };
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

test('over the DevTools port, a dedicated-worker auto-attach is forwarded unchanged; a protected worker it attaches is cut and never shown, an ordinary one is shown', async () => {
  const infos = {
    'worker-page': { type: 'page', url: ORDINARY, title: 'Ordinary' },
    'vault-worker': { type: 'worker', url: 'blob:https://vault.sliccy.ai/7c1d', title: '' },
    'plain-worker': { type: 'worker', url: 'https://ordinary.invalid/worker.js', title: '' },
  };
  const { raw, got, send, attach, settle, leaked, detached } = client(infos, undefined, {
    failing: new Set(['Page.getFrameTree:vault-worker', 'Page.getFrameTree:plain-worker']),
  });
  const page = (await send('Target.attachToTarget', { targetId: 'worker-page', flatten: true }))
    .result?.sessionId;
  assert.ok(page, 'an ordinary page session');
  const har = {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: 'worker', exclude: false }],
  };
  assert.deepEqual((await send('Target.setAutoAttach', har, page)).result, {});
  const forwarded = raw.sent.filter(
    (command) => command.method === 'Target.setAutoAttach' && command.sessionId === page
  );
  assert.deepEqual(forwarded.at(-1).params, har, 'forwarded as the client sent it');
  attach('vault-worker-session', 'vault-worker', page, true);
  attach('plain-worker-session', 'plain-worker', page, true);
  await settle(
    () => detached('vault-worker-session') && attachedTo(got, 'plain-worker-session'),
    400
  );
  assert.ok(detached('vault-worker-session'), 'the protected worker was cut');
  assert.equal(attachedTo(got, 'vault-worker-session'), undefined, 'and never shown');
  assert.ok(attachedTo(got, 'plain-worker-session'), 'the ordinary worker was shown');
  assert.deepEqual(leaked('vault.sliccy.ai', '7c1d'), []);
});

test('over the DevTools port, an auto-attach for shared or service workers is refused and never forwarded', async () => {
  const infos = { 'shared-page': { type: 'page', url: ORDINARY, title: 'Ordinary' } };
  const { raw, send } = client(infos);
  const page = (await send('Target.attachToTarget', { targetId: 'shared-page', flatten: true }))
    .result?.sessionId;
  assert.ok(page);
  for (const filter of [
    [{ type: 'shared_worker', exclude: false }],
    [{ type: 'service_worker', exclude: false }],
    [{ type: 'worker' }, { type: 'shared_worker' }, { type: 'service_worker' }],
  ]) {
    for (const session of [page, undefined]) {
      const answer = await send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter },
        session
      );
      assert.equal(answer.error?.message, SHARED_WORKERS, JSON.stringify(filter));
    }
    assert.ok(
      !raw.sent.some(
        (command) =>
          command.method === 'Target.setAutoAttach' &&
          JSON.stringify(command.params.filter) === JSON.stringify(filter)
      ),
      `${JSON.stringify(filter)} never reached Chrome`
    );
  }
  const off = await send(
    'Target.setAutoAttach',
    { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
    page
  );
  assert.ok(off.result, JSON.stringify(off));
});

for (const route of [undefined, { kind: 'link' }]) {
  const name = route?.kind ?? 'devtools';

  test(`on the ${name} route, mixed worker filters are narrowed as before, on page and browser sessions`, async () => {
    const infos = { 'mixed-page': { type: 'page', url: ORDINARY, title: 'Ordinary' } };
    const { raw, send } = client(infos, route);
    const page = (await send('Target.attachToTarget', { targetId: 'mixed-page', flatten: true }))
      .result?.sessionId;
    assert.ok(page);
    for (const filter of [
      [{ type: 'worker' }, { type: 'browser' }],
      [{ type: 'worker' }, { type: 'other' }],
    ]) {
      for (const [session, narrowed] of [
        [page, [{ type: 'page' }]],
        [undefined, [{ type: 'page' }]],
      ]) {
        await send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter },
          session
        );
        const sent = raw.sent.filter(
          (command) => command.method === 'Target.setAutoAttach' && command.sessionId === session
        );
        assert.deepEqual(
          sent.at(-1).params.filter,
          narrowed,
          `${JSON.stringify(filter)} on ${session ?? 'browser'}`
        );
      }
    }
    const dedicated = [
      { type: 'page', exclude: true },
      { type: 'iframe', exclude: true },
      { type: 'worker' },
    ];
    await send(
      'Target.setAutoAttach',
      { autoAttach: true, flatten: true, filter: dedicated },
      page
    );
    const last = raw.sent.filter(
      (command) => command.method === 'Target.setAutoAttach' && command.sessionId === page
    );
    assert.deepEqual(
      last.at(-1).params.filter,
      dedicated,
      'an exclude list leaving only dedicated workers is forwarded'
    );
  });

  test(`on the ${name} route, a worker whose creator is held, protected or cut is cut, resumed and never shown`, async () => {
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
    const { raw, got, send, attach, settle, leaked, detached } = client(infos, route, {
      failing: new Set(workers.map((id) => `Page.getFrameTree:${id}`)),
    });
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
}
