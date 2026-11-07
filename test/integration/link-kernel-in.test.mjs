import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExitRouter } from '../../src/seed/exits.js';
import {
  answerLink,
  CONTROL,
  createLinks,
  frame,
  OPEN,
  OPENED,
  parse,
  RESET,
  STREAM,
} from '../../src/seed/link.js';

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

function timers() {
  return {
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
  };
}

function dialSocket() {
  const readable = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  const writable = new WritableStream();
  return {
    readable,
    writable,
    close() {},
  };
}

function streamChannel(pagePeer) {
  return (label) => {
    const local = new FakeChannel(label, null);
    const remote = new FakeChannel(label, local);
    local.remote = remote;
    queueMicrotask(() => {
      pagePeer.dispatchEvent(Object.assign(new Event('datachannel'), { channel: remote }));
      queueMicrotask(() => {
        remote.open();
        local.open();
      });
    });
    return local;
  };
}

async function openKernel(createChannel, meta = { kind: 'kernel', port: 80 }) {
  const channel = createChannel(STREAM);
  await new Promise((resolve) => {
    if (channel.readyState === 'open') resolve();
    else channel.addEventListener('open', resolve, { once: true });
  });
  const id = 2;
  channel.send(frame(OPEN, id, JSON.stringify(meta)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no RESET or OPENED')), 2000);
    channel.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') return;
      const parsed = parse(data);
      if (!parsed || parsed.id !== id) return;
      if (parsed.type === RESET) {
        clearTimeout(timer);
        resolve(new TextDecoder().decode(parsed.payload));
      } else if (parsed.type === OPENED) {
        clearTimeout(timer);
        resolve({ type: OPENED });
      }
    });
  });
}

async function connect(mode, { agent = null, dials = [] } = {}) {
  const pagePeer = new FakePeer();
  const nodePeer = new FakePeer();
  pagePeer.pair(nodePeer);
  const hellos = [];
  const originalCreate = pagePeer.createDataChannel.bind(pagePeer);
  pagePeer.createDataChannel = (label) => {
    const channel = originalCreate(label);
    if (label === CONTROL) {
      const send = channel.send.bind(channel);
      channel.send = (data) => {
        if (typeof data === 'string') hellos.push(JSON.parse(data));
        return send(data);
      };
    }
    return channel;
  };
  const key = mode;
  const links = createLinks({
    router: createExitRouter(),
    makePeer: () => pagePeer,
    timers: timers(),
    kernel: () => ({
      dial: (meta) => {
        dials.push(meta);
        return dialSocket();
      },
    }),
    agent,
  });
  const node = answerLink({
    pc: nodePeer,
    send: async (message) => {
      await links.links.get(key)?.offer.receive(message);
    },
    hello: () => ({
      name: `${mode}-node`,
      host: 'Node',
      mode,
      caps: ['net'],
      routes: { prefixes: [], exit: true },
    }),
    timers: timers(),
  });
  links.start({
    key,
    mode,
    send: (message) => void node.receive(message),
  });
  await node.linked;
  await links.links.get(key).offer.session.ready;
  return {
    links,
    key,
    pageHello: hellos.find((h) => h.role === 'page'),
    dials,
    createChannel: streamChannel(pagePeer),
  };
}

test('a local link HELLO still offers kernel-in, and OPEN { kind: kernel } dials once', async () => {
  const dials = [];
  const { links, key, pageHello, createChannel } = await connect('local', {
    dials,
    agent: { allowed: () => true, handle: () => {} },
  });
  assert.deepEqual(pageHello.caps, ['kernel-in', 'browsers', 'mounts', 'agent']);
  const answer = await openKernel(createChannel);
  assert.deepEqual(answer, { type: OPENED });
  assert.equal(dials.length, 1);
  assert.deepEqual(dials[0], { port: 80 });
  links.drop(key, 'done');
});

test('a remote link HELLO omits kernel-in, and OPEN { kind: kernel } is EACCES without dialing', async () => {
  const dials = [];
  const { links, key, pageHello, createChannel } = await connect('remote', {
    dials,
    agent: { allowed: () => true, handle: () => {} },
  });
  assert.deepEqual(pageHello.caps, ['browsers', 'mounts', 'agent']);
  assert.equal(await openKernel(createChannel), 'EACCES');
  assert.equal(dials.length, 0);
  links.drop(key, 'done');
});

test('a remote link without agent still lists only browsers and mounts', async () => {
  const { links, key, pageHello } = await connect('remote');
  assert.deepEqual(pageHello.caps, ['browsers', 'mounts']);
  links.drop(key, 'done');
});
