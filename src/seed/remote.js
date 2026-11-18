import { followInventory, inventoryIdentity, shaped } from './inventory.js';
import { fromThisKernel } from './leaders.js';

export const MAX_PROMPT = 16 * 1024 * 1024;
const MODES = ['steer', 'followUp', 'reject'];
const ANSWERS = ['once', 'always', 'deny', 'stop'];
const NO_APPROVALS = 'EOPNOTSUPP: this agent has no approvals';
export const OWN_KERNEL = "EACCES: a link from this seven's own kernel can't decide approvals";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const line = (event) => encoder.encode(`${JSON.stringify(event)}\n`);

function refusal(error) {
  const code = error.code ?? 'EIO';
  const message = error.message ?? '';
  if (message === code || message.startsWith(`${code}:`)) return message;
  return message ? `${code}: ${message}` : code;
}

async function* lines(events) {
  for await (const approvals of events) yield { t: 'approvals', approvals };
}

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

const clock = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle),
};

export function createRemote({
  control,
  onChange = () => {},
  inventory = inventoryIdentity(),
  now = Date.now,
  timers = clock,
  ownKernel = fromThisKernel,
}) {
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
        ...(meta.busy === true ? { busy: true } : {}),
      });
      stream.accepted({
        head: watch.head,
        ...(watch.gap ? { gap: true } : {}),
        ...(typeof watch.busy === 'boolean' ? { busy: watch.busy } : {}),
      });
      await pump(stream, watch.events);
    },
    async inventory(api, meta, stream) {
      if (typeof api.inventory !== 'function')
        return stream.reset('EOPNOTSUPP: this agent has no inventory');
      const watch = meta.watch === true;
      const opened = await api.inventory({ watch });
      const known = await inventory();
      const render = (snapshot) => shaped(snapshot, { ...known, now });
      stream.accepted(await render(opened.snapshot));
      if (!watch || !opened.events) return stream.closeWrite();
      await followInventory(stream, opened.snapshot, opened.events, { render, line, now, timers });
    },
    async approvals(api, meta, stream) {
      if (typeof api.approvals !== 'function') return stream.reset(NO_APPROVALS);
      const watch = meta.watch === true;
      const opened = await api.approvals({ watch });
      stream.accepted({ approvals: opened.approvals });
      if (!watch || !opened.events) return stream.closeWrite();
      await pump(stream, lines(opened.events));
    },
    async decide(api, meta, stream, link) {
      if (typeof api.decide !== 'function') return stream.reset(NO_APPROVALS);
      const { id, answer, reason } = meta;
      if (typeof id !== 'string' || !id) return stream.reset('EINVAL: decide needs an approval id');
      if (!ANSWERS.includes(answer))
        return stream.reset('EINVAL: the answer is once, always, deny or stop');
      if (reason !== undefined && typeof reason !== 'string')
        return stream.reset('EINVAL: a reason is text');
      const device = link.id ?? link.key;
      await api.decide({ id, answer, ...(reason === undefined ? {} : { reason }), device });
      stream.accepted({ ok: true });
      stream.closeWrite();
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
      if (meta.op === 'decide') {
        try {
          if (await ownKernel(link)) return stream.reset(OWN_KERNEL);
        } catch {
          return stream.reset(OWN_KERNEL);
        }
      }
      const mode = meta.op === 'prompt' || meta.op === 'watch' ? meta.op : null;
      if (mode) mark(link, mode, 1);
      let api = null;
      try {
        api = await control();
        if (!api) return stream.reset('EOPNOTSUPP: the agent is not running');
        await op(api, meta, stream, link);
      } catch (error) {
        stream.reset(refusal(error));
      } finally {
        if (mode) mark(link, mode, -1);
        await api?.close?.();
      }
    },
  };
}
