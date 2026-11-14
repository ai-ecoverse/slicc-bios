import assert from 'node:assert/strict';
import { test } from 'node:test';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

const SEVEN = 'https://seven.invalid';
const SEVEN_PAGE = `${SEVEN}/os/`;
const ORDINARY = 'https://ordinary.invalid/page';
const CROSS = 'https://cross.invalid/inner';
const WORKER = 'https://cross.invalid/worker.js';
const SECRET = 'worker-secret-body';
const BOUND = 1000;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chrome(infos) {
  const sent = [];
  const failing = new Set();
  const owners = new Map();
  const slow = [];
  let sessions = 0;
  const own = (sessionId) => owners.get(sessionId) ?? sessionId?.split('~')[0];
  const origin = (url) => (URL.canParse(url) ? new URL(url).origin : '://');
  const connection = {
    sent,
    owners,
    slow,
    failing,
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
          if (!infos[asked] || failing.has(asked))
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
        case 'Runtime.evaluate': {
          const answer = { result: { result: { type: 'string', value: SECRET } } };
          if (command.params?.expression === 'slow') return void slow.push(() => reply(answer));
          return reply(answer);
        }
        default:
          return reply({ result: {} });
      }
    },
  };
  return connection;
}

function harness(infos, route) {
  const raw = chrome(infos);
  const guarded = guardProtected(raw, [SEVEN], new Map(), route);
  const got = [];
  guarded.onmessage = (text) => got.push(JSON.parse(text));
  let id = 0;
  const post = (method, params = {}, sessionId) => {
    id += 1;
    const mine = id;
    guarded.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
    return mine;
  };
  const reply = async (mine) => {
    for (let n = 0; n < 600 && !got.some((message) => message.id === mine); n++) await tick();
    return got.find((message) => message.id === mine);
  };
  const send = (method, params, sessionId) => reply(post(method, params, sessionId));
  const shown = (sessionId) =>
    got.some(
      (message) =>
        message.method === 'Target.attachedToTarget' && message.params?.sessionId === sessionId
    );
  const evaluations = (sessionId) =>
    raw.sent.filter(
      (command) => command.method === 'Runtime.evaluate' && command.sessionId === sessionId
    ).length;
  const reads = (...ids) =>
    raw.sent.filter(
      (command) =>
        command.method === 'Target.getTargetInfo' && ids.includes(command.params?.targetId)
    ).length;
  const consoleEvent = (sessionId, value) =>
    raw.emit({
      method: 'Runtime.consoleAPICalled',
      sessionId,
      params: {
        type: 'log',
        args: [{ type: 'string', value }],
        executionContextId: 1,
        timestamp: 1,
      },
    });
  return { raw, got, post, reply, send, shown, evaluations, reads, consoleEvent };
}

async function shownWorker(route) {
  const infos = {
    host: { type: 'page', url: ORDINARY, title: 'Host' },
    kid: { type: 'iframe', url: CROSS, title: 'Frame', parentId: 'host' },
    worker: { type: 'worker', url: WORKER, title: 'Worker', parentId: 'kid' },
  };
  const h = harness(infos, route);
  const host = (await h.send('Target.attachToTarget', { targetId: 'host', flatten: true })).result
    ?.sessionId;
  assert.ok(host, 'the ordinary page attaches');
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
  h.raw.owners.set('worker~90', 'worker');
  h.raw.emit({
    method: 'Target.attachedToTarget',
    sessionId: kid,
    params: {
      sessionId: 'worker~90',
      targetInfo: { targetId: 'worker', attached: true, ...infos.worker },
      waitingForDebugger: false,
    },
  });
  for (let n = 0; n < 200 && !h.shown('worker~90'); n++) await tick();
  assert.ok(h.shown('worker~90'), 'the worker of an ordinary iframe is shown');
  const enabled = await h.send('Runtime.enable', {}, 'worker~90');
  assert.equal(enabled?.error, undefined, JSON.stringify(enabled?.error));
  const first = await h.send('Runtime.evaluate', { expression: '1' }, 'worker~90');
  assert.equal(first?.error, undefined, JSON.stringify(first?.error));
  return { h, infos, session: 'worker~90', kid };
}

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link' }],
  ['extension', { kind: 'extension' }],
];

for (const [name, route] of routes) {
  for (const moved of ['page', 'iframe']) {
    test(`over ${name}, a shown worker refuses commands once its ${moved} moved onto seven without an event, after the bound`, async () => {
      const { h, infos, session } = await shownWorker(route);
      const id = moved === 'page' ? 'host' : 'kid';
      infos[id] = { ...infos[id], url: SEVEN_PAGE };
      await later(BOUND + 200);
      const read = await h.send('Runtime.evaluate', { expression: 'self.secret' }, session);
      assert.ok(read?.error, 'the command is refused');
      assert.equal(h.evaluations(session), 1, 'the second evaluate never reaches Chrome');
    });

    test(`over ${name}, a shown worker's events stop once its ${moved} moved onto seven without an event, after the bound`, async () => {
      const { h, infos, session } = await shownWorker(route);
      const id = moved === 'page' ? 'host' : 'kid';
      h.consoleEvent(session, `BEFORE-${name}`);
      for (let n = 0; n < 100 && !JSON.stringify(h.got).includes(`BEFORE-${name}`); n++)
        await tick();
      assert.ok(JSON.stringify(h.got).includes(`BEFORE-${name}`), 'events flow while ordinary');
      infos[id] = { ...infos[id], url: SEVEN_PAGE };
      await later(BOUND + 200);
      const after = h.got.length;
      h.consoleEvent(session, `AFTER-${name}`);
      await later(200);
      assert.ok(!JSON.stringify(h.got.slice(after)).includes(`AFTER-${name}`));
    });

    test(`over ${name}, an answer a shown worker gives after its ${moved} moved onto seven without an event is refused`, async () => {
      const { h, infos, session } = await shownWorker(route);
      const mine = h.post('Runtime.evaluate', { expression: 'slow' }, session);
      for (let n = 0; n < 200 && h.raw.slow.length === 0; n++) await tick();
      assert.equal(h.raw.slow.length, 1, 'the evaluate reaches Chrome while the chain is ordinary');
      const id = moved === 'page' ? 'host' : 'kid';
      infos[id] = { ...infos[id], url: SEVEN_PAGE };
      await later(BOUND + 200);
      h.raw.slow[0]();
      const answer = await h.reply(mine);
      assert.ok(answer?.error, 'the answer is refused');
      assert.ok(!JSON.stringify(answer).includes(SECRET));
    });
  }

  test(`over ${name}, a shown worker refuses commands once a re-read of its creator chain fails, after the bound`, async () => {
    const { h, infos, session } = await shownWorker(route);
    delete infos.host;
    await later(BOUND + 200);
    const read = await h.send('Runtime.evaluate', { expression: 'self.secret' }, session);
    assert.ok(read?.error, 'the command is refused');
    assert.equal(h.evaluations(session), 1, 'the second evaluate never reaches Chrome');
    const reads = h.reads('host');
    await h.send('Runtime.evaluate', { expression: 'self.secret' }, session);
    assert.ok(h.reads('host') - reads <= 1, 'a failed read is not repeated within the bound');
  });

  const reattach = async (h, infos, kid, sessionId) => {
    h.raw.owners.set(sessionId, 'worker');
    h.raw.emit({
      method: 'Target.attachedToTarget',
      sessionId: kid,
      params: {
        sessionId,
        targetInfo: { targetId: 'worker', attached: true, ...infos.worker },
        waitingForDebugger: false,
      },
    });
    await later(300);
    const read = await h.send('Runtime.evaluate', { expression: 'self.secret' }, sessionId);
    return { shown: h.shown(sessionId), read, evaluated: h.evaluations(sessionId) };
  };

  test(`over ${name}, a worker cut for a failed creator read stays cut when it attaches again after its page moved onto seven`, async () => {
    const { h, infos, session, kid } = await shownWorker(route);
    h.raw.failing.add('host');
    const mark = h.got.length;
    await later(BOUND + 200);
    const refused = await h.send('Runtime.evaluate', { expression: 'self.secret' }, session);
    assert.ok(refused?.error, 'the command is refused while the read fails');
    h.raw.failing.delete('host');
    infos.host = { ...infos.host, url: SEVEN_PAGE };
    const again = await reattach(h, infos, kid, 'worker~91');
    assert.ok(!again.shown, 'the second attachment is not published');
    assert.ok(again.read?.error, 'its command is refused');
    assert.equal(again.evaluated, 0, 'no Runtime.evaluate reaches the worker');
    assert.ok(
      !JSON.stringify(h.got.slice(mark)).includes(SECRET),
      'nothing of the worker reaches the client'
    );
  });

  test(`over ${name}, a worker whose creator read keeps failing is refused on every attach without a read storm`, async () => {
    const { h, infos, session, kid } = await shownWorker(route);
    h.raw.failing.add('host');
    const mark = h.got.length;
    await later(BOUND + 200);
    const before = h.reads('host');
    const refused = await h.send('Runtime.evaluate', { expression: 'self.secret' }, session);
    assert.ok(refused?.error, 'the command is refused while the read fails');
    const start = Date.now();
    for (let i = 0; i < 4; i++) {
      const again = await reattach(h, infos, kid, `worker~${92 + i}`);
      assert.ok(!again.shown, `attachment ${i} is not published`);
      assert.ok(again.read?.error, `attachment ${i} refuses its command`);
      assert.equal(again.evaluated, 0, `attachment ${i} gets no Runtime.evaluate`);
    }
    const windows = Math.ceil((Date.now() - start) / BOUND) + 1;
    assert.ok(
      h.reads('host') - before <= windows,
      `at most one failing read per bound, got ${h.reads('host') - before}`
    );
    assert.ok(!JSON.stringify(h.got.slice(mark)).includes(SECRET));
  });

  test(`over ${name}, a burst of worker events reads the creator chain at most once per bound`, async () => {
    const { h, session } = await shownWorker(route);
    await later(BOUND + 200);
    const before = h.reads('host', 'kid');
    const start = Date.now();
    for (let i = 0; i < 200; i++) h.consoleEvent(session, `burst-${i}`);
    for (let n = 0; n < 400 && !JSON.stringify(h.got).includes('burst-199'); n++) await tick();
    assert.ok(JSON.stringify(h.got).includes('burst-199'), 'an ordinary worker keeps its events');
    const windows = Math.ceil((Date.now() - start) / BOUND) + 1;
    assert.ok(
      h.reads('host', 'kid') - before <= 2 * windows,
      `at most one read per chain target per bound, got ${h.reads('host', 'kid') - before}`
    );
  });
}
