import { protection } from './guard.js';
import { switchedOff } from './switches.js';

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
  'capture.camera': {},
  'capture.devices': {},
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

const OPEN = { signal: null, reply: (reply) => reply, done() {} };

export function plugged(hook, prompts, extras = () => ({}), guard = () => null) {
  return Object.fromEntries(
    Object.keys(hook?.kinds ?? {})
      .filter((kind) => Object.hasOwn(prompts, kind))
      .map((kind) => [
        kind,
        async (request, { gesture }) => {
          const prompt = await prompts[kind](request);
          const guarded = guard(request, prompt);
          if (guarded) await guarded.ask(prompt, gesture);
          else if (prompt) await gesture(request.stamp, prompt, request.signal);
          const open = guarded ? guarded.open() : { ...OPEN, signal: request.signal };
          const {
            failure = () => null,
            end,
            ...extra
          } = extras({
            ...request,
            signal: open.signal,
          });
          open.ends?.(end);
          let reply;
          try {
            reply = await hook.handle({ ...request, ...extra, signal: open.signal });
          } catch (error) {
            open.done();
            throw failure() ?? error;
          }
          const late = failure();
          if (late) {
            open.done();
            throw late;
          }
          return open.reply(reply);
        },
      ])
  );
}

export const STOPPED = 'stopped in seven';
export const CAPTURE_DENIED = 'the request to capture was denied';
export const UNANSWERED = "the agent couldn't answer the request to capture";
export const blocked = (what) => `${what} permission is blocked for this site`;
export const CAMERA_REFUSED = "seven doesn't answer this camera request";
export const CAMERA_DISMISSED = 'the request to use the camera was dismissed';
export const CAMERA_LATE = 'nobody answered the request to use the camera within 60 s';
const PERMISSIONS = ['camera', 'microphone'];

export function capturing(kind, options, prompt = null) {
  if (kind === 'capture.camera') {
    cameraDevice(options);
    const microphone = Boolean(captureMicrophone(options));
    return {
      kind: 'camera',
      label: CAPTURE_VIDEO.includes(options?.type) ? 'Recording camera' : 'Taking a photo',
      what: microphone ? 'with microphone' : '',
      whats: microphone ? ['camera', 'microphone'] : ['camera'],
      picker: false,
      listing: false,
      asks: true,
    };
  }
  if (kind === 'capture.devices')
    return {
      kind: 'camera',
      label: '',
      what: '',
      whats: [],
      picker: false,
      listing: true,
      asks: false,
    };
  if (kind === 'capture.screen') {
    const microphone = Boolean(captureMicrophone(options));
    return {
      kind: 'screen',
      label: CAPTURE_VIDEO.includes(options?.type) ? 'Recording screen' : 'Taking a photo',
      what: microphone ? 'with microphone' : '',
      whats: microphone ? ['screen', 'microphone'] : ['screen'],
      picker: true,
      listing: false,
      asks: true,
    };
  }
  if (kind === 'audio.record') {
    const listing = Boolean(options?.devices);
    return {
      kind: 'microphone',
      label: 'Recording microphone',
      what: '',
      whats: listing ? [] : ['microphone'],
      picker: false,
      listing,
      asks: !listing,
    };
  }
  if (kind === 'audio.transcribe' && prompt)
    return {
      kind: 'microphone',
      label: 'Recording microphone',
      what: '',
      whats: ['microphone'],
      picker: false,
      listing: false,
      asks: false,
    };
  return null;
}

export function who(stamp) {
  const agent = tagsOf(stamp).find((tag) => tag?.kind === 'agent');
  if (agent)
    return typeof agent.agentId === 'string' ? agent.agentId.replace(/^cone:/, '') : 'the agent';
  return typed(stamp) ? 'a terminal' : 'a program';
}

export function requesterOf(stamp) {
  const agent = tagsOf(stamp).find((tag) => tag?.kind === 'agent');
  if (agent && typeof agent.agentId === 'string')
    return { kind: 'agent', name: who(stamp), agentId: agent.agentId };
  if (agent) return { kind: 'agent', name: who(stamp) };
  return typed(stamp)
    ? { kind: 'user', name: 'you', where: 'a terminal' }
    : { kind: 'user', name: 'a program' };
}

export const programOf = (stamp) =>
  typeof stamp?.argv0 === 'string' && stamp.argv0 ? stamp.argv0 : 'a program';

export function clickFor({ stamp, options }, capture) {
  if (capture.picker) {
    const { body } = capturePrompt({ stamp, options });
    return {
      title: 'Choose what to share?',
      body,
      action: 'Choose what to share',
      waiting: 'choose what to share',
      dismissed: CAPTURE_DISMISSED,
      detail: { what: 'screen', program: programOf(stamp) },
    };
  }
  if (capture.kind === 'camera') {
    const both = capture.whats.includes('microphone') ? 'camera and microphone' : 'camera';
    const { body } = cameraPrompt({ stamp, options });
    return {
      title: `Allow the ${both}?`,
      body: `${body} The browser asks next whether seven may use ${both === 'camera' ? 'it' : 'them'}.`,
      action: `Allow ${both}`,
      waiting: `allow the ${both}`,
      dismissed: CAMERA_DISMISSED,
      detail: { what: 'camera', program: programOf(stamp) },
    };
  }
  return {
    title: 'Allow the microphone?',
    body: `${asker(stamp)} asks seven to record from your microphone${lasting(options?.seconds)}. The browser asks next whether seven may use it.`,
    action: 'Allow microphone',
    waiting: 'allow the microphone',
    dismissed: 'the request to use the microphone was dismissed',
    detail: { what: 'microphone', program: programOf(stamp) },
  };
}

export async function permissionOf(name, permissions = globalThis.navigator?.permissions) {
  try {
    const status = await permissions.query({ name });
    return status?.state ?? 'prompt';
  } catch {
    return 'prompt';
  }
}

export async function labelOf(id, media = globalThis.navigator?.mediaDevices) {
  if (typeof id !== 'string' || !id) return undefined;
  try {
    const found = (await media.enumerateDevices()).find((device) => device.deviceId === id);
    return found?.label || undefined;
  } catch {
    return undefined;
  }
}

function deviceOf(kind, options) {
  if (kind === 'audio.record' || kind === 'capture.camera') return options?.device;
  const microphone = captureMicrophone(options);
  return typeof microphone === 'string' ? microphone : undefined;
}

function watched(body, done) {
  const reader = body.getReader();
  return new ReadableStream(
    {
      async pull(controller) {
        let read;
        try {
          read = await reader.read();
        } catch (error) {
          done();
          controller.error(error);
          return;
        }
        if (read.done) {
          done();
          controller.close();
        } else controller.enqueue(read.value);
      },
      cancel(reason) {
        done();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
}

export function captures({
  agent = () => null,
  on = () => true,
  clicks,
  live,
  active = () => globalThis.navigator?.userActivation?.isActive === true,
  permission = permissionOf,
  label = labelOf,
  where = () => undefined,
}) {
  const open = new Set();
  const asked = async ({ kind, options, stamp, signal }) => {
    const owner = agent();
    if (typeof owner?.approveCapture !== 'function') return null;
    const device = await label(deviceOf(kind, options));
    const place = where(stamp);
    try {
      return await owner.approveCapture(
        { kind, options, stamp, ...(device ? { label: device } : {}) },
        { signal, ...(place ? { where: place } : {}) }
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error?.code !== 'EAGAIN') throw refused(UNANSWERED);
      return null;
    }
  };
  const needsClick = async ({ stamp }, capture) => {
    if (capture.listing) return false;
    let granted = !capture.picker;
    for (const what of capture.whats.filter((what) => PERMISSIONS.includes(what))) {
      const state = await permission(what);
      if (state === 'denied') throw refused(blocked(what));
      if (state !== 'granted') granted = false;
    }
    if (granted) return false;
    return !(typed(stamp) && active());
  };
  const switched = (capture) => {
    for (const what of capture.whats) if (!on(what)) throw refused(switchedOff(what));
  };
  const consent = async (request, capture, prompt, gesture) => {
    switched(capture);
    await asking(request, capture, prompt, gesture);
    switched(capture);
  };
  const asking = async (request, capture, prompt, gesture) => {
    const { stamp, signal } = request;
    const answer = capture.asks ? await asked(request) : null;
    if (signal?.aborted) throw signal.reason;
    if (answer === null) {
      if (prompt) await gesture(stamp, prompt, signal);
      return;
    }
    if (answer !== 'once' && answer !== 'always')
      throw refused((typeof answer?.message === 'string' && answer.message) || CAPTURE_DENIED);
    if (!(await needsClick(request, capture))) return;
    await clicks.ask({
      ...clickFor(request, capture),
      kind: 'capture',
      asker: requesterOf(stamp),
      signal,
      stamp,
      progress: (line) => request.progress?.(line),
    });
  };
  const watch = (request, capture) => {
    const local = new AbortController();
    let end = () => false;
    let remove = () => {};
    let finished = false;
    const entry = {
      whats: capture.whats,
      stop: (reason) => {
        if (!end()) local.abort(reason);
      },
    };
    const done = () => {
      if (finished) return;
      finished = true;
      open.delete(entry);
      remove();
      request.signal?.removeEventListener('abort', forward);
    };
    const forward = () => {
      local.abort(request.signal.reason);
      done();
    };
    if (!capture.listing) {
      open.add(entry);
      remove = live.add({
        kind: capture.kind,
        label: capture.label,
        what: capture.what,
        asker: who(request.stamp),
        action: { label: 'Stop', run: () => entry.stop(refused(STOPPED)) },
      });
    }
    if (request.signal?.aborted) forward();
    else request.signal?.addEventListener('abort', forward, { once: true });
    return {
      signal: local.signal,
      ends(given) {
        if (typeof given === 'function') end = given;
      },
      reply: (reply) => {
        if (reply?.getReader) return watched(reply, done);
        done();
        return reply;
      },
      done,
    };
  };
  const guard = (request, prompt) => {
    const capture = capturing(request.kind, request.options, prompt);
    if (!capture) return null;
    return {
      ask: (prompt, gesture) => consent(request, capture, prompt, gesture),
      open: () => watch(request, capture),
    };
  };
  guard.on = on;
  guard.off = (what) => {
    for (const entry of [...open])
      if (entry.whats.includes(what)) entry.stop(refused(switchedOff(what)));
  };
  return guard;
}

export const CAPTURE_VIDEO = ['video/webm', 'video/mp4'];

export const captureSound = (options) =>
  CAPTURE_VIDEO.includes(options?.type) && options?.system === true;

const DEVICE_ID = /^[\w+/=.-]+$/;

export function captureMicrophone(options) {
  if (!CAPTURE_VIDEO.includes(options?.type)) return false;
  const microphone = options?.microphone;
  if (microphone === undefined || microphone === false) return false;
  if (microphone === true || (typeof microphone === 'string' && DEVICE_ID.test(microphone)))
    return microphone;
  throw refused("seven doesn't answer this microphone request");
}

export function cameraDevice(options) {
  const device = options?.device;
  if (device === undefined) return undefined;
  if (typeof device === 'string' && DEVICE_ID.test(device)) return device;
  throw refused(CAMERA_REFUSED);
}

export const heard = (microphone) =>
  microphone === true ? true : { deviceId: { exact: microphone } };

export function cameraPrompt({ stamp, options }) {
  if (!CAPTURE_VIDEO.includes(options?.type))
    return {
      title: 'Take a photo?',
      body: `${asker(stamp)} asks seven to take a photo with your camera.`,
      action: 'Take photo',
      cancel: 'Cancel',
      variant: 'confirmation',
      dismissed: CAMERA_DISMISSED,
      late: CAMERA_LATE,
    };
  const both = captureMicrophone(options) ? 'camera and microphone' : 'camera';
  return {
    title: `Record the ${both}?`,
    body: `${asker(stamp)} asks seven to record from your ${both}${lasting(options?.duration)}.`,
    action: 'Record',
    cancel: 'Cancel',
    variant: 'confirmation',
    dismissed: CAMERA_DISMISSED,
    late: CAMERA_LATE,
  };
}

export const capturePrompts = {
  'capture.screen': capturePrompt,
  'capture.camera': cameraPrompt,
  'capture.devices': () => null,
};

export function capturePrompt({ stamp, options }) {
  const sound = captureSound(options) ? ' and its sound' : '';
  const microphone = captureMicrophone(options)
    ? `, and record from your microphone${lasting(options?.duration)}`
    : '';
  return {
    title: captureMicrophone(options)
      ? 'Capture the screen and microphone?'
      : 'Capture the screen?',
    body: `${asker(stamp)} asks seven to capture your screen${sound}${microphone}. You pick what to share next.`,
    action: 'Choose',
    cancel: 'Cancel',
    variant: 'confirmation',
    dismissed: CAPTURE_DISMISSED,
    late: CAPTURE_LATE,
  };
}

export function lasting(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  return ` for up to ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function asking(title, says, action, what, timed = false) {
  return ({ stamp, options }) => ({
    title,
    body: `${asker(stamp)} asks seven to ${says}${timed ? lasting(options?.seconds) : ''}.`,
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
  'use the microphone',
  true
);
const listening = asking(
  'Use the microphone?',
  'listen through your microphone',
  'Listen',
  'use the microphone',
  true
);
export const BYTES_ONLY = ['whisper'];

const spoken = (options) => Boolean(options?.status || options?.warmup);
const probe = (options) => Boolean(options?.status || options?.warmup || options?.supported);

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
  'audio.say': (request) => (spoken(request.options) ? null : speaking(request)),
  'audio.voices': () => null,
  'audio.record': (request) => (request.options?.devices ? null : recording(request)),
  'audio.transcribe': async (request) => {
    if (probe(request.options)) return null;
    if (!BYTES_ONLY.includes(request.options?.engine)) return listening(request);
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
  return ({ options, signal } = {}) => {
    let reason = null;
    let mic = null;
    let sharing = null;
    const microphone = captureMicrophone(options);
    const userMedia = async (constraints) => {
      const audio = heard(microphone);
      if (
        !microphone ||
        constraints?.video !== false ||
        Object.keys(constraints).some((key) => !['audio', 'video'].includes(key)) ||
        JSON.stringify(constraints.audio) !== JSON.stringify(audio)
      )
        throw refused("seven doesn't answer this microphone request");
      if (signal?.aborted) throw signal.reason;
      if (reason) throw reason;
      const devices = media();
      if (typeof devices?.getUserMedia !== 'function')
        throw new DOMException(
          'microphone recording is not supported in this browser',
          'NotSupportedError'
        );
      mic = await devices.getUserMedia({ audio, video: false });
      if (signal?.aborted || reason) {
        stopped(mic);
        throw reason ?? signal.reason;
      }
      return mic;
    };
    const display = async (constraints) => {
      const devices = media();
      if (typeof devices?.getDisplayMedia !== 'function')
        throw new DOMException(
          'screen capture is not supported in this browser',
          'NotSupportedError'
        );
      const stream = await devices.getDisplayMedia({
        ...constraints,
        audio: captureSound(options) && constraints?.audio === true,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
        preferCurrentTab: false,
      });
      const track = stream?.getVideoTracks?.()[0];
      let settled = false;
      const stop = (next) => {
        reason ??= refused(next);
        stopped(stream);
        stopped(mic);
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
      sharing = track ?? null;
      return stream;
    };
    const end = () => {
      if (!sharing || !CAPTURE_VIDEO.includes(options?.type)) return false;
      sharing.dispatchEvent?.(new Event('ended'));
      return true;
    };
    return { display, userMedia, end, failure: () => reason };
  };
}

const plain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const SIZES = ['width', 'height', 'frameRate'];

const sized = (value) =>
  positive(value) ||
  (plain(value) &&
    Object.keys(value).length === 1 &&
    (positive(value.ideal) || positive(value.exact)));

export function cameraVideo(video, device) {
  if (video === true) return device === undefined;
  if (!plain(video)) return false;
  const { deviceId, ...rest } = video;
  if (!Object.entries(rest).every(([key, value]) => SIZES.includes(key) && sized(value)))
    return false;
  if (device === undefined) return deviceId === undefined;
  return plain(deviceId) && Object.keys(deviceId).length === 1 && deviceId.exact === device;
}

function copied(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

export function cameraAsked(asked, options) {
  const device = cameraDevice(options);
  const microphone = captureMicrophone(options);
  const constraints = copied(asked);
  if (
    !plain(constraints) ||
    Object.keys(constraints).some((key) => key !== 'audio' && key !== 'video') ||
    !cameraVideo(constraints.video, device) ||
    JSON.stringify(constraints.audio ?? false) !==
      JSON.stringify(microphone ? heard(microphone) : false)
  )
    throw refused(CAMERA_REFUSED);
  return { constraints, whats: microphone ? ['camera', 'microphone'] : ['camera'] };
}

export function cameraman({
  media = () => globalThis.navigator?.mediaDevices,
  on = () => true,
} = {}) {
  return ({ options, signal } = {}) => {
    let used = false;
    let sharing = null;
    const userMedia = async (asked) => {
      if (used) throw refused(CAMERA_REFUSED);
      const { constraints, whats } = cameraAsked(asked, options);
      used = true;
      if (signal?.aborted) throw signal.reason;
      for (const what of whats) if (!on(what)) throw refused(switchedOff(what));
      const devices = media();
      if (typeof devices?.getUserMedia !== 'function')
        throw new DOMException(
          'camera capture is not supported in this browser',
          'NotSupportedError'
        );
      const stream = await devices.getUserMedia(constraints);
      if (signal?.aborted) {
        stopped(stream);
        throw signal.reason;
      }
      sharing = stream?.getVideoTracks?.()[0] ?? null;
      return stream;
    };
    const end = () => {
      if (!sharing || !CAPTURE_VIDEO.includes(options?.type)) return false;
      sharing.dispatchEvent?.(new Event('ended'));
      return true;
    };
    return { userMedia, end };
  };
}

export const byKind = (extras) => (request) => extras[request.kind]?.(request) ?? {};

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
