const root = navigator.storage.getDirectory();
let connections = 0;

async function open(path) {
  const names = path.split('/');
  const name = names.pop();
  let dir = await root;
  for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir.getFileHandle(name, { create: true });
}

async function install({ from, to = '', files }, progress) {
  let bytes = 0;
  for (const file of files) {
    const response = await fetch(new URL(file, from));
    if (!response.ok) throw new Error(`${response.status} ${response.url}`);
    const writable = await (await open(to + file)).createWritable();
    const counter = new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        progress({ file, bytes });
        controller.enqueue(chunk);
      },
    });
    await response.body.pipeThrough(counter).pipeTo(writable);
  }
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
