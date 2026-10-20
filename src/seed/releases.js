import { compare } from './packages.js';
import { production } from './site.js';

export const API = 'https://api.github.com';
export const GITHUB_PAGES = 'https://github.com/';
export const REGISTRY = 'https://registry.npmjs.org';
export const ORIGIN_KEY = 'slicc-os.releases-origin';
export const MAX_RELEASES = 30;
export const MAX_NOTES = 64 * 1024;
export const PER_PAGE = 100;
export const PAGES = 5;
export const TTL = 24 * 60 * 60 * 1000;
export const BACKOFF = 15 * 60 * 1000;
const TIMEOUT = 10000;
const DB = 'slicc-releases';
const STORE = 'cache';
const BLOCKED = 'blocked';
const GITHUB =
  /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i;
const SHORT = /^(?:git@github\.com:|github:)([^/]+)\/([^/#?]+?)(?:\.git)?$/i;
const NAME = /^[A-Za-z0-9_.-]+$/;

export function repoOf(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (typeof url !== 'string') return null;
  const match = url.trim().match(GITHUB) ?? url.trim().match(SHORT);
  if (!match || !NAME.test(match[1]) || !NAME.test(match[2])) return null;
  return `${match[1]}/${match[2]}`;
}

export function shortName(name) {
  return name.slice(name.lastIndexOf('/') + 1);
}

export function versionOf(tag, { short = null, own = false } = {}) {
  if (typeof tag !== 'string') return null;
  if (short && tag.startsWith(`${short}-`) && /^\d/.test(tag.slice(short.length + 1))) {
    return tag.slice(short.length + 1);
  }
  if (own && /^v?\d+\.\d+/.test(tag)) return tag.replace(/^v/, '');
  return null;
}

export function truncate(text) {
  if (text.length <= MAX_NOTES) return text;
  const cut = text.slice(0, MAX_NOTES);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function within(items, { from, to, short, own }) {
  const picked = [];
  for (const item of items) {
    const version = versionOf(item.tag, { short, own });
    if (!version || typeof item.url !== 'string' || !item.url.startsWith(GITHUB_PAGES)) continue;
    const fits =
      from === null || from === undefined
        ? version === to
        : version === from || (compare(version, from) > 0 && compare(version, to) <= 0);
    if (!fits) continue;
    const release = { version, url: item.url };
    if (typeof item.body === 'string' && item.body) release.notes = truncate(item.body);
    picked.push(release);
  }
  return picked.sort((a, b) => compare(b.version, a.version)).slice(0, MAX_RELEASES);
}

function covered(items, want) {
  const until = want.from === null || want.from === undefined ? want.to : want.from;
  return items.some((item) => versionOf(item.tag, want) === until);
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbStore(idb = globalThis.indexedDB) {
  async function use(mode, act) {
    const opening = idb.open(DB, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
    const db = await request(opening);
    try {
      return await request(act(db.transaction(STORE, mode).objectStore(STORE)));
    } finally {
      db.close();
    }
  }
  return {
    get: (key) => use('readonly', (store) => store.get(key)).catch(() => undefined),
    put: (key, value) => use('readwrite', (store) => store.put(value, key)).catch(() => undefined),
  };
}

export function apiOrigin({
  origin = globalThis.location?.origin,
  storage = globalThis.localStorage,
  report = (message) => console.error(message),
} = {}) {
  let wanted = null;
  try {
    wanted = storage?.getItem(ORIGIN_KEY) ?? null;
  } catch {
    wanted = null;
  }
  if (production(URL.parse(origin ?? '')?.host)) {
    if (wanted !== null) report(`releases: ${ORIGIN_KEY} is refused on ${origin}; using ${API}`);
    return API;
  }
  if (wanted === null) return API;
  const parsed = URL.parse(wanted);
  if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.origin !== wanted) {
    report(`releases: ${ORIGIN_KEY} must be an http(s) origin; using ${API}`);
    return API;
  }
  return parsed.origin;
}

const plain = { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' };

function item(release) {
  return { tag: release.tag_name, url: release.html_url, body: release.body ?? null };
}

function blockUntil(response, now) {
  const retry = Number(response.headers.get('retry-after'));
  if (retry > 0) return now() + retry * 1000;
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (reset > 0 && response.headers.get('x-ratelimit-remaining') === '0') return reset * 1000;
  return now() + BACKOFF;
}

export function createReleases({
  fetcher = (...args) => globalThis.fetch(...args),
  store = idbStore(),
  now = Date.now,
  origin = apiOrigin(),
  registry = REGISTRY,
} = {}) {
  let blocked = null;

  async function isBlocked() {
    blocked ??= (await store.get(BLOCKED)) ?? 0;
    return blocked > now();
  }

  async function block(until) {
    blocked = until;
    await store.put(BLOCKED, until);
  }

  async function page(repo, n, etag) {
    const headers = { accept: 'application/vnd.github+json' };
    if (etag) headers['if-none-match'] = etag;
    const url = `${origin}/repos/${repo}/releases?per_page=${PER_PAGE}&page=${n}`;
    const response = await fetcher(url, {
      ...plain,
      headers,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (response.status === 403 || response.status === 429) {
      await block(blockUntil(response, now));
      return { failed: true };
    }
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      await block(blockUntil(response, now));
    }
    if (response.status === 304) return { same: true };
    if (!response.ok) return { failed: true };
    const list = await response.json();
    if (!Array.isArray(list)) return { failed: true };
    return { etag: response.headers.get('etag'), items: list.map(item) };
  }

  function round() {
    const repos = new Map();
    const docs = new Map();

    async function load(repo) {
      const kept = await store.get(`repo:${repo}`);
      if (!kept || now() - kept.at > TTL) return { at: 0, pages: [], end: false };
      return kept;
    }

    async function fill(repo, state, want) {
      while (
        !state.end &&
        state.pages.length < PAGES &&
        !covered(
          state.pages.flatMap((one) => one.items),
          want
        )
      ) {
        if (await isBlocked()) return;
        const got = await page(repo, state.pages.length + 1, null);
        if (got.failed || got.same) return;
        state.pages.push({ etag: got.etag, items: got.items });
        state.end = got.items.length < PER_PAGE;
        state.dirty = true;
      }
    }

    async function first(repo) {
      if (await isBlocked()) return null;
      const kept = await load(repo);
      const got = await page(repo, 1, kept.pages[0]?.etag ?? null);
      if (got.failed) return null;
      if (got.same) return { pages: kept.pages, end: kept.end, dirty: true };
      return {
        pages: [{ etag: got.etag, items: got.items }],
        end: got.items.length < PER_PAGE,
        dirty: true,
      };
    }

    async function items(repo, want) {
      if (!repos.has(repo))
        repos.set(
          repo,
          first(repo).catch(() => null)
        );
      const state = await repos.get(repo);
      if (!state) return null;
      await fill(repo, state, want).catch(() => undefined);
      if (state.dirty) {
        state.dirty = false;
        await store.put(`repo:${repo}`, { at: now(), pages: state.pages, end: state.end });
      }
      return state.pages.flatMap((one) => one.items);
    }

    async function repository(name, version) {
      const key = `npm:${name}@${version}`;
      if (!docs.has(key)) {
        docs.set(
          key,
          (async () => {
            const kept = await store.get(key);
            if (kept !== undefined) return kept.repo;
            const response = await fetcher(
              `${registry}/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`,
              { ...plain, signal: AbortSignal.timeout(TIMEOUT) }
            );
            if (!response.ok) return null;
            const repo = repoOf((await response.json()).repository);
            await store.put(key, { repo });
            return repo;
          })().catch(() => null)
        );
      }
      return docs.get(key);
    }

    return { items, repository };
  }

  return { round };
}

export const REPOS = {
  kernel: 'ai-ecoverse/slicc-kernel',
  ui: 'ai-ecoverse/slicc-spectrum',
  agent: 'ai-ecoverse/slicc-agent',
  tailscale: 'ai-ecoverse/wasm-tailscale',
};

function picked(kept, from, to) {
  if (!kept || !to) return undefined;
  const list = within(kept.items, { from, to, short: kept.short, own: kept.own });
  return list.length ? list : undefined;
}

export const WAIT = 3000;
export const OWNER = 'ai-ecoverse';

function bounded(work, wait, late) {
  let timer = null;
  let slow = false;
  const done = work.then(() => {
    clearTimeout(timer);
    if (slow) late();
  });
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      slow = true;
      resolve();
    }, wait);
  });
  return Promise.race([done, deadline]);
}

export function createNotes({ releases, repos = REPOS, wait = WAIT }) {
  const rows = new Map();
  let known = new Map();
  let current = null;
  let port = null;
  const renote = () => port?.renote();
  return {
    prepare(updates) {
      port = updates;
      const round = releases.round();
      current = round;
      const work = Promise.all(
        Object.entries(repos).map(async ([id, repo]) => {
          const { from = null, to = null } = updates.get(id) ?? {};
          if (!to) return;
          const want = { from, to, own: true, short: null };
          const found = await round.items(repo, want).catch(() => null);
          if (found) rows.set(id, { items: found, own: true, short: null });
          else rows.delete(id);
        })
      );
      return bounded(work, wait, renote);
    },
    pick(id, from, to) {
      return picked(rows.get(id), from, to);
    },
    packages(list) {
      const round = current ?? releases.round();
      const work = (async () => {
        const found = new Map();
        for (const row of list) {
          const to = row.offered ?? row.version;
          if (!to) continue;
          const repo = await round.repository(row.package, row.version ?? to).catch(() => null);
          if (!repo?.startsWith(`${OWNER}/`)) continue;
          const short = shortName(row.package);
          const own = shortName(repo).toLowerCase() === short.toLowerCase();
          const want = { from: row.version, to, short, own };
          const items = await round.items(repo, want).catch(() => null);
          if (items) found.set(row.id, { items, short, own });
        }
        known = found;
      })();
      return bounded(work, wait, renote);
    },
    annotate(list) {
      return list.map((row) => {
        const releases = picked(known.get(row.id), row.version, row.offered ?? row.version);
        return releases ? { ...row, releases } : row;
      });
    },
  };
}
