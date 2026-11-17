import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';

const SEVEN = 'https://seven.invalid';
const SEVEN_PAGE = `${SEVEN}/os/`;
const ORDINARY = 'https://ordinary.invalid/page';
const CROSS = 'https://cross.invalid/inner';
const WORKER = 'https://cross.invalid/worker.js';
const DEVICE = { kind: 'device', id: 'device-1', name: 'phone' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function chrome(infos) {
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
      const reply = (payload) =>
        queueMicrotask(() =>
          connection.emit({
            id: command.id,
            ...(command.sessionId ? { sessionId: command.sessionId } : {}),
            ...payload,
          })
        );
      if (command.method === 'Page.getFrameTree' && infos[owner]?.type.endsWith('worker')) {
        reply({ error: { code: -32000, message: `refused by the fake: ${key}` } });
        return;
      }
      const info = (targetId) => ({ targetId, attached: true, ...infos[targetId] });
      switch (command.method) {
        case 'Target.getTargetInfo': {
          const asked = command.params?.targetId ?? owner;
          if (!infos[asked])
            return reply({ error: { code: -32602, message: `no target ${asked}` } });
          return reply({ result: { targetInfo: info(asked) } });
        }
        case 'Target.attachToTarget':
          sessions += 1;
          return reply({ result: { sessionId: `${command.params.targetId}~${sessions}` } });
        case 'Target.getTargets':
          return reply({
            result: {
              targetInfos: Object.entries(infos).map(([targetId, value]) => ({
                targetId,
                attached: false,
                ...value,
              })),
            },
          });
        case 'Page.getFrameTree':
          return reply({
            result: {
              frameTree: {
                frame: {
                  id: `frame-${owner}`,
                  loaderId: 'loader',
                  url: infos[owner]?.url ?? ORDINARY,
                  securityOrigin: origin(infos[owner]?.url ?? ORDINARY),
                },
              },
            },
          });
        case 'Page.getNavigationHistory':
          return reply({
            result: {
              currentIndex: 0,
              entries: [
                { id: 0, url: infos[owner]?.url, userTypedURL: infos[owner]?.url, title: '' },
              ],
            },
          });
        case 'DOM.getDocument':
          return reply({ result: { root: { nodeId: 1, nodeName: '#document', children: [] } } });
        case 'Runtime.evaluate':
          return reply({ result: { result: { type: 'string', value: 'worker-secret-body' } } });
        default:
          return reply({ result: {} });
      }
    },
  };
  return connection;
}

function harness(infos, route, caller) {
  const raw = chrome(infos);
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
  const attach = (sessionId, targetId, parent) => {
    raw.owners.set(sessionId, targetId);
    raw.emit({
      method: 'Target.attachedToTarget',
      ...(parent ? { sessionId: parent } : {}),
      params: {
        sessionId,
        targetInfo: { targetId, attached: true, ...infos[targetId] },
        waitingForDebugger: false,
      },
    });
  };
  const settle = async (done, rounds = 200) => {
    for (let n = 0; n < rounds && !done(); n++) await tick();
  };
  const shown = (sessionId) =>
    got.some(
      (message) =>
        message.method === 'Target.attachedToTarget' && message.params?.sessionId === sessionId
    );
  const detached = (sessionId) =>
    raw.sent.some(
      (command) =>
        command.method === 'Target.detachFromTarget' && command.params.sessionId === sessionId
    );
  const leaked = (...values) => values.filter((value) => JSON.stringify(got).includes(value));
  return { raw, got, send, attach, settle, shown, detached, leaked };
}

const creatorForms = {
  parentId: (kid) => ({ parentId: kid }),
  openerId: (kid) => ({ openerId: kid }),
  parentFrameId: (kid) => ({ parentFrameId: kid }),
};

const world = (workerCreator, ownerUrl) => ({
  host: { type: 'page', url: ownerUrl, title: 'Host' },
  kid: { type: 'iframe', url: CROSS, title: 'Frame', parentId: 'host' },
  worker: { type: 'worker', url: WORKER, title: 'Worker', ...workerCreator },
});

const listedIds = async (h) =>
  ((await h.send('Target.getTargets')).result?.targetInfos ?? []).map((info) => info.targetId);

async function reachable(h) {
  const info = await h.send('Target.getTargetInfo', { targetId: 'worker' });
  const attached = await h.send('Target.attachToTarget', { targetId: 'worker', flatten: true });
  if (info.error && attached.error) return false;
  if (attached.error) return Boolean(info.result?.targetInfo);
  const read = await h.send(
    'Runtime.evaluate',
    { expression: 'document.body.innerText' },
    attached.result.sessionId
  );
  return Boolean(info.result?.targetInfo) || !read.error;
}

for (const route of [undefined, { kind: 'link' }]) {
  const name = route?.kind ?? 'devtools';
  for (const [who, caller] of [
    ['a kernel program', undefined],
    ['a remote device', DEVICE],
  ]) {
    for (const [form, creator] of Object.entries(creatorForms)) {
      test(`over ${name}, for ${who}, a worker created by an iframe that the protected-parent rule hides is never shown, listed, described or attachable (${form})`, async () => {
        const infos = {
          'seven-page': { type: 'page', url: SEVEN_PAGE, title: 'seven' },
          kid: { type: 'iframe', url: CROSS, title: 'Frame', parentId: 'seven-page' },
          worker: { type: 'worker', url: WORKER, title: 'Worker', ...creator('kid') },
        };
        const h = harness(infos, route, caller);
        h.attach('worker~1', 'worker');
        await h.settle(() => h.detached('worker~1'), 100);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(!h.shown('worker~1'), 'the worker attachment is not published');
        assert.ok(h.detached('worker~1'), 'the worker session is cut');
        const ids = await listedIds(h);
        assert.ok(!ids.includes('worker'), 'the worker is not listed');
        assert.ok(!ids.includes('kid'), 'the iframe is not listed');
        assert.equal(await reachable(h), false, 'the worker is neither described nor attachable');
        assert.deepEqual(h.leaked(WORKER, CROSS, 'worker-secret-body'), []);
      });
    }

    test(`over ${name}, for ${who}, a worker created by an ordinary iframe is ${caller ? 'never delivered to a device' : 'shown as on main'}`, async () => {
      const infos = world({ parentId: 'kid' }, ORDINARY);
      const h = harness(infos, route, caller);
      const host = (await h.send('Target.attachToTarget', { targetId: 'host', flatten: true }))
        .result?.sessionId;
      assert.ok(host, 'an ordinary page attaches');
      const kid = (await h.send('Target.attachToTarget', { targetId: 'kid', flatten: true })).result
        ?.sessionId;
      assert.ok(kid, 'its ordinary iframe attaches');
      await h.send(
        'Target.setAutoAttach',
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: 'worker' }],
        },
        kid
      );
      h.attach('worker~1', 'worker', kid);
      if (caller) {
        await h.settle(() => h.detached('worker~1'), 100);
        assert.ok(!h.shown('worker~1'), 'a device gets no worker session');
        assert.ok(h.detached('worker~1'), 'the device worker session is cut');
        assert.ok(!(await listedIds(h)).includes('worker'));
      } else {
        await h.settle(() => h.shown('worker~1'), 400);
        assert.ok(h.shown('worker~1'), 'a kernel program gets the worker');
        assert.ok(!h.detached('worker~1'), 'and it stays attached');
        const read = await h.send('Runtime.evaluate', { expression: '1' }, 'worker~1');
        assert.equal(read.error, undefined, JSON.stringify(read.error));
      }
    });
  }

  for (const turn of [
    'owner moves onto seven',
    'owner without a session is learned protected late',
  ]) {
    test(`over ${name}, a worker of an iframe that turns protected after the worker was shown is cut too (${turn})`, async () => {
      const infos = world({ parentId: 'kid' }, ORDINARY);
      infos['seven-page'] = { type: 'page', url: SEVEN_PAGE, title: 'seven' };
      const h = harness(infos, route);
      if (turn === 'owner moves onto seven') {
        const host = (await h.send('Target.attachToTarget', { targetId: 'host', flatten: true }))
          .result?.sessionId;
        assert.ok(host, 'the page attaches');
      }
      const kid = (await h.send('Target.attachToTarget', { targetId: 'kid', flatten: true })).result
        ?.sessionId;
      assert.ok(kid, 'its iframe attaches');
      await h.send(
        'Target.setAutoAttach',
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: 'worker' }],
        },
        kid
      );
      h.attach('worker~1', 'worker', kid);
      await h.settle(() => h.shown('worker~1'), 400);
      assert.ok(h.shown('worker~1'), 'the worker is shown while its creator is ordinary');
      assert.equal(
        (await h.send('Runtime.evaluate', { expression: '1' }, 'worker~1')).error,
        undefined
      );
      infos.host = { ...infos.host, url: SEVEN_PAGE };
      h.raw.emit({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: { targetId: 'host', attached: true, ...infos.host } },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const read = await h.send('Runtime.evaluate', { expression: '1' }, 'worker~1');
      assert.ok(read.error, 'the worker session refuses commands once its creator chain turned');
      await h.settle(() => h.detached('worker~1'), 300);
      assert.ok(h.detached('worker~1'), 'the worker session is cut');
      const after = h.got.length;
      h.raw.emit({
        method: 'Runtime.consoleAPICalled',
        sessionId: 'worker~1',
        params: {
          type: 'log',
          args: [{ type: 'string', value: `AFTER-${name}` }],
          executionContextId: 1,
          timestamp: 1,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(!JSON.stringify(h.got.slice(after)).includes(`AFTER-${name}`));
    });
  }
}
