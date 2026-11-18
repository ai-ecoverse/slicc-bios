import assert from 'node:assert/strict';
import { test } from 'node:test';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

const SEVEN = 'https://seven.invalid';
const SEVEN_PAGE = `${SEVEN}/os/`;
const ORDINARY = 'https://ordinary.invalid/page';
const WORKER = 'https://cross.invalid/worker.js';
const OUTER = 'https://cross.invalid/outer.js';
const SECRET = 'worker-secret-body';
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
      const reply = (payload) =>
        queueMicrotask(() =>
          connection.emit({
            id: command.id,
            ...(command.sessionId ? { sessionId: command.sessionId } : {}),
            ...payload,
          })
        );
      if (command.method === 'Page.getFrameTree' && infos[owner]?.type.endsWith('worker'))
        return reply({ error: { code: -32000, message: 'refused by the fake' } });
      const info = (targetId) => ({ targetId, attached: true, ...infos[targetId] });
      switch (command.method) {
        case 'Target.getTargetInfo': {
          const asked = command.params?.targetId ?? owner;
          if (!infos[asked])
            return reply({ error: { code: -32602, message: `no target ${asked}` } });
          return reply({ result: { targetInfo: info(asked) } });
        }
        case 'Target.attachToTarget': {
          sessions += 1;
          const sessionId = `${command.params.targetId}~${sessions}`;
          owners.set(sessionId, command.params.targetId);
          return reply({ result: { sessionId } });
        }
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
          return reply({ result: { result: { type: 'string', value: SECRET } } });
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
    for (let n = 0; n < 600 && !got.some((message) => message.id === mine); n++) await tick();
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
  const attachSent = (targetId) =>
    raw.sent.some(
      (command) =>
        command.method === 'Target.attachToTarget' && command.params?.targetId === targetId
    );
  const evaluated = (targetId) =>
    raw.sent.some(
      (command) =>
        command.method === 'Runtime.evaluate' && raw.owners.get(command.sessionId) === targetId
    );
  const leaked = (...values) => values.filter((value) => JSON.stringify(got).includes(value));
  return { raw, got, send, attach, settle, shown, detached, attachSent, evaluated, leaked };
}

const worlds = {
  'a protected-URL iframe': () => ({
    host: { type: 'page', url: ORDINARY, title: 'Host' },
    seven: { type: 'iframe', url: SEVEN_PAGE, title: 'seven', parentId: 'host' },
    worker: { type: 'worker', url: WORKER, title: 'Worker', parentId: 'seven' },
  }),
  'a protected page': () => ({
    host: { type: 'page', url: ORDINARY, title: 'Host' },
    seven: { type: 'page', url: SEVEN_PAGE, title: 'seven' },
    worker: { type: 'worker', url: WORKER, title: 'Worker', parentId: 'seven' },
  }),
  'a worker of a protected-URL iframe': () => ({
    host: { type: 'page', url: ORDINARY, title: 'Host' },
    seven: { type: 'iframe', url: SEVEN_PAGE, title: 'seven', parentId: 'host' },
    outer: { type: 'worker', url: OUTER, title: 'Outer', parentId: 'seven' },
    worker: { type: 'worker', url: WORKER, title: 'Worker', parentId: 'outer' },
  }),
  'a worker of a protected page': () => ({
    host: { type: 'page', url: ORDINARY, title: 'Host' },
    seven: { type: 'page', url: SEVEN_PAGE, title: 'seven' },
    outer: { type: 'worker', url: OUTER, title: 'Outer', parentId: 'seven' },
    worker: { type: 'worker', url: WORKER, title: 'Worker', parentId: 'outer' },
  }),
};

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link' }],
  ['extension', { kind: 'extension' }],
];
const callers = [
  ['a kernel program', undefined],
  ['a remote device', DEVICE],
];

const listedIds = async (h) =>
  ((await h.send('Target.getTargets')).result?.targetInfos ?? []).map((info) => info.targetId);

async function refusedById(h, label) {
  const info = await h.send('Target.getTargetInfo', { targetId: 'worker' });
  assert.ok(info?.error, `${label}: Target.getTargetInfo of the worker errors`);
  const attached = await h.send('Target.attachToTarget', { targetId: 'worker', flatten: true });
  assert.ok(attached?.error, `${label}: Target.attachToTarget of the worker errors`);
  assert.equal(attached.result, undefined, `${label}: no session is answered`);
  assert.ok(!h.attachSent('worker'), `${label}: Target.attachToTarget never reaches Chrome`);
  assert.ok(!h.attachSent('outer'), `${label}: the creator worker is never attached either`);
  assert.ok(!h.evaluated('worker'), `${label}: no Runtime.evaluate reaches the worker`);
}

for (const [name, route] of routes) {
  for (const [who, caller] of callers) {
    for (const [parent, world] of Object.entries(worlds)) {
      test(`over ${name}, for ${who}, a worker with an ordinary script URL whose parent is ${parent} is not attachable or describable by id`, async () => {
        const h = harness(world(), route, caller);
        await refusedById(h, 'before the ordinary page is attached');
        const host = await h.send('Target.attachToTarget', { targetId: 'host', flatten: true });
        assert.equal(host?.error, undefined, 'the ordinary page attaches');
        await refusedById(h, 'after the ordinary page is attached');
        assert.deepEqual(h.leaked(WORKER, OUTER, SECRET), []);
      });

      test(`over ${name}, for ${who}, a worker with an ordinary script URL whose parent is ${parent} is never listed or discovered`, async () => {
        const infos = world();
        const h = harness(infos, route, caller);
        assert.ok(!(await listedIds(h)).includes('worker'), 'the worker is not listed');
        await h.send('Target.setDiscoverTargets', { discover: true });
        for (const method of ['Target.targetCreated', 'Target.targetInfoChanged'])
          h.raw.emit({
            method,
            params: { targetInfo: { targetId: 'worker', attached: false, ...infos.worker } },
          });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(!(await listedIds(h)).includes('worker'), 'the worker is still not listed');
        assert.deepEqual(h.leaked(WORKER, OUTER, SECRET), []);
      });

      test(`over ${name}, for ${who}, an auto-attached worker with an ordinary script URL whose parent is ${parent} is never shown`, async () => {
        const infos = world();
        const h = harness(infos, route, caller);
        const host = (await h.send('Target.attachToTarget', { targetId: 'host', flatten: true }))
          .result?.sessionId;
        assert.ok(host, 'the ordinary page attaches');
        await h.send(
          'Target.setAutoAttach',
          {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
            filter: [{ type: 'worker' }],
          },
          host
        );
        h.attach('worker~80', 'worker', host);
        h.attach('worker~81', 'worker');
        if (infos.seven.type === 'iframe') {
          h.attach('seven~82', 'seven', host);
          h.attach('worker~83', 'worker', 'seven~82');
        }
        const sessions = [
          'worker~80',
          'worker~81',
          ...(infos.seven.type === 'iframe' ? ['worker~83'] : []),
        ];
        await h.settle(() => sessions.every((session) => h.detached(session)), 300);
        await new Promise((resolve) => setTimeout(resolve, 200));
        for (const session of sessions) {
          assert.ok(!h.shown(session), `${session} is not published`);
          assert.ok(h.detached(session), `${session} is cut`);
          const read = await h.send('Runtime.evaluate', { expression: 'self.secret' }, session);
          assert.ok(read?.error, `${session} refuses Runtime.evaluate`);
        }
        assert.ok(!h.evaluated('worker'), 'no Runtime.evaluate reaches the worker');
        await refusedById(h, 'after the auto-attached sessions were cut');
        assert.deepEqual(h.leaked(WORKER, OUTER, SECRET), []);
      });
    }
  }
}

for (const [name, route] of routes) {
  test(`over ${name}, a worker in a parent cycle is refused`, async () => {
    const h = harness(
      {
        a: { type: 'worker', url: OUTER, title: 'A', parentId: 'worker' },
        worker: { type: 'worker', url: WORKER, title: 'Worker', parentId: 'a' },
      },
      route
    );
    await refusedById(h, 'a cycle');
    assert.ok(!h.attachSent('a'));
    assert.deepEqual(h.leaked(WORKER, SECRET), []);
  });

  test(`over ${name}, a worker at the end of a chain longer than the depth bound is refused`, async () => {
    const infos = { root: { type: 'page', url: ORDINARY, title: 'Root' } };
    let parent = 'root';
    for (let i = 0; i < 70; i++) {
      infos[`w${i}`] = { type: 'worker', url: `${OUTER}?${i}`, title: `W${i}`, parentId: parent };
      parent = `w${i}`;
    }
    infos.worker = { type: 'worker', url: WORKER, title: 'Worker', parentId: parent };
    const h = harness(infos, route);
    await refusedById(h, 'a long chain');
    assert.deepEqual(h.leaked(WORKER, SECRET), []);
  });

  test(`over ${name}, a worker deep in a worker chain under a protected-URL iframe is refused`, async () => {
    const infos = {
      host: { type: 'page', url: ORDINARY, title: 'Host' },
      seven: { type: 'iframe', url: SEVEN_PAGE, title: 'seven', parentId: 'host' },
    };
    let parent = 'seven';
    for (let i = 0; i < 12; i++) {
      infos[`w${i}`] = { type: 'worker', url: `${OUTER}?${i}`, title: `W${i}`, parentId: parent };
      parent = `w${i}`;
    }
    infos.worker = { type: 'worker', url: WORKER, title: 'Worker', parentId: parent };
    const h = harness(infos, route);
    await refusedById(h, 'a deep chain');
    assert.deepEqual(h.leaked(WORKER, SECRET), []);
  });

  test(`over ${name}, a worker of a worker of an ordinary iframe still attaches for a kernel program`, async () => {
    const h = harness(
      {
        host: { type: 'page', url: ORDINARY, title: 'Host' },
        kid: { type: 'iframe', url: 'https://cross.invalid/inner', title: 'Kid', parentId: 'host' },
        outer: { type: 'worker', url: OUTER, title: 'Outer', parentId: 'kid' },
        worker: { type: 'worker', url: WORKER, title: 'Worker', parentId: 'outer' },
      },
      route
    );
    const attached = await h.send('Target.attachToTarget', { targetId: 'worker', flatten: true });
    assert.equal(attached?.error, undefined, JSON.stringify(attached?.error));
    const read = await h.send('Runtime.evaluate', { expression: '1' }, attached.result.sessionId);
    assert.equal(read?.error, undefined, JSON.stringify(read?.error));
  });
}
