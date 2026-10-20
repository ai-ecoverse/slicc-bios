export const PENDING = 'slicc-os.six-import';
export const NOTICE = 'six-import';
const EXPORT = /^\/slicc-v6-upgrade\/([\w-]+)\/?$/;

async function exported(root, dir) {
  const id = EXPORT.exec(dir)?.[1];
  if (!id) return false;
  try {
    const exports = await root.getDirectoryHandle('slicc-v6-upgrade');
    await (await exports.getDirectoryHandle(id)).getFileHandle('manifest.json');
    return true;
  } catch {
    return false;
  }
}

export function failedNotice(error) {
  return {
    id: NOTICE,
    tone: 'warning',
    title: 'Your SLICC 6 cones aren’t in seven yet',
    body: `Seven couldn’t import what SLICC 6 left in this browser: ${String(error).replace(/\.$/, '')}. Seven tries again the next time it starts.`,
    actions: [],
  };
}

async function attempt({
  storage = localStorage,
  root,
  connect,
  notices,
  locks = navigator.locks,
}) {
  const dir = storage.getItem(PENDING);
  if (!dir) return null;
  if (!(await exported(root, dir))) {
    storage.removeItem(PENDING);
    return null;
  }
  return locks.request(PENDING, { ifAvailable: true }, async (lock) => {
    if (!lock) return null;
    const connection = await connect();
    try {
      const result = await connection.control.importProfile({
        upload: null,
        data: null,
        inPlace: dir.replace(/\/$/, ''),
        again: false,
        preview: false,
      });
      if (result.error) {
        notices.show(failedNotice(result.error), () => {});
        return result;
      }
      storage.removeItem(PENDING);
      notices.remove(NOTICE);
      return result;
    } finally {
      await connection.close();
    }
  });
}

export function importSix(options) {
  return attempt(options).catch((error) => {
    console.warn(`SLICC 6 import: ${error.message}`);
    return null;
  });
}
