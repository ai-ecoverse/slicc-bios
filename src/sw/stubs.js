const shims = {
  crypto: {
    randomUUID: 'globalThis.crypto.randomUUID.bind(globalThis.crypto)',
    getRandomValues: 'globalThis.crypto.getRandomValues.bind(globalThis.crypto)',
    webcrypto: 'globalThis.crypto',
    subtle: 'globalThis.crypto.subtle',
  },
  url: {
    URL: 'globalThis.URL',
    URLSearchParams: 'globalThis.URLSearchParams',
  },
};

const workerThreads = `const NAME = 'slicc-worker-threads';
const inside =
  typeof WorkerGlobalScope !== 'undefined' &&
  globalThis instanceof WorkerGlobalScope &&
  globalThis.name === NAME;

function events() {
  const listeners = new Map();
  return {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

export class Worker {
  #worker;
  #events = events();

  constructor(url, options = {}) {
    this.#worker = new globalThis.Worker(url, { type: 'module', name: NAME });
    this.#worker.addEventListener('message', (event) => this.#events.emit('message', event.data));
    this.#worker.addEventListener('error', (event) => {
      event.preventDefault();
      this.#events.emit('error', event.error ?? new Error(event.message || 'the worker failed'));
    });
    this.#worker.addEventListener('messageerror', () =>
      this.#events.emit('error', new Error('a message from the worker could not be read'))
    );
    this.#worker.postMessage({ workerData: options.workerData ?? null });
  }

  on(event, listener) {
    this.#events.on(event, listener);
    return this;
  }

  postMessage(message) {
    this.#worker.postMessage(message);
  }

  terminate() {
    this.#worker.terminate();
    return Promise.resolve(1);
  }

  ref() {}

  unref() {}
}

let port = null;
let data = null;
if (inside) {
  const key = Symbol.for(NAME);
  globalThis[key] ??= new Promise((resolve) => {
    const queued = [];
    const listeners = [];
    const shared = {
      postMessage: (message) => globalThis.postMessage(message),
      on(event, listener) {
        if (event === 'message') {
          listeners.push(listener);
          for (const message of queued.splice(0)) listener(message);
        }
        return shared;
      },
    };
    globalThis.addEventListener(
      'message',
      (event) => {
        resolve({ data: event.data?.workerData ?? null, port: shared });
        globalThis.addEventListener('message', (next) => {
          if (listeners.length) for (const listener of listeners) listener(next.data);
          else queued.push(next.data);
        });
      },
      { once: true }
    );
  });
  ({ data, port } = await globalThis[key]);
}

export const parentPort = port;
export const workerData = data;
export const isMainThread = !inside;
export const threadId = 0;
export default { Worker, parentPort, workerData, isMainThread, threadId };`;

const modules = {
  worker_threads: {
    source: workerThreads,
    exports: ['Worker', 'parentPort', 'workerData', 'isMainThread', 'threadId'],
  },
};

import { reserved } from './transform.js';

const identifier = /^[A-Za-z_$][\w$]*$/;

function exportable(items) {
  return [...new Set(items)].filter((item) => identifier.test(item) && !reserved.has(item));
}

function missing(name) {
  return `function __slicc_missing(member) { return function () { throw new Error(\`node:${name}\${member ? '.' + member : ''} is not available in the browser\`); }; }`;
}

function throwing(item) {
  return `export const ${item} = __slicc_missing(${JSON.stringify(item)});`;
}

export function nodeStub(name, wanted = []) {
  const real = modules[name];
  if (real) {
    const extra = exportable(wanted).filter((item) => !real.exports.includes(item));
    return [real.source, missing(name), ...extra.map(throwing)].join('\n');
  }
  const known = shims[name] ?? {};
  const names = exportable([...Object.keys(known), ...wanted]);
  const lines = [
    missing(name),
    ...names.map((item) =>
      known[item] ? `export const ${item} = ${known[item]};` : throwing(item)
    ),
    `export default new Proxy(__slicc_missing(''), { get: (target, member) => ({ ${names.join(', ')} })[member] ?? __slicc_missing(String(member)) });`,
  ];
  return lines.join('\n');
}
