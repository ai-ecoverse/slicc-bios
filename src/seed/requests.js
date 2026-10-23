import { protection } from './guard.js';

export const NOT_URL = "that isn't a URL";
export const SCHEME = 'seven opens only http and https URLs';
export const OWN = "seven doesn't open its own pages or the vault for a program";
export const DISMISSED = 'the request to open the page was dismissed';
export const LATE = 'nobody answered the request to open the page within 60 s';
export const WAIT_MS = 60_000;
export const BUSY = 'another request is waiting for you';

export const refused = (message) => new DOMException(message, 'NotAllowedError');

function parsed(tag) {
  try {
    return JSON.parse(tag);
  } catch {
    return null;
  }
}

export function tagsOf(stamp) {
  return [stamp?.tag, ...(stamp?.tags ?? [])].filter((tag) => typeof tag === 'string').map(parsed);
}

export function session(stamp) {
  return JSON.stringify([stamp?.uid ?? null, stamp?.tag ?? null, stamp?.tags ?? []]);
}

export function typed(stamp) {
  const tags = tagsOf(stamp);
  return (
    tags.length > 0 &&
    tags.every(
      (tag) =>
        tag?.kind === 'user' && typeof tag.where === 'string' && tag.where.startsWith('terminal:')
    )
  );
}

export function asker(stamp) {
  const agent = tagsOf(stamp).find((tag) => tag?.kind === 'agent');
  if (!agent) return 'A program';
  return typeof agent.agentId === 'string' ? `The agent ${agent.agentId}` : 'The agent';
}

function within(root, name, found) {
  for (const element of root.querySelectorAll('*')) {
    if (element.localName === name) found.push(element);
    if (element.shadowRoot) within(element.shadowRoot, name, found);
  }
  return found;
}

export function dialogs(root = globalThis.document) {
  return root ? within(root, 'slicc-confirm', []) : [];
}

export const WRAP = '#body { overflow-wrap: anywhere; }';

export function wrapped(element, make = () => new CSSStyleSheet()) {
  const root = element.shadowRoot;
  if (!root) return;
  const sheet = make();
  sheet.replaceSync(WRAP);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
}

export function shown(options, { show, find = dialogs, wrap = wrapped }) {
  const before = new Set(find());
  const result = show(options);
  const added = find().filter((element) => !before.has(element));
  for (const element of added) wrap(element);
  return {
    result,
    close: () => {
      for (const element of added) element.remove();
    },
  };
}

export function gestures({
  show,
  ask = (options) => shown(options, { show }),
  active = () => globalThis.navigator?.userActivation?.isActive === true,
  timers = globalThis,
  wait = WAIT_MS,
} = {}) {
  const waiting = new Set();
  return async (stamp, { dismissed, late, ...prompt }, signal) => {
    if (signal.aborted) throw signal.reason;
    if (typed(stamp) && active()) return;
    const key = session(stamp);
    if (waiting.has(key)) throw refused(BUSY);
    const asked = ask(prompt);
    waiting.add(key);
    let why = dismissed;
    const stop = (reason) => {
      why = reason;
      asked.close();
    };
    const timer = timers.setTimeout(() => stop(late), wait);
    const withdraw = () => stop(null);
    signal.addEventListener('abort', withdraw, { once: true });
    let yes;
    try {
      yes = await asked.result;
    } finally {
      waiting.delete(key);
      timers.clearTimeout(timer);
      signal.removeEventListener('abort', withdraw);
    }
    if (signal.aborted) throw signal.reason;
    if (!yes) throw refused(why);
  };
}

export function target(text, is) {
  if (typeof text !== 'string' || !URL.canParse(text)) throw refused(NOT_URL);
  const url = new URL(text);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refused(SCHEME);
  if (is.url(text) || is.url(url.href)) throw refused(OWN);
  return url.href;
}

export function openUrl({
  is = protection(globalThis.location?.origin),
  open = (url) => globalThis.open(url, '_blank', 'noopener,noreferrer'),
} = {}) {
  return async ({ options, stamp, signal }, { gesture }) => {
    const url = target(options?.url, is);
    await gesture(
      stamp,
      {
        title: 'Open this page?',
        body: `${asker(stamp)} asks seven to open ${url}`,
        action: 'Open',
        cancel: 'Cancel',
        variant: 'confirmation',
        dismissed: DISMISSED,
        late: LATE,
      },
      signal
    );
    open(url);
  };
}

export const KINDS = { 'open.url': {} };

export function pageRequests({
  show,
  handlers = { 'open.url': openUrl() },
  kinds = KINDS,
  gesture = gestures({ show }),
} = {}) {
  const listed = Object.fromEntries(
    Object.entries(kinds).filter(([kind]) => typeof handlers[kind] === 'function')
  );
  return {
    kinds: listed,
    async handle(request) {
      const answer = Object.hasOwn(listed, request.kind) ? handlers[request.kind] : null;
      if (!answer)
        throw new DOMException(`seven doesn't answer ${request.kind}`, 'NotSupportedError');
      return answer(request, { gesture });
    },
  };
}

export function plugged(hook, prompts) {
  return Object.fromEntries(
    Object.keys(hook?.kinds ?? {})
      .filter((kind) => Object.hasOwn(prompts, kind))
      .map((kind) => [
        kind,
        async (request, { gesture }) => {
          await gesture(request.stamp, prompts[kind](request), request.signal);
          return hook.handle(request);
        },
      ])
  );
}
