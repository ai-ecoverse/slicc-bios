import { createKernel, fetchTransport } from '@ai-ecoverse/slicc-kernel';
import '@ai-ecoverse/slicc-spectrum/ui';
import { followGuest, installAgent, loadChat } from './agent.js';
import { createFollow, hubClient, hubOrigin, hubs, joinUrl } from './follow.js';
import { home } from './site.js';

export const SEAT_KEY = 'slicc-os.seat';
export const REFUSED = 'This guest link isn’t valid any more.';
export const CONNECTING = 'Connecting to the host…';
export const RETRY_MS = 2_000;
const NOWHERE = { setItem() {}, removeItem() {} };

export function takeSeat({
  location: at = location,
  history: past = history,
  storage = sessionStorage,
  allowed = hubs(localStorage),
} = {}) {
  const params = new URLSearchParams(at.hash.slice(1));
  if (params.has('seat')) {
    const url = joinUrl(params.get('seat'), allowed);
    params.delete('seat');
    const rest = params.toString();
    past.replaceState(past.state, '', `${at.pathname}${at.search}${rest ? `#${rest}` : ''}`);
    if (url) storage.setItem(SEAT_KEY, url);
    else storage.removeItem(SEAT_KEY);
  }
  const url = joinUrl(storage.getItem(SEAT_KEY), allowed);
  return url ? { hub: hubOrigin(url), url } : null;
}

export function unlabeled(model) {
  const { agent } = model;
  const messages = (...args) =>
    agent
      .messages(...args)
      .map((message) =>
        message.role === 'assistant' && message.model ? { ...message, model: undefined } : message
      );
  return {
    ...model,
    agent: new Proxy(agent, {
      get(target, key) {
        if (key === 'messages') return messages;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
}

export function freshCertificate() {
  return RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
}

export function joinSeat({
  kept,
  show,
  say,
  post,
  makePeer,
  prepare = async () => undefined,
  connect = (open) => followGuest(open),
  create = async (connection) => unlabeled((await loadChat()).createAgentModel(connection, {})),
  storage = sessionStorage,
  cert = freshCertificate,
  timers = globalThis,
  tab = crypto.randomUUID(),
}) {
  const follow = createFollow({
    kept,
    storage: NOWHERE,
    post,
    makePeer,
    cert,
    forget: async () => undefined,
    hello: () => ({ name: 'SLICC guest', mode: 'remote', kind: 'guest', caps: [], node: tab }),
    timers,
  });
  let connection = null;
  let busy = false;
  let again = false;
  let over = false;
  let retry = null;
  const drop = () => {
    const old = connection;
    connection = null;
    show(null);
    void old?.close().catch(() => undefined);
  };
  const refuse = (text) => {
    over = true;
    timers.clearTimeout(retry);
    storage.removeItem(SEAT_KEY);
    drop();
    say(text);
    void follow.leave();
  };
  const later = () => {
    timers.clearTimeout(retry);
    retry = timers.setTimeout(sync, RETRY_MS);
  };
  async function join() {
    await prepare();
    const joined = await connect((meta) => follow.open(meta));
    let model;
    try {
      model = await create(joined);
    } catch (error) {
      void joined.close().catch(() => undefined);
      throw error;
    }
    connection = joined;
    show(model);
    void joined.closed.then(() => {
      if (connection !== joined || over) return;
      drop();
      say(CONNECTING);
      later();
    });
  }
  async function sync() {
    if (busy) again = true;
    if (over || busy) return;
    if (follow.status().link === 'failed') return refuse(REFUSED);
    if (connection && !follow.session()) drop();
    if (connection) return;
    say(CONNECTING);
    if (!follow.session()) return;
    busy = true;
    try {
      await join();
    } catch (error) {
      if (error?.code === 'EVERSION') refuse(error.message);
      else if (error?.code === 'EACCES') refuse(REFUSED);
      else later();
    } finally {
      busy = false;
    }
    if (again) {
      again = false;
      await sync();
    }
  }
  follow.on(() => void sync());
  follow.start();
  void sync();
  return { follow, sync, connection: () => connection };
}

export function seatPage(
  doc = document,
  media = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
) {
  const theme = doc.querySelector('.swc-theme');
  const sp = doc.querySelector('sp-theme');
  const chat = doc.querySelector('slicc-chat');
  const state = doc.querySelector('[data-seat-state]');
  const color = () => {
    const name = media?.matches ? 'dark' : 'light';
    theme.className = `swc-theme swc-theme--sizeM swc-theme--${name}`;
    sp.setAttribute('color', name);
    doc.documentElement.style.colorScheme = name;
  };
  color();
  media?.addEventListener?.('change', color);
  return {
    show(model) {
      if (model) chat.model = model;
      chat.hidden = !model;
      state.hidden = Boolean(model);
    },
    say(text) {
      state.textContent = text;
      state.hidden = false;
      chat.hidden = true;
    },
  };
}

export function preparing(root, { install = installAgent } = {}) {
  let prepared = null;
  return () => {
    prepared ??= install(() =>
      createKernel({ root, users: 'off', network: { transport: fetchTransport() }, media: false })
    ).catch((error) => {
      prepared = null;
      throw error;
    });
    return prepared;
  };
}

export async function boot() {
  const kept = takeSeat();
  const page = seatPage();
  if (!kept) return page.say(REFUSED);
  return joinSeat({
    kept,
    ...page,
    post: hubClient({
      origin: location.hostname.endsWith('.sliccy.ai') ? home() : null,
      fetch: (...args) => fetch(...args),
    }),
    makePeer: (config) => new RTCPeerConnection(config),
    prepare: preparing(await navigator.storage.getDirectory()),
  });
}

await boot();
