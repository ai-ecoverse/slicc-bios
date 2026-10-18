import { certificate } from './follow.js';

export const PAIR_KEY = 'slicc-pair';
export const PAIRED_KEY = 'slicc-os.paired';
export const PAIR_PATH = '/slicc/v1/pair';
export const SIGNAL_PATH = '/slicc/v1/signal';
export const FIRST_PORT = 17117;
export const LAST_PORT = 17126;
export const CERT = 'loopback';
export const UNLINK_MS = 5_000;
export const GATHER_MS = 10_000;
export const POST_MS = 15_000;
export const PROMPT_MS = 120_000;
export const BACKOFF_MIN = 1_000;
export const BACKOFF_MAX = 30_000;
export const NOT_A_LINK = 'That isn’t a pairing link from slicc pair.';
export const BUSY = 'Seven is already linking a computer.';
export const NOTHING = 'There’s no pairing to confirm.';
const VALUE = /^(\d{1,5})\.([A-Za-z0-9_-]{22})\.([0-9a-f]{64})$/;
const PERMISSIONS = ['loopback-network', 'local-network-access', 'local-network'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export const short = (fp) => `${fp.slice(0, 4)}…${fp.slice(-2)}`;

const refusal = (code, message) => Object.assign(new Error(message), { code });

export function pairingValue(text) {
  const raw = String(text ?? '').trim();
  const at = raw.indexOf('#');
  return new URLSearchParams(at < 0 ? raw : raw.slice(at + 1)).get(PAIR_KEY);
}

export function parsePairing(text) {
  const found = VALUE.exec(pairingValue(text) ?? '');
  if (!found) throw new Error(NOT_A_LINK);
  const port = Number(found[1]);
  if (port >= 9222 && port <= 9229)
    throw new Error(`Seven never pairs over port ${port}: it’s a browser’s debugging port.`);
  if (port < 1024 || port > 65535)
    throw new Error(`Seven never pairs over port ${port}: slicc listens on ports 1024 to 65535.`);
  return { port, token: found[2], fingerprint: found[3] };
}

export function takePairing({ location: at = location, history: past = history } = {}) {
  const params = new URLSearchParams(at.hash.slice(1));
  if (!params.has(PAIR_KEY)) return null;
  const value = params.get(PAIR_KEY);
  params.delete(PAIR_KEY);
  const rest = params.toString();
  past.replaceState(past.state, '', `${at.pathname}${at.search}${rest ? `#${rest}` : ''}`);
  return `#${PAIR_KEY}=${value}`;
}

export function sdpFingerprint(sdp) {
  let found = null;
  for (const line of String(sdp ?? '').split(/\r?\n/)) {
    const match = /^a=fingerprint:(\S+) (\S+)$/.exec(line);
    if (match?.[1].toLowerCase() !== 'sha-256') continue;
    const value = match[2].replaceAll(':', '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value) || (found && found !== value)) return null;
    found = value;
  }
  return found;
}

export function signalPorts(remembered) {
  const range = Array.from({ length: LAST_PORT - FIRST_PORT + 1 }, (_, n) => FIRST_PORT + n);
  return [remembered, ...range.filter((port) => port !== remembered)];
}

export const backoff = (tries) => Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** tries);

function load(storage) {
  try {
    const kept = JSON.parse(storage.getItem(PAIRED_KEY));
    if (!kept || typeof kept !== 'object' || Array.isArray(kept)) return {};
    return Object.fromEntries(
      Object.entries(kept).filter(
        ([fp, pin]) => /^[0-9a-f]{64}$/.test(fp) && Number.isInteger(pin?.port)
      )
    );
  } catch {
    return {};
  }
}

export function localNetwork(
  permissions = globalThis.navigator?.permissions,
  here = globalThis.location?.hostname
) {
  if (LOOPBACK.has(here)) return { ready: Promise.resolve(), state: () => 'granted' };
  let state = null;
  const watch = async () => {
    for (const name of PERMISSIONS) {
      const found = await permissions?.query({ name }).catch(() => null);
      if (!found) continue;
      state = found.state;
      found.addEventListener?.('change', () => {
        state = found.state;
      });
      return;
    }
  };
  const ready = watch();
  return { ready, state: () => state };
}

const BLOCKED =
  'This browser blocks seven from reaching apps on this computer. Allow local network access in this site’s settings, then try again.';
export const MIXED =
  'This browser doesn’t let an https page reach slicc on this computer, so seven can’t pair here. Use the join command under Link another device, or open seven in Chrome, Edge or Firefox.';
const UNREACHABLE = (port) =>
  `Nothing answered on port ${port}, or slicc refused this page’s origin: is slicc still running on this computer?`;
const UNPREPARED =
  'Seven couldn’t prepare the link: this browser gave it no network addresses for it.';
const REFUSED =
  'slicc refused this pairing link: it’s wrong, already used or expired. Press Enter in slicc for a new one.';

export function mixedBlocked(scope = globalThis) {
  return scope.location?.protocol === 'https:' && /^Apple/.test(scope.navigator?.vendor ?? '');
}

export function loopbackPost({ fetcher, lna, waiting, timers, mixed = () => false }) {
  return async (port, path, body, cancel) => {
    waiting(1);
    const deadline = new AbortController();
    const timer = timers.setTimeout(
      () => deadline.abort(new Error('no answer in time')),
      lna.state() === 'prompt' ? PROMPT_MS : POST_MS
    );
    const signal = cancel ? AbortSignal.any([cancel, deadline.signal]) : deadline.signal;
    let response;
    try {
      response = await fetcher(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        signal,
      });
    } catch {
      if (cancel?.aborted) throw cancel.reason;
      if (lna.state() === 'denied') throw refusal('blocked', BLOCKED);
      if (mixed()) throw refusal('blocked', MIXED);
      throw refusal('unreachable', UNREACHABLE(port));
    } finally {
      timers.clearTimeout(timer);
      waiting(-1);
    }
    if (!response.ok) throw refusal('refused', REFUSED);
    const value = await response.json().catch(() => null);
    if (typeof value?.answer !== 'string')
      throw refusal('malformed', `slicc on port ${port} sent no answer.`);
    return value;
  };
}

export function answeredBy(fp, port, value) {
  if (sdpFingerprint(value.answer) !== fp)
    throw refusal(
      'fingerprint',
      `Something else answered on port ${port}, not the slicc that made this link.`
    );
}

const key = (fp) => `pair:${fp}`;

const dropped = (links, link, reason) => {
  if (links.links.get(link.key) === link) links.drop(link.key, reason);
};

function until(links, link) {
  return new Promise((resolve) => {
    const check = () => {
      if (links.links.get(link.key) === link) return;
      off();
      resolve();
    };
    const off = links.on(check);
    check();
  });
}

export function loopbackOffer({ links, mint, address, timers }) {
  return async (fp) => {
    const certificates = [await mint()];
    let gathered;
    const sdp = new Promise((resolve) => {
      gathered = resolve;
    });
    const link = links.start({
      key: key(fp),
      mode: 'local',
      certificates,
      send: (message) => {
        if (message.t === 'candidate' && message.candidate === null)
          gathered(link.pc.localDescription.sdp);
      },
    });
    link.paired = true;
    links.identify(key(fp), fp, address(fp));
    const gone = until(links, link).then(() => {
      throw refusal('gone', 'The link closed before it was set up.');
    });
    gone.catch(() => {});
    const timer = timers.setTimeout(() => gathered(link.pc.localDescription?.sdp), GATHER_MS);
    try {
      const offered = await Promise.race([sdp, gone]);
      if (!offered) throw refusal('gathering', UNPREPARED);
      return { link, sdp: offered, gone };
    } catch (error) {
      dropped(links, link, 'no offer');
      throw error;
    } finally {
      timers.clearTimeout(timer);
    }
  };
}

export function keeper({ timers, live, reconnect }) {
  const state = { tries: 0, timer: null, busy: false, stopped: false };
  const run = async () => {
    state.timer = null;
    if (state.stopped || state.busy || live()) return;
    state.busy = true;
    try {
      await reconnect();
      state.tries = 0;
    } catch {
      state.tries += 1;
    } finally {
      state.busy = false;
    }
    check();
  };
  const check = () => {
    if (state.stopped || state.busy || state.timer || live()) return;
    state.timer = timers.setTimeout(run, backoff(state.tries));
  };
  return {
    check,
    wake() {
      if (state.busy || live()) return;
      timers.clearTimeout(state.timer);
      state.timer = null;
      void run();
    },
    stop() {
      state.stopped = true;
      timers.clearTimeout(state.timer);
    },
  };
}

const forgottenNote = (pin) =>
  `${String(pin.name ?? 'slicc').replace(/^slicc\b/i, 'SLICC')} no longer knows this seven. Pair it again.`;

export function pinRow(id, pin) {
  return {
    id,
    name: pin.name ?? 'slicc on this computer',
    host: pin.label ? `${pin.label}.slicc.internal` : '',
    address: pin.address ?? '',
    mode: 'local',
    kind: 'cli',
    offers: pin.offers ?? [],
    ...(pin.policy ? { policy: pin.policy } : {}),
    exit: Boolean(pin.exit),
    state: 'offline',
    ...(pin.forgotten ? { note: forgottenNote(pin) } : {}),
  };
}

export function pinOf(pin, link) {
  const { peer } = link;
  const caps = Array.isArray(peer.caps) ? peer.caps : [];
  return {
    ...pin,
    ...(typeof peer.name === 'string' ? { name: peer.name } : {}),
    label: link.label,
    address: link.address,
    offers: ['net', 'http', 'ssh'].filter((offer) => caps.includes(offer)),
    exit: Boolean(peer.routes?.exit) && caps.includes('net'),
    ...(typeof peer.policy?.summary === 'string' ? { policy: peer.policy.summary } : {}),
  };
}

export async function unlinkLoopback(link, timers) {
  if (!link?.peer || !link.offer.session.caps().includes('unlink-loopback')) return false;
  const timeout = new Promise((resolve) => timers.setTimeout(resolve, UNLINK_MS, null));
  const stream = await Promise.race([
    link.offer.session.open({ kind: 'unlink' }, { shared: true }),
    timeout,
  ]).catch(() => null);
  if (!stream) return false;
  stream.closeWrite();
  await Promise.race([stream.settled, timeout]);
  return true;
}

function attempts({ show, shown, pairWith, lna }) {
  let pending = null;
  return {
    async begin(text, { arrived = false } = {}) {
      if (shown().state === 'linking') throw new Error(BUSY);
      let found;
      try {
        found = parsePairing(text);
      } catch (error) {
        if (!arrived) throw error;
        show({ state: 'failed', error: error.message });
        return;
      }
      pending = { pairing: found };
      show({ state: 'confirm', code: short(found.fingerprint) });
    },
    refuse(error) {
      if (shown().state === 'linking') return;
      pending = null;
      show({ state: 'failed', error });
    },
    async confirm() {
      if (shown().state !== 'confirm' || !pending) throw new Error(NOTHING);
      const attempt = pending;
      attempt.abort = new AbortController();
      const code = short(attempt.pairing.fingerprint);
      show({ state: 'linking', code });
      try {
        await lna.ready;
        const name = await pairWith(attempt.pairing, attempt.abort.signal);
        if (pending === attempt) show({ state: 'linked', code, name });
      } catch (error) {
        if (pending === attempt) show({ state: 'failed', code, error: error.message });
      }
      if (pending === attempt) pending = null;
    },
    async cancel() {
      const attempt = pending;
      pending = null;
      attempt?.abort?.abort(new Error('cancelled'));
      show({ state: 'idle' });
    },
  };
}

export function createPairing({
  links,
  storage = localStorage,
  fetch: fetcher = (...args) => fetch(...args),
  certificate: mint = () => certificate(CERT),
  timers = globalThis,
  scope = globalThis,
  lna = localNetwork(),
  mixed = () => mixedBlocked(),
}) {
  const pins = load(storage);
  const listeners = new Set();
  const keepers = new Map();
  let shown = { state: 'idle' };
  let waiting = 0;
  let running = false;
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const save = () => storage.setItem(PAIRED_KEY, JSON.stringify(pins));
  const live = (fp) => {
    const link = links.links.get(key(fp));
    return link && !link.offer.session.closed() ? link : null;
  };
  const post = loopbackPost({
    fetcher,
    lna,
    timers,
    mixed,
    waiting: (n) => {
      waiting += n;
      changed();
    },
  });
  const offer = loopbackOffer({ links, mint, timers, address: (fp) => pins[fp]?.address });

  async function pairWith({ port, token, fingerprint: fp }, signal) {
    const { link, sdp } = await offer(fp);
    let value;
    try {
      value = await post(port, PAIR_PATH, { token, offer: sdp }, signal);
      answeredBy(fp, port, value);
    } catch (error) {
      dropped(links, link, 'not paired');
      throw error;
    }
    const name = typeof value.name === 'string' && value.name ? value.name : pins[fp]?.name;
    pins[fp] = { ...pins[fp], port, ...(name ? { name } : {}) };
    delete pins[fp].forgotten;
    save();
    keep(fp);
    if (live(fp) === link) {
      await link.offer.receive({ t: 'answer', sdp: value.answer }).catch(() => {});
      await link.offer.session.ready.catch(() => {});
    }
    return live(fp)?.peer?.name ?? pins[fp].name ?? 'slicc on this computer';
  }

  async function reconnect(fp) {
    const pin = pins[fp];
    const { link, sdp, gone } = await offer(fp);
    let refused = false;
    for (const port of signalPorts(pin.port)) {
      try {
        const value = await Promise.race([post(port, SIGNAL_PATH, { offer: sdp }), gone]);
        answeredBy(fp, port, value);
        pin.port = port;
        delete pin.forgotten;
        save();
        changed();
        await link.offer.receive({ t: 'answer', sdp: value.answer });
        return;
      } catch (error) {
        if (error.code === 'gone') throw error;
        if (port === pin.port && error.code === 'refused') refused = true;
      }
    }
    dropped(links, link, 'no slicc answered');
    if (refused && !pin.forgotten) {
      pin.forgotten = true;
      save();
      changed();
    }
    throw refusal('unreachable', 'no slicc answered');
  }

  function keep(fp) {
    if (!running || keepers.has(fp)) return;
    const kept = keeper({ timers, live: () => live(fp), reconnect: () => reconnect(fp) });
    keepers.set(fp, kept);
    kept.check();
  }

  const wake = () => {
    for (const kept of keepers.values()) kept.wake();
  };

  links.on(() => {
    let dirty = false;
    for (const fp of Object.keys(pins)) {
      const link = live(fp);
      if (!link?.peer) continue;
      const next = pinOf(pins[fp], link);
      if (JSON.stringify(next) === JSON.stringify(pins[fp])) continue;
      Object.assign(pins[fp], next);
      dirty = true;
    }
    if (dirty) save();
    for (const kept of keepers.values()) kept.check();
  });

  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => ({ ...shown }),
    permission: () => {
      const state = lna.state();
      if (waiting && state === 'prompt') return 'prompt';
      return state === 'denied' && Object.keys(pins).length ? 'denied' : null;
    },
    known: (id) => Object.hasOwn(pins, id),
    describe: (link) => (pins[link.id]?.forgotten ? { note: forgottenNote(pins[link.id]) } : {}),
    away: () =>
      Object.entries(pins)
        .filter(([fp]) => !live(fp))
        .map(([id, pin]) => pinRow(id, pin)),
    start() {
      if (running) return;
      running = true;
      for (const fp of Object.keys(pins)) delete pins[fp];
      Object.assign(pins, load(storage));
      for (const fp of Object.keys(pins)) keep(fp);
      scope.addEventListener?.('online', wake);
      scope.document?.addEventListener?.('visibilitychange', () => {
        if (scope.document.visibilityState === 'visible') wake();
      });
    },
    wake,
    ...attempts({
      show: (next) => {
        shown = next;
        changed();
      },
      shown: () => shown,
      pairWith,
      lna,
    }),
    async forget(fp) {
      keepers.get(fp)?.stop();
      keepers.delete(fp);
      await unlinkLoopback(live(fp), timers);
      delete pins[fp];
      save();
      links.drop(key(fp), 'unlinked');
      changed();
    },
  };
}
