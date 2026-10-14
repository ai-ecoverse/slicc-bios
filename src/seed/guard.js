import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

export const PROTECTED = 'seven’s own pages and the vault are out of reach of browser automation';
export const UNSEEN = 'this request wasn’t seen, so it could be seven’s or the vault’s';
export const FETCH = 'Fetch needs a tab session; it can’t pause the whole browser';
export const STREAM =
  'this stream wasn’t handed out by the guard, so it could be seven’s or the vault’s';
export const FAILED = 'the CDP guard couldn’t check this answer, so it held it back';

const GUARD_IDS = 2 ** 30;
const HOLD_MS = 2000;
const BLANK_MS = 10000;
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

export function protection(own) {
  const matcher = protectedOrigins(catalog.protectedOrigins, own ? [own] : []);
  const web = (url) => typeof url === 'string' && matcher.url(url.replace(/^ws(s?):/i, 'http$1:'));
  return { ...matcher, url: web };
}

class Guard {
  constructor(connection, own) {
    this.connection = connection;
    this.is = protection(own);
    this.targets = new Map();
    this.sessions = new Map();
    this.shown = new Set();
    this.blocked = new Set();
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
    this.targets.set(info.targetId, {
      url: info.url ?? '',
      openerId: info.openerId,
      was: known?.was || known?.guarded || false,
      guarded: known?.guarded || false,
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

  async verify(sessionId) {
    void this.call('Page.enable', {}, sessionId);
    const tree = (await this.call('Page.getFrameTree', {}, sessionId)).result?.frameTree;
    const all = framed(tree);
    for (const frame of all) this.frames.set(frame.id, frame.url);
    return !all.some((frame) => this.is.url(frame.url));
  }

  async inspect(sessionId, targetId, parent) {
    const [guarded, clean] = await Promise.all([
      targetId ? this.target(targetId) : false,
      this.verify(sessionId),
    ]);
    if (guarded || !clean) {
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
    this.sessions.set(sessionId, { targetId: targetInfo.targetId, parent });
    if (params.waitingForDebugger) void this.call('Runtime.runIfWaitingForDebugger', {}, sessionId);
    const info = await this.named(targetInfo.targetId);
    if (!info) return this.cut(sessionId, parent);
    this.targets.delete(info.targetId);
    this.learn(info);
    if (await this.watch(sessionId, info.targetId, parent)) {
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

  release({ method, params = {}, sessionId }) {
    const { requestId } = params;
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
      if (!info.url && (info.type === 'page' || info.type === 'iframe')) {
        void this.blank(message);
        return true;
      }
      this.learn(info);
      if (await this.watch(params.sessionId, info.targetId, sessionId)) this.deliver(message);
      return true;
    }
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      this.learn(params.targetInfo);
      if (!(await this.target(params.targetInfo?.targetId))) return false;
      this.cutTarget(params.targetInfo.targetId);
      return true;
    }
    if (method === 'Target.targetDestroyed') {
      return this.targets.get(params.targetId)?.guarded === true;
    }
    if (method === 'Target.detachedFromTarget') {
      this.sessions.delete(params.sessionId);
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
    if (NAVIGATED.has(method)) return this.is.url(params.url);
    if (method === 'Network.requestWillBeSent' && params.type === 'Document') {
      return this.is.url(params.request?.url);
    }
    return method === 'Runtime.executionContextCreated' && this.is.url(params.context?.origin);
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
    if (method.startsWith('Target.') && (await this.targetEvent(message))) return;
    if (this.blocked.has(sessionId) && PAUSES.has(method)) return this.release(message);
    if (this.hidden(sessionId)) return;
    if (this.walked({ ...message, method })) return this.cut(sessionId);
    if (await this.swallowed({ ...message, method })) return;
    if (this.stored({ ...message, method })) return;
    if (sessionId && this.naming({ ...message, method })) return;
    if (sessionId && method.startsWith('Page.') && !this.pages.has(sessionId)) return;
    this.deliver(message);
  }

  async listed(message, result) {
    const targetInfos = [];
    for (const info of result.targetInfos) {
      this.learn(info);
      if (!(await this.target(info.targetId))) targetInfos.push(info);
    }
    return this.deliver({ ...message, result: { ...result, targetInfos } });
  }

  async answer(message, was) {
    if (was?.sessionId && this.blocked.has(was.sessionId)) return this.refuse(was);
    const { method, params = {} } = was ?? {};
    const { result } = message;
    if (method === 'Target.attachToTarget' && result?.sessionId) {
      const ok = await this.watch(result.sessionId, params.targetId);
      return ok ? this.deliver(message) : this.refuse(was);
    }
    if (method === 'Target.getTargets' && Array.isArray(result?.targetInfos)) {
      return this.listed(message, result);
    }
    if (method === 'Target.createTarget' && result?.targetId) {
      this.learn({ targetId: result.targetId, url: params.url });
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

  plainly(method, params, sessionId) {
    return (
      (sessionId !== undefined && this.hidden(sessionId)) ||
      UNSAFE.has(method) ||
      (FLAT.has(method) && params.flatten !== true) ||
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
    return this.requests.get(id) ? PROTECTED : null;
  }

  async check(message) {
    const { method, params = {}, sessionId } = message;
    if (typeof method !== 'string') return null;
    if (method.startsWith('Fetch.') && sessionId === undefined) return FETCH;
    if (this.plainly(method, params, sessionId)) return PROTECTED;
    if ((method === 'IO.read' || method === 'IO.close') && !this.streams.has(params.handle)) {
      return STREAM;
    }
    if (params.targetId !== undefined && (await this.current(params.targetId))) return PROTECTED;
    if (await this.frame(params.frameId)) return PROTECTED;
    return this.unseen(method, params);
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
          return why ? this.refuse(message, why) : this.pass(message);
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
