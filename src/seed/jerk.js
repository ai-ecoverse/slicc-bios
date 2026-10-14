export const NO_JERK = 'no linked device runs jerk: link a slicc CLI on a computer that has jerk';
export const NOT_HERE =
  'signing in from seven arrives with a later seven: run jerk on a linked computer';
export const CREATE_MS = 150000;
export const OTHER_MS = 60000;

const EXITS = { EPROTO: 1, EACCES: 2, EBUSY: 1, ETIMEDOUT: 3, ECONNRESET: 1, EOPNOTSUPP: 4 };
const ROW = ['provider', 'name', 'env', 'device', 'signedIn', 'user', 'scopes'];

export function exitOf(error) {
  return EXITS[error?.code] ?? 1;
}

function rowOf(item, device) {
  const row = { device };
  for (const key of ROW) {
    const value = item?.[key];
    if (key === 'env' || key === 'scopes') {
      if (Array.isArray(value)) row[key] = value.filter((entry) => typeof entry === 'string');
    } else if (key === 'signedIn') {
      if (typeof value === 'boolean') row[key] = value;
    } else if (typeof value === 'string') row[key] = value;
  }
  row.env ??= [];
  return typeof row.provider === 'string' ? row : null;
}

export function carriers(links, cap) {
  const all = [...(links?.links?.values() ?? [])].filter(
    (link) => link.peer && link.offer?.session?.caps().includes(cap)
  );
  return all.sort((a, b) => (a.mode === 'local' ? 0 : 1) - (b.mode === 'local' ? 0 : 1));
}

async function events(stream, onEvent) {
  const decoder = new TextDecoder();
  let rest = '';
  let result = null;
  const line = (text) => {
    if (!text.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed?.event === 'result') result = parsed;
    else if (parsed?.event === 'progress' && typeof parsed.message === 'string') onEvent(parsed);
  };
  for (let chunk = await stream.read(); chunk; chunk = await stream.read()) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split('\n');
    rest = lines.pop();
    for (const text of lines) line(text);
  }
  line(rest + decoder.decode());
  return result;
}

export async function j1(link, meta, { onProgress = () => {}, signal, timers = globalThis } = {}) {
  const session = link.offer.session;
  const stream = await session.open({ kind: 'jerk', ...meta });
  const stop = () => stream.close?.();
  signal?.addEventListener?.('abort', stop, { once: true });
  const deadline = timers.setTimeout(stop, meta.op === 'create' ? CREATE_MS : OTHER_MS);
  try {
    stream.closeWrite?.();
    return await events(stream, onProgress);
  } finally {
    timers.clearTimeout(deadline);
    signal?.removeEventListener?.('abort', stop);
  }
}

function picked(result) {
  const out = { exit: Number.isInteger(result?.exit) ? result.exit : 1 };
  if (typeof result?.user === 'string') out.user = result.user;
  if (Array.isArray(result?.scopes))
    out.scopes = result.scopes.filter((scope) => typeof scope === 'string');
  if (typeof result?.message === 'string') out.message = result.message.slice(0, 500);
  return out;
}

const own = (provider) => (secret) =>
  secret.source === `oauth:${provider}` || secret.source?.startsWith(`jerk:${provider}@`);

export function createJerk({ links, vault, timers = globalThis }) {
  const running = new Map();
  const done = (id, fields) => vault.answer(id, 'done', fields).catch(() => undefined);

  async function list(id) {
    const rows = [];
    for (const link of carriers(links(), 'jerk')) {
      const result = await j1(link, { op: 'list' }, { timers }).catch(() => null);
      for (const item of result?.items ?? []) {
        const row = rowOf(item, link.label);
        if (row) rows.push(row);
      }
    }
    await done(id, { exit: 0, rows });
  }

  async function status(id, provider) {
    const secrets = (await vault.call('list')).list.secrets ?? [];
    const found = secrets.some((secret) => !secret.removedAt && own(provider)(secret));
    await done(
      id,
      found
        ? { exit: 0 }
        : {
            exit: 3,
            message: `no token for ${provider} in seven's vault: run jerk ${provider} create`,
          }
    );
  }

  async function create(id, req) {
    const [link] = carriers(links(), 'jerk');
    if (!link) return done(id, { exit: 4, message: NO_JERK });
    const controller = new AbortController();
    running.set(id, controller);
    try {
      const meta = { op: 'create', provider: req.provider };
      if (typeof req.scope === 'string') meta.scope = req.scope;
      if (req.params && typeof req.params === 'object') meta.params = req.params;
      const result = await j1(link, meta, {
        signal: controller.signal,
        timers,
        onProgress: ({ message }) =>
          void vault
            .answer(id, 'progress', { progress: message.slice(0, 200) })
            .catch(() => undefined),
      });
      if (controller.signal.aborted) return;
      await done(id, result ? picked(result) : { exit: 1, message: 'jerk ended without a result' });
    } catch (error) {
      if (!controller.signal.aborted)
        await done(id, { exit: exitOf(error), message: error.message });
    } finally {
      running.delete(id);
    }
  }

  async function unseal(id, provider) {
    const secrets = (await vault.call('list')).list.secrets ?? [];
    const leases = secrets.filter(
      (secret) => !secret.removedAt && secret.source?.startsWith(`jerk:${provider}@`)
    );
    for (const secret of leases) await vault.port.remove(secret.name, secret.kind);
    await done(id, { exit: 0, message: `removed ${leases.length} ${provider} token(s)` });
  }

  return {
    handle(req, id) {
      const work =
        req.kind === 'jerk'
          ? req.jop === 'list'
            ? list(id)
            : req.jop === 'status'
              ? status(id, req.provider)
              : req.jop === 'create'
                ? create(id, req)
                : done(id, { exit: 1, message: `unknown jerk op ${req.jop}` })
          : req.kind === 'unseal'
            ? unseal(id, req.provider)
            : req.kind === 'oauth' || req.kind === 'jerk-seal'
              ? done(id, { exit: 5, message: NOT_HERE })
              : Promise.resolve();
      return work.catch((error) => done(id, { exit: 1, message: error.message }));
    },
    cancelled(id) {
      running.get(id)?.abort();
      running.delete(id);
    },
  };
}
