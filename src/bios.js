import { usersMode } from './seed/users.js';

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
    if (!call) return;
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

function remember(key, list) {
  if (list.length) return localStorage.setItem(key, JSON.stringify(list));
  return localStorage.removeItem(key);
}

function fixed(changed) {
  return changed.length
    ? `, ${changed.length} changed ${changed.length === 1 ? 'file' : 'files'} put back`
    : '';
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

function baseProject() {
  return usersMode() === 'off' ? {} : { base: 'opt/slicc/base' };
}

const repaired = [];
const stopped = [];

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
  const {
    packages,
    downloaded,
    removed,
    bytes,
    repaired: changed,
    stopped: kept,
  } = await installer('packages', { from, ...baseProject() }, (progress) =>
    report(`${progress.done}/${progress.total} ${progress.path}`)
  );
  const pruned = removed ? `, ${removed} removed` : '';
  repaired.push(...changed);
  stopped.push(...kept);
  return `${downloaded}/${packages} downloaded from npm, ${size(bytes)}${pruned}${fixed(changed)}`;
});

await step('seed', async () => {
  const files = [
    'adobe.js',
    'agent.js',
    'approvals.js',
    'browser.js',
    'callback.html',
    'callback.js',
    'cdp.js',
    'clipboard.js',
    'denials.js',
    'exits.js',
    'follow.js',
    'follower.js',
    'followers.js',
    'grammars.js',
    'guard.js',
    'index.html',
    'layer.js',
    'link-ws.js',
    'link.js',
    'loopback.js',
    'mounts.js',
    'network.js',
    'notices.js',
    'os.css',
    'os.js',
    'packages.js',
    'projects.js',
    'present.js',
    'profile.js',
    'remote.js',
    'rules.js',
    'start.js',
    'storage.js',
    'switchboard-worker.js',
    'switchboard.js',
    'tabs.js',
    'tags.js',
    'tailscale.js',
    'tailscale-worker.js',
    'terminal.js',
    'transport.js',
    'tray.js',
    'tunnel.js',
    'update.js',
    'updates.js',
    'users.js',
  ];
  const from = new URL('seed/', import.meta.url).href;
  const {
    bytes,
    repaired: changed,
    stopped: kept,
  } = await installer('install', {
    from,
    to: 'os/',
    files,
    source: 'os',
  });
  repaired.push(...changed);
  stopped.push(...kept);
  return `os/{${files.join(',')}} ${size(bytes)}${fixed(changed)}`;
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
  remember('slicc-bios.repaired', repaired);
  remember('slicc-bios.stopped', stopped);
  const ui = new URL('os/', import.meta.url);
  ui.hash = location.hash;
  location.replace(ui);
  return ui.pathname;
});
