import { hasPlaceholder } from './placeholders.js';
import { checkRedirect } from './redirects.js';

export const FORWARD_BODY_MAX = 64 * 1024 * 1024;
export const FORWARD_CHUNK_MAX = 32 * 1024;
export const FORWARD_QUEUE_MAX = 2 * 1024 * 1024;
export const FORWARD_WAIT_MS = 120000;

const LOCAL = Symbol();
const failure = (message, status = 502, cause) =>
  Object.assign(new Error(message), {
    status,
    code: status === 403 ? 'EACCES' : 'EIO',
    [LOCAL]: true,
    ...(cause === 'policy-paused' ? { cause } : {}),
  });
const refused = (cause) => failure('the credentialed request was refused', 403, cause);

function approved(original, head) {
  return (
    head?.method === original.method &&
    head.url === original.url &&
    Array.isArray(head.headers) &&
    head.headers.length === original.headers.length &&
    head.headers.every(
      (pair, i) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair[0] === original.headers[i][0] &&
        typeof pair[1] === 'string' &&
        !/[\r\n\0]/.test(pair[1])
    ) &&
    !hasPlaceholder(head)
  );
}

async function within(work, signal, ms = FORWARD_WAIT_MS) {
  signal.throwIfAborted();
  let timer;
  let abort;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('the credentialed request timed out')), ms);
        abort = () => reject(failure('the credentialed request was cancelled'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function collected(request, max, signal) {
  if (request.body !== undefined) {
    if (!(request.body instanceof Uint8Array) || request.body.byteLength > max) throw refused();
    return request.body;
  }
  const chunks = [];
  let length = 0;
  const iterator = request.bodyStream[Symbol.asyncIterator]();
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await within(iterator.next(), signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw refused();
      length += next.value.byteLength;
      if (length > max) throw failure('the request body is too large', 413);
      chunks.push(next.value.slice());
    }
  } finally {
    void Promise.resolve(iterator.return?.()).catch(() => {});
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function validResponse(data) {
  return (
    Number.isInteger(data.status) &&
    data.status >= 100 &&
    data.status <= 599 &&
    typeof data.statusText === 'string' &&
    typeof data.url === 'string' &&
    Array.isArray(data.headers) &&
    data.headers.every(
      (pair) => Array.isArray(pair) && pair.length === 2 && pair.every((v) => typeof v === 'string')
    ) &&
    data.headers.flat().reduce((size, text) => size + text.length, 0) <= 256 * 1024
  );
}

function exchange(signal, onFailure, maxQueue = FORWARD_QUEUE_MAX) {
  const { port1, port2 } = new MessageChannel();
  const chunks = [];
  let bytes = 0;
  let ended = false;
  let error;
  let wake;
  let room;
  let credit;
  let expected = 0;
  let headerResolve;
  let headerReject;
  let headerSeen = false;
  const head = new Promise((resolve, reject) => {
    headerResolve = resolve;
    headerReject = reject;
  });
  head.catch(() => {});
  const close = (reason) => {
    if (ended) return;
    ended = true;
    error = reason;
    if (reason) {
      chunks.length = 0;
      bytes = 0;
    }
    headerReject(reason ?? failure('the vault returned no response'));
    credit?.reject(reason ?? failure('the vault returned no credit'));
    wake?.();
    room?.();
    port1.close();
    port2.close();
    signal.removeEventListener('abort', abort);
    if (reason) onFailure();
  };
  const abort = () => close(failure('the credentialed request was cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  const received = {
    response(data) {
      if (headerSeen || !validResponse(data))
        return close(failure('the vault returned an invalid response'));
      headerSeen = true;
      headerResolve(data);
    },
    body(data) {
      if (!headerSeen || !(data.chunk instanceof Uint8Array))
        return close(failure('the vault returned an invalid body'));
      bytes += data.chunk.byteLength;
      if (bytes > maxQueue) return close(failure('the response queue is full'));
      chunks.push(data.chunk);
      wake?.();
    },
    credit(data) {
      if (!credit || data.bytes !== expected)
        return close(failure('the vault returned invalid credit'));
      const waiting = credit;
      credit = null;
      waiting.resolve();
    },
    end: () => close(),
    error: () => close(failure('the credentialed transport failed')),
  };
  port1.onmessage = ({ data }) => {
    if (ended) return;
    if (!Object.hasOwn(received, data?.op))
      return close(failure('the vault returned an invalid message'));
    received[data.op](data);
  };
  port1.start();
  return {
    port: port2,
    head,
    close,
    send: (data) => {
      if (ended) throw error ?? failure('the response stream is closed');
      port1.postMessage(data);
    },
    async push(chunk) {
      for (let offset = 0; offset < chunk.byteLength; offset += FORWARD_CHUNK_MAX) {
        while (!ended && bytes >= maxQueue / 2) {
          await within(
            new Promise((resolve) => {
              room = resolve;
            }),
            signal
          );
          room = null;
        }
        if (ended) throw error ?? failure('the response stream is closed');
        const part = chunk.slice(offset, offset + FORWARD_CHUNK_MAX);
        expected = part.byteLength;
        const acknowledged = new Promise((resolve, reject) => {
          credit = { resolve, reject };
        });
        port1.postMessage({ op: 'body', chunk: part }, [part.buffer]);
        await within(acknowledged, signal);
      }
    },
    body: (async function* () {
      for (;;) {
        const chunk = chunks.shift();
        if (chunk) {
          bytes -= chunk.byteLength;
          room?.();
          yield chunk;
          continue;
        }
        if (ended) {
          if (error) throw error;
          return;
        }
        await within(
          new Promise((resolve) => {
            wake = resolve;
          }),
          signal
        );
        wake = null;
      }
    })(),
  };
}

function selectedFor(request, options) {
  if (request.v !== 1 || request.caller?.users !== 'enforce' || options.ready() !== true)
    throw refused();
  if (request.body !== undefined && request.bodyStream !== undefined) throw refused();
  const epoch = options.vault.forwardEpoch();
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw refused();
  const selected = options.select(request.url);
  if (
    selected?.rawTraits?.manualRedirects !== true ||
    selected.rawTraits.encodedBodies !== false ||
    selected.active() !== true
  )
    throw refused();
  if (!Number.isSafeInteger(selected.maxRequestBody) || selected.maxRequestBody < 0)
    throw refused();
  return { selected, epoch, max: Math.min(FORWARD_BODY_MAX, selected.maxRequestBody) };
}

function mcpBody(result, present, max) {
  if (result.bodyComplete !== true || Object.hasOwn(result, 'body') !== present) throw refused();
  if (present && (!(result.body instanceof Uint8Array) || result.body.byteLength > max))
    throw refused();
  return result.body;
}

async function admittedBody(request, original, selected, max, signal, ask, discard) {
  const present = request.body !== undefined || request.bodyStream !== undefined;
  let result = await ask();
  let body;
  let bodyStream;
  if (result?.needsBody === true) {
    discard();
    if (!present) throw refused();
    body = await collected(request, max, signal);
    result = await ask(body);
    if (result?.mode !== 'mcp') throw refused();
  }
  if (!approved(original, result?.head)) throw refused(result?.refused?.cause);
  if (result.mode === 'secret') {
    if (Object.hasOwn(result, 'body') || Object.hasOwn(result, 'bodyComplete')) throw refused();
    if (request.bodyStream && selected.streamingBodies === true) bodyStream = request.bodyStream;
    else body = present ? await collected(request, max, signal) : undefined;
  } else if (result.mode === 'mcp') {
    body = mcpBody(result, present, max);
  } else throw refused();
  return { head: result.head, body, bodyStream };
}

export function createForwarder({
  vault,
  select,
  ready,
  policyEpoch = () => 0,
  onPolicyChange = () => () => {},
}) {
  return async (request, { signal }) => {
    signal.throwIfAborted();
    const { selected, epoch, max } = selectedFor(request, { vault, select, ready });
    const policy = policyEpoch();
    const present = request.body !== undefined || request.bodyStream !== undefined;
    const original = { method: request.method, url: request.url, headers: request.headers };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let relay;
    let raw;
    let cancelled = false;
    const current = () =>
      ready() === true &&
      policyEpoch() === policy &&
      vault.forwardEpoch() === epoch &&
      selected.active() === true;
    const changed = () => {
      if (!current()) abort();
    };
    const offStatus = vault.port.on('status', changed);
    const offAvailability = vault.port.on('availability', changed);
    const offRoute = selected.onChange?.(changed) ?? (() => {});
    const offPolicy = onPolicyChange(changed);
    const clean = () => {
      signal.removeEventListener('abort', abort);
      offStatus();
      offAvailability();
      offRoute();
      offPolicy();
    };
    const cancel = async () => {
      if (cancelled) return;
      cancelled = true;
      abort();
      relay?.close(failure('the credentialed request was cancelled'));
      clean();
      await Promise.resolve()
        .then(() => raw?.cancel())
        .catch(() => {});
    };
    try {
      const ask = async (body) => {
        controller.signal.throwIfAborted();
        relay = exchange(controller.signal, () => {
          void cancel();
        });
        return within(
          vault.forward(
            {
              head: original,
              owner: request.caller,
              exit: selected.exit,
              rawTraits: selected.rawTraits,
              bodyPresent: present,
              streamCredit: true,
              ...(body === undefined ? {} : { body }),
            },
            relay.port,
            { signal: controller.signal }
          ),
          controller.signal
        );
      };
      const { head, body, bodyStream } = await admittedBody(
        request,
        original,
        selected,
        max,
        controller.signal,
        ask,
        () => relay.close()
      );
      if (!current()) throw refused();
      const headers = head.headers.filter(
        ([name]) => !['content-length', 'transfer-encoding'].includes(name.toLowerCase())
      );
      controller.signal.throwIfAborted();
      raw = await within(
        Promise.resolve(
          selected.fetch({
            ...head,
            headers,
            redirect: 'manual',
            ...(body === undefined ? {} : { body }),
            ...(bodyStream === undefined ? {} : { bodyStream }),
            signal: controller.signal,
          })
        ).then((response) => {
          raw = response;
          if (controller.signal.aborted)
            void Promise.resolve()
              .then(() => response.cancel())
              .catch(() => {});
          return response;
        }),
        controller.signal
      );
      if (raw.opaqueRedirect === true || raw.type === 'opaqueredirect' || raw.status === 0) {
        await within(
          Promise.resolve()
            .then(() => raw.cancel())
            .catch(() => {}),
          controller.signal
        );
        raw = {
          status: 502,
          statusText: 'Bad Gateway',
          headers: [['content-type', 'text/plain; charset=utf-8']],
          url: original.url,
          body: (async function* () {
            yield new TextEncoder().encode('credentialed request redirected; not followed');
          })(),
          cancel: async () => {},
        };
      } else await checkRedirect({ url: original.url, redirect: 'manual' }, raw);
      relay.send({
        op: 'response',
        status: raw.status,
        statusText: raw.statusText,
        url: raw.url ?? original.url,
        redirected: false,
        headers: raw.headers,
      });
      const pumping = (async () => {
        for await (const chunk of raw.body) {
          if (!(chunk instanceof Uint8Array)) throw failure('the transport returned invalid bytes');
          await relay.push(chunk);
        }
        relay.send({ op: 'end' });
      })();
      pumping.catch((error) => {
        try {
          relay.send({ op: 'error', message: String(error?.message ?? error) });
        } catch {
          void cancel();
        }
      });
      const scrubbed = await within(relay.head, controller.signal);
      return {
        status: scrubbed.status,
        statusText: scrubbed.statusText,
        url: scrubbed.url,
        redirected: false,
        headers: scrubbed.headers.filter(
          ([name]) =>
            !['content-length', 'content-encoding', 'transfer-encoding'].includes(
              name.toLowerCase()
            )
        ),
        body: (async function* () {
          try {
            yield* relay.body;
          } finally {
            await cancel();
          }
        })(),
        cancel,
      };
    } catch (error) {
      await cancel();
      throw error?.[LOCAL] ? error : failure('the credentialed transport failed');
    }
  };
}
