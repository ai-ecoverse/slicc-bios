export const SCRUB_RECEIPT_MS = 5000;

const failure = (code = 'ENOTCONN') => Object.assign(new Error(), { code });
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function acknowledge(worker, scrub, signal) {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', abort);
      port1.onmessage = null;
      port1.onmessageerror = null;
      port1.close();
      port2.close();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason);
    port1.onmessage = ({ data, ports }) => {
      for (const port of ports) port.close();
      const valid =
        ports.length === 0 &&
        exact(data, ['v', 'nonce', 'version']) &&
        data.v === 1 &&
        data.nonce === nonce &&
        data.version === scrub.version;
      finish(valid ? undefined : failure());
    };
    port1.onmessageerror = () => finish(failure());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    port1.start();
    try {
      worker.postMessage({ scrub, scrubReceipt: { v: 1, nonce, version: scrub.version } }, [port2]);
    } catch {
      finish(failure());
    }
  });
}

export class ScrubWorkers extends Set {
  generation = 0;
  #pending = new Set();
  #timers;

  constructor(timers = globalThis) {
    super();
    this.#timers = timers;
  }

  invalidate() {
    this.generation += 1;
    for (const controller of this.#pending) controller.abort(failure());
  }

  add(worker) {
    if (!this.has(worker)) this.invalidate();
    return super.add(worker);
  }

  delete(worker) {
    if (this.has(worker)) this.invalidate();
    return super.delete(worker);
  }

  attach(worker, initialize) {
    this.add(worker);
    initialize(worker);
    return () => this.delete(worker);
  }

  async wait(scrub, { signal } = {}) {
    const controller = new AbortController();
    const generation = this.generation;
    const abort = () => controller.abort(failure());
    const timer = this.#timers.setTimeout(
      () => controller.abort(failure('ETIMEDOUT')),
      SCRUB_RECEIPT_MS
    );
    this.#pending.add(controller);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      controller.signal.throwIfAborted();
      await Promise.all([...this].map((worker) => acknowledge(worker, scrub, controller.signal)));
      controller.signal.throwIfAborted();
      if (generation !== this.generation) throw failure();
    } finally {
      this.#timers.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.#pending.delete(controller);
      controller.abort(failure());
    }
  }
}
