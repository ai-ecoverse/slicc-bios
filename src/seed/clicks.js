import { tabList } from './live.js';
import { BUSY, REST_MS, refused, session } from './requests.js';

export const CLICKS_CHANNEL = 'slicc-clicks';
export const APPROVAL_MS = 300_000;
export const CLICK_LATE = 'nobody clicked within 5 min';
export const CLICK_DISMISSED = 'the click in seven was cancelled';
export const NOT_HERE = "Click in seven's tab that asked.";
export const MARK = '● ';

export const waitingLine = (what) => `waiting for a click in seven's tab: ${what}`;

export function attention({
  page = globalThis.document,
  Notice = globalThis.Notification,
  focus = () => globalThis.focus?.(),
} = {}) {
  const held = new Set();
  const notes = new Map();
  const mark = () => {
    if (!page?.hidden || !held.size) return;
    if (!page.title.startsWith(MARK)) page.title = `${MARK}${page.title}`;
    if (Notice?.permission !== 'granted') return;
    for (const hold of held) {
      if (notes.has(hold)) continue;
      const note = new Notice(hold.title, { body: hold.body, tag: hold.tag });
      note.onclick = () => {
        focus();
        note.close();
      };
      notes.set(hold, note);
    }
  };
  const unmark = () => {
    if (page?.title?.startsWith(MARK)) page.title = page.title.slice(MARK.length);
  };
  page?.addEventListener?.('visibilitychange', () => (page.hidden ? mark() : unmark()));
  return (hold) => {
    held.add(hold);
    mark();
    return () => {
      held.delete(hold);
      notes.get(hold)?.close();
      notes.delete(hold);
      if (!held.size) unmark();
    };
  };
}

export function createClicks({
  channel = new BroadcastChannel(CLICKS_CHANNEL),
  tab,
  events,
  notice = attention(),
  timers = globalThis,
  wait = APPROVAL_MS,
  rest = REST_MS,
  now = Date.now,
} = {}) {
  const pending = new Map();
  const waiting = new Set();
  const resting = new Map();
  const listeners = { approvals: new Set(), ended: new Set() };
  let count = 0;
  const emit = (type, value) => {
    for (const listener of [...listeners[type]]) listener(value);
  };
  const shared = tabList({
    channel,
    tab,
    events,
    act: (id) => pending.get(id)?.settle('deny', 'answered'),
    heard: (data, before) => {
      const left = new Set(data.list.map((item) => item.id));
      const why = new Map((data.ended ?? []).map((end) => [end.id, end.reason]));
      for (const item of before)
        if (!left.has(item.id))
          emit('ended', { id: item.id, reason: why.get(item.id) ?? 'withdrawn' });
    },
  });
  const list = () => [
    ...shared.mine(),
    ...shared.theirs().map((item) => ({ ...item, here: false })),
  ];
  shared.on(() => emit('approvals', list()));
  const ask = ({
    kind,
    detail = {},
    asker,
    title,
    body,
    action,
    signal,
    stamp,
    waiting: what = action,
    progress = () => {},
    dismissed = CLICK_DISMISSED,
  }) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const key = session(stamp);
    if (resting.has(key)) {
      if (resting.get(key) > now()) return Promise.reject(refused(dismissed));
      resting.delete(key);
    }
    if (waiting.has(key)) return Promise.reject(refused(BUSY));
    count += 1;
    const createdAt = now();
    const item = {
      id: `click:${shared.tab}:${count}`,
      kind: 'click',
      subject: kind,
      what: detail.what ?? '',
      program: detail.program ?? 'a program',
      requester: asker,
      title,
      body,
      action,
      here: true,
      createdAt,
      expiresAt: createdAt + wait,
    };
    waiting.add(key);
    progress(waitingLine(what));
    return new Promise((resolve, reject) => {
      const release = notice({ title, body, tag: item.id });
      const withdraw = () => settle('deny', 'withdrawn');
      const timer = timers.setTimeout(() => settle('deny', 'expired'), wait);
      const settle = (decision, reason) => {
        if (!pending.delete(item.id)) return;
        waiting.delete(key);
        timers.clearTimeout(timer);
        signal?.removeEventListener('abort', withdraw);
        release();
        shared.set(
          shared.mine().filter((entry) => entry.id !== item.id),
          { ended: [{ id: item.id, reason: reason ?? 'answered' }] }
        );
        if (reason) emit('ended', { id: item.id, reason });
        if (decision === 'once') return resolve();
        if (signal?.aborted) return reject(signal.reason);
        resting.set(key, now() + rest);
        reject(refused(reason === 'expired' ? CLICK_LATE : dismissed));
      };
      pending.set(item.id, { settle });
      signal?.addEventListener('abort', withdraw, { once: true });
      shared.set([...shared.mine(), item]);
    });
  };
  return {
    ask,
    port: {
      has: (id) => list().some((item) => item.id === id),
      list,
      on(type, listener) {
        if (!Object.hasOwn(listeners, type)) return () => undefined;
        listeners[type].add(listener);
        return () => listeners[type].delete(listener);
      },
      async decide(id, decision) {
        const mine = pending.get(id);
        if (mine) return mine.settle(decision === 'once' ? 'once' : 'deny', null);
        const holder = shared.holder(id);
        if (!holder) return;
        if (decision !== 'deny') throw new Error(NOT_HERE);
        shared.send(holder, id);
      },
    },
  };
}

export function withClicks(port, clicks) {
  const list = () => [...port.list(), ...clicks.list()];
  return {
    ...port,
    list,
    on(type, listener) {
      const heard = type === 'approvals' ? () => listener(list()) : listener;
      const offs = [port.on(type, heard), clicks.on(type, heard)];
      return () => {
        for (const off of offs) off();
      };
    },
    decide: (id, decision, ...rest) =>
      clicks.has(id) ? clicks.decide(id, decision) : port.decide(id, decision, ...rest),
  };
}
