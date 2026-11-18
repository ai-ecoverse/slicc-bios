import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExitRouter } from '../../src/seed/exits.js';
import { CONTROL, linkFacade, NO_DECIDE, outbound, record } from '../../src/seed/facade.js';
import { fromThisKernel } from '../../src/seed/leaders.js';
import { answerLink, createLinks } from '../../src/seed/link.js';
import { createRemote, OWN_KERNEL } from '../../src/seed/remote.js';

class FakeChannel extends EventTarget {
  constructor(label, remote) {
    super();
    this.label = label;
    this.remote = remote;
    this.readyState = 'connecting';
    this.binaryType = 'arraybuffer';
    this.bufferedAmount = 0;
  }

  send(data) {
    queueMicrotask(() => this.remote.dispatchEvent(new MessageEvent('message', { data })));
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
    if (this.remote.readyState !== 'closed') this.remote.close();
  }

  open() {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
}

class FakePeer extends EventTarget {
  constructor() {
    super();
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.mate = null;
  }

  pair(other) {
    this.mate = other;
    other.mate = this;
  }

  createDataChannel(label) {
    const local = new FakeChannel(label, null);
    const remote = new FakeChannel(label, local);
    local.remote = remote;
    queueMicrotask(() => {
      this.mate?.dispatchEvent(Object.assign(new Event('datachannel'), { channel: remote }));
      queueMicrotask(() => {
        remote.open();
        local.open();
      });
    });
    return local;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'o' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'a' };
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    this.connectionState = 'connected';
    this.dispatchEvent(new Event('connectionstatechange'));
  }

  async addIceCandidate() {}

  close() {
    this.connectionState = 'closed';
  }
}

const timers = { setTimeout: () => 0, clearTimeout() {} };
const notOwn = (link) => fromThisKernel(link, async () => [OWN]);

const OWN = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);

const item = (id, extra = {}) => ({
  id,
  kind: 'sudo',
  requester: { kind: 'agent', name: 'cone', where: 'cone' },
  detail: { command: 'apt install jq' },
  tier: 'user',
  always: true,
  stoppable: false,
  createdAt: 1,
  expiresAt: 300001,
  ...extra,
});

function refused(code, sentence) {
  return Object.assign(new Error(`${code}: ${sentence}`), { code });
}

function stubAgent() {
  const calls = [];
  const changes = [];
  let wake = null;
  const events = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (!changes.length) await new Promise((resolve) => (wake = resolve));
          const value = changes.shift();
          return value === null ? { value: undefined, done: true } : { value, done: false };
        },
        async return() {
          return { value: undefined, done: true };
        },
      };
    },
  };
  return {
    calls,
    change(next) {
      changes.push(next);
      wake?.();
    },
    control: async () => ({
      async approvals(options) {
        calls.push(['approvals', options]);
        const approvals = [item('a1'), item('a2', { kind: 'guest-tool', later: 'kept' })];
        return options.watch ? { approvals, events } : { approvals };
      },
      async decide(request) {
        calls.push(['decide', request]);
        if (request.id === 'gone') throw refused('ENOENT', 'no approval has that id');
        if (request.answer === 'always')
          throw refused('EINVAL', 'Always allow is not offered for this request.');
        return { ok: true };
      },
    }),
  };
}

async function connect({ mode = 'remote', allowed = () => true, remote, id = null }) {
  const pagePeer = new FakePeer();
  const nodePeer = new FakePeer();
  pagePeer.pair(nodePeer);
  const key = `${mode}-key`;
  const links = createLinks({
    router: createExitRouter(),
    makePeer: () => pagePeer,
    timers,
    agent: { allowed, handle: (link, meta, s) => remote.handle(link, meta, s) },
  });
  const node = answerLink({
    pc: nodePeer,
    send: async (message) => {
      await links.links.get(key)?.offer.receive(message);
    },
    hello: () => ({ name: 'node', mode, caps: [] }),
    timers,
  });
  links.start({ key, mode, send: (message) => void node.receive(message) });
  if (id) links.identify(key, id);
  const session = await node.linked;
  await session.ready;
  await links.links.get(key).offer.session.ready;
  return { session, close: () => links.drop(key, 'done') };
}

async function lines(stream) {
  const out = [];
  let text = '';
  for (let chunk = await stream.read(); chunk; chunk = await stream.read()) {
    text += new TextDecoder().decode(chunk);
    const parts = text.split('\n');
    text = parts.pop();
    out.push(...parts.map((part) => JSON.parse(part)));
  }
  return out;
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error.message === error.code ? error.code : `${error.code}: ${error.message}`;
  }
  assert.fail('the OPEN was answered');
}

test('approvals over the agent cap: the snapshot, then END', async () => {
  const agent = stubAgent();
  const remote = createRemote({ control: agent.control, ownKernel: notOwn });
  const link = await connect({ remote, id: OTHER });
  const stream = await link.session.open({ kind: 'agent', op: 'approvals' });
  assert.deepEqual(stream.info, {
    approvals: [item('a1'), item('a2', { kind: 'guest-tool', later: 'kept' })],
  });
  assert.deepEqual(await lines(stream), []);
  assert.deepEqual(agent.calls, [['approvals', { watch: false }]]);
  link.close();
});

test('approvals with watch sends a whole new snapshot after each change', async () => {
  const agent = stubAgent();
  const remote = createRemote({ control: agent.control, ownKernel: notOwn });
  const link = await connect({ remote, id: OTHER });
  const stream = await link.session.open({ kind: 'agent', op: 'approvals', watch: true });
  assert.equal(stream.info.approvals.length, 2);
  agent.change([item('a2', { kind: 'guest-tool', later: 'kept' })]);
  agent.change({ approvals: [] });
  agent.change(null);
  assert.deepEqual(await lines(stream), [
    { t: 'approvals', approvals: [item('a2', { kind: 'guest-tool', later: 'kept' })] },
    { t: 'approvals', approvals: [] },
  ]);
  assert.deepEqual(agent.calls, [['approvals', { watch: true }]]);
  link.close();
});

test('decide answers { ok: true } then END, with the link as the device', async () => {
  const agent = stubAgent();
  const remote = createRemote({
    control: agent.control,
    ownKernel: (link) => fromThisKernel(link, async () => [OWN]),
  });
  const link = await connect({ remote, id: OTHER });
  const stream = await link.session.open({
    kind: 'agent',
    op: 'decide',
    id: 'a1',
    answer: 'once',
    reason: 'looks fine',
  });
  assert.deepEqual(stream.info, { ok: true });
  assert.deepEqual(await lines(stream), []);
  assert.deepEqual(agent.calls, [
    ['decide', { id: 'a1', answer: 'once', reason: 'looks fine', device: OTHER }],
  ]);
  link.close();
});

test("a refused decide resets with the agent's sentence, exactly", async () => {
  const agent = stubAgent();
  const remote = createRemote({ control: agent.control, ownKernel: notOwn });
  const link = await connect({ remote, id: OTHER });
  const open = (meta) => link.session.open({ kind: 'agent', op: 'decide', ...meta });
  assert.equal(
    await refusal(open({ id: 'a1', answer: 'always' })),
    'EINVAL: Always allow is not offered for this request.'
  );
  assert.equal(
    await refusal(open({ id: 'gone', answer: 'deny' })),
    'ENOENT: no approval has that id'
  );
  assert.equal(await refusal(open({ id: 'a1', answer: 'maybe' })), 'EINVAL');
  assert.equal(await refusal(open({ answer: 'once' })), 'EINVAL');
  assert.equal(await refusal(open({ id: 'a1', answer: 'once', reason: 7 })), 'EINVAL');
  assert.deepEqual(agent.calls, [
    ['decide', { id: 'a1', answer: 'always', device: OTHER }],
    ['decide', { id: 'gone', answer: 'deny', device: OTHER }],
  ]);
  link.close();
});

test('without the Linked devices permission, approvals and decide are EACCES', async () => {
  const agent = stubAgent();
  const remote = createRemote({ control: agent.control, ownKernel: notOwn });
  const link = await connect({ remote, id: OTHER, allowed: () => false });
  for (const meta of [
    { op: 'approvals' },
    { op: 'approvals', watch: true },
    { op: 'decide', id: 'a1', answer: 'once' },
  ])
    assert.equal(await refusal(link.session.open({ kind: 'agent', ...meta })), 'EACCES');
  assert.deepEqual(agent.calls, []);
  link.close();
});

test("decide from a link that is this seven's own kernel is EACCES, and approvals still answer", async () => {
  const agent = stubAgent();
  const remote = createRemote({
    control: agent.control,
    ownKernel: (link) => fromThisKernel(link, async () => [OTHER, OWN]),
  });
  const link = await connect({ remote, id: OWN });
  assert.equal(
    await refusal(link.session.open({ kind: 'agent', op: 'decide', id: 'a1', answer: 'once' })),
    OWN_KERNEL
  );
  const stream = await link.session.open({ kind: 'agent', op: 'approvals' });
  assert.equal(stream.info.approvals.length, 2);
  assert.deepEqual(
    agent.calls.map(([op]) => op),
    ['approvals']
  );
  link.close();
});

test('decide is refused when the own-kernel check itself fails', async () => {
  const agent = stubAgent();
  const remote = createRemote({
    control: agent.control,
    ownKernel: async () => {
      throw new Error('IndexedDB is gone');
    },
  });
  const link = await connect({ remote, id: OTHER });
  assert.equal(
    await refusal(link.session.open({ kind: 'agent', op: 'decide', id: 'a1', answer: 'once' })),
    OWN_KERNEL
  );
  assert.deepEqual(agent.calls, []);
  link.close();
});

test('an agent without approvals answers EOPNOTSUPP for both ops', async () => {
  const remote = createRemote({
    control: async () => ({ prompt() {}, abort() {} }),
    ownKernel: notOwn,
  });
  const link = await connect({ remote, id: OTHER });
  for (const meta of [{ op: 'approvals' }, { op: 'decide', id: 'a1', answer: 'once' }])
    assert.equal(
      await refusal(link.session.open({ kind: 'agent', ...meta })),
      'EOPNOTSUPP: this agent has no approvals'
    );
  link.close();
});

async function throughFacade(open) {
  const asked = [];
  const facade = linkFacade({
    check: async () => null,
    scrub: async (text) => text,
    leaders: {
      open: async (join, meta) => {
        asked.push(meta);
        const stream = {
          info: { approvals: [] },
          read: () => new Promise(() => {}),
          reset: () => undefined,
        };
        return { stream, release: () => undefined };
      },
    },
  });
  const conn = facade({ uid: 0, users: 'enforce' });
  const first = new Promise((resolve) => {
    conn.onmessage = (bytes) => resolve(JSON.parse(new TextDecoder().decode(bytes.subarray(5))));
  });
  conn.send(record(CONTROL, JSON.stringify({ v: 1, join: 'https://hub.test/join/x', open })));
  const answer = await first;
  conn.close();
  return { answer, asked };
}

test("seven's kernel reaches approvals through the link facade, never decide", async () => {
  assert.deepEqual(outbound({ kind: 'agent', op: 'approvals', watch: true, extra: 1 }), {
    kind: 'agent',
    op: 'approvals',
    watch: true,
  });
  assert.deepEqual(outbound({ kind: 'agent', op: 'approvals', watch: 'yes' }), {
    kind: 'agent',
    op: 'approvals',
  });
  assert.equal(outbound({ kind: 'agent', op: 'decide', id: 'a1', answer: 'once' }), null);
  const listed = await throughFacade({ kind: 'agent', op: 'approvals', watch: true });
  assert.deepEqual(listed.answer, { opened: { approvals: [] } });
  assert.deepEqual(listed.asked, [{ kind: 'agent', op: 'approvals', watch: true }]);
  const decided = await throughFacade({ kind: 'agent', op: 'decide', id: 'a1', answer: 'once' });
  assert.deepEqual(decided.answer, { reset: NO_DECIDE });
  assert.deepEqual(decided.asked, []);
});
