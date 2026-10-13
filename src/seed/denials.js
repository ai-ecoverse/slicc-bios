export const LOG = 'var/log/slicc/denials.log';
export const CAP = 1024 * 1024;

async function folder(root) {
  const parts = LOG.split('/');
  parts.pop();
  let dir = await root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}

async function append(root, text, cap) {
  const name = LOG.split('/').pop();
  const dir = await folder(root);
  const handle = await dir.getFileHandle(name, { create: true });
  const file = await handle.getFile();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (file.size && file.size + bytes > cap) {
    const kept = await (await dir.getFileHandle(`${name}.1`, { create: true })).createWritable();
    await kept.write(await file.arrayBuffer());
    await kept.close();
    const fresh = await handle.createWritable();
    await fresh.write(text);
    await fresh.close();
    return;
  }
  const writable = await handle.createWritable({ keepExistingData: true });
  await writable.seek(file.size);
  await writable.write(text);
  await writable.close();
}

export function denialLog({
  root,
  users,
  mode,
  now = Date.now,
  every = 2000,
  batch = 100,
  cap = CAP,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  const names = new Map();
  const pending = new Map();
  let queue = Promise.resolve();
  let timer = null;
  const nameOf = async (uid) => {
    if (!names.has(uid)) {
      for (const user of (await users()
        ?.list()
        .catch(() => [])) ?? [])
        names.set(user.uid, user.name);
    }
    return names.get(uid) ?? String(uid);
  };
  const flush = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    const taken = [...pending.values()];
    pending.clear();
    if (!taken.length) return queue;
    queue = queue
      .then(async () => {
        const lines = [];
        for (const { uid, tag, op, path, errno, count, first, last } of taken) {
          const line = {
            time: new Date(last).toISOString(),
            first: new Date(first).toISOString(),
            count,
            user: await nameOf(uid),
            tag,
            op,
            path,
            errno,
            mode,
          };
          lines.push(`${JSON.stringify(line)}\n`);
        }
        await append(root, lines.join(''), cap);
      })
      .catch((error) => console.warn(`denials.log: ${error.message}`));
    return queue;
  };
  const log = (denial) => {
    const at = now();
    const tag = denial.tag ?? null;
    const key = [denial.uid, tag, denial.op, denial.path, denial.errno].join('\0');
    const known = pending.get(key);
    if (known) {
      known.count += 1;
      known.last = at;
    } else {
      pending.set(key, { ...denial, tag, count: 1, first: at, last: at });
    }
    if (pending.size >= batch) return flush();
    if (timer === null) timer = schedule(flush, every);
    return queue;
  };
  log.flush = flush;
  return log;
}
