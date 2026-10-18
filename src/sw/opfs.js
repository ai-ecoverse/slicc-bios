export function opfsReader(root = () => navigator.storage.getDirectory()) {
  const folders = new Map();
  const folder = async (names, cached) => {
    let dir = await root();
    let at = '';
    for (const part of names) {
      at += `/${part}`;
      const known = cached ? folders.get(at) : undefined;
      dir = known ?? (await dir.getDirectoryHandle(part));
      folders.set(at, dir);
    }
    return dir;
  };
  return async (path) => {
    const names = path.split('/').filter(Boolean);
    const name = path.endsWith('/') || names.length === 0 ? 'index.html' : names.pop();
    try {
      return await (await (await folder(names, true)).getFileHandle(name)).getFile();
    } catch (first) {
      try {
        return await (await (await folder(names, false)).getFileHandle(name)).getFile();
      } catch (second) {
        try {
          second.first = first;
        } catch {}
        throw second;
      }
    }
  };
}

export function joined(task) {
  let running = null;
  return () => {
    running ??= task().finally(() => {
      running = null;
    });
    return running;
  };
}
