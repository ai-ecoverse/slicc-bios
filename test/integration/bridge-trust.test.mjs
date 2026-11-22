import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { flush, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

globalThis.location ??= { origin: 'https://seven.sliccy.ai' };

const SEED = new URL('../../src/seed/', import.meta.url);
const PREVIEW = 'https://0f3c00000000000000000000000000aa--a91e0000000000000000.sliccy.now/';
const ORIGIN = new URL(PREVIEW).origin;
const SEVEN = 'https://seven.sliccy.ai';
const HOOK_A = 'serve-0123456789abcdef';
const HOOK_B = 'serve-fedcba9876543210';

const MUTANTS = {
  unauthenticated: [
    'bridge.js',
    'if (!conn || known || !preview) return;',
    'if (!conn || known) return;',
  ],
  token: ['bridge.js', 'const live = tab?.token === token;', 'const live = Boolean(tab);'],
  gone: [
    'bridge.js',
    '    if (!preview) {\n      this.warn(',
    '    if (!live) {\n      this.warn(',
  ],
  name: [
    'bridge-cdp.js',
    'return claim(name, NAME_CHARS);',
    "return [...name].slice(0, NAME_CHARS).join('');",
  ],
  webhook: ['bridge.js', 'if (preview.webhook !== message.webhookId) return true;', ''],
  attribution: [
    'bridge.js',
    'const preview = live ? this.previews.get(tab.token) : undefined;',
    'const preview = this.previews.get(token);',
  ],
  unheld: ['tray.js', " || WEBHOOK.test(message?.webhookId ?? '')", ''],
  oversize: ['bridge.js', '...bounded(body.detail)', 'detail: body.detail ?? null'],
  answer: ['bridge.js', " || text(message, 'connId') !== call.conn", ''],
  reply: ['bridge.js', 'bytesOf(size) > REPLY_BYTES', 'false'],
  target: [
    'bridge.js',
    'find(([conn, tab]) => targetId(tab, conn) === target)',
    "find(() => target.startsWith('preview:'))",
  ],
  handle: ['bridge-cdp.js', 'Number(found[1]) === world', 'true'],
  browser: [
    'bridge.js',
    "'Target.createTarget': () => refusal(-32000, NO_BROWSER),",
    "'Target.createTarget': () => ok({ targetId: 'opened' }),",
  ],
  duplicate: [
    'bridge.js',
    'if (!conn || known || !preview) return;',
    'if (!conn || !preview) return;',
  ],
  replay: ['bridge.js', '    if (replay) return;\n', ''],
  stale: ['bridge.js', 'for (const tab of this.tabs.values()) tab.stale = true;', ''],
  relinked: [
    'bridge.js',
    'if (known?.token === token) known.stale = false;',
    'if (known) known.stale = false;',
  ],
  url: ['bridge.js', 'if (URL.parse(url)?.origin !== tab.origin) return;', ''],
  origin: ['bridge.js', 'origin: originOf(preview.url),', "origin: text(message, 'origin'),"],
  claims: ['bridge.js', 'from: originOf(message.origin),', "from: text(message, 'origin'),"],
  title: ['bridge.js', 'tab.title = plain(title);', 'tab.title = title;'],
  resolved: [
    'bridge.js',
    'outcome.result?.result?.objectId ?? outcome.result?.object?.objectId',
    'outcome.result?.result?.objectId',
  ],
  accessors: [
    'bridge-cdp.js',
    'const accessors = params.accessorPropertiesOnly === true;',
    'const accessors = false;',
  ],
  getter: [
    'bridge-cdp.js',
    'if (d.get !== undefined) p.get = desc(d.get);',
    'p.value = desc(o[name]);',
  ],
  scope: [
    'bridge-cdp.js',
    'const f = (0, eval)(${literal(`(${declaration})`)});',
    'const f = (${declaration});',
  ],
};

registerHooks({
  resolve(specifier, context, next) {
    const mutant = context.parentURL && URL.parse(context.parentURL)?.searchParams.get('mutant');
    const resolved = next(specifier, context);
    if (!mutant || !specifier.startsWith('./') || MUTANTS[mutant][0] !== specifier.slice(2))
      return resolved;
    return { ...resolved, url: `${resolved.url}?mutant=${mutant}` };
  },
  load(url, context, next) {
    const mutant = URL.parse(url)?.searchParams.get('mutant');
    const loaded = next(url, context);
    if (!mutant) return loaded;
    const [file, from, to] = MUTANTS[mutant];
    const source = String(loaded.source);
    if (!url.split('?')[0].endsWith(`/${file}`)) return loaded;
    assert.ok(source.includes(from), `mutant ${mutant}: ${from} is not in the source`);
    return { ...loaded, source: source.replace(from, to) };
  },
});

const load = (file, mutant) =>
  import(`${new URL(file, SEED).href}${mutant ? `?mutant=${mutant}` : ''}`);

class Node {
  constructor(name) {
    this.nodeType = 1;
    this.nodeName = name.toUpperCase();
    this.localName = name;
    this.childNodes = [];
    this.attributes = [];
  }
}

function visitorPage({ href = PREVIEW, title = 'Shop' } = {}) {
  const context = createContext({
    Node,
    button: new Node('button'),
    Map,
    WeakMap,
    Symbol,
    String,
    Number,
    Object,
    Array,
    Error,
    BigInt,
    JSON,
    Promise,
    Reflect,
    location: { href },
    document: { title },
  });
  context.globalThis = context;
  return async (expression) => {
    try {
      const value = await runInContext(expression, context);
      return { result: { type: typeof value, value } };
    } catch (error) {
      return {
        exceptionDetails: { text: String(error), exception: { description: String(error) } },
      };
    }
  };
}

async function hub(mutant, { pages = {} } = {}) {
  const { Bridge } = await load('bridge.js', mutant);
  const sent = [];
  const delivered = [];
  const warned = [];
  const timers = [];
  const seen = { c1: [], c2: [] };
  const hold = new Set();
  const bridge = new Bridge({
    send: (message) => {
      sent.push(message);
      if (message.type === 'bridge.cdp.request') {
        seen[message.connId]?.push(message.method);
        if (!hold.has(message.connId)) void answer(message);
      }
      return true;
    },
    deliver: async (name, delivery) => {
      delivered.push([name, delivery]);
      return { delivered: true };
    },
    timers: {
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      clearTimeout() {},
    },
    warn: (line) => warned.push(line),
  });
  const runs = { c1: pages.c1 ?? visitorPage(), c2: pages.c2 ?? visitorPage({ title: 'Other' }) };
  async function answer(message) {
    await Promise.resolve();
    const result =
      message.method === 'Runtime.evaluate'
        ? { result: await runs[message.connId](message.params.expression) }
        : { error: { code: -32601, message: `no ${message.method}` } };
    bridge.control.responded({
      type: 'bridge.cdp.response',
      connId: message.connId,
      id: message.id,
      ...result,
    });
  }
  const a = bridge.add({ token: 'A', url: PREVIEW, title: '/home/a', webhook: HOOK_A, uid: 0 });
  const b = bridge.add({ token: 'B', url: PREVIEW, title: '/home/b', webhook: HOOK_B, uid: 0 });
  const connect = (connId, previewToken, extra = {}) =>
    bridge.control.connected({
      type: 'bridge.connected',
      connId,
      previewToken,
      origin: ORIGIN,
      userAgent: 'UA',
      connectedAt: 'now',
      ...extra,
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { bridge, sent, delivered, warned, timers, seen, hold, a, b, connect, settle };
}

function client(connection) {
  const got = [];
  connection.onmessage = (text) => got.push(JSON.parse(text));
  let id = 0;
  const answered = async (n) => {
    for (let i = 0; i < 400; i += 1) {
      const found = got.find((m) => m.id === n);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  };
  return {
    got,
    answered,
    async call(method, params = {}, sessionId) {
      id += 1;
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return answered(id);
    },
  };
}

const emit = (webhookId, headers, name = 'bought') => ({
  type: 'webhook.event',
  webhookId,
  headers,
  body: { name, detail: { n: 1 } },
});

const ROWS = {
  token: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    await h.settle();
    h.delivered.length = 0;
    assert.equal(h.bridge.control.emitted(emit(HOOK_A, { 'x-slicc-preview-conn': 'c1' })), true);
    assert.equal(
      h.bridge.control.emitted(
        emit(HOOK_A, { 'x-slicc-preview-token': 'Z', 'x-slicc-preview-conn': 'c1' })
      ),
      true
    );
    await h.settle();
    assert.deepEqual(h.delivered, [], 'an emit without the preview token is never delivered');
    assert.deepEqual(
      h.bridge.logs('A', 0).filter((r) => r.event === 'emit'),
      []
    );
  },
  webhook: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    h.connect('c2', 'B');
    await h.settle();
    h.delivered.length = 0;
    h.bridge.control.emitted(
      emit(HOOK_A, { 'x-slicc-preview-token': 'B', 'x-slicc-preview-conn': 'c2' })
    );
    await h.settle();
    assert.deepEqual(
      h.delivered,
      [],
      "preview A's emit carrying B's token reaches neither webhook"
    );
    assert.deepEqual(
      h.bridge.logs('B', 0).filter((r) => r.event === 'emit'),
      []
    );
  },
  unheld: async (mutant) => {
    const { createTray } = await load('tray.js', mutant);
    const webhooks = [];
    let socket;
    class Socket {
      constructor() {
        this.readyState = 1;
        this.listeners = [];
        socket = this;
      }
      addEventListener(type, fn) {
        if (type === 'message') this.listeners.push(fn);
      }
      send() {}
      close() {}
    }
    const fetcher = async (url) =>
      new URL(url).pathname === '/tray'
        ? Response.json({
            trayId: 't1',
            capabilities: {
              controller: { url: 'https://hub.test/controller/c1' },
              join: { url: 'https://hub.test/join/j1' },
            },
          })
        : Response.json({ role: 'leader', websocket: { url: 'https://hub.test/ws' } });
    const storage = new Map();
    const tray = createTray({
      links: { links: new Map(), on() {} },
      origin: 'https://hub.test',
      fetch: fetcher,
      WebSocket: Socket,
      storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
      timers: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} },
      onWebhook: async (name) => webhooks.push(name),
      previews: () => null,
    });
    tray.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const say = (message) => {
      for (const fn of socket.listeners) fn({ data: JSON.stringify(message) });
    };
    say(emit(HOOK_A, { 'x-slicc-preview-token': 'A' }));
    say(emit('deploy', {}));
    await new Promise((resolve) => setTimeout(resolve, 20));
    tray.stop();
    assert.deepEqual(
      webhooks,
      ['deploy'],
      'a serve-<hex> webhook seven holds no preview for is dropped'
    );
  },
  attribution: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    h.connect('c2', 'B');
    await h.settle();
    h.delivered.length = 0;
    for (const conn of ['c2', 'c9', ''])
      h.bridge.control.emitted(
        emit(HOOK_A, { 'x-slicc-preview-token': 'A', 'x-slicc-preview-conn': conn })
      );
    await h.settle();
    assert.deepEqual(
      h.delivered,
      [],
      "an emit carrying another visitor's or no live connection is dropped"
    );
    assert.deepEqual(
      h.bridge.logs('A', 0).filter((r) => r.event === 'emit'),
      []
    );
    assert.equal(
      h.warned.filter((line) => line.includes("from a connection seven doesn't hold")).length,
      3
    );
  },
  oversize: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    await h.settle();
    h.delivered.length = 0;
    let deep = 'end';
    for (let n = 0; n < 5000; n += 1) deep = { a: deep };
    for (const detail of ['x'.repeat(100 * 1024), deep])
      h.bridge.control.emitted({
        ...emit(HOOK_A, { 'x-slicc-preview-token': 'A', 'x-slicc-preview-conn': 'c1' }),
        body: { name: 'n'.repeat(5000), detail },
      });
    await h.settle();
    assert.equal(h.delivered.length, 2);
    for (const [, delivery] of h.delivered) {
      const body = JSON.parse(delivery.body);
      assert.equal(body.truncated, true, 'an oversize detail is marked truncated');
      assert.ok(Buffer.byteLength(delivery.body) <= 17 * 1024, 'the webhook body stays bounded');
      assert.equal(body.name.length, 200);
    }
  },
  gone: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    await h.settle();
    h.delivered.length = 0;
    h.bridge.previews.delete('A');
    const headers = { 'x-slicc-preview-token': 'A', 'x-slicc-preview-conn': 'c1' };
    assert.doesNotThrow(() => h.bridge.control.emitted(emit(HOOK_A, headers)));
    await h.settle();
    assert.deepEqual(h.delivered, [], "a lingering tab whose preview is gone can't emit");
    assert.ok(h.warned.some((line) => line.includes("from a connection seven doesn't hold")));
  },
  name: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    await h.settle();
    h.delivered.length = 0;
    const headers = { 'x-slicc-preview-token': 'A', 'x-slicc-preview-conn': 'c1' };
    h.bridge.control.emitted(emit(HOOK_A, headers, 'buy\u001b[2J\u009b31m\nnow\r'));
    await h.settle();
    const { name } = JSON.parse(h.delivered[0][1].body);
    assert.doesNotMatch(
      name,
      /[\u0000-\u001f\u007f-\u009f]/,
      'an emit name arrives without control characters'
    );
    assert.equal(h.bridge.logs('A', 0).at(-1).name, name);
  },
  answer: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    h.connect('c2', 'A');
    await h.settle();
    h.hold.add('c2');
    const cdp = client(h.bridge.connection());
    const { sessionId } = (
      await cdp.call('Target.attachToTarget', { targetId: 'preview:A:c2', flatten: true })
    ).result;
    const pending = cdp.call(
      'Runtime.evaluate',
      { expression: 'document.title', returnByValue: true },
      sessionId
    );
    await h.settle();
    const request = h.sent.findLast((m) => m.type === 'bridge.cdp.request' && m.connId === 'c2');
    h.bridge.control.responded({
      type: 'bridge.cdp.response',
      connId: 'c1',
      id: request.id,
      result: {
        result: { type: 'string', value: JSON.stringify({ t: 'string', v: 'forged by c1' }) },
      },
    });
    h.bridge.control.responded({
      type: 'bridge.cdp.response',
      connId: 'c2',
      id: request.id,
      result: { result: { type: 'string', value: JSON.stringify({ t: 'string', v: 'Other' }) } },
    });
    assert.equal((await pending).result.result.value, 'Other', "c1 can't answer c2's call");
  },
  reply: async (mutant) => {
    const huge = async () => ({
      result: {
        type: 'string',
        value: JSON.stringify({ t: 'string', v: 'x'.repeat(26 * 1024 * 1024) }),
      },
    });
    const h = await hub(mutant, { pages: { c1: huge } });
    h.connect('c1', 'A');
    await h.settle();
    const cdp = client(h.bridge.connection());
    const { sessionId } = (
      await cdp.call('Target.attachToTarget', { targetId: 'preview:A:c1', flatten: true })
    ).result;
    const answer = await cdp.call(
      'Runtime.evaluate',
      { expression: '1', returnByValue: true },
      sessionId
    );
    assert.match(answer.error?.message ?? '', /over 25 MiB, so seven refused it/);
  },
  handle: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    h.connect('c2', 'A');
    await h.settle();
    const cdp = client(h.bridge.connection());
    const one = (
      await cdp.call('Target.attachToTarget', { targetId: 'preview:A:c1', flatten: true })
    ).result.sessionId;
    const two = (
      await cdp.call('Target.attachToTarget', { targetId: 'preview:A:c2', flatten: true })
    ).result.sessionId;
    await cdp.call('Runtime.evaluate', { expression: 'document' }, two);
    const held = (await cdp.call('Runtime.evaluate', { expression: 'document' }, one)).result.result
      .objectId;
    assert.match(held, /^7\.\d+\.\d+$/);
    const crossed = await cdp.call(
      'Runtime.callFunctionOn',
      {
        objectId: held,
        functionDeclaration: 'function () { return this.title; }',
        returnByValue: true,
      },
      two
    );
    assert.equal(
      crossed.error?.message,
      "the object is gone from the visitor's page (it navigated, or the handle was released)",
      "a handle of another visitor's tab is refused"
    );
  },
  browser: async (mutant) => {
    const h = await hub(mutant);
    const cdp = client(h.bridge.connection());
    const answer = await cdp.call('Target.createTarget', { url: PREVIEW });
    assert.equal(
      answer.error?.message,
      "a preview bridge can't open or close the visitor's browser"
    );
  },
  resolved: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    await h.settle();
    const cdp = client(h.bridge.connection());
    const { sessionId } = (
      await cdp.call('Target.attachToTarget', { targetId: 'preview:A:c1', flatten: true })
    ).result;
    const held = (await cdp.call('Runtime.evaluate', { expression: 'button' }, sessionId)).result
      .result.objectId;
    const { backendNodeId } = (await cdp.call('DOM.describeNode', { objectId: held }, sessionId))
      .result.node;
    const resolved = await cdp.call(
      'DOM.resolveNode',
      { backendNodeId, objectGroup: 'g' },
      sessionId
    );
    const handle = resolved.result.object.objectId;
    const name = () =>
      cdp.call(
        'Runtime.callFunctionOn',
        {
          objectId: handle,
          functionDeclaration: 'function () { return this.localName; }',
          returnByValue: true,
        },
        sessionId
      );
    await cdp.call('Runtime.releaseObjectGroup', { objectGroup: 'other' }, sessionId);
    await h.settle();
    assert.equal(
      (await name()).result?.result?.value,
      'button',
      "another group's release keeps the node"
    );
    await cdp.call('Runtime.releaseObjectGroup', { objectGroup: 'g' }, sessionId);
    await h.settle();
    assert.equal(
      (await name()).error?.message,
      "the object is gone from the visitor's page (it navigated, or the handle was released)",
      "releasing its group releases a resolved node's handle"
    );
  },
  accessors: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    await h.settle();
    const cdp = client(h.bridge.connection());
    const { sessionId } = (
      await cdp.call('Target.attachToTarget', { targetId: 'preview:A:c1', flatten: true })
    ).result;
    const made = await cdp.call(
      'Runtime.evaluate',
      {
        expression:
          '(globalThis.reads = 0, { get total() { globalThis.reads += 1; return 42; }, n: 1 })',
      },
      sessionId
    );
    const listed = await cdp.call(
      'Runtime.getProperties',
      { objectId: made.result.result.objectId, ownProperties: true, accessorPropertiesOnly: true },
      sessionId
    );
    const props = listed.result.result;
    assert.deepEqual(
      props.map((p) => p.name),
      ['total'],
      'only accessor properties are listed'
    );
    assert.deepEqual([props[0].get?.type, 'value' in props[0]], ['function', false]);
    const reads = await cdp.call(
      'Runtime.evaluate',
      { expression: 'globalThis.reads', returnByValue: true },
      sessionId
    );
    assert.equal(reads.result.result.value, 0, 'never run');
  },
  getter: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    await h.settle();
    const cdp = client(h.bridge.connection());
    const { sessionId } = (
      await cdp.call('Target.attachToTarget', { targetId: 'preview:A:c1', flatten: true })
    ).result;
    const made = await cdp.call(
      'Runtime.evaluate',
      {
        expression:
          '(globalThis.reads = 0, { get total() { globalThis.reads += 1; return 42; }, n: 1 })',
      },
      sessionId
    );
    const listed = await cdp.call(
      'Runtime.getProperties',
      { objectId: made.result.result.objectId, ownProperties: true },
      sessionId
    );
    const total = listed.result.result.find((p) => p.name === 'total');
    assert.equal(total.get?.type, 'function');
    const reads = await cdp.call(
      'Runtime.evaluate',
      { expression: 'globalThis.reads', returnByValue: true },
      sessionId
    );
    assert.equal(
      reads.result.result.value,
      0,
      'listing properties never runs a getter in the visitor page'
    );
  },
  scope: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    await h.settle();
    const cdp = client(h.bridge.connection());
    const { sessionId } = (
      await cdp.call('Target.attachToTarget', { targetId: 'preview:A:c1', flatten: true })
    ).result;
    const answer = await cdp.call(
      'Runtime.callFunctionOn',
      {
        functionDeclaration: 'function () { return [typeof R, typeof keep, typeof args].join(); }',
        returnByValue: true,
      },
      sessionId
    );
    assert.equal(
      answer.result.result.value,
      'undefined,undefined,undefined',
      "a called function doesn't see the bridge's own names"
    );
  },
  target: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    await h.settle();
    const cdp = client(h.bridge.connection());
    for (const targetId of ['preview:B:c1', 'preview:A:c1x', 'preview:A:', 'preview:A:c2'])
      assert.equal(
        (await cdp.call('Target.attachToTarget', { targetId, flatten: true })).error?.code,
        -32602,
        `${targetId} is forged`
      );
    assert.ok(
      (await cdp.call('Target.attachToTarget', { targetId: 'preview:A:c1', flatten: true })).result
        .sessionId
    );
  },
  unauthenticated: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'Z');
    await h.settle();
    const cdp = client(h.bridge.connection());
    assert.deepEqual(
      (await cdp.call('Target.getTargets')).result.targetInfos,
      [],
      'an unknown preview token opens no target'
    );
    assert.deepEqual(h.delivered, []);
  },
  duplicate: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    await h.settle();
    h.connect('c1', 'A', { origin: SEVEN });
    await h.settle();
    assert.equal(h.bridge.logs('A', 0).filter((r) => r.event === 'connected').length, 1);
    assert.equal(
      h.delivered.length,
      1,
      'a second connected for the same connection is no new visit'
    );
  },
  replay: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A', { replay: true });
    await h.settle();
    assert.deepEqual(h.bridge.logs('A', 0), [], 'a replayed tab is not recorded');
    assert.deepEqual(h.delivered, [], 'a replayed tab is not announced');
    const cdp = client(h.bridge.connection());
    assert.equal((await cdp.call('Target.getTargets')).result.targetInfos.length, 1);
  },
  stale: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    h.connect('c2', 'A');
    await h.settle();
    h.bridge.control.relinked();
    h.connect('c1', 'A', { replay: true });
    h.timers.find((timer) => timer.ms === 3000).fn();
    const cdp = client(h.bridge.connection());
    const ids = (await cdp.call('Target.getTargets')).result.targetInfos.map((t) => t.targetId);
    assert.deepEqual(
      ids,
      ['preview:A:c1'],
      'a tab the hub did not replay is gone after the relink'
    );
    const gone = h.bridge.logs('A', 0).filter((r) => r.event === 'disconnected');
    assert.deepEqual(
      gone.map((r) => r.connId),
      ['c2']
    );
  },
  relinked: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A');
    await h.settle();
    h.bridge.control.relinked();
    h.connect('c1', 'B', { replay: true });
    h.timers.find((timer) => timer.ms === 3000).fn();
    const cdp = client(h.bridge.connection());
    assert.deepEqual(
      (await cdp.call('Target.getTargets')).result.targetInfos,
      [],
      "a replay under another preview's token doesn't keep the tab"
    );
  },
  url: async (mutant) => {
    const claimed = [
      `${SEVEN}/os/`,
      'https://vault.sliccy.ai/',
      'chrome://settings/',
      'javascript:alert(1)',
      `${ORIGIN}.evil.test/`,
    ];
    for (const href of claimed) {
      const h = await hub(mutant, { pages: { c1: visitorPage({ href }) } });
      h.connect('c1', 'A');
      await h.settle();
      const cdp = client(h.bridge.connection());
      const [info] = (await cdp.call('Target.getTargets')).result.targetInfos;
      assert.deepEqual(
        [info.url, info.browserContextId],
        [PREVIEW, 'preview'],
        `${href} is not the target's URL`
      );
    }
  },
  claims: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A', {
      origin: 'chrome-extension://abc\u001b[2J',
      userAgent: `UA\u001b[2J${'u'.repeat(900)}`,
    });
    await h.settle();
    const [record] = h.bridge.logs('A', 0);
    assert.equal(record.origin, 'about:invalid', 'a privileged scheme is not an origin');
    assert.doesNotMatch(record.userAgent, /\u001b/);
    assert.equal([...record.userAgent].length, 512);
    assert.equal(JSON.parse(h.delivered[0][1].body).origin, 'about:invalid');
  },
  origin: async (mutant) => {
    const h = await hub(mutant);
    h.connect('c1', 'A', { origin: SEVEN });
    await h.settle();
    const cdp = client(h.bridge.connection());
    const { sessionId } = (
      await cdp.call('Target.attachToTarget', { targetId: 'preview:A:c1', flatten: true })
    ).result;
    await cdp.call('Runtime.enable', {}, sessionId);
    const tree = (await cdp.call('Page.getFrameTree', {}, sessionId)).result.frameTree.frame;
    const context = cdp.got.find((m) => m.method === 'Runtime.executionContextCreated').params
      .context;
    assert.deepEqual(
      [tree.securityOrigin, context.origin],
      [ORIGIN, ORIGIN],
      'a claimed origin is never the target'
    );
    assert.equal(h.bridge.logs('A', 0)[0].origin, SEVEN, 'the record keeps what the hub said');
  },
  title: async (mutant) => {
    const injected = `Shop\n1: [preview:B:c9] ${SEVEN}/ "vault"\u001b[2J${'x'.repeat(400)}`;
    const h = await hub(mutant, { pages: { c1: visitorPage({ title: injected }) } });
    h.connect('c1', 'A');
    await h.settle();
    const cdp = client(h.bridge.connection());
    const [info] = (await cdp.call('Target.getTargets')).result.targetInfos;
    assert.doesNotMatch(
      info.title,
      /[\u0000-\u001f\u007f-\u009f]/,
      'no control characters in a title'
    );
    assert.equal([...info.title].length, 200);
    assert.ok(info.title.startsWith('Shop 1: [preview:B:c9]'));
  },
};

for (const [name, row] of Object.entries(ROWS)) {
  test(`bridge trust row: ${name}`, () => row(null));
  test(`bridge trust mutant: without the ${name} check, its row fails`, async () => {
    await assert.rejects(
      row(name),
      (error) => !String(error?.message).includes('is not in the source'),
      `the ${name} row passes without its check`
    );
  });
}

async function guarded() {
  const { guardProtected } = await load('guard.js');
  const { PREVIEW_ROUTE } = await load('bridge-cdp.js');
  const h = await hub(null);
  h.connect('c1', 'A');
  await h.settle();
  const cdp = client(
    guardProtected(h.bridge.connection(), [SEVEN], new Map(), PREVIEW_ROUTE, undefined, {
      kind: 'kernel',
      stamp: { uid: 0 },
    })
  );
  const attached = await cdp.call('Target.attachToTarget', {
    targetId: 'preview:A:c1',
    flatten: true,
  });
  const { sessionId } = attached.result;
  return { h, cdp, sessionId };
}

const REFUSED = [
  ['Target.sendMessageToTarget', { message: '{}', targetId: 'preview:A:c1' }, false],
  ['Target.attachToTarget', { targetId: 'preview:A:c1' }, false],
  ['Page.addScriptToEvaluateOnNewDocument', { source: 'window.x = 1' }, true],
  ['Emulation.setUserAgentOverride', { userAgent: 'x' }, true],
  ['Network.setRequestInterception', { patterns: [] }, true],
  ['Network.setExtraHTTPHeaders', { headers: { a: 'b' } }, true],
  ['Page.navigate', { url: `${SEVEN}/os/` }, true],
  ['Debugger.enable', {}, true],
  ['Target.createTarget', { url: PREVIEW }, false],
];

test('the preview route: the guard refuses what it refuses on the DevTools port, before the visitor sees it', async () => {
  const { h, cdp, sessionId } = await guarded();
  const version = await cdp.call('Browser.getVersion');
  assert.deepEqual(version.result.slicc, { route: 'preview' });
  for (const [method, params, session] of REFUSED) {
    const before = h.seen.c1.length;
    const answer = await cdp.call(method, params, session ? sessionId : undefined);
    assert.ok(answer?.error, `${method} is refused`);
    assert.ok(!h.seen.c1.slice(before).includes(method), `${method} never reaches the visitor`);
  }
  const cookies = await cdp.call('Network.getAllCookies', {}, sessionId);
  assert.deepEqual(cookies.result.cookies, []);
  assert.ok(!h.seen.c1.includes('Network.getAllCookies'));
  const title = await cdp.call(
    'Runtime.evaluate',
    { expression: 'document.title', returnByValue: true },
    sessionId
  );
  assert.equal(title.result.result.value, 'Shop', 'an ordinary visitor tab stays drivable');
});

test('the preview route: a visitor claiming a protected origin and URL changes nothing for real targets, at most cuts its own session, and is listed as a preview', async (t) => {
  const { guardProtected } = await load('guard.js');
  const { joined } = await load('bridge.js');
  const { PREVIEW_ROUTE } = await load('bridge-cdp.js');
  const claimed = visitorPage({ href: `${protectedOrigin}/vault`, title: 'vault' });
  const h = await hub(null, { pages: { c1: claimed } });
  h.connect('c1', 'A', { origin: protectedOrigin });
  await h.settle();
  const p = protocol(t, (raw, own) =>
    joined(
      guardProtected(raw, own, new Map(), undefined),
      guardProtected(h.bridge.connection(), own, new Map(), PREVIEW_ROUTE, undefined, {
        kind: 'kernel',
      })
    )
  );
  p.target('ordinary');
  p.target('vault', 'page', {
    id: 'vault',
    url: `${protectedOrigin}/x`,
    securityOrigin: protectedOrigin,
  });
  const listed = await p.send('Target.getTargets');
  const preview = listed.result.targetInfos.find((info) => info.targetId === 'preview:A:c1');
  assert.deepEqual(
    [preview.url, preview.browserContextId, preview.type],
    [PREVIEW, 'preview', 'page']
  );
  const real = await p.attach('ordinary');
  const before = await p.send('Runtime.evaluate', { expression: '1' }, real);
  assert.equal(before.result?.result?.value, 'synthetic-content');
  const vault = await p.send('Target.attachToTarget', { targetId: 'vault', flatten: true });
  assert.ok(vault.error, "seven's real protected tab stays refused");
  const attached = await p.send('Target.attachToTarget', {
    targetId: 'preview:A:c1',
    flatten: true,
  });
  const own = attached.result?.sessionId;
  assert.ok(own, 'the preview target attaches');
  await p.send('Runtime.enable', {}, own);
  await flush();
  const read = await p.send(
    'Runtime.evaluate',
    { expression: 'location.href', returnByValue: true },
    own
  );
  assert.ok(
    read.error || read.result.result.value === `${protectedOrigin}/vault`,
    "the preview session is cut or answers only with the visitor's own page"
  );
  assert.ok(
    !p.sent.some((m) => m.sessionId === own || m.params?.targetId === 'preview:A:c1'),
    'nothing of the preview session reaches the real browser'
  );
  assert.ok(!h.seen.c1.includes('Target.attachToTarget'));
  const after = await p.send('Runtime.evaluate', { expression: '1' }, real);
  assert.equal(after.result?.result?.value, 'synthetic-content', 'the real target is unaffected');
  const again = await p.send('Target.attachToTarget', { targetId: 'vault', flatten: true });
  assert.ok(again.error, "seven's real protected tab is still refused after the claim");
});
