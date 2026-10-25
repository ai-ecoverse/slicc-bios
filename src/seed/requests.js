import { protection } from './guard.js';

export const NOT_URL = "that isn't a URL";
export const SCHEME = 'seven opens only http and https URLs';
export const OWN = "seven doesn't open its own pages or the vault for a program";
export const DISMISSED = 'the request to open the page was dismissed';
export const LATE = 'nobody answered the request to open the page within 60 s';
export const WAIT_MS = 60_000;
export const REST_MS = 10_000;
export const BUSY = 'another request is waiting for you';
export const CAPTURE_DISMISSED = 'the request to capture the screen was dismissed';
export const CAPTURE_LATE = 'nobody answered the request to capture the screen within 60 s';
export const CAPTURED = "seven doesn't capture its own pages or the vault";
export const UNKNOWN_TAB =
  "seven can't tell this tab isn't its own or the vault's (it sets no capture handle), so it doesn't capture it; share a window or the screen";
export const HANDLE = 'slicc-seven';
export const SHARED = ['window', 'monitor'];
export const HANDLES = [HANDLE, 'slicc-vault'];
export const HANDLE_MS = 1000;
const STEP_MS = 50;

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

export function focused(root = globalThis.document) {
  let active = root?.activeElement ?? null;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

export function shown(options, { show, find = dialogs, wrap = wrapped, current = focused }) {
  const back = current();
  const before = new Set(find());
  const result = show(options);
  const added = find().filter((element) => !before.has(element));
  for (const element of added) wrap(element);
  return {
    result,
    close: () => {
      for (const element of added) element.remove();
      if (back?.isConnected) back.focus();
    },
  };
}

export function gestures({
  show,
  ask = (options) => shown(options, { show }),
  active = () => globalThis.navigator?.userActivation?.isActive === true,
  timers = globalThis,
  wait = WAIT_MS,
  rest = REST_MS,
  now = () => Date.now(),
} = {}) {
  const waiting = new Set();
  const resting = new Map();
  return async (stamp, { dismissed, late, ...prompt }, signal) => {
    if (signal.aborted) throw signal.reason;
    if (typed(stamp) && active()) return;
    const key = session(stamp);
    if (resting.has(key)) {
      if (resting.get(key) > now()) throw refused(dismissed);
      resting.delete(key);
    }
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
    if (!yes) {
      resting.set(key, now() + rest);
      throw refused(why);
    }
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

export const KINDS = {
  'open.url': {},
  'capture.screen': {},
  'clipboard.write': {},
  'audio.play': {},
  'audio.say': {},
  'audio.voices': {},
  'audio.record': {},
  'audio.transcribe': {},
};

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

export function plugged(hook, prompts, extras = () => ({})) {
  return Object.fromEntries(
    Object.keys(hook?.kinds ?? {})
      .filter((kind) => Object.hasOwn(prompts, kind))
      .map((kind) => [
        kind,
        async (request, { gesture }) => {
          const prompt = await prompts[kind](request);
          if (prompt) await gesture(request.stamp, prompt, request.signal);
          const { failure = () => null, ...extra } = extras();
          let reply;
          try {
            reply = await hook.handle({ ...request, ...extra });
          } catch (error) {
            throw failure() ?? error;
          }
          const late = failure();
          if (late) throw late;
          return reply;
        },
      ])
  );
}

export function capturePrompt({ stamp }) {
  return {
    title: 'Capture the screen?',
    body: `${asker(stamp)} asks seven to capture your screen. You pick what to share next.`,
    action: 'Choose',
    cancel: 'Cancel',
    variant: 'confirmation',
    dismissed: CAPTURE_DISMISSED,
    late: CAPTURE_LATE,
  };
}

function asking(title, says, action, what) {
  return ({ stamp }) => ({
    title,
    body: `${asker(stamp)} asks seven to ${says}.`,
    action,
    cancel: 'Cancel',
    variant: 'confirmation',
    dismissed: `the request to ${what} was dismissed`,
    late: `nobody answered the request to ${what} within 60 s`,
  });
}

const playing = asking('Play a sound?', 'play a sound', 'Play', 'play a sound');
const speaking = asking('Speak aloud?', 'speak aloud', 'Speak', 'speak aloud');
const recording = asking(
  'Use the microphone?',
  'record from your microphone',
  'Record',
  'use the microphone'
);
const listening = asking(
  'Use the microphone?',
  'listen through your microphone',
  'Listen',
  'use the microphone'
);
const probe = (options) =>
  Boolean(options?.status || options?.warmup || options?.supported || options?.devices);

export async function peeked(body) {
  if (!body?.getReader) return { body, carried: false };
  const reader = body.getReader();
  let first = await reader.read();
  while (!first.done && !first.value?.byteLength) first = await reader.read();
  const carried = !first.done;
  const rest = new ReadableStream({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { body: rest, carried };
}

export const audioPrompts = {
  'audio.play': playing,
  'audio.say': (request) => (probe(request.options) ? null : speaking(request)),
  'audio.voices': () => null,
  'audio.record': recording,
  'audio.transcribe': async (request) => {
    if (probe(request.options)) return null;
    const { body, carried } = await peeked(request.body);
    request.body = body;
    return carried ? null : listening(request);
  },
};

function stopped(stream) {
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}

export async function handleOf(
  track,
  { wait = HANDLE_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}
) {
  let handle = track?.getCaptureHandle?.() ?? null;
  if (handle || track?.getSettings?.().displaySurface !== 'browser') return handle;
  for (let waited = 0; !handle && waited < wait; waited += STEP_MS) {
    await sleep(STEP_MS);
    handle = track.getCaptureHandle?.() ?? null;
  }
  return handle;
}

export function displayer({
  media = () => globalThis.navigator?.mediaDevices,
  is = protection(globalThis.location?.origin),
  settle = handleOf,
} = {}) {
  const sevens = (handle) =>
    HANDLES.includes(handle?.handle) || Boolean(handle?.origin && is.url(handle.origin));
  const why = (track, handle) => {
    if (sevens(handle)) return CAPTURED;
    if (!handle && !SHARED.includes(track?.getSettings?.().displaySurface)) return UNKNOWN_TAB;
    return null;
  };
  return () => {
    let reason = null;
    const display = async (constraints) => {
      const devices = media();
      if (typeof devices?.getDisplayMedia !== 'function')
        throw new DOMException(
          'screen capture is not supported in this browser',
          'NotSupportedError'
        );
      const stream = await devices.getDisplayMedia({
        ...constraints,
        audio: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
        preferCurrentTab: false,
      });
      const track = stream?.getVideoTracks?.()[0];
      let settled = false;
      const stop = (next) => {
        reason ??= refused(next);
        stopped(stream);
        if (settled) track?.dispatchEvent?.(new Event('ended'));
      };
      track?.addEventListener?.('capturehandlechange', () => {
        if (reason) return;
        const next = why(track, track.getCaptureHandle?.());
        if (next) stop(next);
      });
      const first = why(track, await settle(track));
      const now = reason ? null : why(track, track?.getCaptureHandle?.() ?? null);
      if (!reason && (first || now)) stop(first ?? now);
      if (reason) throw reason;
      settled = true;
      return stream;
    };
    return { display, failure: () => reason };
  };
}

export function markCaptured({
  media = () => globalThis.navigator?.mediaDevices,
  origin = globalThis.location?.origin,
} = {}) {
  media()?.setCaptureHandleConfig?.({
    handle: HANDLE,
    exposeOrigin: true,
    permittedOrigins: [origin],
  });
}
