const DISMISSED = 'slicc-os.notices.dismissed';

export function createNotices({ storage = localStorage } = {}) {
  const listeners = new Set();
  const handlers = new Map();
  let notices = [];
  const dismissed = () => {
    try {
      return new Set(JSON.parse(storage.getItem(DISMISSED) ?? '[]'));
    } catch {
      return new Set();
    }
  };
  const emit = () => {
    for (const listener of [...listeners]) listener(notices);
  };
  const remove = (id) => {
    if (!notices.some((notice) => notice.id === id)) return;
    notices = notices.filter((notice) => notice.id !== id);
    handlers.delete(id);
    emit();
  };
  return {
    on(type, listener) {
      if (type !== 'notices') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: () => notices,
    show(notice, handler) {
      if (dismissed().has(notice.id)) return false;
      const at = notices.findIndex((item) => item.id === notice.id);
      notices = at < 0 ? [...notices, notice] : notices.with(at, notice);
      handlers.set(notice.id, handler);
      emit();
      return true;
    },
    remove,
    async act(id, action) {
      const handler = handlers.get(id);
      if (!handler) throw new Error('This notice is gone.');
      await handler(action);
    },
    dismiss(id) {
      storage.setItem(DISMISSED, JSON.stringify([...dismissed(), id]));
      remove(id);
    },
  };
}
