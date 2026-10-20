import { usersMode } from './seed/users.js';

const quiet = {
  begin() {},
  report() {},
  done() {},
  fail(name, message) {
    const drawer = document.querySelector('.diagnostics');
    document.querySelector('.splash').dataset.state = 'failed';
    document.querySelector('.verb').textContent = `${name}: ${message}`;
    drawer.classList.add('open');
    drawer.inert = false;
    for (const button of document.querySelectorAll('.retry')) {
      button.hidden = false;
      button.onclick = () => location.reload();
    }
  },
};
const { splash } = await import('./sw/splash.js').catch((error) => {
  console.warn(`bios: booting without the splash, ${error.message}`);
  return { splash: quiet };
});

export function uiPage(hash) {
  return new URLSearchParams(hash.slice(1)).has('seat') ? 'os/join.html' : 'os/';
}

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
  splash.begin(name);
  try {
    output.value = await task((text, counted) => {
      output.value = text;
      splash.report(name, text, counted);
    });
  } catch (error) {
    item.dataset.state = 'failed';
    output.value = error.message;
    splash.fail(name, error.message);
    throw error;
  }
  item.dataset.state = 'done';
  document.querySelector('progress').value += 1;
  splash.done(name, output.value);
}

let installer;

function baseProject() {
  return usersMode() === 'off' ? {} : { base: 'opt/slicc/base' };
}

const repaired = [];
const stopped = [];

const SETTLE = 15000;

function activated(registration, worker) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', check);
      navigator.serviceWorker.removeEventListener('controllerchange', check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant')
        finish(new Error(`${worker.scriptURL} failed to install`));
    };
    const timer = setTimeout(() => {
      if (!registration.active) return finish(new Error(`${worker.scriptURL} didn't activate`));
      console.warn(
        `bios: ${worker.scriptURL} is still ${worker.state}, going on under the active worker`
      );
      finish();
    }, SETTLE);
    worker.addEventListener('statechange', check);
    navigator.serviceWorker.addEventListener('controllerchange', check);
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
    report(`${progress.done}/${progress.total} ${progress.path}`, progress)
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
    'facade.js',
    'follow.js',
    'follower.js',
    'followers.js',
    'grammars.js',
    'guard.js',
    'index.html',
    'jerk.js',
    'join.css',
    'join.html',
    'join.js',
    'layer.js',
    'leaders.js',
    'link-udp.js',
    'link-ws.js',
    'link.js',
    'loopback.js',
    'mounts.js',
    'network.js',
    'notices.js',
    'os.css',
    'os.js',
    'packages.js',
    'pair.js',
    'projects.js',
    'present.js',
    'profile.js',
    'remote.js',
    'site.js',
    'skills.js',
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
    'user.js',
    'users.js',
    'vault.js',
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

const root = new URL('/', import.meta.url);
let scope = root.href;

await step('intercept', async () => {
  const registration = await navigator.serviceWorker.register(new URL('sw.js', import.meta.url), {
    type: 'module',
    scope: root.pathname,
  });
  scope = registration.scope;
  if (!registration.installing && !registration.waiting) await registration.update();
  const update = registration.installing ?? registration.waiting;
  if (update) await activated(registration, update);
  return registration.scope;
});

await step('navigate', async () => {
  remember('slicc-bios.repaired', repaired);
  remember('slicc-bios.stopped', stopped);
  const ui = new URL(uiPage(location.hash), scope);
  ui.hash = location.hash;
  location.replace(ui);
  return ui.pathname;
});
