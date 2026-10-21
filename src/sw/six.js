export const MARKER = 'slicc-os.six';
export const UPGRADED = 'upgraded';
export const PENDING = 'slicc-os.six-import';
export const RETIRED = 'slicc-bios.six-retired';
export const EXPORTER = '/upgrade-to-seven.html';
export const ASSETS = '/assets/';
export const EXPORTS = 'slicc-v6-upgrade';
export const PROFILE = 'slicc-fs';
export const TYPE = 'slicc-six-upgrade';
export const QUIET = 120000;
export const SILENT = 'SLICC 6’s upgrade page stopped answering. Try again.';
export const BAD = 'SLICC 6’s upgrade page gave no export to import. Try again.';
const PHASES = ['stopping', 'reading', 'writing'];
const ID = /^[\w-]+$/;

let known = false;

export async function retired(storage = globalThis.caches) {
  known ||= await storage.has(RETIRED);
  return known;
}

export const upgraded = (storage = localStorage) => storage.getItem(MARKER) === UPGRADED;

export async function hasProfile(root) {
  try {
    const dir = await root.getDirectoryHandle(PROFILE);
    return !(await dir.keys().next()).done;
  } catch {
    return false;
  }
}

export async function offered(origin = location.origin, get = fetch) {
  try {
    const response = await get(new URL(EXPORTER, origin), { cache: 'no-store' });
    if (!response.ok || new URL(response.url).pathname !== EXPORTER) return false;
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    return page.querySelector(`meta[name="${TYPE}"]`) !== null;
  } catch {
    return false;
  }
}

export async function retire({ caches, container, origin }) {
  await caches.open(RETIRED);
  const preview = `${origin}/preview/`;
  for (const registration of await container.getRegistrations()) {
    if (registration.scope.startsWith(preview)) await registration.unregister();
  }
}

export async function clean(root, keep) {
  let exports;
  try {
    exports = await root.getDirectoryHandle(EXPORTS);
  } catch {
    return [];
  }
  const removed = [];
  for await (const name of exports.keys()) {
    if (name === keep) continue;
    await exports.removeEntry(name, { recursive: true }).then(
      () => removed.push(name),
      () => undefined
    );
  }
  return removed;
}

export function finished(data) {
  if (typeof data.exportId !== 'string' || !ID.test(data.exportId)) return null;
  if (data.dir !== `/${EXPORTS}/${data.exportId}/`) return null;
  return { exportId: data.exportId, dir: data.dir };
}

export function exportSix({ doc = document, win = window, report, settle, quiet = QUIET }) {
  return new Promise((resolve, reject) => {
    const frame = doc.createElement('iframe');
    frame.hidden = true;
    frame.className = 'six-exporter';
    frame.title = 'SLICC 6';
    frame.src = new URL(EXPORTER, win.location.origin).href;
    let timer;
    let over = false;
    const finish = async (error, result) => {
      if (over) return;
      over = true;
      win.removeEventListener('message', heard);
      clearTimeout(timer);
      let failure = error;
      if (!failure) await settle(result).catch((thrown) => (failure = thrown));
      frame.remove();
      if (failure) reject(failure);
      else resolve(result);
    };
    const idle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error(SILENT)), quiet);
    };
    const heard = (event) => {
      if (event.origin !== win.location.origin || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (data?.type !== TYPE) return;
      if (typeof data.error === 'string') return finish(new Error(data.error));
      if (data.done === true) {
        const result = finished(data);
        return result ? finish(null, result) : finish(new Error(BAD));
      }
      if (!PHASES.includes(data.phase)) return;
      idle();
      report({ phase: data.phase, done: Number(data.done) || 0, total: Number(data.total) || 0 });
    };
    win.addEventListener('message', heard);
    doc.body.append(frame);
    idle();
  });
}

const count = (value) => value.toLocaleString('en-US');

export function progressLine({ phase, done, total }) {
  if (phase === 'stopping') return 'Stopping SLICC 6 tabs…';
  const what = phase === 'reading' ? 'Reading files' : 'Writing the export';
  return total ? `${what}: ${count(done)} of ${count(total)}` : what;
}

export function sixDialog(doc = document) {
  const box = doc.querySelector('.six');
  const title = box.querySelector('.six-title');
  const body = box.querySelector('.six-body');
  const line = box.querySelector('.six-progress');
  const bar = box.querySelector('.six-bar');
  const move = box.querySelector('.six-move');
  const later = box.querySelector('.six-later');
  let answer = null;
  const state = (name) => {
    box.dataset.state = name;
    doc.querySelector('.splash').dataset.six = name;
  };
  box.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key !== 'Escape') return;
    event.preventDefault();
    answer?.(false);
  });
  const choose = () =>
    new Promise((resolve) => {
      answer = (value) => {
        answer = null;
        resolve(value);
      };
      move.hidden = false;
      later.hidden = false;
      move.onclick = () => answer?.(true);
      later.onclick = () => answer?.(false);
      if (!box.open) box.showModal();
      later.focus();
    });
  return {
    async ask() {
      state('asking');
      title.textContent = 'Move SLICC 6 into seven in this browser?';
      body.textContent =
        'Your cones, files and skills from SLICC 6 move into seven. Files move as they are, including any keys or passwords written inside them. After that, SLICC 6 and its Chrome extension stop working in this browser.';
      line.hidden = true;
      bar.hidden = true;
      move.textContent = 'Move to seven';
      return choose();
    },
    moving() {
      state('moving');
      title.textContent = 'Moving SLICC 6 into seven';
      body.textContent = 'Keep this tab open. SLICC 6 tabs in this browser stop now.';
      move.hidden = true;
      later.hidden = true;
      line.hidden = false;
      bar.hidden = false;
      bar.removeAttribute('value');
      line.textContent = 'Starting';
    },
    report(progress) {
      line.textContent = progressLine(progress);
      if (progress.phase !== 'stopping' && progress.total) {
        bar.max = progress.total;
        bar.value = progress.done;
      } else bar.removeAttribute('value');
    },
    async failed(message) {
      state('failed');
      title.textContent = 'Couldn’t move SLICC 6';
      body.textContent = `${message} SLICC 6 still works in this browser.`;
      line.hidden = true;
      bar.hidden = true;
      move.textContent = 'Try again';
      return choose();
    },
    close() {
      state('closed');
      box.close();
    },
  };
}

export async function upgradeSix({
  root,
  storage = localStorage,
  caches = globalThis.caches,
  container = navigator.serviceWorker,
  origin = location.origin,
  dialog = sixDialog(),
  run = exportSix,
}) {
  const settle = async ({ exportId, dir }) => {
    storage.setItem(MARKER, UPGRADED);
    storage.setItem(PENDING, dir);
    await retire({ caches, container, origin }).catch((error) =>
      console.warn(`bios: retiring SLICC 6, ${error.message}`)
    );
    await clean(root, exportId).catch(() => []);
  };
  const later = () => {
    dialog.close();
    return null;
  };
  if (!(await dialog.ask())) return later();
  for (;;) {
    dialog.moving();
    try {
      const result = await run({ report: dialog.report, settle });
      dialog.close();
      return result;
    } catch (error) {
      if (!(await dialog.failed(error.message))) return later();
    }
  }
}

async function step({ root, storage, locks, ...rest }) {
  if (upgraded(storage)) {
    await retire({
      caches: rest.caches ?? globalThis.caches,
      container: rest.container ?? navigator.serviceWorker,
      origin: rest.origin ?? location.origin,
    });
    return 'retired';
  }
  if (!(await hasProfile(root)) || !(await offered(rest.origin))) return 'none';
  return locks.request(TYPE, { ifAvailable: true }, async (lock) => {
    if (!lock) return 'busy';
    const result = await upgradeSix({ root, storage, ...rest });
    return result ? 'upgraded' : 'declined';
  });
}

export function sixStep({ storage = localStorage, locks = navigator.locks, ...rest }) {
  return step({ storage, locks, ...rest }).catch((error) => {
    console.warn(`bios: SLICC 6, ${error.message}`);
    return 'failed';
  });
}
