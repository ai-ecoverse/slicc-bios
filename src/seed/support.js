import { imsHosts, relayed, SEVEN_CLIENT } from './adobe.js';

export const SUPPORT_API = '/api/support/';
export const SUPPORT_KEY = 'slicc-os.support';
export const ADOBE_PROXY = 'https://adobe-llm-proxy.paolo-moz.workers.dev';
export const POLL = 10_000;
export const WAITING = 30_000;
export const RELIST = 5 * 60_000;
export const ONLY_YOU = 'Only you and Adobe Support';
export const LONGEST = 5 * 60_000;
export const PATIENCE = 60 * 60_000;
export const EARLY = 30_000;
export const GAP = 2000;
export const PAGE = 100;
export const PAGES = 20;
export const REMEMBERED = 1000;
export const NEEDED = ['AdobeID', 'openid', 'additional_info.ownerOrg'];
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DOTS = /^\.{1,2}$/;
export const TITLE_LIMIT = 120;
export const BODY_LIMIT = 2000;
export const validId = (id) => typeof id === 'string' && ID.test(id) && !DOTS.test(id);
const LONGEST_TIMER = 2 ** 31 - 1;

export const SAID = {
  invalid_input: 'Support couldn’t take that. Check what you wrote and try again.',
  key_conflict: 'That request key was already used for something else.',
  not_found: 'That request isn’t there anymore.',
  rate_limited: 'Support is busy. Try again in a minute.',
  not_enrolled: 'Support isn’t set up for this account.',
  invalid_assertion: 'Your Adobe sign-in ended. Sign in again.',
  too_long: 'That’s longer than Support takes: a message can be up to 2,000 characters.',
};
export const AGAIN = 'Support didn’t get that. Try again.';
export const SIGN_IN_FIRST = 'Sign in with Adobe first.';
export const REFUSED = 'Adobe didn’t accept the sign-in. Try again.';
export const UNSET = 'Adobe’s sign-in settings didn’t load. Try again.';
export const UNREACHABLE =
  'Seven can’t reach Adobe Support right now, so this list may be out of date.';
export const BUSY = 'Adobe Support is busy, so this list may be out of date.';

export const WWW = 'https://www.sliccy.ai';
export const SHARED_BIOS = '/7/';

export const supportBase = (bios) => `${new URL(bios).pathname}api/support/`;

export function offersSupport(origin, storage, bios = `${origin}/`) {
  if (origin === WWW) return new URL(bios).pathname === SHARED_BIOS;
  if (relayed(origin)) return true;
  try {
    return storage?.getItem(SUPPORT_KEY) === 'on';
  } catch {
    return false;
  }
}

export function scopesOf(scopes) {
  const listed = typeof scopes === 'string' ? scopes.split(',') : [];
  const named = listed.map((scope) => scope.trim()).filter(Boolean);
  return [...new Set([...named, ...NEEDED])].join(',');
}

export async function imsOptions(fetcher) {
  const response = await fetcher(`${ADOBE_PROXY}/v1/config`, {
    headers: { accept: 'application/json' },
    credentials: 'omit',
  }).catch(() => null);
  const config = response?.ok ? await response.json().catch(() => null) : null;
  if (!config || typeof config !== 'object') throw new Error(UNSET);
  return {
    clientId: SEVEN_CLIENT,
    scopes: scopesOf(config.scopes),
    imsEnvironment: Object.hasOwn(imsHosts, config.imsEnvironment) ? config.imsEnvironment : 'prod',
  };
}

export function sentence(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return REFUSED;
  const said = `${text[0].toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(said) ? said : `${said}.`;
}

export function waitOf(value, now = Date.now) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now();
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), PATIENCE) : 0;
}

export function backoff(failures, retry, random = Math.random) {
  const step = Math.min(POLL * 2 ** Math.min(failures - 1, 5), LONGEST);
  return Math.max(step / 2 + (random() * step) / 2, retry);
}

const epochOf = (value) => (typeof value === 'number' ? value : Date.parse(value) || 0);
const text = (value) => (typeof value === 'string' ? value : '');

export function summary(item) {
  return {
    id: String(item.id),
    title: text(item.title),
    lastActivity: epochOf(item.lastActivity),
    resolved: item.resolved === true,
    unread: Number.isInteger(item.unread) && item.unread > 0 ? item.unread : 0,
  };
}

export function message(item) {
  const customer = item.kind === 'customer';
  const deleted = item.deleted === true;
  return {
    id: String(item.id),
    at: epochOf(item.at),
    author: customer ? 'customer' : 'support',
    name: text(item.name) || (customer ? '' : 'Adobe Support'),
    body: deleted ? '' : text(item.body),
    ...(item.rev > 0 && !deleted ? { edited: true } : {}),
    ...(deleted ? { deleted: true } : {}),
  };
}

export function profileOf(profile) {
  const name = [profile?.displayName, profile?.name, profile?.email].find(
    (value) => typeof value === 'string' && value.trim()
  );
  const org = typeof profile?.ownerOrg === 'string' && profile.ownerOrg ? profile.ownerOrg : null;
  const user = typeof profile?.userId === 'string' && profile.userId ? profile.userId : null;
  return {
    ...(name ? { identity: name.trim() } : {}),
    ...(org ? { org } : {}),
    ...(user ? { user } : {}),
  };
}

export function unenrolled({ identity, org, user }) {
  const named = user ? (identity ? `${identity} (user ID ${user})` : `user ID ${user}`) : identity;
  return { ...(named ? { identity: named } : {}), ...(org ? { org } : {}) };
}

export const NAME_LIMIT = 200;

export function audienceOf(value, name) {
  if (value === 'individual') return ONLY_YOU;
  if (value !== 'shared' || typeof name !== 'string') return null;
  const named = name.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  if (!named || [...named].length > NAME_LIMIT) return null;
  return `Everyone at ${named} who uses Support, and Adobe Support`;
}

export function requestOf(error) {
  if (error?.request === 'pending') return { request: 'pending' };
  if (error?.request !== 'declined') return {};
  const reason = typeof error.reason === 'string' ? error.reason.trim() : '';
  return { request: 'declined', ...(reason ? { reason } : {}) };
}

class Problem extends Error {
  constructor(status, code, retry = 0, request = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.retry = retry;
    this.request = request;
  }
}

const reset = () => new DOMException('Support was signed out', 'AbortError');
const stale = (error) => error?.name === 'AbortError';

const fresh = () => ({
  controller: new AbortController(),
  token: null,
  account: {},
  channel: null,
  audience: null,
  listed: 0,
  cursor: null,
  seen: new Set(),
  enrolled: false,
  pending: false,
  busy: false,
  again: false,
  failures: 0,
  until: 0,
  last: 0,
  timer: null,
  expiry: null,
});

const root = (id) => {
  if (!validId(id)) throw new Problem(404, 'not_found');
  return `threads/${id}`;
};

export function checkText(value, limit, { line = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || (line && /[\r\n]/.test(value)))
    throw new Problem(400, 'invalid_input');
  if (value.length > limit) throw new Problem(400, 'too_long');
  return value;
}

const listOf = (value) => (Array.isArray(value) ? value : []);

class Support {
  constructor(deps) {
    this.deps = deps;
    this.listeners = { status: new Set(), threads: new Set(), thread: new Set() };
    this.status = { state: 'signed-out' };
    this.list = [];
    this.count = 0;
    this.session = null;
  }

  emit(type, value) {
    for (const listener of [...this.listeners[type]]) listener(value);
  }

  who(s) {
    const { identity, org } = s.account;
    return {
      ...(identity ? { identity } : {}),
      ...(org ? { org } : {}),
      ...(s.channel ? { channel: s.channel } : {}),
      ...(s.audience ? { audience: s.audience } : {}),
    };
  }

  show(next) {
    this.status = next;
    this.emit('status', next);
  }

  shown(items, unread) {
    this.list = items;
    this.count = unread;
    this.emit('threads', items);
  }

  live(s) {
    return this.session === s;
  }

  drop() {
    const s = this.session;
    this.session = null;
    if (!s) return;
    s.controller.abort();
    this.deps.cancel(s.timer);
    this.deps.cancel(s.expiry);
  }

  clear(next) {
    this.drop();
    this.show(next);
    this.shown([], 0);
  }

  expire(s) {
    if (this.live(s)) this.clear({ state: 'signed-out' });
  }

  async call(s, path, { method = 'GET', body, key } = {}) {
    const headers = { accept: 'application/json', authorization: `Bearer ${s.token}` };
    if (body) headers['content-type'] = 'application/json';
    if (key !== undefined) headers['idempotency-key'] = key;
    let response;
    try {
      response = await this.deps.fetch(`${this.deps.base}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: s.controller.signal,
      });
    } catch {
      if (!this.live(s)) throw reset();
      throw new Problem(0, 'unavailable');
    }
    const data = await response.json().catch(() => null);
    if (!this.live(s)) throw reset();
    if (response.ok && data && typeof data === 'object') return data;
    const code = typeof data?.error?.code === 'string' ? data.error.code : 'unavailable';
    const retry = waitOf(response.headers.get('retry-after'), this.deps.now);
    const request = code === 'not_enrolled' ? requestOf(data.error) : {};
    throw new Problem(response.status, code, retry, request);
  }

  async pages(s, path, field) {
    for (let tries = 0; ; tries += 1) {
      try {
        const first = await this.call(s, `${path}?${new URLSearchParams({ limit: PAGE })}`);
        const items = [...listOf(first[field])];
        let next = first.next;
        for (let page = 1; next && page < PAGES; page += 1) {
          const query = new URLSearchParams({ limit: PAGE, cursor: next });
          const more = await this.call(s, `${path}?${query}`);
          items.push(...listOf(more[field]));
          next = more.next;
        }
        return { first, items };
      } catch (error) {
        if (error.code !== 'cursor_expired' || tries > 0) throw error;
      }
    }
  }

  async relist(s) {
    const { first, items } = await this.pages(s, 'threads', 'items');
    return {
      items: items.filter((item) => item && validId(String(item.id))).map(summary),
      unread: Number.isInteger(first.unreadThreads) ? first.unreadThreads : 0,
      cursor: typeof first.changeCursor === 'string' ? first.changeCursor : null,
      audience: audienceOf(first.audience, first.audienceName),
    };
  }

  keep(s, listed) {
    s.audience = listed.audience;
    s.listed = this.deps.now();
    this.shown(listed.items, listed.unread);
  }

  async load(s) {
    const listed = await this.relist(s);
    if (!listed.cursor) throw new Problem(503, 'unavailable');
    s.cursor = listed.cursor;
    s.seen = new Set();
    this.keep(s, listed);
  }

  remember(s, ids) {
    for (const id of ids) s.seen.add(id);
    for (const id of s.seen) {
      if (s.seen.size <= REMEMBERED) break;
      s.seen.delete(id);
    }
  }

  async changes(s) {
    let after = s.cursor;
    const events = [];
    let unread = this.count;
    for (let page = 0; page < PAGES; page += 1) {
      const batch = await this.call(s, `changes?${new URLSearchParams({ after })}`);
      if (typeof batch.next !== 'string') throw new Problem(503, 'unavailable');
      events.push(...listOf(batch.events));
      if (Number.isInteger(batch.unreadThreads)) unread = batch.unreadThreads;
      after = batch.next;
      if (batch.hasMore !== true) break;
    }
    return { events, unread, after };
  }

  async drain(s) {
    const { events, unread, after } = await this.changes(s);
    const unseen = events.filter((event) => typeof event?.id === 'string' && !s.seen.has(event.id));
    const ids = unseen.map((event) => event.threadId).filter((id) => typeof id === 'string');
    if (unseen.length || this.deps.now() - s.listed >= RELIST) {
      this.keep(s, await this.relist(s));
    } else if (unread !== this.count) {
      this.shown(this.list, unread);
    }
    this.remember(
      s,
      unseen.map((event) => event.id)
    );
    s.cursor = after;
    for (const id of new Set(ids)) this.emit('thread', id);
  }

  later(s, ms) {
    if (!this.live(s)) return;
    this.deps.cancel(s.timer);
    s.timer = null;
    if (!this.deps.visible()) return;
    const run = () => {
      s.timer = null;
      void this.poll(s);
    };
    s.timer = this.deps.schedule(run, Math.min(ms, LONGEST_TIMER));
  }

  wake() {
    const s = this.session;
    if (!s?.token || !(s.enrolled || s.pending)) return;
    if (s.busy) {
      s.again = true;
      return;
    }
    const now = this.deps.now();
    this.later(s, Math.max(0, s.until - now, s.last + GAP - now));
  }

  unenroll(s, request) {
    s.enrolled = false;
    s.pending = request.request === 'pending';
    s.cursor = null;
    s.audience = null;
    s.failures = 0;
    s.until = 0;
    s.last = this.deps.now();
    this.deps.cancel(s.timer);
    s.timer = null;
    const next = { ...this.who(s), ...unenrolled(s.account), state: 'not-enrolled', ...request };
    if (JSON.stringify(next) !== JSON.stringify(this.status)) this.show(next);
    if (this.list.length || this.count) this.shown([], 0);
    if (s.pending) this.later(s, WAITING);
  }

  trouble(s, error) {
    if (stale(error) || !this.live(s)) return;
    if (error.status === 401) return this.expire(s);
    if (error.code === 'not_enrolled') return this.unenroll(s, error.request);
    if (s.pending) {
      s.failures += 1;
      const wait = Math.max(backoff(s.failures, error.retry, this.deps.random), WAITING);
      s.until = this.deps.now() + wait;
      return this.later(s, wait);
    }
    if (error.code === 'cursor_expired' || error.code === 'invalid_cursor') {
      s.cursor = null;
      return this.later(s, 0);
    }
    s.failures += 1;
    const wait = backoff(s.failures, error.retry, this.deps.random);
    s.until = this.deps.now() + wait;
    const detail = error.status === 429 ? BUSY : UNREACHABLE;
    this.show({ ...this.who(s), state: 'offline', detail });
    this.later(s, wait);
  }

  async poll(s) {
    if (!this.live(s) || s.busy || !(s.enrolled || s.pending) || !this.deps.visible()) return;
    s.busy = true;
    try {
      if (s.cursor) await this.drain(s);
      else await this.load(s);
      s.enrolled = true;
      s.pending = false;
      s.failures = 0;
      s.until = 0;
      s.last = this.deps.now();
      if (this.status.state !== 'ready' || this.status.audience !== (s.audience ?? undefined))
        this.show({ ...this.who(s), state: 'ready' });
      this.later(s, POLL);
    } catch (error) {
      this.trouble(s, error);
    } finally {
      s.busy = false;
    }
    if (s.again && this.live(s) && (s.enrolled || s.pending)) {
      s.again = false;
      this.wake();
    }
  }

  async profile(s, config) {
    const ims = imsHosts[config?.imsEnvironment] ?? imsHosts.prod;
    const response = await this.deps
      .fetch(`${ims}/ims/profile/v1`, {
        headers: { accept: 'application/json', authorization: `Bearer ${s.token}` },
        credentials: 'omit',
        signal: s.controller.signal,
      })
      .catch(() => null);
    if (!this.live(s)) throw reset();
    if (response?.status === 401 || response?.status === 403) throw new Error(REFUSED);
    const found = response?.ok ? await response.json().catch(() => null) : null;
    if (!this.live(s)) throw reset();
    return profileOf(found);
  }

  expiring(s, expiresIn) {
    if (!(expiresIn > 0)) return;
    const ms = Math.max(0, expiresIn * 1000 - EARLY);
    s.expiry = this.deps.schedule(() => this.expire(s), Math.min(ms, LONGEST_TIMER));
  }

  async signIn() {
    this.drop();
    const s = fresh();
    this.session = s;
    this.show({ state: 'signing-in' });
    this.shown([], 0);
    let config = null;
    const asked = async () => {
      config = await this.deps.options();
      return config;
    };
    try {
      const got = await this.deps.grant('adobe', asked, { signal: s.controller.signal });
      if (!this.live(s)) return;
      s.token = got.token;
      this.expiring(s, got.expiresIn);
      s.account = await this.profile(s, config);
    } catch (error) {
      if (!this.live(s)) return;
      this.clear({ state: 'signed-out' });
      throw new Error(stale(error) ? 'The sign-in was cancelled.' : sentence(error?.message));
    }
    s.enrolled = true;
    this.show({ ...this.who(s), state: 'loading' });
    void this.poll(s);
  }

  failed(s, error) {
    if (stale(error) || !this.live(s)) return reset();
    if (error.status === 401) {
      this.expire(s);
      return new Error(SAID.invalid_assertion);
    }
    if (error.code === 'not_enrolled') this.unenroll(s, error.request);
    return new Error(SAID[error.code] ?? AGAIN);
  }

  async write(work) {
    const s = this.session;
    if (!s?.token) throw new Error(SIGN_IN_FIRST);
    try {
      return await work(s);
    } catch (error) {
      throw this.failed(s, error);
    }
  }

  thread(id) {
    return this.write(async (s) => {
      const { first, items } = await this.pages(s, root(id), 'messages');
      return {
        id: String(first.id ?? id),
        title: text(first.title),
        resolved: first.resolved === true,
        messages: items.filter(Boolean).map(message),
      };
    });
  }

  create({ key, title, body, topic }) {
    return this.write(async (s) => {
      checkText(title, TITLE_LIMIT, { line: true });
      checkText(body, BODY_LIMIT);
      const made = await this.call(s, 'threads', {
        method: 'POST',
        key,
        body: { title, body, ...(topic ? { topic } : {}) },
      });
      if (typeof made.channelName === 'string' && made.channelName !== s.channel) {
        s.channel = made.channelName;
        this.show({ ...this.status, channel: s.channel });
      }
      this.wake();
      return { id: String(made.threadId) };
    });
  }

  reply({ key, thread, body }) {
    return this.write(async (s) => {
      const path = `${root(thread)}/replies`;
      checkText(body, BODY_LIMIT);
      const made = await this.call(s, path, { method: 'POST', key, body: { body } });
      this.wake();
      return { id: String(made.id) };
    });
  }

  read(id, through) {
    return this.write(async (s) => {
      const path = `${root(id)}/read`;
      if (!validId(through)) throw new Problem(404, 'not_found');
      const done = await this.call(s, path, { method: 'PUT', body: { through } });
      const items = this.list.map((item) => (item.id === id ? { ...item, unread: 0 } : item));
      this.shown(items, Number.isInteger(done.unreadThreads) ? done.unreadThreads : this.count);
    });
  }
}

export function createSupport({
  grant,
  fetch: fetcher = (...args) => globalThis.fetch(...args),
  options = () => imsOptions(fetcher),
  base = SUPPORT_API,
  now = () => Date.now(),
  random = Math.random,
  schedule = (run, ms) => setTimeout(run, ms),
  cancel = (id) => clearTimeout(id),
  visible = () => globalThis.document?.visibilityState !== 'hidden',
  watch = (wake) => {
    globalThis.document?.addEventListener?.('visibilitychange', wake);
    globalThis.addEventListener?.('focus', wake);
    globalThis.addEventListener?.('online', wake);
  },
}) {
  const deps = { grant, fetch: fetcher, options, base, now, random, schedule, cancel, visible };
  const support = new Support(deps);
  watch(() => support.wake());
  return {
    on(type, listener) {
      if (!Object.hasOwn(support.listeners, type)) return () => undefined;
      support.listeners[type].add(listener);
      return () => support.listeners[type].delete(listener);
    },
    status: () => support.status,
    threads: () => support.list,
    unread: () => support.count,
    signIn: () => support.signIn(),
    signOut: async () => support.clear({ state: 'signed-out' }),
    thread: (id) => support.thread(id),
    create: (draft) => support.create(draft),
    reply: (reply) => support.reply(reply),
    read: (id, through) => support.read(id, through),
  };
}
