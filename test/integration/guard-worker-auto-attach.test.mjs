import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected, SHARED_WORKERS } from '../../src/seed/guard.js';

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
