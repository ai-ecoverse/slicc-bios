export const ACTIVATE = 'now';
export const NUDGE_MS = 2000;
export const WAKE_MS = 2000;
export const SETTLE_MS = 15000;

export function nudge(
  registration,
  { container = navigator.serviceWorker, ms = WAKE_MS, timers = globalThis } = {}
) {
  const next = registration.waiting;
  if (!next) return Promise.resolve(false);
  const old = registration.active;
  return new Promise((resolve) => {
    let timer = null;
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      timers.clearTimeout(timer);
      container.removeEventListener('message', heard);
      next.postMessage({ activate: ACTIVATE });
      resolve(true);
    };
    const heard = (event) => {
      if (event.source === old) send();
    };
    if (!old) return send();
    container.addEventListener('message', heard);
    timer = timers.setTimeout(send, ms);
    old.postMessage({ streams: 'mine' });
  });
}

export function activated(
  registration,
  worker,
  {
    container = navigator.serviceWorker,
    timers = globalThis,
    settle = SETTLE_MS,
    after = NUDGE_MS,
    warn = (message) => console.warn(message),
    wake = nudge,
  } = {}
) {
  return new Promise((resolve, reject) => {
    let nudging = null;
    const arm = () => {
      if (nudging !== null || worker.state !== 'installed') return;
      nudging = timers.setTimeout(() => {
        if (registration.waiting === worker) void wake(registration, { container, timers });
      }, after);
    };
    const finish = (error) => {
      timers.clearTimeout(timer);
      timers.clearTimeout(nudging);
      worker.removeEventListener('statechange', check);
      container.removeEventListener('controllerchange', check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant')
        finish(new Error(`${worker.scriptURL} failed to install`));
      else arm();
    };
    const timer = timers.setTimeout(() => {
      if (!registration.active) return finish(new Error(`${worker.scriptURL} didn't activate`));
      warn(`bios: ${worker.scriptURL} is still ${worker.state}, going on under the active worker`);
      finish();
    }, settle);
    worker.addEventListener('statechange', check);
    container.addEventListener('controllerchange', check);
    check();
  });
}
