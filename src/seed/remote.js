export const MAX_PROMPT = 16 * 1024 * 1024;
const MODES = ['steer', 'followUp', 'reject'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const line = (event) => encoder.encode(`${JSON.stringify(event)}\n`);

const refusal = (error) => `${error.code ?? 'EIO'}${error.message ? `: ${error.message}` : ''}`;

async function readText(stream, length) {
  const chunks = [];
  let total = 0;
  for (let chunk = await stream.read(); chunk; chunk = await stream.read()) {
    total += chunk.length;
    if (total > length) return null;
    chunks.push(chunk);
  }
  if (total !== length) return null;
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return decoder.decode(all);
}

async function pump(stream, events) {
  const iterator = events[Symbol.asyncIterator]();
  let gone = false;
  const watching = (async () => {
    try {
      while ((await stream.read()) !== null);
      if (!(await stream.settled)) return;
    } catch {}
    gone = true;
    await iterator.return?.();
  })();
  try {
    for (let next = await iterator.next(); !next.done && !gone; next = await iterator.next()) {
      await stream.write(line(next.value));
    }
  } catch {
    gone = true;
  }
  if (!gone) stream.closeWrite();
  void watching;
}

export function createRemote({ control, onChange = () => {} }) {
  const active = new Map();
  const mark = (link, mode, by) => {
    const counts = active.get(link.key) ?? { prompt: 0, watch: 0 };
    counts[mode] += by;
    active.set(link.key, counts);
    onChange();
  };
  const ops = {
    async prompt(api, meta, stream) {
      const whenBusy = MODES.includes(meta.whenBusy) ? meta.whenBusy : 'followUp';
      const long = meta.text === undefined;
      let text = meta.text;
      if (long) {
        if (!Number.isInteger(meta.length) || meta.length < 0 || meta.length > MAX_PROMPT) {
          return stream.reset('EINVAL');
        }
        stream.accepted({});
        text = await readText(stream, meta.length);
        if (text === null) return stream.reset('EPROTO');
      } else if (typeof text !== 'string') return stream.reset('EINVAL');
      const run = await api.prompt({ text, whenBusy, thinking: meta.thinking === true });
      if (long) await stream.write(line({ t: 'delivered', delivered: run.delivered }));
      else stream.accepted({ delivered: run.delivered });
      await pump(stream, run.events);
    },
    async watch(api, meta, stream) {
      const watch = await api.watch({
        ...(typeof meta.since === 'string' ? { since: meta.since } : {}),
        thinking: meta.thinking === true,
      });
      stream.accepted({ head: watch.head, ...(watch.gap ? { gap: true } : {}) });
      await pump(stream, watch.events);
    },
    async abort(api, _meta, stream) {
      const { aborted } = await api.abort();
      stream.accepted({ aborted: aborted === true });
      stream.closeWrite();
    },
  };
  return {
    controlling(link) {
      const counts = active.get(link.key);
      if (counts?.prompt) return 'prompt';
      return counts?.watch ? 'watch' : undefined;
    },
    async handle(link, meta, stream) {
      const op = ops[meta.op];
      if (!op) return stream.reset('EINVAL');
      const mode = meta.op === 'abort' ? null : meta.op;
      if (mode) mark(link, mode, 1);
      let api = null;
      try {
        api = await control();
        if (!api) return stream.reset('EOPNOTSUPP: the agent is not running');
        await op(api, meta, stream);
      } catch (error) {
        stream.reset(refusal(error));
      } finally {
        if (mode) mark(link, mode, -1);
        await api?.close?.();
      }
    },
  };
}
