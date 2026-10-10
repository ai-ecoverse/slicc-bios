export const ID = 'storage';
export const TITLE = 'Seven’s files may be cleared';
const WARNING = 'Chrome may clear seven’s files and chats when disk space runs low.';
export const INSTALL = `${WARNING} Install seven as an app to keep them.`;
export const BOOKMARK = `${WARNING} Bookmark seven to keep them.`;
export const STILL =
  'Chrome still doesn’t keep seven’s files. Install seven as an app or bookmark it, then try again.';

export function installPrompts(events = globalThis) {
  const listeners = new Set();
  let prompt = null;
  events.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    prompt = event;
    for (const listener of [...listeners]) listener('prompt');
  });
  events.addEventListener('appinstalled', () => {
    prompt = null;
    for (const listener of [...listeners]) listener('installed');
  });
  return {
    take() {
      const taken = prompt;
      prompt = null;
      return taken;
    },
    offered: () => prompt !== null,
    on(listener) {
      listeners.add(listener);
    },
  };
}

export function keepStorage({ notices, prompts, storage = navigator.storage }) {
  let asked = false;
  let shown = false;
  const notice = () => ({
    id: ID,
    tone: 'warning',
    title: TITLE,
    body: prompts.offered() ? INSTALL : BOOKMARK,
    actions: [
      ...(prompts.offered() ? [{ id: 'install', label: 'Install' }] : []),
      { id: 'retry', label: 'Try again' },
    ],
  });
  const show = () => {
    shown = notices.show(notice(), act);
  };
  const kept = async () => {
    if (!(await storage.persist())) return false;
    shown = false;
    notices.remove(ID);
    return true;
  };
  async function act(action) {
    const offer = action === 'install' ? prompts.take() : null;
    if (offer) {
      await offer.prompt();
      await offer.userChoice;
      show();
      return;
    }
    if (!(await kept())) throw new Error(STILL);
  }
  prompts.on((what) => {
    if (!shown) return;
    if (what === 'prompt') show();
    else void kept().then((done) => done || show());
  });
  return {
    async sent() {
      if (asked) return;
      asked = true;
      try {
        if ((await storage.persisted()) || (await storage.persist())) return;
      } catch {}
      show();
    },
  };
}

export function onSend(agent, sent) {
  return new Proxy(agent, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'send') {
        return (...args) => {
          void sent();
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
