import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';
import { RELAY, SIGN_IN_CLIENTS } from './adobe.js';
import { hold, isHeld } from './held.js';

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
export const WORLD = 'slicc: refused: that execution context belongs to a browser extension';
export const UNSEEN_CONTEXT =
  'slicc: refused: that execution context or object is not exposed to browser automation';
export const PROFILED =
  'slicc: refused: a browser extension runs scripts in this page, and profiling it would expose them';
export const DEBUGGER =
  'slicc: refused: breakpoints could run in seven’s pages or the vault, so the guard doesn’t offer the Debugger domains';

const GUARD_IDS = 2 ** 30;
const HOLD_MS = 2000;
const BLANK_MS = 10000;
const ERROR_PAGE = 'chrome-error://chromewebdata/';
const bare = (url) => url.split('#')[0];
const SCRUB_MS = 5000;
export const BLANKED = 'data:text/html,%3Ctitle%3Eblocked%3C%2Ftitle%3E';
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
const CONTENTS = new Set([
  'Page.captureSnapshot',
  'Page.getResourceContent',
  'Page.searchInResource',
  'Network.getResponseBody',
  'Network.searchInResponseBody',
  'Fetch.getResponseBody',
  'IO.read',
  'CSS.getStyleSheetText',
  'Audits.getEncodedResponse',
  'Network.getResponseBodyForInterception',
  'Network.getRequestPostData',
  'DOM.getDocument',
  'DOM.getFlattenedDocument',
  'DOM.getOuterHTML',
  'DOM.describeNode',
  'DOMSnapshot.captureSnapshot',
  'DOMSnapshot.getSnapshot',
]);
const TREED = new Set([
  'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree',
  'Accessibility.getChildAXNodes',
  'Accessibility.queryAXTree',
]);
const STREAMED = new Set([
  'Network.streamResourceContent',
  'Fetch.takeResponseBodyAsStream',
  'Network.takeResponseBodyForInterceptionAsStream',
]);
const SEARCHES = {
  'Network.searchInResponseBody': ({ requestId }) => ['Network.getResponseBody', { requestId }],
  'Page.searchInResource': ({ frameId, url }) => ['Page.getResourceContent', { frameId, url }],
};
export const STREAMING =
  'slicc: refused: a streamed body can’t be checked for seven’s or the vault’s URLs, so the guard doesn’t stream bodies; read the whole body instead';
const CLOSED = new Set(['url', 'scopeURL', 'scriptURL']);
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
const EXTENSIONS = /^(chrome-extension|moz-extension|safari-web-extension|ms-browser-extension):/i;
const CONTEXT_KEYS = new Set(['contextId', 'executionContextId']);
const UNIQUE_KEYS = new Set(['uniqueContextId', 'executionContextUniqueId']);
const objectKey = (key) => key === 'objectId' || key.endsWith('ObjectId');
const PROBE =
  "typeof chrome === 'object' && chrome !== null && Boolean(chrome.runtime && chrome.runtime.id)";
const OBJECT_ID = /^-?\d+\.(\d+)\.\d+$/;
const PROFILERS = ['HeapProfiler.', 'Profiler.'];
const PAGE_PAINT = new Set([
  'Page.captureScreenshot',
  'Page.startScreencast',
  'Page.captureSnapshot',
]);
const PAGE_DOMAINS = [
  'DOM.',
  'DOMSnapshot.',
  'CSS.',
  'Accessibility.',
  'Input.',
  'LayerTree.',
  'HeadlessExperimental.',
  'Cast.',
];
const pageScoped = (method = '') =>
  PAGE_PAINT.has(method) || PAGE_DOMAINS.some((domain) => method.startsWith(domain));
const FRAME_CHILDREN = [{ type: 'iframe', exclude: false }, { exclude: true }];
const NO_AUTO_ATTACH =
  'slicc: refused: Target.setAutoAttach is not supported: attach to each target';
const STRUCTURE = new Set([
  'Page.frameAttached',
  'Page.frameDetached',
  'Page.frameNavigated',
  'Target.attachedToTarget',
  'Target.detachedFromTarget',
  'Target.targetDestroyed',
  'Target.targetInfoChanged',
  'Runtime.executionContextCreated',
]);

function objectIds(value, found) {
  if (typeof value !== 'string') return;
  const [, context] = value.match(OBJECT_ID) ?? [];
  found.push(context === undefined ? ['unreadable', value] : ['ids', Number(context)]);
}

function selected(method, params) {
  const found = [];
  if (params === null || typeof params !== 'object') return found;
  for (const [key, item] of Object.entries(params)) if (objectKey(key)) objectIds(item, found);
  if (method.startsWith('Runtime.') || method.startsWith('DOM.')) {
    for (const key of CONTEXT_KEYS) {
      if (params[key] !== undefined && (key !== 'contextId' || method.startsWith('Runtime.')))
        found.push(['ids', params[key]]);
    }
    for (const key of UNIQUE_KEYS)
      if (params[key] !== undefined) found.push(['uniques', params[key]]);
  }
  if (Array.isArray(params.arguments))
    for (const item of params.arguments) objectIds(item?.objectId, found);
  return found;
}

function mentioned(value, found = []) {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) mentioned(item, found);
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'value') continue;
    if (CONTEXT_KEYS.has(key)) found.push(['ids', item]);
    else if (UNIQUE_KEYS.has(key)) found.push(['uniques', item]);
    else if (objectKey(key)) objectIds(item, found);
    else mentioned(item, found);
  }
  return found;
}

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
    return true;
  }
};

const owned = (own) => [own ?? []].flat().filter(Boolean);

const STARTS = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\//gi;
const ENCODED_STARTS = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*%(?:25)*3a%(?:25)*2f%(?:25)*2f/gi;
const STOPS = /[\s"'<>\\`]/g;
const ENCODED_STOPS = /[\s"'<>\\`&]/g;
const AUTHORITY = 4096;
const SPOKEN = /^(?:Network|Fetch|Log|Audits|Page|CSS|Console|DOM)\./;
const CONSOLE = new Set(['Runtime.exceptionThrown', 'Runtime.consoleAPICalled']);
const ANSWERED = new Set([
  'headers',
  'headersText',
  'responseHeaders',
  'redirectResponse',
  'response',
]);
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOSTS = new RegExp(
  `((?:${[...catalog.protectedOrigins.domains, ...catalog.protectedOrigins.hosts].map(escaped).join('|')}))(\\.?(?::\\d+|%3a\\d+)?)(?:[/?#\\\\][^\\s"'<>\`]*|(?:%2f|%3f|%23|%5c)[^\\s"'<>\`&]*)`,
  'giu'
);

const ENTITIES = { colon: ':', sol: '/', amp: '&', quest: '?', num: '#', equals: '=', period: '.' };

function unescaped(text) {
  return text
    .replace(
      /\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\(\/)/gi,
      (found, unicode, hex, slash) =>
        slash ?? String.fromCharCode(Number.parseInt(unicode ?? hex, 16))
    )
    .replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]+));?/gi, (found, hex, dec, name) => {
      if (hex || dec) {
        const code = hex ? Number.parseInt(hex, 16) : Number(dec);
        return code <= 0x10ffff ? String.fromCodePoint(code) : found;
      }
      return ENTITIES[name.toLowerCase()] ?? found;
    });
}

function decodedBytes(text) {
  try {
    return atob(text);
  } catch {
    return '';
  }
}

function decoded(text) {
  let out = text.replace(/%[0-9a-f]?$/i, '');
  for (let i = 0; i < 4 && /%[0-9a-f]{2}/i.test(out); i += 1) {
    try {
      out = decodeURIComponent(out);
    } catch {
      return out;
    }
  }
  return out;
}

function authority(text) {
  const start = text.indexOf('://') + 3;
  const rest = text.slice(start, start + AUTHORITY + 1);
  const end = rest.search(/[/?#\\]/);
  const whole = end < 0 ? rest : rest.slice(0, end);
  if (whole.length > AUTHORITY) return null;
  return `${text.slice(0, start)}${whole.slice(whole.lastIndexOf('@') + 1)}`;
}

function scanned(value, starts, stops, swap) {
  let out = '';
  let last = 0;
  let stop = -1;
  starts.lastIndex = 0;
  for (let found = starts.exec(value); found; found = starts.exec(value)) {
    if (found.index >= stop) {
      stops.lastIndex = found.index;
      stop = stops.exec(value)?.index ?? value.length;
    }
    const swapped = swap(value.slice(found.index, stop));
    if (swapped === null) continue;
    out += value.slice(last, found.index) + swapped;
    last = stop;
    starts.lastIndex = stop;
  }
  return out + value.slice(last);
}

const PUBLIC = {
  'www.sliccy.ai': /^\/(?:7\/?|install\.sh|docs(?:\/[a-z0-9-]+)*\/?|blog(?:\/[a-z0-9-]+)*\/?)?$/,
  'sliccy.ai': /^\/?$/,
  'ntfy.sliccy.ai': /^\/github\/?$/,
};

const normalHost = (host) => host.toLowerCase().replace(/\.$/, '');

const PROSE = /[.,;:!?)\]}'"]+$/;

function readable(text) {
  const url = text.replace(PROSE, '');
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  const rest = url.slice(url.indexOf('://') + 3);
  const raw = /[/\\?#]/.test(rest) ? rest.slice(rest.search(/[/\\?#]/)) : '';
  if (raw !== parsed.pathname && !(raw === '' && parsed.pathname === '/')) return false;
  if (parsed.pathname === '/') return true;
  return PUBLIC[normalHost(parsed.hostname)]?.test(parsed.pathname) === true;
}

const HOST_CHAR = /[a-z0-9-]/i;

function labelsBefore(text, end) {
  let start = end;
  for (let count = 0; count < 8 && text[start - 1] === '.'; count += 1) {
    let at = start - 1;
    while (at > 0 && start - 1 - at < 63 && HOST_CHAR.test(text[at - 1])) at -= 1;
    if (at === start - 1) break;
    start = at;
  }
  return text.slice(start, end);
}

const hopKey = (url) => {
  if (!URL.canParse(url)) return bare(url).split('?')[0];
  const parsed = new URL(url);
  return `${parsed.protocol}//${normalHost(parsed.hostname)}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
};

export function redacting(is) {
  let webs = 0;
  const past = (text, shown) => {
    if (/^(?:https?|wss?):/i.test(text) && text.length > shown.length && !readable(text)) {
      webs += 1;
    }
  };
  const origin = (text) => {
    const shown = authority(text);
    if (shown === null) return text.slice(0, text.indexOf('://') + 3);
    if (!is.url(`${shown}/`)) return null;
    if (URL.canParse(`${shown}/`)) past(text, shown);
    return shown;
  };
  const encoded = (text) => {
    const plain = decoded(text.slice(0, AUTHORITY * 3));
    if (!plain.includes('://')) return null;
    const shown = origin(plain);
    return shown === null ? null : encodeURIComponent(shown);
  };
  const text = (value) => {
    if (!value.includes('://') && !/%(?:25)*3a/i.test(value) && !/sliccy\.ai/i.test(value)) {
      return value;
    }
    const raw = scanned(value, STARTS, STOPS, origin);
    const coded = scanned(raw, ENCODED_STARTS, ENCODED_STOPS, encoded);
    return coded.replace(HOSTS, (found, host, port, offset) => {
      const labels = labelsBefore(coded, offset);
      if (!readable(`http://${labels}${decoded(found)}`)) webs += 1;
      return `${host}${port}`;
    });
  };
  const walk = (value, path, changed) => {
    if (typeof value === 'string') {
      const out = text(value);
      if (out !== value) changed.push(path);
      return out;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, path, changed));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    const before = changed.length;
    for (const [key, item] of Object.entries(value)) {
      out[text(key)] = walk(item, ANSWERED.has(key) ? [...path, key] : path, changed);
    }
    const sibling = Object.entries(value).some(
      ([key, item]) => typeof item === 'string' && out[text(key)] !== item
    );
    if (sibling && changed.length > before && typeof out.urlFragment === 'string') {
      out.urlFragment = '';
    }
    return out;
  };
  return (params) => {
    const changed = [];
    webs = 0;
    const out = walk(params, [], changed);
    return {
      params: out,
      changed,
      named: webs > 0,
      answered: changed.some((path) => path.length > 0),
    };
  };
}

const kept = (set, value) => {
  set.add(value);
  if (set.size > REMEMBERED) set.delete(set.values().next().value);
};

const INHERITING = /^(?:$|about:|javascript:)/i;
const ORDINARY = /^(?:https?|data):/i;
const BLANK = /^about:blank(?:#|$)/i;

export const ARM = [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }];

const CALLBACK_NAMED = RELAY.replace(/^https?:\/\//, '').toLowerCase();

export function signsIn(url) {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return false;
  let text = url;
  for (let i = 0; i < 5; i += 1) {
    const lower = text.toLowerCase();
    if (lower.includes(CALLBACK_NAMED)) return true;
    for (const [, id] of lower.matchAll(/[?&#]client_id=([^&#\s]*)/g)) {
      if ([...SIGN_IN_CLIENTS].some((client) => client.toLowerCase() === id)) return true;
    }
    const next = text.replace(/\+/g, ' ').replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run.replace(/%([0-9a-f]{2})/gi, (found, hex) =>
          String.fromCharCode(Number.parseInt(hex, 16))
        );
      }
    });
    if (next === text) return false;
    text = next;
  }
  return true;
}

export function protection(own) {
  const matcher = protectedOrigins(catalog.protectedOrigins, owned(own));
  const web = (url, options) =>
    typeof url === 'string' &&
    (matcher.url(url.replace(/^ws(s?):/i, 'http$1:'), options) || signsIn(url));
  const target = (info) =>
    matcher.target(info) || (!info.type?.endsWith('worker') && signsIn(info.url));
  return { ...matcher, url: web, target };
}

class Guard {
  constructor(connection, own) {
    this.connection = connection;
    this.is = protection(own);
    this.redact = redacting(this.is);
    this.redirected = new Set();
    this.continued = new Set();
    this.delivered = new Set();
    this.extras = new Set();
    this.hops = new Set();
    this.sheets = new Set();
    this.navs = new Map();
    this.navSessions = new Map();
    this.errored = new Map();
    this.offered = new Set();
    this.contexts = new Set();
    this.worlds = new Map();
    this.runtimes = new Set();
    this.primed = new Set();
    this.targets = new Map();
    this.sessions = new Map();
    this.shown = new Set();
    this.blocked = new Set();
    this.gone = new Set();
    this.waiting = new Set();
    this.pages = new Set();
    this.frames = new Map();
    this.parents = new Map();
    this.scopes = new Map();
    this.placements = new Map();
    this.placing = new Map();
    this.placementsPending = new Map();
    this.casts = new Set();
    this.requests = new Map();
    this.held = new Map();
    this.internal = new Map();
    this.asked = new Map();
    this.commands = new Map();
    this.finished = new WeakSet();
    this.watching = new Map();
    this.queues = new Map();
    this.streams = new Set();
    this.allowed = new Set();
    this.blockedWorkers = new Set();
    this.next = GUARD_IDS;
    this.guarded = { onmessage: null, onclose: null };
  }

  redacted(message) {
    const { method, params } = message;
    if (!params || !(SPOKEN.test(method ?? '') || CONSOLE.has(method)))
      return this.deliver(message);
    if (
      method === 'Network.responseReceivedExtraInfo' &&
      params.statusCode >= 300 &&
      params.statusCode < 400
    ) {
      kept(this.extras, params.requestId);
    }
    if (method === 'CSS.styleSheetAdded' && this.is.url(params.header?.sourceURL)) {
      kept(this.sheets, params.header.styleSheetId);
    }
    const { params: redacted, changed, answered } = this.redact(params);
    if (!changed.length) return this.deliver(message);
    if (answered && /^(?:Network|Fetch)\./.test(method)) {
      for (const id of [params.requestId, params.networkId])
        if (id !== undefined) kept(this.redirected, id);
      for (const url of [params.request?.url, params.response?.url])
        if (typeof url === 'string') kept(this.hops, hopKey(url));
    }
    return this.deliver({ ...message, params: redacted });
  }

  deliver(message) {
    const command = this.commands.get(message.id);
    if (command) {
      this.finished.add(command);
      this.commands.delete(message.id);
    }
    try {
      this.guarded.onmessage?.(JSON.stringify(message));
    } catch (error) {
      console.warn(`a CDP client failed on a message: ${error.message}`);
    }
  }

  call(method, params, sessionId) {
    return new Promise((resolve) => {
      this.next += 1;
      this.internal.set(this.next, (message) => {
        if (method === 'Page.getFrameTree')
          this.recordTree(this.scopeTarget(sessionId), message.result?.frameTree);
        if (method === 'DOM.getDocument' && this.placements.has(sessionId))
          this.recordOwners(this.scopeTarget(sessionId), message.result?.root);
        resolve(message);
      });
      this.connection.send(
        JSON.stringify({ id: this.next, method, params, ...(sessionId ? { sessionId } : {}) })
      );
    });
  }

  refuse(command, message = PROTECTED) {
    if (this.finished.has(command)) return;
    this.finished.add(command);
    this.commands.delete(command.id);
    const { id, sessionId, method, params } = command;
    globalThis.sliccGuardTrace?.push({
      method,
      targetId: params?.targetId,
      sessionId,
      refused: message,
    });
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
      parentId: info.parentId ?? known?.parentId,
      was: known?.was || known?.guarded || false,
      guarded: known?.guarded || false,
      real: known?.real || false,
      access: known?.access || info.canAccessOpener === true,
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
    if (isHeld(targetId) || isHeld(found.openerId)) {
      hold(targetId);
      found.guarded = true;
      return true;
    }
    if (depth > 8) return true;
    if (found.parentId && found.parentId !== targetId) {
      await this.target(found.parentId, depth + 1);
      if (isHeld(found.parentId)) {
        hold(targetId);
        found.guarded = true;
        return true;
      }
    }
    const opener = await this.opener(found.openerId, depth);
    const lent = found.type === 'page' && (found.access || BLANK.test(found.url));
    if (isHeld(found.openerId) || (opener === 'protected' && lent)) {
      hold(targetId);
      found.guarded = true;
      return true;
    }
    const verdict = this.is.target({
      url: found.url,
      type: found.type,
      previous: found.was,
      opener,
    });
    if (verdict && !INHERITING.test(found.url)) found.real = true;
    if (!found.real && ORDINARY.test(found.url) && !this.is.url(found.url)) {
      found.guarded = false;
      found.was = false;
    }
    found.guarded = found.guarded || verdict;
    return found.guarded;
  }

  scope(targetId) {
    if (!this.scopes.has(targetId))
      this.scopes.set(targetId, {
        frames: new Set(),
        owners: new Set(),
        remoteOwners: new Set(),
        ready: false,
      });
    return this.scopes.get(targetId);
  }

  scopeTarget(sessionId) {
    return (
      this.placements.get(sessionId) ??
      this.sessions.get(sessionId)?.targetId ??
      this.navSessions.get(sessionId)?.targetId
    );
  }

  pageLocked(targetId, seen = new Set()) {
    if (!targetId || seen.has(targetId)) return true;
    seen.add(targetId);
    const scope = this.scopes.get(targetId);
    if (!scope?.ready) return true;
    for (const id of scope.frames) {
      const url = this.frames.get(id);
      if (url === undefined || url === '' || this.is.url(url)) return true;
      if (
        id !== scope.root &&
        (scope.remoteOwners.has(id) || this.targets.get(id)?.type === 'iframe') &&
        this.pageLocked(id, new Set(seen))
      )
        return true;
      if (id !== scope.root && (!this.parents.has(id) || !this.frames.has(this.parents.get(id))))
        return true;
    }
    for (const [child, entry] of this.scopes) {
      if (entry.parent === targetId && this.pageLocked(child, new Set(seen))) return true;
    }
    return false;
  }

  locked(sessionId) {
    const targetId = this.scopeTarget(sessionId);
    if (!targetId) return true;
    const seen = new Set();
    let id = targetId;
    while (id) {
      if (seen.has(id) || this.pageLocked(id)) return true;
      seen.add(id);
      id = this.scopes.get(id)?.parent;
    }
    return false;
  }

  stopCasts() {
    for (const message of this.asked.values()) {
      if (pageScoped(message.method) && this.locked(message.sessionId)) {
        message.locked = true;
        this.refuse(message);
      }
    }
    for (const sessionId of this.casts) {
      if (!this.locked(sessionId)) continue;
      this.casts.delete(sessionId);
      void this.call('Page.stopScreencast', {}, sessionId);
    }
  }

  recordTree(targetId, tree) {
    const scope = this.scope(targetId);
    const all = framed(tree);
    scope.root = tree?.frame?.id;
    scope.treeFrames = new Set(all.map((frame) => frame.id));
    scope.frames = new Set([...scope.treeFrames, ...scope.owners]);
    const parentId = tree?.frame?.parentId;
    if (parentId && !scope.parent)
      scope.parent = this.scopes.has(parentId)
        ? parentId
        : [...this.scopes].find(
            ([id, entry]) => id !== targetId && entry.frames.has(parentId)
          )?.[0];
    scope.tree = all.length > 0;
    scope.ready = scope.tree && !scope.failed && !scope.pending;
    if (this.targets.get(targetId)?.type === 'iframe' && !scope.parent) scope.ready = false;
    for (const frame of all) {
      this.frames.set(
        frame.id,
        this.is.url(frame.securityOrigin) ? frame.securityOrigin : (frame.url ?? '')
      );
      if (frame.parentId) this.parents.set(frame.id, frame.parentId);
    }
    this.stopCasts();
  }

  recordOwners(targetId, root) {
    const scope = this.scope(targetId);
    scope.ownersReady = Boolean(root);
    const former = scope.owners;
    scope.owners = new Set();
    scope.remoteOwners = new Set();
    const nodes = [root];
    while (nodes.length) {
      const node = nodes.pop();
      if (!node) continue;
      this.recordOwner(scope, node);
      nodes.push(
        ...(node.children ?? []),
        ...(node.shadowRoots ?? []),
        node.contentDocument,
        node.templateContent
      );
    }
    for (const id of former)
      if (!scope.owners.has(id) && !scope.treeFrames?.has(id)) scope.frames.delete(id);
    this.stopCasts();
  }

  recordOwner(scope, node) {
    if (node.nodeName !== 'IFRAME' && node.nodeName !== 'FRAME') return;
    if (!node.frameId) {
      scope.ownersReady = false;
      return;
    }
    scope.owners.add(node.frameId);
    if (!node.contentDocument) scope.remoteOwners.add(node.frameId);
    scope.frames.add(node.frameId);
    if (!this.frames.has(node.frameId)) this.frames.set(node.frameId, '');
    if (!this.parents.has(node.frameId)) this.parents.set(node.frameId, scope.root);
  }

  place(targetId, sessionId) {
    const active = this.placementsPending.get(targetId);
    if (active) {
      active.again = true;
      active.sessionId = sessionId;
      return active.promise;
    }
    this.placements.set(sessionId, targetId);
    this.scope(targetId).ready = false;
    this.stopCasts();
    const entry = { sessionId, again: false };
    this.placementsPending.set(targetId, entry);
    entry.promise = Promise.resolve().then(() => this.placeNext(targetId, entry));
    this.placing.set(targetId, entry.promise);
    return entry.promise;
  }

  async placeNext(targetId, entry) {
    try {
      await this.placeOne(targetId, entry.sessionId);
      while (entry.again) {
        entry.again = false;
        await this.placeOne(targetId, entry.sessionId);
      }
    } finally {
      this.placementsPending.delete(targetId);
    }
  }

  async placeOne(targetId, sessionId) {
    this.placements.set(sessionId, targetId);
    this.scope(targetId).pending = (this.scope(targetId).pending ?? 0) + 1;
    this.scope(targetId).ready = false;
    this.stopCasts();
    const enabled = await this.call('Page.enable', {}, sessionId);
    const [attached] = await Promise.all([
      this.call(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: FRAME_CHILDREN },
        sessionId
      ),
      this.call('Page.getFrameTree', {}, sessionId),
    ]);
    await this.call('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
    const disabled = await this.call('DOM.disable', {}, sessionId);
    const scope = this.scope(targetId);
    scope.pending -= 1;
    scope.failed = Boolean(
      enabled.error ||
        (attached.error && attached.error.message !== NO_AUTO_ATTACH) ||
        !scope.ownersReady ||
        disabled.error
    );
    scope.ready = Boolean(scope.tree && !scope.failed && !scope.pending);
    if (this.targets.get(targetId)?.type === 'iframe' && !scope.parent) scope.ready = false;
    this.stopCasts();
    await Promise.all(
      [...this.scopes]
        .filter(([, scope]) => scope.parent === targetId)
        .map(([id]) => this.placing.get(id))
    );
  }

  scopeEvent(message) {
    const targetId = this.scopeTarget(message.sessionId);
    this.scopeTargets(message, targetId);
    if (targetId) this.scopeFrames(message, targetId);
    this.stopCasts();
  }

  scopeTargets({ method, params = {}, sessionId }, targetId) {
    if (
      method === 'Target.targetInfoChanged' &&
      this.scopes.has(params.targetInfo?.targetId) &&
      this.is.url(params.targetInfo.url)
    )
      this.frames.set(params.targetInfo.targetId, params.targetInfo.url);
    if (method === 'Target.attachedToTarget' && this.placements.has(sessionId)) {
      const info = params.targetInfo;
      if (info?.type !== 'iframe') return;
      const child = this.scope(info.targetId);
      child.parent = targetId;
      child.ready = false;
      this.learn(info);
      this.placements.set(params.sessionId, info.targetId);
      this.placing.set(info.targetId, this.place(info.targetId, params.sessionId));
      if (params.waitingForDebugger)
        void this.call('Runtime.runIfWaitingForDebugger', {}, params.sessionId);
    }
    if (method === 'Target.targetDestroyed') this.scopes.delete(params.targetId);
    if (method === 'Target.detachedFromTarget' && params.sessionId !== undefined) {
      kept(this.gone, params.sessionId);
      this.refusePending(params.sessionId);
    }
    if (method === 'Target.detachedFromTarget' && this.placements.has(params.sessionId)) {
      const childId = this.placements.get(params.sessionId);
      this.placements.delete(params.sessionId);
      const child = this.scopes.get(childId);
      if (child) child.ready = false;
    }
  }

  scopeFrames({ method, params = {} }, targetId) {
    if (method === 'Page.frameAttached') {
      const scope = this.scope(targetId);
      scope.frames.add(params.frameId);
      scope.owners.add(params.frameId);
      this.frames.set(params.frameId, '');
      if (params.parentFrameId) this.parents.set(params.frameId, params.parentFrameId);
    }
    if (method === 'Page.frameNavigated' && params.frame)
      this.scopeNavigated(params.frame, targetId);
    const foreign =
      params.context?.auxData?.type === 'isolated' && EXTENSIONS.test(params.context?.origin ?? '');
    if (
      method === 'Runtime.executionContextCreated' &&
      !foreign &&
      this.is.url(params.context?.origin)
    ) {
      const id = params.context.auxData?.frameId;
      if (id) {
        this.scope(targetId).frames.add(id);
        this.frames.set(id, params.context.origin);
      } else this.scope(targetId).ready = false;
    }
    if (method === 'Page.frameDetached') {
      if (params.reason === 'swap') this.frames.set(params.frameId, '');
      else {
        this.removeFrame(params.frameId);
        const navSession = this.navs.get(targetId)?.session;
        if (navSession) this.placing.set(targetId, this.place(targetId, navSession));
      }
    }
  }

  scopeNavigated(frame, targetId) {
    const scope = this.scope(targetId);
    if (frame.id === scope.root || (!frame.parentId && !scope.root)) {
      for (const id of scope.frames) if (id !== targetId) this.removeFrame(id);
      scope.frames.clear();
      scope.owners.clear();
      scope.remoteOwners.clear();
      scope.ready = false;
      const navSession = this.navs.get(targetId)?.session;
      if (navSession) this.placing.set(targetId, this.place(targetId, navSession));
    }
    scope.frames.add(frame.id);
    if (frame.parentId && frame.id !== scope.root) scope.remoteOwners.delete(frame.id);
    this.frames.set(
      frame.id,
      this.is.url(frame.securityOrigin) ? frame.securityOrigin : (frame.url ?? '')
    );
    if (frame.parentId) this.parents.set(frame.id, frame.parentId);
  }

  removeFrame(frameId) {
    const gone = new Set([frameId]);
    for (let size = 0; size !== gone.size; ) {
      size = gone.size;
      for (const [id, parent] of this.parents) if (gone.has(parent)) gone.add(id);
      for (const [id, scope] of this.scopes) if (gone.has(scope.parent)) gone.add(id);
    }
    for (const id of gone) {
      this.frames.delete(id);
      this.parents.delete(id);
      this.scopes.delete(id);
      for (const scope of this.scopes.values()) {
        scope.frames.delete(id);
        scope.owners.delete(id);
        scope.remoteOwners.delete(id);
        scope.treeFrames?.delete(id);
      }
    }
  }

  async frame(frameId, strict = false) {
    if (frameId === undefined) return false;
    if (this.targets.has(frameId)) return this.target(frameId);
    if (this.frames.has(frameId)) {
      const url = this.frames.get(frameId);
      if (this.is.url(url)) return true;
      return strict && (url === '' || inherits(url)) && (await this.inherited(frameId, 0));
    }
    if (await this.lookup(frameId)) return this.target(frameId);
    if (strict) return true;
    this.frames.set(frameId, '');
    return false;
  }

  async inherited(frameId, depth) {
    const parent = this.parents.get(frameId);
    if (parent === undefined || depth > 16) return true;
    if (this.targets.has(parent)) return this.target(parent);
    if (!this.frames.has(parent)) return true;
    const url = this.frames.get(parent);
    if (this.is.url(url)) return true;
    if (url === '' || inherits(url)) return this.inherited(parent, depth + 1);
    return false;
  }

  hidden(sessionId) {
    return sessionId !== undefined && (this.blocked.has(sessionId) || !this.shown.has(sessionId));
  }

  refusePending(sessionId) {
    if (sessionId === undefined) return;
    for (const command of this.asked.values())
      if (command.sessionId === sessionId) this.refuse(command);
    for (const command of this.commands.values())
      if (command.sessionId === sessionId) this.refuse(command);
  }

  cut(sessionId, parent) {
    if (this.blocked.has(sessionId)) return;
    this.blocked.add(sessionId);
    this.refusePending(sessionId);
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
    this.placing.set(nav.targetId, this.place(nav.targetId, session));
    await this.placing.get(nav.targetId);
    nav.settle(steps.some((step) => step.error));
  }

  navEvent({ method, params = {} }, nav) {
    if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
      nav.last = `${params.frame.url}${params.frame.urlFragment ?? ''}`;
      nav.stopped = false;
      return this.wiping(nav, nav.last);
    }
    if (method === 'Page.frameStoppedLoading' && params.frameId === nav.targetId) {
      nav.stopped = true;
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
    for (const frame of all) {
      this.frames.set(frame.id, this.framed(frame));
      if (frame.parentId) this.parents.set(frame.id, frame.parentId);
    }
    return Boolean(tree?.frame) &&
      !all.some((frame) => this.is.url(frame.url) || this.is.url(frame.securityOrigin));
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
    this.gone.delete(sessionId);
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
      const guarded = await this.target(info.targetId);
      if (guarded || nav?.taken || nav?.failed) return this.cut(sessionId, parent);
      if (nav) nav.held = false;
      this.deliver({
        ...message,
        params: { ...params, targetInfo: this.masked(info), waitingForDebugger: false },
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
      const shown = this.delivered.has(requestId);
      const marked = this.requests.get(requestId) === true || (await this.request(params));
      const waiting = this.settle(requestId, marked);
      if (marked && shown && params.redirectResponse && !this.continued.has(requestId)) {
        return this.hopped(message);
      }
      if (marked) return !shown || this.continuing(message);
      kept(this.delivered, requestId);
      this.redacted(message);
      for (const held of waiting) this.redacted(held);
      return true;
    }
    if (!this.requests.has(requestId)) {
      this.hold(requestId, message);
      return true;
    }
    if (this.requests.get(requestId) && this.delivered.has(requestId)) {
      return this.continuing(message);
    }
    return this.requests.get(requestId);
  }

  hopped(message) {
    const { requestId, redirectResponse } = message.params;
    kept(this.continued, requestId);
    if (redirectResponse.url) kept(this.hops, hopKey(redirectResponse.url));
    kept(this.redirected, requestId);
    this.redacted(message);
    return true;
  }

  continuing(message) {
    const { method, params = {} } = message;
    if (method === 'Network.loadingFailed' || method === 'Network.loadingFinished') {
      this.redacted({
        method: 'Network.loadingFailed',
        sessionId: message.sessionId,
        params: {
          requestId: params.requestId,
          timestamp: params.timestamp,
          type: params.type ?? 'Other',
          errorText: 'net::ERR_BLOCKED_BY_CLIENT',
          canceled: false,
          blockedReason: 'inspector',
        },
      });
      return true;
    }
    if (method !== 'Network.responseReceivedExtraInfo') return true;
    const redirect = params.statusCode >= 300 && params.statusCode < 400;
    if (!redirect || this.extras.has(params.requestId)) return true;
    if (!this.redact({ headers: params.headers ?? {} }).changed.length) return true;
    kept(this.extras, params.requestId);
    this.redacted(message);
    return true;
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
    if (!nav?.session || nav.scrub) return;
    nav.scrub = this.scrubbing(nav);
    if (!nav.last?.startsWith('chrome-error:')) return;
    nav.erred = true;
    if (nav.stopped) this.wipe(nav);
  }

  scrubbing(nav) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(nav.scrubTimer);
        nav.wiped = null;
        nav.scrub = null;
        nav.retried = false;
        resolve();
      };
      const expire = async () => {
        const answer = nav.session ? await this.call('Page.getFrameTree', {}, nav.session) : {};
        const url = answer.result?.frameTree?.frame;
        const shown = url ? `${url.url}${url.urlFragment ?? ''}` : undefined;
        if (shown !== undefined && !shown.startsWith('chrome-error:') && !this.is.url(shown)) {
          return done();
        }
        if (!nav.retried && shown?.startsWith('chrome-error:')) {
          nav.retried = true;
          void this.call('Page.navigate', { url: BLANKED }, nav.session);
          nav.scrubTimer = setTimeout(expire, SCRUB_MS);
          nav.scrubTimer.unref?.();
          return;
        }
        done();
        this.cutTarget(nav.targetId);
      };
      nav.scrubTimer = setTimeout(expire, SCRUB_MS);
      nav.scrubTimer.unref?.();
      nav.wiped = done;
    });
  }

  wiping(nav, url) {
    if (!nav.wiped) return;
    if (url === BLANKED) return nav.wiped();
    nav.erred = url.startsWith('chrome-error:');
    if (!nav.erred && !inherits(url) && !this.is.url(url)) nav.wiped();
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
      this.watching.delete(params.sessionId);
      this.worlds.delete(params.sessionId);
      this.runtimes.delete(params.sessionId);
      this.primed.delete(params.sessionId);
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
      this.frames.set(params.frame.id, this.framed(params.frame));
      if (params.frame.parentId) this.parents.set(params.frame.id, params.frame.parentId);
      const targetId = this.sessions.get(sessionId)?.targetId;
      if (!params.frame.parentId && targetId && this.targets.has(targetId)) {
        this.targets.get(targetId).url = params.frame.url;
      }
      return this.is.url(params.frame.url) || this.is.url(params.frame.securityOrigin);
    }
    if (method === 'Page.frameAttached' && params.frameId) {
      if (!this.frames.has(params.frameId)) this.frames.set(params.frameId, '');
      if (params.parentFrameId) this.parents.set(params.frameId, params.parentFrameId);
    }
    if (NAVIGATED.has(method)) return !this.armed(sessionId) && this.is.url(params.url);
    if (method === 'Network.requestWillBeSent' && params.type === 'Document') {
      return !this.armed(sessionId) && this.is.url(params.request?.url);
    }
    return method === 'Runtime.executionContextCreated' && this.is.url(params.context?.origin);
  }

  world(sessionId) {
    let world = this.worlds.get(sessionId);
    if (!world) {
      world = { ids: new Map(), uniques: new Map(), names: new Set() };
      this.worlds.set(sessionId, world);
    }
    return world;
  }

  foreign({ method, params = {}, sessionId }) {
    if (method === 'Runtime.executionContextCreated' && params.context) {
      const { id, uniqueId, name, origin, auxData } = params.context;
      const hidden = auxData?.type === 'isolated' && EXTENSIONS.test(origin ?? '');
      const world = this.world(sessionId);
      world.ids.set(id, hidden);
      if (uniqueId !== undefined) world.uniques.set(uniqueId, hidden);
      if (hidden && name) world.names.add(name);
      if (hidden) return true;
    }
    const world = this.worlds.get(sessionId);
    if (!world || !method.startsWith('Runtime.')) return false;
    return mentioned(params).some(([kind, value]) => world[kind]?.get(value) === true);
  }

  verdict(found, sessionId) {
    const world = this.worlds.get(sessionId);
    const known = found.map(([kind, value]) => world?.[kind]?.get(value));
    if (known.includes(true)) return WORLD;
    return known.includes(undefined) ? UNSEEN_CONTEXT : null;
  }

  async prime(sessionId) {
    if (!this.runtimes.has(sessionId)) this.primed.add(sessionId);
    await this.call('Runtime.enable', {}, sessionId);
    await this.queues.get(sessionId);
  }

  async learned(sessionId) {
    if (!this.runtimes.has(sessionId) && !this.primed.has(sessionId)) await this.prime(sessionId);
    return this.world(sessionId);
  }

  async gating(method, params, sessionId) {
    if (!sessionId) return null;
    if (method === 'Page.createIsolatedWorld' && typeof params.worldName === 'string') {
      return (await this.learned(sessionId)).names.has(params.worldName) ? WORLD : null;
    }
    if (PROFILERS.some((domain) => method.startsWith(domain))) {
      return [...(await this.learned(sessionId)).ids.values()].includes(true) ? PROFILED : null;
    }
    return null;
  }

  async probe(found, sessionId) {
    const world = this.world(sessionId);
    for (const [kind, value] of found) {
      if (kind === 'unreadable' || world[kind].has(value)) continue;
      const where = kind === 'ids' ? { contextId: value } : { uniqueContextId: value };
      const probed = await this.call(
        'Runtime.evaluate',
        { expression: PROBE, returnByValue: true, silent: true, ...where },
        sessionId
      );
      const extension = probed.result?.result?.value;
      if (typeof extension === 'boolean' && !probed.result.exceptionDetails)
        world[kind].set(value, extension);
    }
  }

  async selecting(method, params, sessionId) {
    const gated = await this.gating(method, params, sessionId);
    if (gated) return gated;
    const found = selected(method, params);
    if (!found.length) return null;
    const verdict = this.verdict(found, sessionId);
    if (verdict !== UNSEEN_CONTEXT || !sessionId) return verdict;
    await this.learned(sessionId);
    if (this.verdict(found, sessionId) !== UNSEEN_CONTEXT) return this.verdict(found, sessionId);
    await this.probe(found, sessionId);
    return this.verdict(found, sessionId);
  }

  hides(entry) {
    return this.is.url(entry.url) || this.is.url(entry.userTypedURL);
  }

  entry(entry) {
    if (!this.hides(entry)) return entry;
    return { ...entry, url: ERROR_PAGE, userTypedURL: ERROR_PAGE, title: '' };
  }

  framed(frame) {
    const named = [frame.unreachableUrl, frame.securityOrigin].find((url) => this.is.url(url));
    return named ?? frame.url ?? '';
  }

  tree({ frame, childFrames, resources, ...rest }) {
    if (frame.id !== undefined && !this.targets.has(frame.id)) {
      this.frames.set(frame.id, this.framed(frame));
      if (frame.parentId) this.parents.set(frame.id, frame.parentId);
    }
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
    const failed = this.errored.get(info.targetId);
    if (info.url === undefined || failed === undefined) return info;
    if (![failed, '', ERROR_PAGE].includes(bare(info.url))) return info;
    const origin = URL.canParse(failed) ? new URL(failed).origin : ERROR_PAGE;
    return { ...info, url: origin, title: origin };
  }

  armed(sessionId) {
    const nav = this.navs.get(this.sessions.get(sessionId)?.targetId);
    return Boolean(nav?.done && !nav.failed && nav.session);
  }

  naming(message) {
    const { method, params } = message;
    if (method.startsWith('Network.') || method.startsWith('Fetch.')) return false;
    return this.valued(params, 0, true);
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

  async styleLater(message) {
    const { sessionId, params = {} } = message;
    const header = params.header;
    const scope = this.scopes.get(this.scopeTarget(sessionId));
    if (!header || header.frameId !== scope?.root || this.is.url(this.frames.get(header.frameId)))
      return;
    if (this.is.url(header.sourceURL)) kept(this.sheets, header.styleSheetId);
    if ((await this.placed(sessionId)) && !this.hidden(sessionId) && !this.locked(sessionId))
      this.redacted(message);
  }

  deferredStyle(message) {
    if (message.method !== 'CSS.styleSheetAdded' || !this.locked(message.sessionId)) return false;
    void this.styleLater(message).catch(() => {});
    return true;
  }

  async event(message) {
    const method = message.method ?? '';
    const { sessionId } = message;
    const foreign = this.foreign({ ...message, method });
    if (this.navSessions.has(sessionId))
      return this.navEvent(message, this.navSessions.get(sessionId));
    if (this.placements.has(sessionId)) return;
    if (method.startsWith('Target.') && (await this.targetEvent(message))) return;
    if (method === 'Page.screencastFrame' && !this.casts.has(sessionId)) return;
    if (this.deferredStyle(message)) return;
    if (this.locked(sessionId) && (pageScoped(method) || method === 'Page.screencastFrame')) return;
    if (this.blocked.has(sessionId) && PAUSES.has(method)) return this.release(message);
    if (this.hidden(sessionId)) return;
    if (foreign) return;
    if (this.walked({ ...message, method })) return this.cut(sessionId);
    if (sessionId && method.startsWith('Runtime.') && !this.runtimes.has(sessionId)) return;
    if (await this.swallowed({ ...message, method })) return;
    if (this.stored({ ...message, method })) return;
    if (sessionId && this.naming({ ...message, method })) return;
    if (sessionId && method.startsWith('Page.') && !this.pages.has(sessionId)) return;
    if (PAUSES.has(method)) this.offered.add(message.params?.requestId);
    this.redacted(message);
  }

  async searched(method, params, sessionId) {
    const [read, args] = SEARCHES[method](params);
    const { result } = await this.call(read, args, sessionId);
    return this.mentions(result);
  }

  mentions(result) {
    if (!result || typeof result !== 'object') return false;
    const field = ['body', 'data', 'content'].find((key) => typeof result[key] === 'string');
    const coded = field ? result[field] : '';
    const plain = result.base64Encoded ? decodedBytes(coded) : coded;
    const printable = /content-transfer-encoding:\s*quoted-printable|=\r?\n|=3d/i.test(plain)
      ? plain
          .replace(/=\r?\n/g, '')
          .replace(/=([0-9a-f]{2})/gi, (found, hex) =>
            String.fromCharCode(Number.parseInt(hex, 16))
          )
      : plain;
    const rest = field ? { ...result, [field]: undefined } : result;
    const strings = [];
    const collect = (value) => {
      if (typeof value === 'string') strings.push(unescaped(value));
      else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          strings.push(key);
          collect(item);
        }
      }
    };
    collect(rest);
    return this.redact({ text: unescaped(printable), strings }).named;
  }

  contents(message, was) {
    if (TREED.has(was?.method) && message.result && typeof message.result === 'object') {
      this.deliver({ ...message, result: this.redact(message.result).params });
      return true;
    }
    if (!CONTENTS.has(was?.method) || !this.mentions(message.result)) return false;
    this.refuse(was);
    return true;
  }

  async listed(message, result) {
    const targetInfos = [];
    for (const info of result.targetInfos) {
      this.learn(info);
      if (!(await this.target(info.targetId))) targetInfos.push(this.masked(info));
    }
    return this.deliver({ ...message, result: { ...result, targetInfos } });
  }

  pageAnswer(was) {
    if (!pageScoped(was?.method) || (!was.locked && !this.locked(was.sessionId))) return false;
    if (was.method === 'Page.startScreencast')
      void this.call('Page.stopScreencast', {}, was.sessionId);
    this.refuse(was);
    return true;
  }

  endedAnswer(was) {
    if (this.finished.has(was)) {
      if (was.method === 'Page.startScreencast')
        void this.call('Page.stopScreencast', {}, was.sessionId);
      return true;
    }
    if (!this.blocked.has(was?.sessionId)) return false;
    this.refuse(was);
    return true;
  }

  async answer(message, was) {
    if (this.endedAnswer(was) || this.pageAnswer(was)) return;
    const { method, params = {} } = was ?? {};
    const { result } = message;
    if (method === 'Page.createIsolatedWorld' && result?.executionContextId !== undefined) {
      const world = this.world(was.sessionId);
      if (!world.ids.has(result.executionContextId))
        world.ids.set(result.executionContextId, false);
    }
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
    if (this.contents(message, was)) return;
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

  keyed(key, value, readOnly) {
    const { is } = this;
    if (key === 'urls' && Array.isArray(value)) {
      return (
        value.length > 0 &&
        value.every((url) => typeof url === 'string' && is.url(url, { readOnly }))
      );
    }
    if (typeof value !== 'string') return false;
    if (ORIGINS.has(key)) return is.url(value, { readOnly: readOnly || !CLOSED.has(key) });
    if (key === 'storageKey') return is.storageKey(value);
    if (key === 'cacheId') return is.storageKey(value.split('|')[0]);
    if (key === 'domain') return is.cookieDomain(value);
    return false;
  }

  valued(params, depth = 0, readOnly = false) {
    if (!params || typeof params !== 'object' || depth > 6) return false;
    return Object.entries(params).some(
      ([key, value]) =>
        !FREE.has(key) &&
        (this.keyed(key, value, readOnly) ||
          (typeof value === 'object' && this.valued(value, depth + 1, readOnly)))
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
    return this.valued(params, 0, true);
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
      (REQUESTS.has(method) &&
        typeof params.url === 'string' &&
        this.hops.has(hopKey(params.url))) ||
      this.sheets.has(params.styleSheetId) ||
      this.workers(method, params) ||
      (method === 'Target.detachFromTarget' &&
        params.sessionId !== undefined &&
        !this.sessions.has(params.sessionId))
    );
  }

  unseen(method, params) {
    if (!BODIES.has(method) && !REQUESTS.has(method)) return null;
    const id = params.requestId ?? params.interceptionId;
    if (this.redirected.has(id) && BODIES.has(method)) return PROTECTED;
    if (!this.requests.has(id)) return UNSEEN;
    if (this.requests.get(id)) return PROTECTED;
    if (!REQUESTS.has(method)) return null;
    if (!this.offered.has(id)) return UNSEEN;
    this.offered.delete(id);
    return null;
  }

  placementPromises(sessionId) {
    let root = this.scopeTarget(sessionId);
    if (root === undefined) return new Map();
    const seen = new Set();
    while (this.scopes.get(root)?.parent) {
      if (seen.has(root)) return null;
      seen.add(root);
      root = this.scopes.get(root).parent;
    }
    const targets = new Set([root]);
    for (let size = 0; size !== targets.size; ) {
      size = targets.size;
      for (const [id, scope] of this.scopes) if (targets.has(scope.parent)) targets.add(id);
    }
    return new Map(
      [...targets].filter((id) => this.placing.has(id)).map((id) => [id, this.placing.get(id)])
    );
  }

  async placementsReady(sessionId, pending) {
    for (;;) {
      await Promise.all(pending.values());
      const latest = this.placementPromises(sessionId);
      if (!latest) return false;
      if ([...latest].every(([id, promise]) => pending.get(id) === promise)) return true;
      pending = latest;
    }
  }

  async placed(sessionId) {
    const pending = this.placementPromises(sessionId);
    if (!pending) return false;
    if (!pending.size) return true;
    let timer;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), NAV_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.placementsReady(sessionId, pending), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  async pageCheck(method, sessionId) {
    if (!pageScoped(method)) return null;
    const unguarded = await this.guarding(method, sessionId);
    if (unguarded) return unguarded;
    if (!(await this.placed(sessionId))) return UNGUARDED;
    return this.locked(sessionId) ? PROTECTED : null;
  }

  async check(message) {
    const { method, params = {}, sessionId } = message;
    if (typeof method !== 'string') return null;
    const page = await this.pageCheck(method, sessionId);
    if (page) return page;
    if (method.startsWith('Fetch.') && sessionId === undefined) return FETCH;
    if (LATER.has(method)) return SCRIPTS;
    if (method === 'Page.navigate' && inherits(params.url)) return INHERITED;
    if (FLAT.has(method) && params.flatten !== true) {
      const target = params.targetId !== undefined && (await this.current(params.targetId));
      return target ? PROTECTED : UNFLAT;
    }
    if (STICKY.has(method) || EMULATION.test(method)) return HEADERS;
    if (DEBUGGERS.some((domain) => method.startsWith(domain))) return DEBUGGER;
    if (STREAMED.has(method)) return STREAMING;
    if (SEARCHES[method] && (await this.searched(method, params, sessionId))) return PROTECTED;
    const world = await this.selecting(method, params, sessionId);
    if (world) return world;
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
    if (await this.frame(params.frameId, true)) return PROTECTED;
    if (method === 'Page.navigateToHistoryEntry' && (await this.back(params, sessionId))) {
      return PROTECTED;
    }
    return this.unseen(method, params);
  }

  async create(message) {
    const { id, params } = message;
    const answer = await this.call('Target.createTarget', {
      ...params,
      background: params.background ?? true,
      url: 'about:blank',
    });
    const targetId = answer.result?.targetId;
    if (this.finished.has(message)) return;
    if (!targetId) return this.deliver({ ...answer, id });
    this.learn({ targetId, url: 'about:blank', type: 'page' });
    this.touch(targetId);
    const nav = this.navs.get(targetId);
    await nav.ready;
    if (this.finished.has(message)) return;
    if (!nav.failed && !inherits(params.url))
      void this.call('Page.navigate', { url: params.url }, nav.session);
    this.deliver({ id, result: answer.result });
  }

  pass(message) {
    if (this.finished.has(message)) return;
    this.commands.set(message.id, message);
    const { id, method, sessionId } = message;
    if (pageScoped(method) && this.locked(sessionId)) return this.refuse(message);
    if (method === 'Page.startScreencast') this.casts.add(sessionId);
    if (method === 'Page.stopScreencast') this.casts.delete(sessionId);
    globalThis.sliccGuardTrace?.push({
      method,
      targetId: message.params?.targetId,
      sessionId,
      passed: true,
    });
    if (sessionId && method === 'Runtime.enable') this.runtimes.add(sessionId);
    if (sessionId && method === 'Runtime.disable') this.runtimes.delete(sessionId);
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
    if (STRUCTURE.has(message.method)) this.scopeEvent(message);
    if (this.internal.has(message.id)) {
      const resolve = this.internal.get(message.id);
      this.internal.delete(message.id);
      return resolve(message);
    }
    const was = message.id === undefined ? undefined : this.asked.get(message.id);
    this.queue(
      message.sessionId ?? was?.sessionId ?? '',
      () => {
        this.asked.delete(message.id);
        return message.id === undefined ? this.event(message) : this.answer(message, was);
      },
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
      this.commands.set(message.id, message);
      if (this.blocked.has(message.sessionId) || this.gone.has(message.sessionId))
        return this.refuse(message);
      this.queue(
        `send:${message.sessionId ?? ''}`,
        async () => {
          if (this.finished.has(message)) return;
          const why = await this.check(message);
          if (this.finished.has(message)) return;
          if (why) return this.refuse(message, why);
          if (message.method === 'Runtime.enable' && this.primed.delete(message.sessionId)) {
            await this.call('Runtime.disable', {}, message.sessionId);
          }
          if (message.method === 'Target.createTarget' && typeof message.params?.url === 'string') {
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
