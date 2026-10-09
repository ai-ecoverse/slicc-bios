const units = ['B', 'kB', 'MB', 'GB'];

function size(bytes) {
  const exponent = Math.min(3, Math.floor(Math.log10(Math.max(bytes, 1)) / 3));
  return `${Number((bytes / 1000 ** exponent).toFixed(1))}${units[exponent]}`;
}

function connect() {
  const { port } = new SharedWorker(new URL('installer.js', import.meta.url), 'slicc-installer');
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

let installer;

function activated(worker) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (worker.state === 'activated') resolve();
      if (worker.state === 'redundant') reject(new Error(`${worker.scriptURL} failed to install`));
    };
    worker.addEventListener('statechange', check);
    check();
  });
}

await step('opfs', async () => {
  await navigator.storage.getDirectory();
  const persisted = await navigator.storage.persist();
  const { quota, usage } = await navigator.storage.estimate();
  return `${persisted ? 'persistent' : 'best effort'}, ${size(quota - usage)} free`;
});

await step('installer', async () => {
  installer = connect();
  const { connections } = await installer('hello');
  return `connection #${connections}`;
});

await step('packages', async (report) => {
  const from = new URL('packages/package-lock.json', import.meta.url).href;
  const { packages, downloaded, removed, bytes } = await installer(
    'packages',
    { from },
    (progress) => report(`${progress.done}/${progress.total} ${progress.path}`)
  );
  const pruned = removed ? `, ${removed} removed` : '';
  return `${downloaded}/${packages} downloaded from npm, ${size(bytes)}${pruned}`;
});

await step('seed', async () => {
  const files = [
    'adobe.js',
    'agent.js',
    'callback.html',
    'callback.js',
    'cdp.js',
    'grammars.js',
    'index.html',
    'loopback.js',
    'mounts.js',
    'network.js',
    'os.css',
    'os.js',
    'tailscale.js',
    'tailscale-worker.js',
    'transport.js',
    'tunnel.js',
    'update.js',
    'updates.js',
  ];
  const from = new URL('seed/', import.meta.url).href;
  const { bytes } = await installer('install', { from, to: 'os/', files });
  return `os/{${files.join(',')}} ${size(bytes)}`;
});

await step('intercept', async () => {
  const registration = await navigator.serviceWorker.register(new URL('sw.js', import.meta.url), {
    type: 'module',
  });
  if (!registration.installing && !registration.waiting) await registration.update();
  const update = registration.installing ?? registration.waiting;
  if (update) await activated(update);
  return registration.scope;
});

await step('navigate', async () => {
  const ui = new URL('os/', import.meta.url);
  ui.hash = location.hash;
  location.replace(ui);
  return ui.pathname;
});
