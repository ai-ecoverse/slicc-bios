const BASH = 'https://cdn.jsdelivr.net/npm/@ai-ecoverse/wasm-bash@5.3.0-7/';
const units = ['B', 'kB', 'MB', 'GB'];

function size(bytes) {
  const exponent = Math.min(3, Math.floor(Math.log10(Math.max(bytes, 1)) / 3));
  return `${Number((bytes / 1000 ** exponent).toFixed(1))}${units[exponent]}`;
}

function connect() {
  const { port } = new SharedWorker(new URL('kernel.js', import.meta.url), 'slicc-kernel');
  const calls = new Map();
  let id = 0;
  port.onmessage = ({ data }) => {
    const call = calls.get(data.id);
    if ('progress' in data) return call.progress(data.progress);
    calls.delete(data.id);
    if ('error' in data) call.reject(new Error(data.error));
    else call.resolve(data.result);
  };
  return (op, args, progress = () => {}) =>
    new Promise((resolve, reject) => {
      calls.set(++id, { resolve, reject, progress });
      port.postMessage({ id, op, args });
    });
}

async function step(name, task) {
  const item = document.querySelector(`[data-step="${name}"]`);
  const output = item.querySelector('output');
  item.dataset.state = 'active';
  try {
    output.value = await task((text) => {
      output.value = text;
    });
  } catch (error) {
    item.dataset.state = 'failed';
    output.value = error.message;
    throw error;
  }
  item.dataset.state = 'done';
  document.querySelector('progress').value += 1;
}

let kernel;

await step('opfs', async () => {
  await navigator.storage.getDirectory();
  const persisted = await navigator.storage.persist();
  const { quota, usage } = await navigator.storage.estimate();
  return `${persisted ? 'persistent' : 'best effort'}, ${size(quota - usage)} free`;
});

await step('kernel', async () => {
  kernel = connect();
  const { connections } = await kernel('hello');
  return `connection #${connections}`;
});

await step('bash', async (report) => {
  const files = ['bin/bash', 'bin/bash.wasm'];
  const receipt = 'var/lib/bios/wasm-bash.json';
  const { bytes, reused } = await kernel('install', { from: BASH, files, receipt }, (progress) =>
    report(`${progress.file} ${size(progress.bytes)}`)
  );
  return `${files.join(', ')} ${size(bytes)}${reused ? ', already in OPFS' : ''}`;
});

await step('seed', async () => {
  const files = ['index.html', 'os.css', 'os.js'];
  const from = new URL('seed/', import.meta.url).href;
  const { bytes } = await kernel('install', { from, to: 'os/', files });
  return `os/{${files.join(',')}} ${size(bytes)}`;
});

await step('script', async () => {
  const from = new URL('boot.sh', import.meta.url).href;
  const { output } = await kernel('bash', { from, cwd: 'os' });
  return output.at(-1);
});

await step('intercept', async () => {
  await navigator.serviceWorker.register(new URL('sw.js', import.meta.url));
  const { scope } = await navigator.serviceWorker.ready;
  return scope;
});

await step('navigate', async () => {
  const ui = new URL('os/bash.html', import.meta.url);
  location.replace(ui);
  return ui.pathname;
});
