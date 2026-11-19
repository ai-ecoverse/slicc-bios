import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExitRouter } from '../../src/seed/exits.js';
import { answerLink, createLinks, WINDOW } from '../../src/seed/link.js';
import { createRemote } from '../../src/seed/remote.js';

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
const OTHER = 'bb'.repeat(32);

function agentConnection(index) {
  const log = [];
  const closed = Promise.withResolvers();
  let latest;
  let wake;
  let ended = false;
  const events = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        while (latest === undefined && !ended) await new Promise((resolve) => (wake = resolve));
        const value = latest;
        latest = undefined;
        return value === undefined ? { done: true, value: undefined } : { done: false, value };
      },
      async return() {
        log.push('return');
        ended = true;
        wake?.();
        return { done: true, value: undefined };
      },
    }),
  };
  return {
    index,
    log,
    closed: closed.promise,
    push(approvals) {
      latest = approvals;
      wake?.();
    },
    api: {
      approvals: async ({ watch }) => ({ approvals: [], ...(watch ? { events } : {}) }),
      close() {
        log.push('close');
        closed.resolve();
      },
    },
  };
}

function stubAgent() {
  const connections = [];
  const opened = [];
  return {
    connections,
    opened(n) {
      opened[n] ??= Promise.withResolvers();
      if (connections[n]) opened[n].resolve(connections[n]);
      return opened[n].promise;
    },
    control: async () => {
      const connection = agentConnection(connections.length);
      connections.push(connection);
      opened[connection.index]?.resolve(connection);
      return connection.api;
    },
  };
}

async function connect(remote) {
  const pagePeer = new FakePeer();
  const nodePeer = new FakePeer();
  pagePeer.pair(nodePeer);
  const key = 'remote-key';
  const links = createLinks({
    router: createExitRouter(),
    makePeer: () => pagePeer,
    timers,
    agent: {
      allowed: () => true,
      handle: (link, meta, s) => remote.handle(link, meta, s),
      identified: (link) => remote.identified(link),
    },
  });
  const node = answerLink({
    pc: nodePeer,
    send: async (message) => {
      await links.links.get(key)?.offer.receive(message);
    },
    hello: () => ({ name: 'node', mode: 'remote', caps: [] }),
    timers,
  });
  links.start({ key, mode: 'remote', send: (message) => void node.receive(message) });
  links.identify(key, OTHER);
  const session = await node.linked;
  await session.ready;
  await links.links.get(key).offer.session.ready;
  return { session, close: () => links.drop(key, 'done') };
}

async function within(promise, ms, what, seen) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`waited ${ms} ms for ${what}; saw ${seen()}`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

const describe = (connection) => JSON.stringify(connection?.log ?? 'no agent connection');

async function readLine(stream, ms, what) {
  const decoder = new TextDecoder();
  let text = '';
  const reading = (async () => {
    while (!text.includes('\n')) {
      const chunk = await stream.read();
      if (chunk === null) throw new Error(`the stream ended before ${what}, after ${text}`);
      text += decoder.decode(chunk, { stream: true });
    }
    return JSON.parse(text.slice(0, text.indexOf('\n')));
  })();
  return within(reading, ms, what, () => JSON.stringify(text));
}

const watchApprovals = (link) => link.session.open({ kind: 'agent', op: 'approvals', watch: true });

test('closing an idle approvals watch returns the agent iterator once and closes its agent connection once', async () => {
  const agent = stubAgent();
  const remote = createRemote({ control: agent.control, ownKernel: async () => false });
  const link = await connect(remote);
  const stream = await watchApprovals(link);
  assert.deepEqual(stream.info, { approvals: [] });
  const connection = await agent.opened(0);
  assert.deepEqual(connection.log, []);
  stream.close();
  await within(connection.closed, 2000, 'the idle watch to close its agent connection', () =>
    describe(connection)
  );
  assert.deepEqual(connection.log, ['return', 'close']);
  assert.equal(agent.connections.length, 1);
  link.close();
});

test('closing one idle approvals watch leaves a second watch on the same link watching', async () => {
  const agent = stubAgent();
  const remote = createRemote({ control: agent.control, ownKernel: async () => false });
  const link = await connect(remote);
  const first = await watchApprovals(link);
  const firstAgent = await agent.opened(0);
  const second = await watchApprovals(link);
  const secondAgent = await agent.opened(1);
  first.close();
  await within(firstAgent.closed, 2000, "the first watch's agent connection to close", () =>
    describe(firstAgent)
  );
  assert.deepEqual(firstAgent.log, ['return', 'close']);
  assert.deepEqual(secondAgent.log, []);
  const item = { id: 'a1', kind: 'sudo' };
  secondAgent.push([item]);
  assert.deepEqual(await readLine(second, 2000, 'the second watch to deliver the next snapshot'), {
    t: 'approvals',
    approvals: [item],
  });
  assert.deepEqual(secondAgent.log, []);
  second.close();
  await within(secondAgent.closed, 2000, "the second watch's agent connection to close", () =>
    describe(secondAgent)
  );
  assert.deepEqual(secondAgent.log, ['return', 'close']);
  assert.deepEqual(firstAgent.log, ['return', 'close']);
  assert.equal(agent.connections.length, 2);
  link.close();
});

test('closing an approvals watch while a snapshot is still being written closes its agent connection once', async () => {
  const agent = stubAgent();
  const remote = createRemote({ control: agent.control, ownKernel: async () => false });
  const link = await connect(remote);
  const stream = await watchApprovals(link);
  const connection = await agent.opened(0);
  connection.push([{ id: 'a1', kind: 'sudo', prompt: 'x'.repeat(WINDOW * 2) }]);
  const first = await within(stream.read(), 2000, 'the first bytes of the large snapshot', () =>
    describe(connection)
  );
  assert.ok(first.length > 0);
  assert.deepEqual(connection.log, []);
  stream.close();
  await within(connection.closed, 2000, 'the in-flight watch to close its agent connection', () =>
    describe(connection)
  );
  assert.deepEqual(connection.log, ['return', 'close']);
  assert.equal(agent.connections.length, 1);
  link.close();
});
