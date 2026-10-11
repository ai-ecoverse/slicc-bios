import { failure } from './link.js';

const NEEDS = { pi: ['view'], terminal: ['view', 'terminal'] };
export const REVOKED = 'EACCES: the owner took this access back';
export const CHANGED = 'ECONNRESET: the owner changed this access';

export function createFollowers({ tray, name = 'SLICC', serve = {}, onChange = () => {} }) {
  const open = new Map();
  const allowed = (link, kind) => {
    const access = tray.access(link.id);
    return NEEDS[kind].every((key) => access[key] === true);
  };
  const count = (link, kind) =>
    [...(open.get(link.key) ?? [])].filter((item) => item.kind === kind).length;

  tray.on(() => {
    for (const items of open.values()) {
      for (const item of [...items]) {
        if (!allowed(item.link, item.kind)) item.stream.reset(REVOKED);
        else if (item.kind === 'pi' && item.control !== tray.access(item.link.id).control)
          item.stream.reset(CHANGED);
      }
    }
  });

  async function track(link, kind, stream, run) {
    const item = { link, kind, stream, control: tray.access(link.id).control };
    if (!open.has(link.key)) open.set(link.key, new Set());
    open.get(link.key).add(item);
    onChange();
    try {
      await run();
    } catch (error) {
      stream.reset(`${error.code ?? 'EIO'}: ${error.message}`);
    } finally {
      open.get(link.key)?.delete(item);
      if (!open.get(link.key)?.size) open.delete(link.key);
      onChange();
    }
  }

  return {
    hello: (link) => ({
      name,
      caps: Object.keys(NEEDS).filter((kind) => serve[kind]),
      permissions: tray.access(link.id),
    }),
    accept(link, meta) {
      const handler = Object.hasOwn(NEEDS, meta.kind) ? serve[meta.kind] : null;
      if (!handler) return Promise.reject(failure('EOPNOTSUPP'));
      if (!allowed(link, meta.kind)) return Promise.reject(failure('EACCES'));
      return {
        handle: (stream) =>
          track(link, meta.kind, stream, () => handler(link, meta, stream, tray.access(link.id))),
      };
    },
    describe(link) {
      const access = tray.access(link.id);
      const terminals = count(link, 'terminal');
      return {
        access,
        ...(access.view ? {} : { asking: true }),
        ...(count(link, 'pi') ? { controlling: 'watch' } : {}),
        ...(terminals ? { terminals } : {}),
      };
    },
  };
}
