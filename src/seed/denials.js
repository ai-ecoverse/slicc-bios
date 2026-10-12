export const LOG = 'var/log/slicc/denials.log';

export function denialLog({ root, users, mode, now = Date.now }) {
  const names = new Map();
  let queue = Promise.resolve();
  const nameOf = async (uid) => {
    if (!names.has(uid)) {
      for (const user of (await users()
        ?.list()
        .catch(() => [])) ?? [])
        names.set(user.uid, user.name);
    }
    return names.get(uid) ?? String(uid);
  };
  const append = async (line) => {
    const parts = LOG.split('/');
    const file = parts.pop();
    let dir = await root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const handle = await dir.getFileHandle(file, { create: true });
    const { size } = await handle.getFile();
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(size);
    await writable.write(line);
    await writable.close();
  };
  const log = (denial) => {
    const time = new Date(now()).toISOString();
    queue = queue
      .then(async () => {
        const line = {
          time,
          user: await nameOf(denial.uid),
          tag: denial.tag ?? null,
          op: denial.op,
          path: denial.path,
          errno: denial.errno,
          mode,
        };
        await append(`${JSON.stringify(line)}\n`);
      })
      .catch((error) => console.warn(`denials.log: ${error.message}`));
    return queue;
  };
  return log;
}
