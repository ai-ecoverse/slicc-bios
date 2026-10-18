import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

export const PROTECTED =
  'slicc: refused: seven’s own pages and the vault are out of reach of browser automation';
export const UNSEEN =
  'slicc: refused: this request wasn’t seen, so it could be seven’s or the vault’s';
export const FETCH = 'slicc: refused: Fetch needs a tab session; it can’t pause the whole browser';
export const STREAM =
  'slicc: refused: this stream wasn’t handed out by the guard, so it could be seven’s or the vault’s';
export const FAILED =
  'slicc: refused: the CDP guard couldn’t check this answer, so it held it back';
export const SCRIPTS =
  'slicc: refused: scripts and bindings for later documents could run in seven’s pages or the vault, so the guard doesn’t allow them; run a script in the page you see with Runtime.evaluate instead';
export const INHERITED =
  'slicc: refused: a browser-side navigation to about: gives the page the origin of whatever drives the browser, so the guard doesn’t send it; open a new tab on about:blank instead';
export const UNFLAT =
  'slicc: refused: the guard only hands out flattened sessions, so attach with flatten: true and send commands with a sessionId';
export const UNGUARDED =
  'slicc: refused: the guard couldn’t keep seven’s pages and the vault out of this tab, so it refuses commands there';
export const HEADERS =
  'slicc: refused: settings for a whole session (headers, user agent, locale, time zone, cache, network conditions, blocked URLs, emulation) could reach seven’s pages or the vault, so the guard doesn’t allow them; change a request through Fetch instead';
export const DEBUGGER =
  'slicc: refused: breakpoints could run in seven’s pages or the vault, so the guard doesn’t offer the Debugger domains';

const GUARD_IDS = 2 ** 30;
const HOLD_MS = 2000;
const BLANK_MS = 10000;
const ERROR_PAGE = 'chrome-error://chromewebdata/';
const bare = (url) => url.split('#')[0];
const SCRUB_MS = 5000;
export const BLANKED = 'about:blank#blocked';
const HISTORY = new Set(['Page.getNavigationHistory']);
const TREES = new Set(['Page.getFrameTree', 'Page.getResourceTree']);
const NAV_MS = 10000;
const NAV_TYPES = new Set(['page', 'iframe', 'background_page', 'webview']);
const UNWAITED = new Set(['Target.getTargetInfo', 'Target.detachFromTarget']);
const POLL_MS = 100;
const REMEMBERED = 10000;

const UNSAFE = new Set([
  'Target.sendMessageToTarget',
  'Target.attachToBrowserTarget',
  'Target.exposeDevToolsProtocol',
  'Tracing.start',
  'Network.clearBrowserCookies',
  'Storage.clearCookies',
  'ServiceWorker.stopAllWorkers',
  'BackgroundService.clearEvents',
  'Network.loadNetworkResource',
  'Storage.getPrivateVerificationTokens',
  'Storage.getTrustTokens',
]);
const FLAT = new Set(['Target.attachToTarget', 'Target.setAutoAttach']);
const LATER = new Set([
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.addScriptToEvaluateOnLoad',
  'Runtime.addBinding',
  'Page.setBypassCSP',
]);
const STICKY = new Set([
  'Network.setExtraHTTPHeaders',
  'Network.setUserAgentOverride',
  'Emulation.setUserAgentOverride',
  'Emulation.setLocaleOverride',
  'Emulation.setTimezoneOverride',
  'Network.setCacheDisabled',
  'Network.emulateNetworkConditions',
  'Network.emulateNetworkConditionsByRule',
  'Network.overrideNetworkState',
  'Network.setBlockedURLs',
]);
const DEBUGGERS = ['Debugger.', 'DOMDebugger.', 'EventBreakpoints.'];
const EMULATION = /^Emulation\.(set|add|update|remove)[A-Z]/;
const NAVIGATED = new Set([
  'Page.frameStartedNavigating',
  'Page.frameRequestedNavigation',
  'Page.frameScheduledNavigation',
  'Page.navigatedWithinDocument',
  'Page.frameNavigated',
  'Page.frameStartedLoading',
]);
const BODIES = new Set([
  'Network.getResponseBody',
  'Network.getRequestPostData',
  'Network.searchInResponseBody',
  'Network.streamResourceContent',
  'Network.replayXHR',
  'Network.getResponseBodyForInterception',
  'Network.takeResponseBodyForInterceptionAsStream',
  'Fetch.getResponseBody',
  'Fetch.takeResponseBodyAsStream',
  'Audits.getEncodedResponse',
]);
const CLEARS = new Set(['Network.clearBrowserCookies', 'Storage.clearCookies']);
const REQUESTS = new Set([
  'Fetch.continueRequest',
  'Fetch.continueResponse',
  'Fetch.continueWithAuth',
  'Fetch.fulfillRequest',
  'Fetch.failRequest',
]);
const COOKIES = new Set([
  'Network.getCookies',
  'Network.getAllCookies',
  'Storage.getCookies',
  'Page.getCookies',
]);
const ORIGINS = new Set([
  'origin',
  'securityOrigin',
  'ownerOrigin',
  'issuerOrigin',
  'topLevelOrigin',
  'topLevelSite',
  'embeddedOrigin',
  'requestingOrigin',
  'scopeURL',
  'scriptURL',
  'manifestId',
  'url',
  'documentURL',
  'unreachableUrl',
]);
const FREE = new Set([
  'expression',
  'arguments',
  'functionDeclaration',
  'value',
  'values',
  'headers',
  'responseHeaders',
  'postData',
  'body',
  'source',
  'html',
  'text',
  'data',
  'message',
]);
const STORED = [
  'Storage.',
  'DOMStorage.',
  'IndexedDB.',
  'CacheStorage.',
  'ServiceWorker.',
  'BackgroundService.',
];
const WORKERS = ['registrationId', 'versionId'];
const PAUSES = new Set(['Fetch.requestPaused', 'Fetch.authRequired']);

function parse(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return {};
  }
  if (!message || typeof message !== 'object') return {};
  if (message.params === null || typeof message.params !== 'object') delete message.params;
  return message;
}

const header = (headers, name) =>
  Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];

const inherits = (url) => {
  try {
    return new URL(url).protocol === 'about:';
  } catch {
    return false;
  }
};

const owned = (own) => [own ?? []].flat().filter(Boolean);

export const ARM = [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }];

export function protection(own) {
  const matcher = protectedOrigins(catalog.protectedOrigins, owned(own));
  const web = (url) => typeof url === 'string' && matcher.url(url.replace(/^ws(s?):/i, 'http$1:'));
  return { ...matcher, url: web };
}

class Guard {
  constructor(connection, own) {
    this.connection = connection;
    this.is = protection(own);
    this.navs = new Map();
    this.navSessions = new Map();
    this.errored = new Map();
    this.offered = new Set();
    this.contexts = new Set();
    this.targets = new Map();
    this.sessions = new Map();
    this.shown = new Set();
    this.blocked = new Set();
    this.waiting = new Set();
    this.pages = new Set();
    this.frames = new Map();
    this.requests = new Map();
    this.held = new Map();
    this.internal = new Map();
    this.asked = new Map();
    this.watching = new Map();
    this.queues = new Map();
    this.streams = new Set();
    this.allowed = new Set();
    this.blockedWorkers = new Set();
    this.next = GUARD_IDS;
    this.guarded = { onmessage: null, onclose: null };
  }

  deliver(message) {
    try {
      this.guarded.onmessage?.(JSON.stringify(message));
    } catch (error) {
      console.warn(`a CDP client failed on a message: ${error.message}`);
    }
  }

  call(method, params, sessionId) {
    return new Promise((resolve) => {
      this.next += 1;
      this.internal.set(this.next, resolve);
      this.connection.send(
        JSON.stringify({ id: this.next, method, params, ...(sessionId ? { sessionId } : {}) })
      );
    });
  }

  refuse({ id, sessionId }, message = PROTECTED) {
    this.deliver({ id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message } });
  }

  learn(info) {
    if (!info?.targetId) return;
    const known = this.targets.get(info.targetId);
    const failed = info.url !== undefined && this.errored.get(info.targetId) === bare(info.url);
    this.targets.set(info.targetId, {
      url: failed ? ERROR_PAGE : (info.url ?? ''),
      type: info.type ?? known?.type,
      openerId: info.openerId,
      was: known?.was || known?.guarded || false,
      guarded: known?.guarded || false,
      context: info.browserContextId ?? known?.context,
    });
  }

  async lookup(targetId) {
    if (!this.targets.has(targetId)) {
      this.learn((await this.call('Target.getTargetInfo', { targetId })).result?.targetInfo);
    }
    return this.targets.get(targetId);
  }

  async opener(openerId, depth) {
    if (!openerId) return undefined;
    if (!(await this.lookup(openerId))) return 'unknown';
    return (await this.target(openerId, depth + 1)) ? 'protected' : 'unprotected';
  }

  async target(targetId, depth = 0) {
    const found = await this.lookup(targetId);
    if (!found) return false;
    if (depth > 8) return true;
    const verdict = this.is.target({
      url: found.url,
      type: found.type,
      previous: found.was,
      opener: await this.opener(found.openerId, depth),
    });
    found.guarded = found.guarded || verdict;
    return found.guarded;
  }

  async frame(frameId) {
    if (frameId === undefined) return false;
    if (this.targets.has(frameId)) return this.target(frameId);
    if (this.frames.has(frameId)) return this.is.url(this.frames.get(frameId));
    if (await this.lookup(frameId)) return this.target(frameId);
    this.frames.set(frameId, '');
    return false;
  }

  hidden(sessionId) {
    return sessionId !== undefined && (this.blocked.has(sessionId) || !this.shown.has(sessionId));
  }

  cut(sessionId, parent) {
    if (this.blocked.has(sessionId)) return;
    this.blocked.add(sessionId);
    if (this.waiting.delete(sessionId))
      void this.call('Runtime.runIfWaitingForDebugger', {}, sessionId);
    const targetId = this.sessions.get(sessionId)?.targetId;
    if (targetId) {
      const known = this.targets.get(targetId) ?? { url: '' };
      this.targets.set(targetId, { ...known, was: true, guarded: true });
    }
    void this.call(
      'Target.detachFromTarget',
      { sessionId },
      parent ?? this.sessions.get(sessionId)?.parent
    );
  }

  async current(targetId) {
    const info = (await this.call('Target.getTargetInfo', { targetId })).result?.targetInfo;
    if (info) this.learn(info);
    return this.target(targetId);
  }

  cutTarget(targetId) {
    for (const [sessionId, entry] of this.sessions) {
      if (entry.targetId === targetId) this.cut(sessionId, entry.parent);
    }
  }

  touch(targetId, held = false) {
    if (!targetId) return;
    const known = this.navs.get(targetId);
    if (known) {
      if (!held) known.held = false;
      return;
    }
    if (!NAV_TYPES.has(this.targets.get(targetId)?.type ?? 'page')) return;
    const nav = { targetId, session: null, done: false, failed: false, held };
    nav.ready = new Promise((resolve) => {
      nav.settle = (failed) => {
        if (nav.done) return;
        nav.done = true;
        nav.failed = failed;
        clearTimeout(nav.timer);
        resolve();
      };
    });
    nav.timer = setTimeout(() => nav.settle(true), NAV_MS);
    nav.timer.unref?.();
    this.navs.set(targetId, nav);
    nav.attaching = this.call('Target.attachToTarget', { targetId, flatten: true }).then(
      (answer) => answer.result?.sessionId ?? null
    );
    void nav.attaching.then((session) => this.arm(nav, session));
  }

  async arm(nav, session) {
    if (!session) return nav.settle(true);
    nav.session = session;
    this.navSessions.set(session, nav);
    const steps = await Promise.all([
      this.call('Fetch.enable', { patterns: ARM }, session),
      this.call(
        'Network.enable',
        { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 },
        session
      ),
      this.call('Network.setBypassServiceWorker', { bypass: true }, session),
      this.call('Page.enable', {}, session),
    ]);
    nav.settle(steps.some((step) => step.error));
  }

  navEvent({ method, params = {} }, nav) {
    if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
      return this.wiping(nav, `${params.frame.url}${params.frame.urlFragment ?? ''}`);
    }
    if (method === 'Page.frameStoppedLoading' && params.frameId === nav.targetId) {
      return this.wipe(nav);
    }
    if (method !== 'Fetch.requestPaused') return;
    const { requestId } = params;
    if (params.resourceType === 'Document' && this.is.url(params.request?.url)) {
      if (nav.held) {
        nav.taken = true;
        void this.call('Fetch.continueRequest', { requestId }, nav.session);
        return;
      }
      void this.call(
        'Fetch.failRequest',
        { requestId, errorReason: 'BlockedByClient' },
        nav.session
      );
      this.failed(nav.targetId, params);
      return;
    }
    void this.call('Fetch.continueRequest', { requestId }, nav.session);
  }

  lost(session) {
    const nav = this.navSessions.get(session);
    this.navSessions.delete(session);
    nav.session = null;
    nav.settle(true);
    nav.failed = true;
  }

  async guarding(method, sessionId) {
    if (sessionId === undefined || UNWAITED.has(method)) return null;
    const nav = this.navs.get(this.sessions.get(sessionId)?.targetId);
    if (!nav) return null;
    await nav.ready;
    if (nav.scrub) await nav.scrub;
    return nav.failed ? UNGUARDED : null;
  }

  async verify(sessionId) {
    void this.call('Page.enable', {}, sessionId);
    const tree = (await this.call('Page.getFrameTree', {}, sessionId)).result?.frameTree;
    const all = framed(tree);
    for (const frame of all) this.frames.set(frame.id, frame.url);
    return !all.some((frame) => this.is.url(frame.url));
  }

  async inspect(sessionId, targetId, parent) {
    const guarded = targetId ? await this.target(targetId) : false;
    if (guarded || !(await this.verify(sessionId))) {
      this.cut(sessionId, parent);
      return false;
    }
    this.shown.add(sessionId);
    return true;
  }

  watch(sessionId, targetId, parent) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { targetId, parent });
    if (!this.watching.has(sessionId)) {
      this.watching.set(sessionId, this.inspect(sessionId, targetId, parent));
    }
    return this.watching.get(sessionId);
  }

  async named(targetId) {
    for (let waited = 0; waited < BLANK_MS; waited += POLL_MS) {
      const info = (await this.call('Target.getTargetInfo', { targetId })).result?.targetInfo;
      if (!info) return null;
      if (info.url) return info;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return null;
  }

  async blank(message) {
    const { params, sessionId: parent } = message;
    const { sessionId, targetInfo } = params;
    const { targetId } = targetInfo;
    this.sessions.set(sessionId, { targetId, parent });
    this.learn(targetInfo);
    this.touch(targetId, true);
    const nav = this.navs.get(targetId);
    await nav?.ready;
    if (this.waiting.delete(sessionId))
      void this.call('Runtime.runIfWaitingForDebugger', {}, sessionId);
    const info = await this.named(targetId);
    if (!info || nav?.taken || nav?.failed) return this.cut(sessionId, parent);
    this.targets.delete(info.targetId);
    this.learn(info);
    if (await this.watch(sessionId, info.targetId, parent)) {
      if (nav?.taken || nav?.failed) return this.cut(sessionId, parent);
      if (nav) nav.held = false;
      this.deliver({
        ...message,
        params: { ...params, targetInfo: info, waitingForDebugger: false },
      });
    }
  }

  async request({ request = {}, documentURL, frameId, initiator, url }) {
    const { is } = this;
    return (
      is.url(request.url) ||
      is.url(url) ||
      is.url(documentURL) ||
      is.url(initiator?.url) ||
      is.url(header(request.headers, 'referer')) ||
      is.url(header(request.headers, 'origin')) ||
      (await this.frame(frameId))
    );
  }

  remember(requestId, marked) {
    this.requests.set(requestId, marked);
    if (this.requests.size > REMEMBERED) this.requests.delete(this.requests.keys().next().value);
  }

  settle(requestId, marked) {
    this.remember(requestId, marked);
    const waiting = this.held.get(requestId);
    if (!waiting) return [];
    this.held.delete(requestId);
    clearTimeout(waiting.timer);
    return waiting.messages;
  }

  hold(requestId, message) {
    const waiting = this.held.get(requestId) ?? {
      messages: [],
      timer: setTimeout(() => this.held.delete(requestId), HOLD_MS),
    };
    waiting.timer.unref?.();
    waiting.messages.push(message);
    this.held.set(requestId, waiting);
  }

  async network(message) {
    const { method, params = {} } = message;
    const { requestId } = params;
    if (method === 'Network.requestWillBeSent' || method === 'Network.webSocketCreated') {
      const marked = this.requests.get(requestId) === true || (await this.request(params));
      const waiting = this.settle(requestId, marked);
      if (marked) return true;
      this.deliver(message);
      for (const held of waiting) this.deliver(held);
      return true;
    }
    if (!this.requests.has(requestId)) {
      this.hold(requestId, message);
      return true;
    }
    return this.requests.get(requestId);
  }

  async paused(message) {
    const { params = {} } = message;
    const marked = this.requests.get(params.networkId) === true || (await this.request(params));
    this.remember(params.requestId, marked);
    if (params.networkId !== undefined && marked) this.settle(params.networkId, true);
    if (!marked) return false;
    this.release(message);
    return true;
  }

  failed(targetId, { frameId, request }) {
    if (!targetId || frameId !== targetId) return;
    this.errored.set(targetId, bare(request.url));
    const nav = this.navs.get(targetId);
    if (nav?.session && !nav.scrub) nav.scrub = this.scrubbing(nav);
  }

  scrubbing(nav) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        nav.wiped = null;
        nav.scrub = null;
        this.cutTarget(nav.targetId);
        resolve();
      }, SCRUB_MS);
      timer.unref?.();
      nav.wiped = () => {
        clearTimeout(timer);
        nav.wiped = null;
        nav.scrub = null;
        resolve();
      };
    });
  }

  wiping(nav, url) {
    if (!nav.wiped) return;
    if (url === BLANKED) return nav.wiped();
    nav.erred = url.startsWith('chrome-error:');
  }

  wipe(nav) {
    if (!nav.wiped || !nav.erred) return;
    nav.erred = false;
    void this.call('Page.navigate', { url: BLANKED }, nav.session);
  }

  release({ method, params = {}, sessionId }) {
    const { requestId } = params;
    if (
      method === 'Fetch.requestPaused' &&
      params.resourceType === 'Document' &&
      this.is.url(params.request?.url)
    ) {
      void this.call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId);
      this.failed(this.sessions.get(sessionId)?.targetId, params);
      return;
    }
    if (method === 'Fetch.authRequired') {
      const authChallengeResponse = { response: 'Default' };
      void this.call('Fetch.continueWithAuth', { requestId, authChallengeResponse }, sessionId);
      return;
    }
    const response =
      params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;
    const next = response ? 'Fetch.continueResponse' : 'Fetch.continueRequest';
    void this.call(next, { requestId }, sessionId);
  }

  async targetEvent(message) {
    const { method, params = {}, sessionId } = message;
    if (method === 'Target.attachedToTarget') {
      const info = params.targetInfo ?? {};
      const nav = this.navs.get(info.targetId);
      if (nav && sessionId === undefined && (await nav.attaching) === params.sessionId) return true;
      if (params.waitingForDebugger) this.waiting.add(params.sessionId);
      if (!info.url && (info.type === 'page' || info.type === 'iframe')) {
        void this.blank(message);
        return true;
      }
      this.learn(info);
      if (await this.watch(params.sessionId, info.targetId, sessionId)) {
        this.touch(info.targetId);
        this.deliver(message);
      }
      return true;
    }
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      this.learn(params.targetInfo);
      if (!(await this.target(params.targetInfo?.targetId))) {
        this.deliver({
          ...message,
          params: { ...params, targetInfo: this.masked(params.targetInfo) },
        });
        return true;
      }
      this.cutTarget(params.targetInfo.targetId);
      return true;
    }
    if (method === 'Target.targetDestroyed') {
      const nav = this.navs.get(params.targetId);
      this.navs.delete(params.targetId);
      this.errored.delete(params.targetId);
      if (nav?.session) this.navSessions.delete(nav.session);
      return this.targets.get(params.targetId)?.guarded === true;
    }
    if (method === 'Target.detachedFromTarget') {
      if (this.navSessions.has(params.sessionId)) {
        this.lost(params.sessionId);
        return true;
      }
      this.sessions.delete(params.sessionId);
      this.waiting.delete(params.sessionId);
      return !this.shown.delete(params.sessionId);
    }
    return false;
  }

  walked({ method, params = {}, sessionId }) {
    if (method === 'Page.frameNavigated' && params.frame) {
      this.frames.set(params.frame.id, params.frame.url);
      const targetId = this.sessions.get(sessionId)?.targetId;
      if (!params.frame.parentId && targetId && this.targets.has(targetId)) {
        this.targets.get(targetId).url = params.frame.url;
      }
      return this.is.url(params.frame.url) || this.is.url(params.frame.securityOrigin);
    }
    if (NAVIGATED.has(method)) return !this.armed(sessionId) && this.is.url(params.url);
    if (method === 'Network.requestWillBeSent' && params.type === 'Document') {
      return !this.armed(sessionId) && this.is.url(params.request?.url);
    }
    return method === 'Runtime.executionContextCreated' && this.is.url(params.context?.origin);
  }

  hides(entry) {
    return this.is.url(entry.url) || this.is.url(entry.userTypedURL);
  }

  entry(entry) {
    if (!this.hides(entry)) return entry;
    return { ...entry, url: ERROR_PAGE, userTypedURL: ERROR_PAGE, title: '' };
  }

  tree({ frame, childFrames, resources, ...rest }) {
    const hidden = this.is.url(frame.url) || this.is.url(frame.unreachableUrl);
    const { unreachableUrl, urlFragment, ...shown } = frame;
    return {
      ...rest,
      frame: hidden ? { ...shown, url: ERROR_PAGE, securityOrigin: '://' } : frame,
      ...(childFrames ? { childFrames: childFrames.map((child) => this.tree(child)) } : {}),
      ...(resources ? { resources: resources.filter((item) => !this.is.url(item.url)) } : {}),
    };
  }

  async back(params, sessionId) {
    const history = (await this.call('Page.getNavigationHistory', {}, sessionId)).result;
    const entry = history?.entries?.find((item) => item.id === params.entryId);
    return Boolean(entry && this.hides(entry));
  }

  masked(info) {
    if (info.url === undefined || this.errored.get(info.targetId) !== bare(info.url)) return info;
    return { ...info, url: ERROR_PAGE, title: ERROR_PAGE };
  }

  armed(sessionId) {
    const nav = this.navs.get(this.sessions.get(sessionId)?.targetId);
    return Boolean(nav?.done && !nav.failed && nav.session);
  }

  naming(message) {
    const { method, params } = message;
    if (method.startsWith('Network.') || method.startsWith('Fetch.')) return false;
    return this.valued(params);
  }

  swallowed(message) {
    const { method, params = {} } = message;
    if (method === 'Fetch.requestPaused' || method === 'Fetch.authRequired') {
      return this.paused(message);
    }
    if (method.startsWith('Network.') && params.requestId !== undefined) {
      return this.network(message);
    }
    return false;
  }

  async event(message) {
    const method = message.method ?? '';
    const { sessionId } = message;
    if (this.navSessions.has(sessionId))
      return this.navEvent(message, this.navSessions.get(sessionId));
    if (method.startsWith('Target.') && (await this.targetEvent(message))) return;
    if (this.blocked.has(sessionId) && PAUSES.has(method)) return this.release(message);
    if (this.hidden(sessionId)) return;
    if (this.walked({ ...message, method })) return this.cut(sessionId);
    if (await this.swallowed({ ...message, method })) return;
    if (this.stored({ ...message, method })) return;
    if (sessionId && this.naming({ ...message, method })) return;
    if (sessionId && method.startsWith('Page.') && !this.pages.has(sessionId)) return;
    if (PAUSES.has(method)) this.offered.add(message.params?.requestId);
    this.deliver(message);
  }

  async listed(message, result) {
    const targetInfos = [];
    for (const info of result.targetInfos) {
      this.learn(info);
      if (!(await this.target(info.targetId))) targetInfos.push(this.masked(info));
    }
    return this.deliver({ ...message, result: { ...result, targetInfos } });
  }

  async answer(message, was) {
    if (was?.sessionId && this.blocked.has(was.sessionId)) return this.refuse(was);
    const { method, params = {} } = was ?? {};
    const { result } = message;
    if (method === 'Target.attachToTarget' && result?.sessionId) {
      const ok = await this.watch(result.sessionId, params.targetId);
      if (!ok) return this.refuse(was);
      this.touch(params.targetId);
      return this.deliver(message);
    }
    if (method === 'Target.getTargets' && Array.isArray(result?.targetInfos)) {
      return this.listed(message, result);
    }
    if (HISTORY.has(method) && Array.isArray(result?.entries)) {
      const entries = result.entries.map((entry) => this.entry(entry));
      return this.deliver({ ...message, result: { ...result, entries } });
    }
    if (TREES.has(method) && result?.frameTree) {
      return this.deliver({
        ...message,
        result: { ...result, frameTree: this.tree(result.frameTree) },
      });
    }
    if (method === 'Target.getTargetInfo' && result?.targetInfo) {
      return this.deliver({ ...message, result: { targetInfo: this.masked(result.targetInfo) } });
    }
    if (method === 'Target.createBrowserContext' && result?.browserContextId) {
      this.contexts.add(result.browserContextId);
    }
    if (typeof result?.stream === 'string') this.streams.add(result.stream);
    if (COOKIES.has(method) && Array.isArray(result?.cookies)) {
      const cookies = result.cookies.filter((item) => !this.cookie(item));
      return this.deliver({ ...message, result: { ...result, cookies } });
    }
    this.deliver(message);
  }

  cookie(item) {
    return (
      (typeof item?.domain === 'string' && this.is.cookieDomain(item.domain)) ||
      this.is.url(item?.url) ||
      this.is.url(item?.partitionKey?.topLevelSite)
    );
  }

  keyed(key, value) {
    const { is } = this;
    if (typeof value !== 'string') return false;
    if (ORIGINS.has(key)) return is.url(value);
    if (key === 'storageKey') return is.storageKey(value);
    if (key === 'cacheId') return is.storageKey(value.split('|')[0]);
    if (key === 'domain') return is.cookieDomain(value);
    return false;
  }

  valued(params, depth = 0) {
    if (!params || typeof params !== 'object' || depth > 6) return false;
    return Object.entries(params).some(
      ([key, value]) =>
        !FREE.has(key) &&
        (this.keyed(key, value) || (typeof value === 'object' && this.valued(value, depth + 1)))
    );
  }

  workers(method, params) {
    if (!method.startsWith('ServiceWorker.')) return false;
    return WORKERS.some(
      (key) => params[key] !== undefined && !this.allowed.has(`${key}:${params[key]}`)
    );
  }

  stored(message) {
    const { method, params = {} } = message;
    if (!STORED.some((domain) => method.startsWith(domain))) return false;
    if (
      method === 'ServiceWorker.workerRegistrationUpdated' &&
      Array.isArray(params.registrations)
    ) {
      const registrations = params.registrations.filter((item) => this.worker(item));
      if (registrations.length) this.deliver({ ...message, params: { ...params, registrations } });
      return true;
    }
    if (method === 'ServiceWorker.workerVersionUpdated' && Array.isArray(params.versions)) {
      const versions = params.versions.filter((item) => this.worker(item));
      if (versions.length) this.deliver({ ...message, params: { ...params, versions } });
      return true;
    }
    return this.valued(params);
  }

  worker(item) {
    if (this.valued(item) || this.blockedWorkers.has(item.registrationId)) {
      if (item.registrationId !== undefined) this.blockedWorkers.add(item.registrationId);
      return false;
    }
    for (const key of WORKERS) if (item[key] !== undefined) this.allowed.add(`${key}:${item[key]}`);
    return true;
  }

  clearing(method, params, sessionId) {
    if (!CLEARS.has(method)) return false;
    if (sessionId === undefined) {
      return method === 'Storage.clearCookies' && this.contexts.has(params.browserContextId);
    }
    const context = this.targets.get(this.sessions.get(sessionId)?.targetId)?.context;
    return params.browserContextId === undefined && this.contexts.has(context);
  }

  plainly(method, params, sessionId) {
    return (
      (sessionId !== undefined && this.hidden(sessionId)) ||
      (UNSAFE.has(method) && !this.clearing(method, params, sessionId)) ||
      this.valued(params) ||
      this.workers(method, params) ||
      (method === 'Target.detachFromTarget' &&
        params.sessionId !== undefined &&
        !this.sessions.has(params.sessionId))
    );
  }

  unseen(method, params) {
    if (!BODIES.has(method) && !REQUESTS.has(method)) return null;
    const id = params.requestId ?? params.interceptionId;
    if (!this.requests.has(id)) return UNSEEN;
    if (this.requests.get(id)) return PROTECTED;
    if (!REQUESTS.has(method)) return null;
    if (!this.offered.has(id)) return UNSEEN;
    this.offered.delete(id);
    return null;
  }

  async check(message) {
    const { method, params = {}, sessionId } = message;
    if (typeof method !== 'string') return null;
    if (method.startsWith('Fetch.') && sessionId === undefined) return FETCH;
    if (LATER.has(method)) return SCRIPTS;
    if (method === 'Page.navigate' && inherits(params.url)) return INHERITED;
    if (FLAT.has(method) && params.flatten !== true) {
      const target = params.targetId !== undefined && (await this.current(params.targetId));
      return target ? PROTECTED : UNFLAT;
    }
    if (STICKY.has(method) || EMULATION.test(method)) return HEADERS;
    if (DEBUGGERS.some((domain) => method.startsWith(domain))) return DEBUGGER;
    if (this.plainly(method, params, sessionId)) return PROTECTED;
    const unguarded = await this.guarding(method, sessionId);
    if (unguarded) return unguarded;
    if ((method === 'IO.read' || method === 'IO.close') && !this.streams.has(params.handle)) {
      return STREAM;
    }
    return this.reaching(method, params, sessionId);
  }

  async reaching(method, params, sessionId) {
    if (params.targetId !== undefined && (await this.current(params.targetId))) return PROTECTED;
    if (method === 'Target.attachToTarget') {
      this.touch(params.targetId);
      const nav = this.navs.get(params.targetId);
      if (nav) await nav.ready;
      if (nav?.failed) return UNGUARDED;
    }
    if (await this.frame(params.frameId)) return PROTECTED;
    if (method === 'Page.navigateToHistoryEntry' && (await this.back(params, sessionId))) {
      return PROTECTED;
    }
    return this.unseen(method, params);
  }

  async create({ id, params }) {
    const answer = await this.call('Target.createTarget', { ...params, url: 'about:blank' });
    const targetId = answer.result?.targetId;
    if (!targetId) return this.deliver({ ...answer, id });
    this.learn({ targetId, url: 'about:blank', type: 'page' });
    this.touch(targetId);
    const nav = this.navs.get(targetId);
    await nav.ready;
    if (!nav.failed && !inherits(params.url))
      void this.call('Page.navigate', { url: params.url }, nav.session);
    this.deliver({ id, result: answer.result });
  }

  pass(message) {
    const { id, method, sessionId } = message;
    if (sessionId && method === 'Page.enable') this.pages.add(sessionId);
    if (sessionId && method === 'Page.disable' && this.shown.has(sessionId)) {
      this.pages.delete(sessionId);
      return this.deliver({ id, sessionId, result: {} });
    }
    this.asked.set(id, message);
    this.connection.send(JSON.stringify(message));
  }

  received(text) {
    const message = parse(text);
    if (this.internal.has(message.id)) {
      const resolve = this.internal.get(message.id);
      this.internal.delete(message.id);
      return resolve(message);
    }
    const was = message.id === undefined ? undefined : this.asked.get(message.id);
    this.asked.delete(message.id);
    this.queue(
      message.sessionId ?? was?.sessionId ?? '',
      () => (message.id === undefined ? this.event(message) : this.answer(message, was)),
      (error) => {
        console.warn(`the CDP guard dropped a message: ${error.message}`);
        if (was) this.refuse(was, FAILED);
      }
    );
  }

  queue(key, task, failed) {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(task).catch(failed);
    this.queues.set(key, next);
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  start() {
    const { connection, guarded } = this;
    connection.onmessage = (text) => this.received(text);
    connection.onclose = (why) => guarded.onclose?.(why);
    guarded.send = (text) => {
      const message = parse(text);
      this.queue(
        `send:${message.sessionId ?? ''}`,
        async () => {
          const why = await this.check(message);
          if (why) return this.refuse(message, why);
          if (message.method === 'Target.createTarget' && message.params?.url) {
            return this.create(message);
          }
          return this.pass(message);
        },
        (error) => {
          console.warn(`the CDP guard refused a command: ${error.message}`);
          this.refuse(message, FAILED);
        }
      );
    };
    guarded.close = () => connection.close();
    return guarded;
  }
}

const framed = (tree) =>
  tree?.frame ? [tree.frame, ...(tree.childFrames ?? []).flatMap((child) => framed(child))] : [];

export function guardProtected(connection, own) {
  return new Guard(connection, own).start();
}
