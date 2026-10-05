const root = navigator.storage.getDirectory();
const cache = new Map();
let connections = 0;

async function open(path, create = false) {
  const names = path.split('/');
  const name = names.pop();
  let dir = await root;
  for (const part of names) dir = await dir.getDirectoryHandle(part, { create });
  return dir.getFileHandle(name, { create });
}

async function directory(path) {
  let dir = await root;
  for (const part of path.split('/')) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}

async function read(path) {
  return (await open(path)).getFile();
}

async function cached(path, load) {
  const file = await read(path);
  const stamp = `${file.size}:${file.lastModified}`;
  const hit = cache.get(path)?.stamp === stamp;
  if (!hit) cache.set(path, { stamp, value: load(file) });
  return { hit, value: await cache.get(path).value };
}

async function save(handle, data) {
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.url}`);
  return response;
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
    const response = await get(new URL(file, from));
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
  if (receipt) await save(await open(receipt, true), JSON.stringify({ from, bytes }));
  return { files: files.length, bytes };
}

async function mirror(fs, dir, path) {
  fs.mkdirTree(path);
  for await (const handle of dir.values()) {
    const target = `${path}/${handle.name}`;
    if (handle.kind === 'directory') await mirror(fs, handle, target);
    else fs.writeFile(target, new Uint8Array(await (await handle.getFile()).arrayBuffer()));
  }
}

async function persist(fs, path, dir) {
  for (const name of fs.readdir(path).filter((entry) => entry !== '.' && entry !== '..')) {
    const source = `${path}/${name}`;
    if (fs.isDir(fs.stat(source).mode)) {
      await persist(fs, source, await dir.getDirectoryHandle(name, { create: true }));
    } else {
      await save(await dir.getFileHandle(name, { create: true }), fs.readFile(source));
    }
  }
}

async function bash({ from, cwd }) {
  const [glue, wasm, script] = await Promise.all([
    cached('bin/bash', async (file) => {
      const glue = (await file.text()).replace(/^#!.*\n/, '');
      return new Function('Module', `${glue}\nreturn Module;`);
    }),
    cached('bin/bash.wasm', async (file) => WebAssembly.compile(await file.arrayBuffer())),
    get(from).then((response) => response.text()),
  ]);
  const output = [];
  const ready = Promise.withResolvers();
  const shell = glue.value({
    noInitialRun: true,
    thisProgram: 'bash',
    instantiateWasm: (imports, receive) => {
      WebAssembly.instantiate(wasm.value, imports).then(receive, ready.reject);
    },
    print: (line) => output.push(line),
    printErr: (line) => output.push(line),
    onAbort: (reason) => ready.reject(new Error(`bash aborted: ${reason}`)),
    onRuntimeInitialized: ready.resolve,
  });
  await ready.promise;
  const dir = await directory(cwd);
  await mirror(shell.FS, dir, `/${cwd}`);
  shell.FS.chdir(`/${cwd}`);
  const status = await shell.sliccRunMain(['-c', script]);
  await persist(shell.FS, `/${cwd}`, dir);
  if (status !== 0) throw new Error(`bash exited with ${status}: ${output.at(-1)}`);
  return { status, output, warm: wasm.hit };
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
  bash,
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
