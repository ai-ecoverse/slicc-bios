const root = navigator.storage.getDirectory();
let connections = 0;

async function open(path, create = false) {
  const names = path.split('/');
  const name = names.pop();
  let dir = await root;
  for (const part of names) dir = await dir.getDirectoryHandle(part, { create });
  return dir.getFileHandle(name, { create });
}

async function read(path) {
  return (await open(path)).getFile();
}

async function write(path, text) {
  const writable = await (await open(path, true)).createWritable();
  await writable.write(text);
  await writable.close();
}

async function reusable(from, to, files, receipt) {
  const previous = JSON.parse(await (await read(receipt)).text());
  const sizes = await Promise.all(files.map(async (file) => (await read(to + file)).size));
  const bytes = sizes.reduce((sum, size) => sum + size, 0);
  const same = previous.from === from && previous.bytes === bytes;
  return same ? { files: files.length, bytes, reused: true } : null;
}

async function install({ from, to = '', files, receipt }, progress) {
  const reused = receipt && (await reusable(from, to, files, receipt).catch(() => null));
  if (reused) return reused;
  let bytes = 0;
  for (const file of files) {
    const response = await fetch(new URL(file, from));
    if (!response.ok) throw new Error(`${response.status} ${response.url}`);
    const writable = await (await open(to + file, true)).createWritable();
    const counter = new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        progress({ file, bytes });
        controller.enqueue(chunk);
      },
    });
    await response.body.pipeThrough(counter).pipeTo(writable);
  }
  if (receipt) await write(receipt, JSON.stringify({ from, bytes }));
  return { files: files.length, bytes };
}

async function list(dir, prefix) {
  const entries = [];
  for await (const handle of dir.values()) {
    const path = prefix + handle.name;
    if (handle.kind === 'directory') entries.push(...(await list(handle, `${path}/`)));
    else entries.push({ path, size: (await handle.getFile()).size });
  }
  return entries;
}

const ops = {
  hello: () => ({ connections }),
  install,
  list: async () => (await list(await root, '')).sort((a, b) => (a.path < b.path ? -1 : 1)),
};

self.onconnect = ({ ports: [port] }) => {
  connections += 1;
  port.onmessage = async ({ data: { id, op, args } }) => {
    try {
      const result = await ops[op](args, (progress) => port.postMessage({ id, progress }));
      port.postMessage({ id, result });
    } catch (error) {
      port.postMessage({ id, error: error.message });
    }
  };
};
