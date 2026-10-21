export const PENDING = 'slicc-os.six-import';
export const NOTICE = 'six-import';
const EXPORT = /^\/slicc-v6-upgrade\/([\w-]+)\/?$/;

export const MARKER = 'slicc-os.six';
export const NO_MANIFEST = 'SLICC 6’s export has no readable manifest.json';

async function exported(root, dir) {
  const id = EXPORT.exec(dir)?.[1];
  if (!id) return false;
  try {
    const exports = await root.getDirectoryHandle('slicc-v6-upgrade');
    await (await (await exports.getDirectoryHandle(id)).getFileHandle('manifest.json')).getFile();
    return true;
  } catch {
    return false;
  }
}

export const said = (error) => String(error?.message ?? error);

export async function retirePreview({
  storage = localStorage,
  container = navigator.serviceWorker,
  origin = location.origin,
} = {}) {
  if (storage.getItem(MARKER) !== 'upgraded') return [];
  const gone = [];
  for (const registration of await container.getRegistrations()) {
    if (!registration.scope.startsWith(`${origin}/preview/`)) continue;
    await registration.unregister();
    gone.push(registration.scope);
  }
  return gone;
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
  if (!storage.getItem(PENDING)) return null;
  return locks.request(PENDING, async () => {
    const dir = storage.getItem(PENDING);
    if (!dir) return null;
    if (!(await exported(root, dir))) {
      notices.show(failedNotice(NO_MANIFEST), () => {});
      return null;
    }
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
    console.warn(`SLICC 6 import: ${said(error)}`);
    options.notices.show(failedNotice(said(error)), () => {});
    return null;
  });
}
