import { ownerSnapshot } from './guard-owner-snapshot.mjs';

export function routeMemory() {
  const sent = [];
  let attached = 0;
  const frame = {
    id: 'root',
    loaderId: 'generation',
    url: 'https://ordinary.invalid/page',
    securityOrigin: 'https://ordinary.invalid',
  };
  const answer = (method, params = {}, sessionId) => {
    sent.push({ method, params, sessionId });
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: '1', type: 'page', url: frame.url } };
    if (method === 'Target.attachToTarget') return { sessionId: `memory-${++attached}` };
    if (method === 'Page.getFrameTree') return { frameTree: { frame } };
    if (method === 'DOM.getDocument') return { root: { nodeName: '#document', children: [] } };
    if (method === 'DOMSnapshot.captureSnapshot')
      return ownerSnapshot({ nodeName: '#document' }, 'root');
    if (method === 'Runtime.evaluate') return { result: { value: frame.url } };
    if (method === 'Page.getNavigationHistory')
      return { currentIndex: 0, entries: [{ id: 1, url: frame.url, title: 'ordinary' }] };
    return {};
  };
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      const result = answer(message.method, message.params, message.sessionId);
      queueMicrotask(() =>
        raw.onmessage?.(
          JSON.stringify({
            id: message.id,
            ...(message.sessionId ? { sessionId: message.sessionId } : {}),
            result,
          })
        )
      );
    },
    close() {},
  };
  const extension = (version) =>
    Object.freeze({
      version,
      frames: async () => ({
        version: 2,
        revision: 0,
        rootFrameId: 'root',
        rootLoaderId: 'generation',
        frames: [{ frameId: 0, parentFrameId: -1, kind: 'ordinary' }],
        localFrames: ['root'],
        remoteOwners: [],
      }),
      cdp: Object.freeze({
        on() {
          return () => {};
        },
        async send(method, params, sessionId) {
          return answer(method, params, sessionId);
        },
      }),
    });
  class Socket {
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    send(text) {
      const message = JSON.parse(text);
      const result = answer(message.method, message.params, message.sessionId);
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            id: message.id,
            ...(message.sessionId ? { sessionId: message.sessionId } : {}),
            result,
          }),
        })
      );
    }
    close() {}
  }
  let id = 0;
  async function request(connection, method, params = {}, sessionId) {
    const reply = Promise.withResolvers();
    const current = ++id;
    let timer;
    connection.onmessage = (text) => {
      const message = JSON.parse(text);
      if (message.id === current) {
        clearTimeout(timer);
        reply.resolve(message);
      }
    };
    timer = setTimeout(
      () => reply.reject(new Error(`memory route did not answer ${method}`)),
      3000
    );
    connection.send(
      JSON.stringify({ id: current, method, params, ...(sessionId ? { sessionId } : {}) })
    );
    return reply.promise;
  }
  const links = (version) => () => ({
    links: new Map([
      [
        'owned',
        {
          label: 'owned',
          peer: { version },
          exit: { browsers: () => [{ id: 'chrome', seven: true }], cdp: async () => raw },
        },
      ],
    ]),
  });
  return { raw, sent, extension, Socket, request, links };
}

export function routeGlobals(t, extension, devtools, Socket) {
  const values = { sliccExtension: extension, crestDevTools: devtools, WebSocket: Socket };
  const saved = new Map(
    Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}
