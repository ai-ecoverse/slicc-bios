export const SIX_WORKER = '/llm-proxy-sw.js';
export const DISARM = 'slicc-six-disarm';
export const DISARMED = 'slicc-six-disarmed';
export const ANSWER_MS = 3000;
export const UPDATE_MS = 10000;

export function isSix(worker, origin = location.origin) {
  if (!worker?.scriptURL) return false;
  const url = new URL(worker.scriptURL);
  return url.origin === origin && url.pathname === SIX_WORKER;
}

export function ask(worker, { ms = ANSWER_MS, timers = globalThis } = {}) {
  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve) => {
    let timer = null;
    const finish = (answered) => {
      timers.clearTimeout(timer);
      port1.onmessage = null;
      port1.close();
      resolve(answered);
    };
    timer = timers.setTimeout(() => finish(false), ms);
    port1.onmessage = ({ data }) => {
      if (data?.type === DISARMED) finish(true);
    };
    try {
      worker.postMessage({ type: DISARM }, [port2]);
    } catch {
      finish(false);
    }
  });
}

export function settled(worker, { ms = UPDATE_MS, timers = globalThis } = {}) {
  if (!worker || worker.state === 'activated' || worker.state === 'redundant') {
    return Promise.resolve(worker?.state ?? null);
  }
  return new Promise((resolve) => {
    const finish = () => {
      timers.clearTimeout(timer);
      worker.removeEventListener('statechange', changed);
      resolve(worker.state);
    };
    const changed = () => {
      if (worker.state === 'activated' || worker.state === 'redundant') finish();
    };
    const timer = timers.setTimeout(finish, ms);
    worker.addEventListener('statechange', changed);
  });
}

async function newest(registration, options) {
  try {
    await registration.update();
  } catch (error) {
    console.warn(`bios: SLICC 6's service worker didn't update (${error.message})`);
    return;
  }
  const next = registration.installing ?? registration.waiting;
  if (isSix(next, options.origin)) await settled(next, options);
}

export async function disarmSix({
  container = navigator.serviceWorker,
  scope = '/',
  origin = location.origin,
  ms = ANSWER_MS,
  wait = UPDATE_MS,
  timers = globalThis,
} = {}) {
  if (!container) return null;
  const registration = await container.getRegistration(scope).catch(() => undefined);
  const registered = isSix(registration?.active, origin) ? registration : null;
  if (!registered && !isSix(container.controller, origin)) return null;
  if (registered) await newest(registered, { origin, ms: wait, timers });
  const workers = new Set(
    [container.controller, registered?.active].filter((worker) => isSix(worker, origin))
  );
  const answers = await Promise.all([...workers].map((worker) => ask(worker, { ms, timers })));
  const disarmed = answers.some(Boolean);
  let unregistered = false;
  const stays = registered?.installing ?? registered?.waiting;
  if (registered && isSix(registered.active, origin) && (!stays || isSix(stays, origin))) {
    unregistered = await registered.unregister().catch((error) => {
      console.warn(`bios: SLICC 6's service worker stays registered (${error.message})`);
      return false;
    });
  }
  return { disarmed, unregistered };
}

export function disarmLine(result) {
  if (!result) return '';
  if (result.disarmed) return ", SLICC 6's service worker disarmed";
  if (result.unregistered) return ", SLICC 6's service worker unregistered";
  return ", SLICC 6's service worker still answers";
}
