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
const CLOSE_MS = 5000;
export const BLANKED = 'data:text/html,%3Ctitle%3Eblocked%3C%2Ftitle%3E';
const HISTORY = new Set(['Page.getNavigationHistory']);
const TREES = new Set(['Page.getFrameTree', 'Page.getResourceTree']);
const OBSERVED = new Set([...TREES, ...HISTORY]);
const NAV_MS = 10000;
const NAV_TYPES = new Set(['page', 'iframe', 'background_page', 'webview']);
const UNWAITED = new Set(['Target.getTargetInfo', 'Target.detachFromTarget']);
const POLL_MS = 100;
const REMEMBERED = 10000;
const HISTORY_WAIT = 5000;
const HISTORY_POLL = 40;
const FRAME_MS = 300;
const TREE_WAIT = 2000;
const PROBE_WAIT = 2000;
const PROBE_TRIES = 3;
const PROBE_BUDGET = 1000;
const ANSWER_MS = 1000;
const WORKER_TYPES = new Set(['service_worker', 'shared_worker', 'worker']);
const HISTORY_NAV = new Set([
  'restore',
  'restoreWithPost',
  'historySameDocument',
  'historyDifferentDocument',
  'backForward',
  'back_forward',
]);
const RUNTIME_META = new Set([
  'Runtime.enable',
  'Runtime.disable',
  'Runtime.discardConsoleEntries',
  'Runtime.runIfWaitingForDebugger',
  'Runtime.terminateExecution',
]);
const NAVIGATES = new Set(['Page.navigate', 'Page.reload', 'Page.stopLoading']);
const RECOVERS = new Set([
  ...NAVIGATES,
  ...HISTORY,
  'Page.navigateToHistoryEntry',
  'Page.enable',
  'Page.disable',
]);
const STRANDED = new Set([
  'Target.getTargetInfo',
  'Target.attachToTarget',
  'Target.closeTarget',
  'Target.activateTarget',
]);
const PAGE_CONTENT = new Set([
  'Page.createIsolatedWorld',
  'Page.captureScreenshot',
  'Page.captureSnapshot',
  'Page.printToPDF',
  'Page.getLayoutMetrics',
  'Page.getResourceContent',
  'Page.searchInResource',
  'Page.getAppManifest',
  'Page.getCookies',
  'Page.setDocumentContent',
  'Page.startScreencast',
  'Page.stopScreencast',
  'Page.screencastFrameAck',
  'Page.handleJavaScriptDialog',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Page.reload',
  'Page.stopLoading',
]);
const REACHES = /^(?:DOMSnapshot|Input|Accessibility|IO)\./;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const ERROR_METADATA = new Set([
  'Target.targetCreated',
  'Target.targetInfoChanged',
  'Target.targetDestroyed',
  'Target.attachedToTarget',
  'Target.detachedFromTarget',
  'Page.frameAttached',
  'Page.frameDetached',
  'Page.frameNavigated',
  'Page.frameStartedLoading',
  'Page.frameStoppedLoading',
]);
const requestKey = ({ id, sessionId }) => JSON.stringify([sessionId ?? null, id]);
const RENDERED = new Set([
  'Page.printToPDF',
  'Page.startScreencast',
  'Page.screencastFrame',
  'HeadlessExperimental.beginFrame',
]);
const contentRead = (method = '') =>
  CONTENTS.has(method) ||
  TREED.has(method) ||
  RENDERED.has(method) ||
  /^(?:Runtime|DOM|DOMSnapshot|Accessibility|CSS|LayerTree)\.|^Page\.capture/.test(method);
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
const LISTED_FRAME = /^(?:https?:\/\/[^/?#]|about:(?:blank|srcdoc)(?:[?#]|$))/i;
const PROFILERS = ['HeapProfiler.', 'Profiler.'];
const PAGE_PAINT = new Set([
  'Page.captureScreenshot',
  'Page.startScreencast',
  'Page.captureSnapshot',
  'Page.printToPDF',
  'Page.getResourceContent',
  'Page.searchInResource',
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
export const NO_AUTO_ATTACH =
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
const STOPS = /[\s"'<>`]/g;
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
const AUTHORITIES =
  /(?<![\p{L}\p{N}._-])(?:\[[0-9a-f:.]+\]|[\p{L}\p{N}._-]+)(?::\d+)?(?=[/?#\\])/giu;
const CANDIDATES =
  /(?<![\p{L}\p{N}._-])(?:\[[0-9a-f:.]+\]|[\p{L}\p{N}._-]+)(?::\d+)?(?=$|[\s\u0000-\u001f\u007f"'<>`/?#\\])/giu;
const DELIMITERS = /[\s\u0000-\u001f\u007f"'<>`]/g;

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
  let out = text;
  for (let i = 0; i < 5 && /%[0-9a-f]{2}/i.test(out); i += 1) {
    out = out.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run.replace(/%([0-9a-f]{2})/gi, (found, hex) =>
          String.fromCharCode(Number.parseInt(hex, 16))
        );
      }
    });
  }
  return { text: out, changing: /%[0-9a-f]{2}/i.test(out) };
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
    const swapped = swap(value.slice(found.index, stop), found.index);
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
  const protectedAuthority = (token) => {
    if (token.length > AUTHORITY) return false;
    const http = `http://${token}/`;
    const https = `https://${token}/`;
    return (URL.canParse(http) && is.url(http)) || (URL.canParse(https) && is.url(https));
  };
  const scrub = (value) => {
    const raw = scanned(value, STARTS, STOPS, origin);
    const known = raw.replace(HOSTS, (found, host, port, offset) => {
      const labels = labelsBefore(raw, offset);
      const candidate = decoded(`${labels}${host}${port}`).text;
      if (!is.url(`http://${candidate}/`) && !is.url(`https://${candidate}/`)) return found;
      if (!readable(`http://${labels}${found}`)) webs += 1;
      return `${host}${port}`;
    });
    return scanned(known, AUTHORITIES, STOPS, (candidate) => {
      const token = candidate.slice(0, candidate.search(/[/?#\\]/));
      if (!protectedAuthority(token)) return null;
      if (!readable(`http://${candidate}`)) webs += 1;
      return token;
    });
  };
  const namesProtected = (value) => {
    for (const candidate of value.matchAll(CANDIDATES)) {
      if (protectedAuthority(candidate[0])) return true;
    }
    const compact = value.replace(DELIMITERS, '');
    return scrub(compact) !== compact;
  };
  const closed = (value) => {
    let cut = null;
    scanned(value, STARTS, STOPS, (candidate, offset) => {
      if (cut !== null) return null;
      const shown = origin(candidate);
      if (shown !== null) cut = { prefix: value.slice(0, offset), shown };
      return shown;
    });
    if (
      cut === null ||
      !URL.canParse(cut.shown) ||
      new URL(cut.shown).origin !== cut.shown ||
      !/^\s*\d*\s*;?\s*url\s*=\s*$/i.test(cut.prefix)
    )
      return null;
    return cut.prefix + cut.shown;
  };
  const text = (value) => {
    if (!value.includes('://') && !/[%&\\/?#]/.test(value)) {
      return value;
    }
    const plain = decoded(unescaped(value));
    if (plain.changing) {
      webs += 1;
      const shown = URL.canParse(plain.text) ? new URL(plain.text).origin : '';
      return shown === 'null' ? '' : shown;
    }
    if (plain.text === value) return scrub(value);
    return value.replace(/[^\s"'<>`]+/g, (run) => {
      const normalized = decoded(unescaped(run)).text;
      scrub(run);
      const out = scrub(normalized);
      if (normalized.search(DELIMITERS) >= 0 && namesProtected(normalized)) {
        webs += 1;
        const span = closed(normalized);
        if (span !== null) return span;
        const shown = URL.canParse(normalized) ? new URL(normalized).origin : '';
        return shown === 'null' ? '' : shown;
      }
      if (out === normalized) return run;
      return out;
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
  constructor(connection, own, tabs) {
    this.connection = connection;
    this.tabs = tabs;
    this.recalled = new Set();
    this.closing = false;
    this.closed = false;
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
    this.pendingAttachments = new Set();
    this.privateSessions = new Set();
    this.retiredTargets = new Set();
    this.failedProof = new Set();
    this.proofNeeded = new Set();
    this.contextChecks = new Map();
    this.proofCommits = new Map();
    this.proofEpoch = new Map();
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
    this.quarantined = new Map();
    this.hints = new Map();
    this.shots = new Set();
    this.gone = new Set();
    this.waiting = new Set();
    this.pages = new Set();
    this.frames = new Map();
    this.errorFrames = new Set();
    this.errorUrls = new Map();
    this.frameRoots = new Map();
    this.unsafe = new WeakSet();
    this.pendingContent = new Set();
    this.callerIds = new Map();
    this.parents = new Map();
    this.scopes = new Map();
    this.placements = new Map();
    this.placing = new Map();
    this.placementsPending = new Map();
    this.autoAttachments = new Map();
    this.casts = new Set();
    this.requests = new Map();
    this.held = new Map();
    this.internal = new Map();
    this.evidence = new Set();
    this.asked = new Map();
    this.commands = new Map();
    this.answering = new Set();
    this.finished = new WeakSet();
    this.watching = new Map();
    this.queues = new Map();
    this.streams = new Set();
    this.allowed = new Set();
    this.blockedWorkers = new Set();
    this.pendingHistory = new Set();
    this.pendingCommit = new Set();
    this.settled = new Map();
    this.uncommitted = new Set();
    this.moved = new Set();
    this.mains = new Map();
    this.opening = new Map();
    this.loading = new Map();
    this.revisions = new Map();
    this.recoveries = new WeakMap();
    this.next = GUARD_IDS;
    this.guarded = { onmessage: null, onclose: null };
  }

  redacted(message, source = message) {
    const { method, params } = message;
    if (!params || !(SPOKEN.test(method ?? '') || CONSOLE.has(method)))
      return this.deliver(message, true, source);
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
    if (!changed.length) return this.deliver(message, true, source);
    if (answered && /^(?:Network|Fetch)\./.test(method)) {
      for (const id of [params.requestId, params.networkId])
        if (id !== undefined) kept(this.redirected, id);
      for (const url of [params.request?.url, params.response?.url])
        if (typeof url === 'string') kept(this.hops, hopKey(url));
    }
    return this.deliver({ ...message, params: redacted }, true, source);
  }

  discardEvent(message) {
    if (PAUSES.has(message.method)) {
      this.offered.delete(message.params?.requestId);
      this.release(message);
    }
  }

  eventFields(value = {}) {
    const safe = {};
    for (const key of [
      'id',
      'frameId',
      'parentId',
      'parentFrameId',
      'loaderId',
      'targetId',
      'sessionId',
      'openerId',
      'browserContextId',
    ])
      if (typeof value[key] === 'string' && /^[\w-]{1,256}$/.test(value[key]))
        safe[key] = value[key];
    for (const key of ['url', 'unreachableUrl', 'securityOrigin']) {
      if (value[key] === undefined) continue;
      safe[key] =
        typeof value[key] === 'string' &&
        URL.canParse(value[key]) &&
        !this.is.url(value[key]) &&
        new URL(value[key]).origin !== 'null'
          ? new URL(value[key]).origin
          : ERROR_PAGE;
    }
    if (value.title !== undefined) safe.title = safe.url ?? ERROR_PAGE;
    for (const key of ['attached', 'waitingForDebugger', 'canAccessOpener'])
      if (typeof value[key] === 'boolean') safe[key] = value[key];
    if (
      /^(?:page|iframe|worker|service_worker|shared_worker|background_page|webview|browser|browser_ui|other|Navigation|BackForwardCacheRestore)$/.test(
        value.type ?? ''
      )
    )
      safe.type = value.type;
    if (value.reason === 'remove' || value.reason === 'swap') safe.reason = value.reason;
    return safe;
  }

  metadataEvent(message, proof) {
    const { method, sessionId, params = {} } = message;
    const metadata = {
      method,
      ...(sessionId ? { sessionId } : {}),
      params: {
        ...this.eventFields(params),
        ...(params.frame ? { frame: this.eventFields(params.frame) } : {}),
        ...(params.targetInfo
          ? {
              targetInfo: {
                ...this.eventFields(params.targetInfo),
                ...(method === 'Target.attachedToTarget' &&
                this.fresh(proof) &&
                this.is.url(params.targetInfo.url)
                  ? {
                      url: new URL(params.targetInfo.url).origin,
                      title: new URL(params.targetInfo.url).origin,
                    }
                  : {}),
              },
            }
          : {}),
      },
    };
    if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
      const targetId = this.sessions.get(sessionId)?.targetId;
      const nav = this.navs.get(targetId);
      const owned = this.proofCommits.get(targetId);
      if (
        owned?.accepted &&
        params.frame.unreachableUrl === undefined &&
        !this.is.url(owned.url) &&
        /^https?:/.test(owned.url) &&
        nav?.admitted &&
        !nav.failed &&
        !nav.retired &&
        this.navSessions.get(nav.session) === nav &&
        owned.epoch === this.proofEpoch.get(targetId) &&
        owned.id === params.frame.id &&
        owned.loader === params.frame.loaderId &&
        owned.url === this.framed(params.frame) &&
        this.tabs.get(targetId)?.admitted &&
        this.shown.has(sessionId) &&
        !this.blocked.has(sessionId) &&
        !this.gone.has(sessionId)
      ) {
        const safe = this.redact({ url: owned.url }).params.url;
        if (safe === owned.url) metadata.params.frame.url = safe;
      }
    }
    return metadata;
  }

  deliver(message, release = true, source = message, proof) {
    if (
      message.id === undefined &&
      /^(?:Network|Fetch)\./.test(message.method) &&
      this.failedScope(message.sessionId) &&
      !(message.method === 'Network.loadingFailed' && source !== message)
    )
      return this.discardEvent(message);
    const caller = this.callerIds.get(requestKey(message));
    if (message.id !== undefined && !message.error && caller && this.finished.has(caller)) return;
    if (message.id !== undefined && !message.error && caller?.locked) return this.refuse(caller);
    if (message.id !== undefined && !message.error && caller && this.unsafeContent(caller))
      message = {
        id: message.id,
        sessionId: message.sessionId,
        error: { code: -32000, message: PROTECTED },
      };
    if (message.id === undefined && (this.unsafe.has(source) || this.eventError(source))) {
      if (!ERROR_METADATA.has(message.method)) return this.discardEvent(message);
      message = this.metadataEvent(message, proof);
    }
    if (release && message.id !== undefined) {
      const key = requestKey(message);
      const command = this.commands.get(key);
      if (command) {
        this.finished.add(command);
        this.commands.delete(key);
        this.pendingContent.delete(command);
      }
      this.callerIds.delete(key);
      this.moved.delete(key);
      this.shots.delete(key);
    }
    try {
      this.guarded.onmessage?.(JSON.stringify(message));
    } catch (error) {
      console.warn(`a CDP client failed on a message: ${error.message}`);
    }
  }

  call(method, params, sessionId) {
    if (this.closed || this.gone.has(sessionId))
      return Promise.resolve({ error: { code: -32000, message: UNGUARDED } });
    const placement = this.placements.get(sessionId);
    const nav = this.navSessions.get(sessionId);
    const revision = this.revisions.get(nav?.targetId);
    const work = new Promise((resolve) => {
      const id = ++this.next;
      let timer;
      const answer = async (message) => {
        clearTimeout(timer);
        if (!this.closed && method === 'Page.getFrameTree' && !message.error) {
          this.rememberTreeError(message.result?.frameTree, sessionId, nav, revision);
          if (!nav) await this.rememberExistingNavError(message.result?.frameTree, sessionId);
        }
        const current = this.scopes.get(placement)?.sessionId;
        if (placement === undefined || current === undefined || current === sessionId) {
          if (method === 'Page.getFrameTree' && placement !== undefined)
            this.recordTree(placement, message.result?.frameTree);
          if (method === 'DOM.getDocument' && placement !== undefined)
            this.recordOwners(placement, message.result?.root);
        }
        resolve(message);
      };
      answer.sessionId = sessionId;
      timer = setTimeout(() => {
        this.internal.delete(id);
        void answer({ id, sessionId, error: { code: -32000, message: UNGUARDED } });
      }, NAV_MS);
      timer.unref?.();
      this.internal.set(id, answer);
      this.connection.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
      );
    });
    if (method === 'Page.getFrameTree' && nav?.admitted) {
      this.evidence.add(work);
      void Promise.allSettled([work]).then(() => this.evidence.delete(work));
    }
    return work;
  }

  refuse(command, message = PROTECTED, release = true) {
    if (this.finished.has(command)) return;
    this.finished.add(command);
    const key = requestKey(command);
    if (release && this.commands.get(key) === command) this.commands.delete(key);
    this.pendingContent.delete(command);
    const { id, sessionId } = command;
    this.deliver(
      { id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message } },
      release && this.asked.get(key) !== command && !this.answering.has(command)
    );
  }

  learn(info) {
    if (!info?.targetId) return;
    const known = this.targets.get(info.targetId);
    const remembered = this.tabs.get(info.targetId)?.error;
    if (remembered && !this.errorFrames.has(remembered.id)) {
      this.recalled.add(info.targetId);
      this.frameRoots.set(info.targetId, remembered.id);
      this.errorFrames.add(remembered.id);
      this.errorUrls.set(remembered.id, remembered.url);
      this.errored.set(info.targetId, remembered.url);
    }
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
      reported: info.url ?? known?.reported,
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
    if (!found) return true;
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
    if ((found.was || found.guarded) && this.proofCommits.get(targetId)?.url === BLANKED) {
      found.guarded = true;
      return true;
    }
    if (this.recalled.has(targetId)) return true;
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
        attachedFrames: new Set(),
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

  relatedFrames(roots) {
    const frames = new Set(roots);
    for (let size = 0; size !== frames.size; ) {
      size = frames.size;
      for (const [id, parent] of this.parents) if (frames.has(parent)) frames.add(id);
    }
    return frames;
  }

  errorView(targetId, frames) {
    return {
      targetId,
      root: frames.length === 1 && frames[0].url === ERROR_PAGE ? frames[0].id : undefined,
      errors: new Set(
        frames.filter((frame) => frame.url.startsWith('chrome-error:')).map((frame) => frame.id)
      ),
    };
  }

  errorReady(targetId, scope, view) {
    if (
      !scope?.tree ||
      !scope.setup ||
      view?.targetId !== targetId ||
      !view.root ||
      view.root !== scope.root ||
      scope.treeFrames.size !== 1 ||
      scope.pending ||
      scope.owners.size ||
      scope.remoteOwners.size ||
      scope.attachedFrames.size ||
      scope.protectedOwner ||
      this.relatedFrames(scope.frames).size !== 1
    )
      return false;
    const roots = new Set([targetId, scope.root]);
    for (const [id, child] of this.scopes)
      if (id !== targetId && roots.has(child.parent)) return false;
    for (const [id, child] of this.targets) {
      if (id === targetId || child.type !== 'iframe') continue;
      const parent = child.parentId ?? this.scopes.get(id)?.parent ?? this.parents.get(id);
      if (!parent || roots.has(parent)) return false;
    }
    return true;
  }

  scopeReady(targetId, scope, view) {
    return Boolean(scope?.ready || this.errorReady(targetId, scope, view));
  }

  unavailableFrame(frameId, url, view) {
    return url === undefined || url === '' || (this.errorFrames.has(frameId) && !view);
  }

  holding(targetId) {
    const nav = this.navs.get(targetId);
    return nav?.holds === true && !nav.failed;
  }

  childLocked(id, scope, holds, seen, view) {
    if (id === scope.root) return false;
    if (holds && !LISTED_FRAME.test(this.frames.get(id))) return true;
    if (
      !holds &&
      (scope.remoteOwners.has(id) || this.targets.get(id)?.type === 'iframe') &&
      this.pageLocked(id, new Set(seen), false, view)
    )
      return true;
    return !this.parents.has(id) || !this.frames.has(this.parents.get(id));
  }

  pageLocked(targetId, seen = new Set(), blankRoot = false, view) {
    if (!targetId || seen.has(targetId)) return true;
    seen.add(targetId);
    const scope = this.scopes.get(targetId);
    if (!this.scopeReady(targetId, scope, view) || (view && scope.committed)) return true;
    const holds = this.holding(targetId);
    for (const id of this.relatedFrames(scope.frames)) {
      const url = this.frames.get(id);
      if (this.unavailableFrame(id, url, view)) return true;
      if (this.is.url(url) && !(blankRoot && id === scope.root) && !view?.errors.has(id))
        return true;
      if (this.childLocked(id, scope, holds, seen, view)) return true;
    }
    for (const [child, entry] of this.scopes) {
      if (entry.parent === targetId && this.pageLocked(child, new Set(seen), false, view))
        return true;
    }
    return false;
  }

  locked(sessionId, blankRoot = false) {
    const targetId = this.scopeTarget(sessionId);
    if (!targetId) return true;
    const seen = new Set();
    let id = targetId;
    while (id) {
      if (seen.has(id) || this.pageLocked(id, new Set(), blankRoot && id === targetId)) return true;
      seen.add(id);
      id = this.scopes.get(id)?.parent;
    }
    return false;
  }

  blankAdmission(message) {
    return (
      message?.method === 'Page.captureScreenshot' &&
      this.shots.has(requestKey(message)) &&
      !this.locked(message.sessionId, true)
    );
  }

  stopCasts() {
    for (const message of new Set([...this.asked.values(), ...this.answering])) {
      if (
        pageScoped(message.method) &&
        this.locked(message.sessionId) &&
        !this.blankAdmission(message)
      ) {
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
      this.frames.set(frame.id, this.framed(frame));
      if (frame.parentId) this.parents.set(frame.id, frame.parentId);
    }
    const parentRoot = this.scopes.get(scope.parent)?.root;
    if (
      this.targets.get(targetId)?.type === 'iframe' &&
      typeof parentRoot === 'string' &&
      parentRoot &&
      tree?.frame?.parentId === parentRoot &&
      tree.frame.securityOrigin === '://' &&
      this.containedError(tree.frame, parentRoot) &&
      this.documentFrames(tree)?.length === 1
    )
      this.noteError(tree.frame, scope.sessionId);
    this.stopCasts();
  }

  recordOwners(targetId, root) {
    const scope = this.scope(targetId);
    scope.ownersReady = Boolean(root);
    scope.protectedOwner = false;
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
    const source = (node.attributes ?? []).indexOf('src');
    if (
      scope.attachedFrames.has(node.frameId) &&
      [
        source < 0 ? undefined : node.attributes[source + 1],
        node.contentDocument?.documentURL,
      ].some((url) => this.is.url(url))
    )
      scope.protectedOwner = true;
  }

  place(targetId, sessionId) {
    this.placements.set(sessionId, targetId);
    this.scope(targetId).sessionId = sessionId;
    const active = this.placementsPending.get(targetId);
    if (active) {
      active.again = true;
      active.sessionId = sessionId;
      return active.promise;
    }
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

  placementAttach(sessionId, params) {
    if (!this.placements.has(sessionId) || this.gone.has(sessionId))
      return this.call('Target.setAutoAttach', params, sessionId);
    const config = JSON.stringify(params);
    const cached = this.autoAttachments.get(sessionId);
    if (cached?.config === config) return cached.promise;
    const promise = Promise.resolve()
      .then(() => this.call('Target.setAutoAttach', params, sessionId))
      .then(
        (answer) => {
          if (answer.error && this.autoAttachments.get(sessionId)?.promise === promise)
            this.autoAttachments.delete(sessionId);
          return answer;
        },
        (error) => {
          if (this.autoAttachments.get(sessionId)?.promise === promise)
            this.autoAttachments.delete(sessionId);
          throw error;
        }
      );
    this.autoAttachments.set(sessionId, { config, promise });
    return promise;
  }

  async placeOne(targetId, sessionId) {
    this.placements.set(sessionId, targetId);
    this.scope(targetId).pending = (this.scope(targetId).pending ?? 0) + 1;
    this.scope(targetId).ready = false;
    this.stopCasts();
    const enabled = await this.call('Page.enable', {}, sessionId);
    await this.call('Page.getFrameTree', {}, sessionId);
    const owners = await this.call('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
    const disabled = await this.call('DOM.disable', {}, sessionId);
    const scope = this.scope(targetId);
    const attached =
      !owners.error && !disabled.error && scope.ownersReady && scope.protectedOwner
        ? {}
        : await this.placementAttach(sessionId, {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
            filter: FRAME_CHILDREN,
          });
    scope.pending -= 1;
    scope.setup = Boolean(
      !enabled.error && (!attached.error || attached.error.message === NO_AUTO_ATTACH)
    );
    scope.failed = Boolean(
      enabled.error ||
        owners.error ||
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
    const changed = targetId ?? message.params?.targetInfo?.targetId ?? message.params?.targetId;
    const invalidates =
      message.method !== 'Runtime.executionContextCreated' &&
      (message.method !== 'Target.targetInfoChanged' ||
        this.hinted(message.params?.targetInfo ?? {}));
    if (invalidates || this.is.url(message.params?.context?.origin))
      for (const command of this.callerIds.values()) {
        if (
          this.scopeTarget(command.sessionId) === changed ||
          this.placementPromises(command.sessionId)?.has(changed)
        )
          this.shots.delete(requestKey(command));
      }
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
    if (method === 'Target.targetDestroyed') {
      this.scopes.delete(params.targetId);
      for (const [id, placed] of this.placements)
        if (placed === params.targetId) this.autoAttachments.delete(id);
    }
    if (method === 'Target.detachedFromTarget' && params.sessionId !== undefined) {
      kept(this.gone, params.sessionId);
      this.refusePending(params.sessionId);
    }
    if (method === 'Target.detachedFromTarget' && this.placements.has(params.sessionId)) {
      const childId = this.placements.get(params.sessionId);
      this.placements.delete(params.sessionId);
      const child = this.scopes.get(childId);
      if (child && (child.sessionId === params.sessionId || child.sessionId === undefined))
        child.ready = false;
    }
  }

  refresh(targetId) {
    const sessionId = this.scopes.get(targetId)?.sessionId;
    const session =
      this.navs.get(targetId)?.session ??
      (this.placements.get(sessionId) === targetId ? sessionId : undefined);
    if (session) this.placing.set(targetId, this.place(targetId, session));
  }

  scopeFrames({ method, params = {} }, targetId) {
    if (method === 'Page.frameAttached') {
      const scope = this.scope(targetId);
      scope.frames.add(params.frameId);
      scope.owners.add(params.frameId);
      scope.attachedFrames.add(params.frameId);
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
      this.commitScope(targetId);
      const id = params.context.auxData?.frameId;
      if (id) {
        this.scope(targetId).frames.add(id);
        this.frames.set(id, params.context.origin);
      } else this.scope(targetId).ready = false;
    }
    if (method === 'Page.frameDetached') {
      if (params.reason === 'swap') {
        this.frames.set(params.frameId, '');
        for (const [id, scope] of this.scopes) if (scope.root === params.frameId) this.refresh(id);
      } else this.removeFrame(params.frameId);
      this.refresh(targetId);
    }
  }

  scopeNavigated(frame, targetId) {
    const scope = this.scope(targetId);
    if (
      frame.id === scope.root ||
      frame.id === this.frameRoots.get(targetId) ||
      (!frame.parentId && !scope.root)
    ) {
      if (scope.root && frame.id !== scope.root) {
        this.frames.delete(scope.root);
        this.parents.delete(scope.root);
      } else {
        for (const id of scope.frames) if (id !== targetId) this.removeFrame(id);
      }
      scope.root = frame.id;
      scope.frames.clear();
      scope.owners.clear();
      scope.remoteOwners.clear();
      scope.attachedFrames.clear();
      scope.ready = false;
      this.refresh(targetId);
    }
    scope.frames.add(frame.id);
    if (frame.parentId && frame.id !== scope.root) scope.remoteOwners.delete(frame.id);
    this.frames.set(frame.id, this.framed(frame));
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
        scope.attachedFrames.delete(id);
        scope.treeFrames?.delete(id);
      }
    }
  }

  strandable(targetId, nav = this.navs.get(targetId), established = true) {
    return Boolean(
      this.targets.get(targetId)?.type === 'page' &&
        !this.relatedHeld(targetId) &&
        nav?.session &&
        nav.done &&
        (nav.admitted || !established) &&
        !nav.failed &&
        !nav.held &&
        !nav.taken &&
        ![...this.boundSessions(nav.session)].some((id) => this.pendingCommit.has(id))
    );
  }

  currentProof(proof) {
    return Boolean(
      proof &&
        this.navs.get(proof.targetId) === proof.nav &&
        this.revisions.get(proof.targetId) === proof.revision &&
        this.strandable(proof.targetId, proof.nav)
    );
  }

  fresh(proof) {
    return (
      this.currentProof(proof) && !this.pageLocked(proof.targetId, new Set(), false, proof.view)
    );
  }

  async stranded(targetId) {
    let nav = this.navs.get(targetId);
    if (
      !nav &&
      this.tabs.get(targetId)?.admitted &&
      this.tabs.get(targetId)?.error &&
      !this.relatedHeld(targetId)
    ) {
      this.touch(targetId);
      nav = this.navs.get(targetId);
      if (nav) await nav.ready;
    }
    if (!this.strandable(targetId, nav)) return null;
    if (!(await this.placed(nav.session)) || !this.strandable(targetId, nav)) return null;
    const proof = { targetId, nav, revision: this.revisions.get(targetId) };
    const answer = await this.answered(this.call('Page.getFrameTree', {}, nav.session));
    if (!this.currentProof(proof)) return null;
    const frames = answer && !answer.error ? this.documentFrames(answer.result?.frameTree) : null;
    if (!frames || frames[0].parentId) return null;
    if (frames.some((frame) => this.frameLive(frame))) {
      this.commitScope(targetId);
      return null;
    }
    proof.view = this.errorView(targetId, frames);
    if (!this.fresh(proof)) return null;
    for (const frame of frames) this.noteError(frame, nav.session);
    if (frames[0].url === ERROR_PAGE && this.protectedFrame(frames[0]) && !nav.scrub) {
      nav.scrub = this.scrubbing(nav, frames[0]);
      nav.erred = true;
    }
    this.targets.get(targetId).real = false;
    if (this.is.url(this.targets.get(targetId).reported))
      for (const [id, entry] of this.sessions)
        if (entry.targetId === targetId && !this.quarantined.has(id))
          this.quarantine(id, this.hints.get(targetId) ?? {});
    return proof;
  }

  async frame(frameId, strict = false) {
    if (frameId === undefined) return false;
    if (this.errorFrames.has(frameId)) return true;
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
    this.autoAttachments.delete(sessionId);
    for (const command of this.asked.values())
      if (command.sessionId === sessionId) {
        if (OBSERVED.has(command.method)) this.standIn(command);
        else this.refuse(command);
      }
    for (const command of this.commands.values())
      if (command.sessionId === sessionId) {
        if (OBSERVED.has(command.method)) this.standIn(command);
        else this.refuse(command);
      }
    for (const [id, answer] of this.internal) {
      if (answer.sessionId !== sessionId) continue;
      this.internal.delete(id);
      answer({ id, sessionId, error: { code: -32000, message: UNGUARDED } });
    }
  }

  cut(sessionId, parent, guardTarget = true) {
    this.quarantined.delete(sessionId);
    if (this.blocked.has(sessionId)) return;
    this.blocked.add(sessionId);
    this.refusePending(sessionId);
    if (this.waiting.delete(sessionId))
      void this.call('Runtime.runIfWaitingForDebugger', {}, sessionId);
    const entry = this.sessions.get(sessionId);
    const targetId = entry?.targetId;
    if (targetId && guardTarget) {
      const known = this.targets.get(targetId) ?? { url: '' };
      this.targets.set(targetId, { ...known, was: true, guarded: true });
    }
    const outer = parent ?? entry?.parent;
    if (entry && this.shown.has(sessionId)) {
      entry.cutNotified = true;
      this.deliver({
        method: 'Target.detachedFromTarget',
        params: { sessionId },
        ...(outer ? { sessionId: outer } : {}),
      });
    }
    void this.call('Target.detachFromTarget', { sessionId }, outer);
  }

  async current(targetId, limit = ANSWER_MS) {
    const answer = await this.within(this.call('Target.getTargetInfo', { targetId }), limit);
    const info = answer?.result?.targetInfo;
    if (!answer || answer.error || info?.targetId !== targetId || typeof info.type !== 'string')
      return true;
    this.learn(info);
    if (await this.target(targetId)) return true;
    if (!URL.canParse(info.url)) {
      if (info.url !== '' || !NAV_TYPES.has(info.type)) return true;
      this.touch(targetId);
      const nav = this.navs.get(targetId);
      if (!nav) return true;
      await nav.ready;
      if (nav.failed || !(await this.verify(nav.session))) return true;
      this.learn({ ...info, url: this.frames.get(this.frameRoots.get(targetId)) });
    }
    return this.target(targetId);
  }

  relatedProof(owner, targetId) {
    const seen = new Set();
    for (let id = targetId; id && !seen.has(id); id = this.targets.get(id)?.parentId) {
      if (id === owner) return true;
      seen.add(id);
    }
    return false;
  }

  uncertainProof(targetId, uncertain = true) {
    if (!targetId || this.retiredTargets.has(targetId)) return false;
    if (uncertain) {
      this.failedProof.add(targetId);
      this.proofNeeded.add(targetId);
      this.proofEpoch.set(targetId, (this.proofEpoch.get(targetId) ?? 0) + 1);
      this.proofCommits.delete(targetId);
    }
    for (const command of this.pendingContent)
      if (this.relatedProof(this.sessions.get(command.sessionId)?.targetId, targetId))
        this.unsafe.add(command);
    return false;
  }

  async proveContent(message) {
    if (!message.sessionId || !contentRead(message.method)) return true;
    const owner = this.sessions.get(message.sessionId)?.targetId;
    for (const record of this.contextChecks.get(message.sessionId)?.values() ?? [])
      if (!record.done && (await this.answered(record.promise)) !== true) return false;
    const needed = [...this.proofNeeded].filter((id) => {
      const root = this.frameRoots.get(id) ?? this.scopes.get(id)?.root ?? id;
      return (
        this.relatedProof(owner, id) &&
        !(id !== owner && this.targets.get(id)?.type === 'iframe' && this.errorFrames.has(root))
      );
    });
    if (
      owner &&
      (this.hidden(message.sessionId) || this.targets.get(owner)?.guarded) &&
      !needed.includes(owner)
    )
      needed.push(owner);
    if (
      needed.length &&
      message.method === 'Page.captureScreenshot' &&
      (await this.blankShot(message.sessionId)) &&
      !this.locked(message.sessionId, true)
    )
      return true;
    for (const id of needed) {
      const session = [...this.sessions].find(([, entry]) => entry.targetId === id)?.[0];
      const parent = this.sessions.get(session)?.parent;
      let checked;
      if (session)
        checked = this.shown.has(session)
          ? this.inspect(session, id, parent)
          : this.watch(session, id, parent);
      else checked = this.provePlacement(id);
      if (!checked || !(await checked)) return false;
    }
    return true;
  }

  async provePlacement(targetId) {
    const sessionId = this.scopes.get(targetId)?.sessionId;
    if (
      !sessionId ||
      this.placements.get(sessionId) !== targetId ||
      this.retiredTargets.has(targetId) ||
      (await this.answered(this.current(targetId))) !== false
    )
      return false;
    return this.verify(sessionId);
  }

  failedScope(sessionId) {
    const owner = this.sessions.get(sessionId)?.targetId;
    return [...this.failedProof].some((id) => this.relatedProof(owner, id));
  }

  receiveContext(message) {
    const { method, sessionId, params = {} } = message;
    if (method === 'Runtime.executionContextsCleared') this.contextChecks.delete(sessionId);
    if (method === 'Runtime.executionContextDestroyed')
      this.contextChecks.get(sessionId)?.delete(params.executionContextId);
    const context = params.context;
    if (
      method !== 'Runtime.executionContextCreated' ||
      !context?.auxData?.isDefault ||
      (!this.runtimes.has(sessionId) && !this.primed.has(sessionId))
    )
      return;
    const records = this.contextChecks.get(sessionId) ?? new Map();
    this.contextChecks.set(sessionId, records);
    const record = { message, done: false, targetId: this.sessions.get(sessionId)?.targetId };
    records.set(context.id, record);
    record.promise = this.checkContext(record).finally(() => {
      record.done = true;
    });
  }

  maskedLocation(frameId, value) {
    const url = bare(value);
    const parsed = URL.parse(url);
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) return false;
    const query = url.indexOf('?');
    if (query < 0) return false;
    const matches = [...url.slice(query).matchAll(/[?&]redirect_uri=([^&#]*)/g)];
    if (matches.length !== 1) return false;
    let redirect;
    try {
      redirect = URL.parse(decodeURIComponent(matches[0][1]));
    } catch {
      return false;
    }
    if (
      !redirect ||
      !['http:', 'https:'].includes(redirect.protocol) ||
      !this.is.url(redirect.href)
    )
      return false;
    const match = matches[0];
    const start = query + match.index + match[0].indexOf('=') + 1;
    const projected = `${url.slice(0, start)}${redirect.origin}${url.slice(start + match[1].length)}`;
    return projected === bare(this.frames.get(frameId) ?? '');
  }

  async checkContext(record) {
    const {
      sessionId,
      params: { context },
    } = record.message;
    const current = () => this.contextChecks.get(sessionId)?.get(context.id) === record;
    const where =
      typeof context.uniqueId === 'string'
        ? { uniqueContextId: context.uniqueId }
        : { contextId: context.id };
    const answer = await this.answered(
      this.call(
        'Runtime.evaluate',
        { expression: 'location.href', returnByValue: true, silent: true, ...where },
        sessionId
      )
    );
    const targetId = record.targetId;
    if (!current()) {
      if (!answer || answer.error) this.uncertainProof(targetId);
      return false;
    }
    const value =
      answer?.error || answer?.result?.exceptionDetails ? undefined : answer?.result?.result?.value;
    if (
      typeof value !== 'string' ||
      !URL.canParse(value) ||
      this.unsafeUrl(value) ||
      this.is.url(value) ||
      URL.parse(value)?.protocol === 'chrome-error:'
    ) {
      const world = this.world(sessionId);
      if (world.main === context.uniqueId) delete world.main;
      world.ids.set(context.id, true);
      if (context.uniqueId) world.uniques.set(context.uniqueId, true);
      return this.uncertainProof(targetId);
    }
    let verified = false;
    if (bare(this.frames.get(context.auxData.frameId) ?? '') !== bare(value)) {
      const nav = this.navs.get(targetId);
      if (!nav?.session || !(await this.verify(nav.session, undefined, true)))
        return this.uncertainProof(targetId);
      verified = true;
    }
    if (!current()) return false;
    if (bare(this.frames.get(context.auxData.frameId) ?? '') === bare(value)) return true;
    return (
      verified &&
      (this.isolateLoadingContext(record, context, value) ||
        this.maskedLocation(context.auxData.frameId, value))
    );
  }

  isolateLoadingContext(record, context, value) {
    const frameId = context.auxData.frameId;
    if (
      value !== 'about:blank' ||
      frameId === this.frameRoots.get(record.targetId) ||
      this.frames.get(frameId) !== '' ||
      !this.parents.has(frameId)
    )
      return false;
    const world = this.world(record.message.sessionId);
    if (world.main === context.uniqueId) delete world.main;
    world.ids.set(context.id, true);
    if (context.uniqueId) world.uniques.set(context.uniqueId, true);
    record.loading = true;
    return true;
  }

  async privateAttachment(targetId, sessionId) {
    if (this.privateSessions.has(sessionId)) return true;
    for (const pending of this.pendingAttachments)
      if (pending.targetId === targetId && (await pending.attaching) === sessionId) return true;
    const nav = this.navs.get(targetId);
    return Boolean(nav && (await nav.attaching) === sessionId);
  }

  receiveAttachment(message) {
    if (message.method !== 'Target.attachedToTarget') return;
    const info = message.params?.targetInfo;
    if (!info?.targetId || this.privateSessions.has(message.params.sessionId)) return;
    const parentId =
      info.type === 'iframe' ? this.sessions.get(message.sessionId)?.targetId : undefined;
    this.learn({ ...info, ...(parentId ? { parentId } : {}) });
    if (info.url?.startsWith('chrome-error:') || this.is.target(info) || !URL.canParse(info.url))
      this.uncertainProof(info.targetId);
  }

  receiveFrame(message) {
    const { method, sessionId, params = {} } = message;
    const nav = this.navSessions.get(sessionId);
    const targetId = nav?.targetId ?? this.sessions.get(sessionId)?.targetId;
    if (
      ['Page.frameAttached', 'Page.frameDetached', 'Page.navigatedWithinDocument'].includes(method)
    )
      this.proofCommits.delete(targetId);
    if (method !== 'Page.frameNavigated' || !params.frame) return;
    const frame = params.frame;
    const commit = this.proofCommits.get(targetId);
    const root = this.frameRoots.get(targetId);
    if (this.protectedFrame(frame))
      this.uncertainProof(targetId, !root || !this.containedError(frame, root));
    else if (
      commit &&
      (commit.id !== frame.id ||
        commit.loader !== frame.loaderId ||
        commit.url !== this.framed(frame))
    )
      this.proofCommits.delete(targetId);
    if (
      nav &&
      (root === frame.id || !frame.parentId) &&
      typeof frame.loaderId === 'string' &&
      frame.loaderId &&
      !frame.url.startsWith('chrome-error:') &&
      !this.protectedFrame(frame)
    )
      this.proofCommits.set(targetId, {
        id: frame.id,
        loader: frame.loaderId,
        url: this.framed(frame),
        epoch: this.proofEpoch.get(targetId),
      });
    this.rememberError(frame, sessionId, targetId, nav);
    this.noteError(
      frame,
      sessionId,
      Boolean(nav) &&
        !frame.url?.startsWith('chrome-error:') &&
        !this.unsafeUrl(frame.url) &&
        !this.protectedFrame(frame)
    );
  }

  retireProof(frameId) {
    const ids = [
      frameId,
      ...[...this.frameRoots].filter(([, root]) => root === frameId).map(([id]) => id),
    ];
    for (const id of ids) {
      this.retiredTargets.add(id);
      this.failedProof.delete(id);
      this.proofNeeded.delete(id);
      this.proofCommits.delete(id);
      const nav = this.navs.get(id);
      if (!nav) continue;
      nav.retired = true;
      nav.settle(true);
      this.navs.delete(id);
      if (nav.session) {
        this.navSessions.delete(nav.session);
        void this.call('Target.detachFromTarget', { sessionId: nav.session });
      }
    }
  }

  cutTarget(targetId) {
    for (const [sessionId, entry] of this.sessions) {
      if (entry.targetId === targetId) this.cut(sessionId, entry.parent);
    }
  }

  rememberTab(targetId) {
    if (this.targets.get(targetId)?.type !== 'page') return;
    const record = this.tabs.get(targetId) ?? {};
    record.admitted = true;
    this.tabs.set(targetId, record);
    if (this.tabs.size > REMEMBERED) {
      const oldest = [...this.tabs].find(([id, entry]) => id !== targetId && !entry.error)?.[0];
      if (oldest !== undefined) this.tabs.delete(oldest);
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
    const admitted =
      this.tabs.get(targetId)?.admitted ||
      [...this.sessions].some(([id, entry]) => entry.targetId === targetId && this.shown.has(id));
    const nav = { targetId, session: null, done: false, failed: false, held, admitted };
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
    this.pendingAttachments.add(nav);
    nav.attaching = this.call('Target.attachToTarget', { targetId, flatten: true }).then(
      (answer) => answer.result?.sessionId ?? null
    );
    void nav.attaching.then((session) => {
      if (session) this.privateSessions.add(session);
      this.pendingAttachments.delete(nav);
      return this.arm(nav, session);
    });
  }

  async arm(nav, session) {
    if (nav.retired) {
      if (session) void this.call('Target.detachFromTarget', { sessionId: session });
      return nav.settle(true);
    }
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
    nav.holds = steps[0].result?.holdsDocuments === true;
    this.placing.set(nav.targetId, this.place(nav.targetId, session));
    await this.placing.get(nav.targetId);
    nav.settle(steps.some((step) => step.error));
  }

  navEvent({ method, params = {} }, nav) {
    if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
      nav.last = `${params.frame.url}${params.frame.urlFragment ?? ''}`;
      nav.stopped = false;
      return;
    }
    if (method === 'Page.frameStoppedLoading' && params.frameId === this.mainFrame(nav.session)) {
      nav.stopped = true;
    }
    if (method === 'Fetch.requestPaused') this.pausedDocument(params, nav);
  }

  pausedDocument(params, nav) {
    const { requestId } = params;
    if (params.resourceType !== 'Document' || !this.is.url(params.request?.url)) {
      void this.call('Fetch.continueRequest', { requestId }, nav.session);
      return;
    }
    if (nav.held) {
      nav.taken = true;
      void this.call('Fetch.continueRequest', { requestId }, nav.session);
      return;
    }
    void this.failDocument(params, nav.session, nav.targetId);
    this.failed(nav.targetId, params);
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
    if (nav.scrub && !RECOVERS.has(method)) await nav.scrub;
    return nav.failed ? UNGUARDED : null;
  }

  async verify(sessionId, proof, loading = false) {
    const placed = this.placements.has(sessionId)
      ? { targetId: this.placements.get(sessionId) }
      : undefined;
    const entry = this.sessions.get(sessionId) ?? this.navSessions.get(sessionId) ?? placed;
    const epoch = this.proofEpoch.get(entry?.targetId);
    void this.call('Page.enable', {}, sessionId);
    const answer = await this.proofTree(sessionId, loading);
    if (epoch !== this.proofEpoch.get(entry?.targetId)) return false;
    const tree = answer?.result?.frameTree;
    if (
      answer &&
      (answer.error || !tree?.frame) &&
      WORKER_TYPES.has(this.targets.get(entry?.targetId)?.type)
    )
      return !this.errorDocument(sessionId);
    const all = answer && !answer.error && this.proofFrames(tree, proof);
    if (!all) return this.uncertainProof(entry?.targetId);
    const nav = this.navs.get(entry?.targetId);
    if (
      nav?.session &&
      !proof &&
      !nav.held &&
      !nav.scrub &&
      this.targets.get(entry.targetId)?.type === 'page' &&
      !tree?.frame?.parentId &&
      tree?.frame?.url?.startsWith('chrome-error:') &&
      this.protectedFrame(tree.frame)
    ) {
      nav.scrub = this.scrubbing(nav, tree.frame);
      nav.erred = true;
    }
    if (!proof && this.errorDocument(sessionId)) return false;
    if (!tree?.frame && this.targets.get(entry?.targetId)?.url?.startsWith('chrome-error:'))
      return false;
    if (entry && tree?.frame?.id) {
      entry.frameId = tree.frame.id;
      this.frameRoots.set(entry.targetId, tree.frame.id);
    }
    if (proof) {
      for (const frame of all) this.noteError(frame, sessionId);
      return this.fresh(proof) && !all.some((frame) => this.frameLive(frame));
    }
    if (
      all.some(
        (frame) =>
          (this.protectedFrame(frame) && !this.containedError(frame, tree.frame.id)) ||
          (frame.id === tree.frame.id && this.errorFrames.has(frame.id))
      )
    )
      return this.uncertainProof(entry?.targetId);
    if (
      all.some(
        (frame) => this.containedError(frame, tree.frame.id) && !this.errorFrames.has(frame.id)
      )
    )
      this.uncertainProof(entry?.targetId, false);
    for (const frame of all) this.noteError(frame, sessionId);
    this.completeProof(sessionId, entry, tree);
    return Boolean(tree?.frame) || WORKER_TYPES.has(this.targets.get(entry?.targetId)?.type);
  }

  completeProof(sessionId, entry, tree) {
    this.failedProof.delete(entry?.targetId);
    if (this.navSessions.has(sessionId)) {
      const commit = this.proofCommits.get(entry?.targetId);
      if (
        commit &&
        commit.epoch === this.proofEpoch.get(entry.targetId) &&
        commit.id === tree.frame.id &&
        commit.loader === tree.frame.loaderId &&
        commit.url === this.framed(tree.frame)
      )
        this.proofNeeded.delete(entry.targetId);
    }
  }

  async retainedBlank(sessionId, info) {
    const targetId = info?.targetId;
    const nav = this.navs.get(targetId);
    const commit = this.proofCommits.get(targetId);
    if (
      !this.shown.has(sessionId) ||
      this.sessions.get(sessionId)?.targetId !== targetId ||
      isHeld(targetId) ||
      nav?.held ||
      !nav?.done ||
      nav.failed ||
      nav.retired ||
      !nav.session ||
      this.navSessions.get(nav.session) !== nav ||
      info.type !== 'page' ||
      info.url !== BLANKED ||
      !commit ||
      commit.url !== BLANKED ||
      commit.epoch !== this.proofEpoch.get(targetId)
    )
      return false;
    const answer = await this.proofTree(nav.session);
    const frames = answer && !answer.error && this.documentFrames(answer.result?.frameTree);
    const frame = frames?.[0];
    return Boolean(
      this.navs.get(targetId) === nav &&
        this.navSessions.get(nav.session) === nav &&
        !nav.failed &&
        !nav.retired &&
        this.proofCommits.get(targetId) === commit &&
        commit.epoch === this.proofEpoch.get(targetId) &&
        !isHeld(targetId) &&
        !nav.held &&
        !this.errorFrames.has(commit.id) &&
        this.frameRoots.get(targetId) === commit.id &&
        frames?.length === 1 &&
        !frame.parentId &&
        frame.id === commit.id &&
        frame.loaderId === commit.loader &&
        this.framed(frame) === BLANKED &&
        !this.protectedFrame(frame)
    );
  }

  async attachmentProof(sessionId, targetId, raw, guarded, recoverable) {
    const error =
      this.navs.get(targetId)?.admitted &&
      this.targets.get(targetId)?.url?.startsWith('chrome-error:');
    return recoverable &&
      (guarded || error) &&
      (this.is.url(raw.url) || this.errorDocument(sessionId) || this.recalled.has(targetId))
      ? this.stranded(targetId)
      : null;
  }

  async inspect(sessionId, targetId, parent, recoverable = false) {
    if (this.privateSessions.has(sessionId) || this.retiredTargets.has(targetId)) return false;
    const answer = await this.answered(this.call('Target.getTargetInfo', { targetId }));
    const raw = answer?.result?.targetInfo;
    const info =
      raw?.url === '' && NAV_TYPES.has(raw.type)
        ? { ...raw, url: this.frames.get(this.frameRoots.get(targetId)) ?? '' }
        : raw;
    if (
      !answer ||
      answer.error ||
      info?.targetId !== targetId ||
      typeof info.type !== 'string' ||
      !URL.canParse(info.url)
    )
      return this.uncertainProof(targetId);
    this.learn(info);
    const guarded = await this.target(targetId);
    const proof = await this.attachmentProof(sessionId, targetId, raw, guarded, recoverable);
    if (guarded && !proof) {
      if (!(await this.retainedBlank(sessionId, raw))) this.cut(sessionId, parent);
      return false;
    }
    if (!(await this.verify(sessionId, proof))) return this.uncertainProof(targetId);
    if (!WORKER_TYPES.has(info.type)) {
      const previous = this.navs.get(targetId);
      if (previous?.failed && !previous.retired) this.navs.delete(targetId);
      this.touch(targetId);
      const nav = this.navs.get(targetId);
      if (!nav) return this.uncertainProof(targetId);
      if (
        (await this.answered(nav.ready.then(() => !nav.failed))) !== true ||
        nav.retired ||
        !(await this.verify(nav.session, proof))
      )
        return this.uncertainProof(targetId);
    }
    this.failedProof.delete(targetId);
    this.blocked.delete(sessionId);
    this.shown.add(sessionId);
    const nav = this.navs.get(targetId);
    if (nav) {
      nav.admitted = true;
      this.rememberTab(targetId);
    }
    if (proof) this.quarantine(sessionId, this.hints.get(targetId) ?? {});
    return true;
  }

  watch(sessionId, targetId, parent) {
    this.gone.delete(sessionId);
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { targetId, parent });
    if (this.pendingTarget(targetId)) {
      this.cut(sessionId, parent, false);
      return Promise.resolve(false);
    }
    if (!this.watching.has(sessionId)) {
      const proof = this.inspect(sessionId, targetId, parent, true).then((ok) => {
        if (!ok && this.watching.get(sessionId) === proof) this.watching.delete(sessionId);
        return ok;
      });
      this.watching.set(sessionId, proof);
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
      this.shownTarget(
        { ...message, params: { ...params, waitingForDebugger: false } },
        info,
        message
      );
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
      this.redacted(
        {
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
        },
        message
      );
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

  loadKey(targetId, requestId) {
    return JSON.stringify([targetId, requestId]);
  }

  loadSnapshot(sessionId) {
    return [...this.boundSessions(sessionId)]
      .filter((id) => this.opening.get(id)?.input !== undefined)
      .map((id) => [id, this.opening.get(id)]);
  }

  settleLoad(load, stopped = false) {
    if (!load?.length || load.some(([id, open]) => this.opening.get(id) !== open)) return false;
    for (const [id, open] of load) {
      open.stopped = stopped;
      this.pendingCommit.delete(id);
      this.uncommitted.delete(id);
      this.opening.delete(id);
    }
    return true;
  }

  loadingEvent({ method, params = {}, sessionId }) {
    const targetId = this.scopeTarget(sessionId);
    if (!targetId || !params.requestId) return;
    const key = this.loadKey(targetId, params.requestId);
    if (method === 'Network.loadingFailed') {
      const load = this.loading.get(key);
      this.loading.delete(key);
      this.settleLoad(load);
    }
    if (method !== 'Network.requestWillBeSent' || params.type !== 'Document') return;
    const load = this.loadSnapshot(sessionId);
    if (
      !load.length ||
      !params.loaderId ||
      load.some(
        ([, open]) =>
          open.input !== params.frameId ||
          open.url !== params.request?.url ||
          (open.loaderId && open.loaderId !== params.loaderId)
      )
    )
      return;
    for (const [, open] of load) open.loaderId = params.loaderId;
    this.loading.set(key, load);
    if (this.loading.size > REMEMBERED) this.loading.delete(this.loading.keys().next().value);
  }

  async failDocument(params, sessionId, targetId) {
    const load = this.loading.get(this.loadKey(targetId, params.networkId));
    const answer = await this.call(
      'Fetch.failRequest',
      { requestId: params.requestId, errorReason: 'BlockedByClient' },
      sessionId
    );
    if (!answer.error) this.settleLoad(load);
  }

  failed(targetId, { frameId, request }) {
    const root = this.frameRoots.get(targetId) ?? this.scopes.get(targetId)?.root ?? targetId;
    if (!targetId || frameId !== root) return;
    this.errored.set(targetId, bare(request.url));
    const nav = this.navs.get(targetId);
    if (!nav?.session || nav.scrub) return;
    nav.scrub = this.scrubbing(nav);
    if (nav.last?.startsWith('chrome-error:')) nav.erred = true;
  }

  async scrubTree(nav) {
    if (!nav.session || !(await this.placed(nav.session))) return null;
    return this.answered(this.call('Page.getFrameTree', {}, nav.session));
  }

  scrubbing(nav, frame = nav.document) {
    const ticket = {};
    nav.scrubTicket = ticket;
    nav.scrubDocument = frame?.url?.startsWith('chrome-error:') ? frame : null;
    return new Promise((resolve) => {
      const done = () => {
        if (nav.scrubTicket !== ticket) return;
        clearTimeout(nav.scrubTimer);
        nav.scrubTicket = null;
        nav.closeScrub = null;
        nav.wiped = null;
        nav.scrub = null;
        nav.retried = false;
        resolve();
      };
      const sameDocument = (frame) => {
        const previous = nav.scrubDocument;
        return Boolean(
          previous &&
            typeof previous.loaderId === 'string' &&
            previous.loaderId &&
            previous.id === frame?.id &&
            previous.loaderId === frame?.loaderId &&
            !frame?.parentId &&
            previous.url === frame?.url &&
            this.protectedFrame(previous) &&
            this.protectedFrame(frame)
        );
      };
      const blank = async () => {
        nav.retried = true;
        ticket.blank = this.call('Page.navigate', { url: BLANKED }, nav.session);
        if (ticket.closing) {
          await this.answered(ticket.blank);
          return done();
        }
        nav.scrubTimer = setTimeout(expire, SCRUB_MS);
        nav.scrubTimer.unref?.();
      };
      const probe = async () => {
        const answer = await this.scrubTree(nav);
        if (nav.scrubTicket !== ticket) return;
        const frames =
          answer && !answer.error ? this.documentFrames(answer.result?.frameTree) : null;
        if (frames?.some((frame) => this.frameLive(frame))) this.commitScope(nav.targetId);
        const frame = frames?.[0];
        if (ticket.closing && !sameDocument(frame)) return done();
        if (frame && !frame.url.startsWith('chrome-error:') && !this.is.url(frame.url))
          return done();
        if (
          !nav.retried &&
          frame?.url.startsWith('chrome-error:') &&
          this.strandable(nav.targetId, nav, false) &&
          !this.pageLocked(nav.targetId, new Set(), false, this.errorView(nav.targetId, frames))
        )
          return blank();
        done();
        this.cutTarget(nav.targetId);
      };
      const expire = () => {
        if (ticket.closing && nav.retried) return Promise.resolve(done());
        ticket.checking ??= probe().finally(() => {
          ticket.checking = null;
        });
        return ticket.checking;
      };
      nav.scrubTimer = setTimeout(expire, SCRUB_MS);
      nav.scrubTimer.unref?.();
      nav.wiped = done;
      nav.closeScrub = () => {
        clearTimeout(nav.scrubTimer);
        ticket.closing = true;
        return expire().then(() => ticket.blank && this.answered(ticket.blank));
      };
    });
  }

  wiping(nav, frame) {
    if (!nav?.wiped || frame.parentId) return;
    if (
      !frame.url?.startsWith('chrome-error:') ||
      (nav.scrubDocument?.loaderId &&
        frame.loaderId &&
        nav.scrubDocument.loaderId !== frame.loaderId)
    ) {
      nav.wiped();
      if (this.protectedFrame(frame) && !this.frameLive(frame))
        nav.scrub = this.scrubbing(nav, frame);
      return;
    }
    nav.scrubDocument ??= frame;
    nav.erred = true;
  }

  release({ method, params = {}, sessionId }) {
    const { requestId } = params;
    if (
      method === 'Fetch.requestPaused' &&
      params.resourceType === 'Document' &&
      this.is.url(params.request?.url)
    ) {
      const targetId = this.sessions.get(sessionId)?.targetId;
      void this.failDocument(params, sessionId, targetId);
      this.failed(targetId, params);
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

  discardPending(sessionId) {
    for (const command of [...this.callerIds.values()]) {
      if (command.sessionId !== sessionId) continue;
      this.unsafe.add(command);
      this.pendingContent.delete(command);
      this.asked.delete(requestKey(command));
      this.refuse(command);
    }
  }

  quarantine(sessionId, hint) {
    const ticket = { hint };
    this.quarantined.set(sessionId, ticket);
    for (const command of this.callerIds.values()) {
      if (command.sessionId !== sessionId || RECOVERS.has(command.method)) continue;
      this.unsafe.add(command);
      this.shots.delete(requestKey(command));
    }
    return ticket;
  }

  relatedHeld(targetId, depth = 0) {
    if (!targetId) return false;
    if (isHeld(targetId) || depth > 8) return true;
    const known = this.targets.get(targetId);
    if (!known) return true;
    if (known.parentId && this.relatedHeld(known.parentId, depth + 1)) return true;
    if (!known.openerId) return false;
    if (this.relatedHeld(known.openerId, depth + 1)) return true;
    const opener = this.targets.get(known.openerId);
    return Boolean(
      known.type === 'page' &&
        (known.access || BLANK.test(known.url)) &&
        (opener?.guarded || this.is.target(opener))
    );
  }

  hinted(info) {
    const known = this.targets.get(info.targetId);
    return (
      known?.guarded ||
      isHeld(info.targetId) ||
      this.relatedHeld(info.openerId) ||
      this.relatedHeld(info.parentId ?? known?.parentId) ||
      (info.openerId &&
        (info.canAccessOpener || known?.access) &&
        (this.targets.get(info.openerId)?.guarded ||
          this.is.target(this.targets.get(info.openerId)))) ||
      this.is.target({
        url: info.url ?? known?.url,
        type: info.type ?? known?.type,
        previous: known?.was,
        opener: info.openerId ? 'unknown' : undefined,
      })
    );
  }

  receiveHint(message) {
    const info = message.params?.targetInfo;
    if (!info?.targetId) return;
    this.hints.set(info.targetId, message);
    const guarded = this.hinted(info);
    for (const [id, entry] of this.sessions)
      if (
        entry.targetId === info.targetId &&
        !this.blocked.has(id) &&
        (guarded || this.quarantined.has(id))
      )
        this.quarantine(id, message);
  }

  proofFrames(tree, proof) {
    return this.documentFrames(tree) || (!proof && this.loadingChildren(tree));
  }

  loadingChildren(tree, frames = this.documentFrames(tree, true)) {
    const root = frames?.[0];
    return root &&
      !root.parentId &&
      /^https?:\/\//.test(root.url) &&
      /^https?:\/\//.test(root.securityOrigin) &&
      typeof root.loaderId === 'string' &&
      root.loaderId !== '' &&
      frames.slice(1).some((frame) => frame.url === '') &&
      frames.every(
        (frame) =>
          !this.protectedFrame(frame) &&
          !this.errorFrames.has(frame.id) &&
          !frame.url.startsWith('chrome-error:') &&
          !frame.unreachableUrl
      )
      ? frames
      : null;
  }

  async proofTree(sessionId, partial = false) {
    const started = Date.now();
    let bound = ANSWER_MS;
    let pending;
    for (
      let attempt = 0;
      attempt < Math.ceil(bound / HISTORY_POLL) && Date.now() < started + bound;
      attempt += 1
    ) {
      const answer = await this.within(
        this.call('Page.getFrameTree', {}, sessionId),
        Math.max(1, started + bound - Date.now())
      );
      const tree = answer?.result?.frameTree;
      const loading = this.documentFrames(tree, true);
      if (!answer || answer.error || this.documentFrames(tree) || !loading) return answer;
      const children = this.loadingChildren(tree, loading);
      if (partial && children) return answer;
      if (attempt === 0 && children) bound = 3 * ANSWER_MS;
      if (bound > ANSWER_MS && !children) return answer;
      pending = children ? answer : undefined;
      await pause(HISTORY_POLL);
    }
    return pending;
  }

  documentFrames(tree, loading = false) {
    const pending = [{ tree }];
    const frames = [];
    const ids = new Set();
    while (pending.length) {
      const { tree: node, parent } = pending.pop();
      const frame = node?.frame;
      if (
        !frame ||
        typeof frame.id !== 'string' ||
        !frame.id ||
        ids.has(frame.id) ||
        typeof frame.url !== 'string' ||
        (!URL.canParse(frame.url) &&
          !(
            loading &&
            frame.url === '' &&
            (parent !== undefined ||
              ['', '://', 'null'].includes(frame.securityOrigin) ||
              (/^https?:\/\//.test(frame.securityOrigin) &&
                URL.canParse(frame.securityOrigin) &&
                !this.is.url(frame.securityOrigin)))
          )) ||
        typeof frame.securityOrigin !== 'string' ||
        (!URL.canParse(frame.securityOrigin) &&
          !['null', '://'].includes(frame.securityOrigin) &&
          !(
            loading &&
            frame.securityOrigin === '' &&
            (frame.url === '' ||
              (parent === undefined &&
                !frame.parentId &&
                (frame.url === 'about:blank' ||
                  (/^https?:\/\//.test(frame.url) && !this.is.url(frame.url)))))
          )) ||
        (parent !== undefined && frame.parentId !== parent) ||
        (node.childFrames !== undefined && !Array.isArray(node.childFrames)) ||
        frames.length + pending.length >= 4096
      )
        return null;
      ids.add(frame.id);
      frames.push(frame);
      for (const child of node.childFrames ?? []) pending.push({ tree: child, parent: frame.id });
    }
    return frames;
  }

  async checkHint(sessionId, ticket) {
    const entry = this.sessions.get(sessionId);
    if (this.quarantined.get(sessionId) !== ticket) return;
    if (
      !entry ||
      !this.shown.has(sessionId) ||
      isHeld(entry.targetId) ||
      !NAV_TYPES.has(this.targets.get(entry.targetId)?.type)
    )
      return this.cut(sessionId);
    const answer = await this.answered(this.call('Page.getFrameTree', {}, sessionId));
    if (this.quarantined.get(sessionId) !== ticket) return;
    const frames = answer && !answer.error ? this.documentFrames(answer.result?.frameTree) : null;
    if (!frames || frames.some((frame) => this.frameLive(frame)) || isHeld(entry.targetId))
      return this.cut(sessionId);
    for (const frame of frames) this.noteError(frame, sessionId);
    ticket.verified = true;
    if (this.pendingTarget(entry.targetId)) return;
    const commit = ticket.commit;
    if (commit) {
      const root = frames[0];
      if (
        root.parentId ||
        root.id !== commit.id ||
        root.url !== commit.url ||
        root.loaderId !== commit.loaderId ||
        this.protectedFrame(root)
      )
        return;
    } else {
      const url = ticket.hint.params?.targetInfo?.url;
      if (typeof url !== 'string' || !URL.canParse(url) || this.is.url(url)) return;
    }
    this.quarantined.delete(sessionId);
    this.refresh(entry.targetId);
  }

  startHint(sessionId, ticket) {
    if (ticket.checking) return;
    ticket.checking = this.checkHint(sessionId, ticket).catch(() => {
      if (this.quarantined.get(sessionId) === ticket) this.cut(sessionId);
    });
  }

  refreshHint(message, committed) {
    for (const id of this.boundSessions(message.sessionId)) {
      const ticket = this.quarantined.get(id);
      if (!ticket) continue;
      if (this.frameLive(message.params.frame)) this.cut(id);
      else {
        const frame = message.params.frame;
        const targetId = this.sessions.get(id)?.targetId;
        const next = this.quarantine(id, ticket.hint);
        if (
          committed?.has(id) &&
          !this.pendingTarget(targetId) &&
          this.targets.get(targetId)?.type === 'page' &&
          !frame.parentId &&
          frame.id === this.frameRoots.get(targetId) &&
          typeof frame.loaderId === 'string' &&
          frame.loaderId &&
          !this.protectedFrame(frame) &&
          !this.unsafeUrl(frame.url) &&
          !inherits(frame.url)
        )
          next.commit = { id: frame.id, url: frame.url, loaderId: frame.loaderId };
        this.startHint(id, next);
      }
    }
  }

  async targetHint(message) {
    const info = message.params?.targetInfo;
    this.learn(info);
    const targetId = info?.targetId;
    const guarded = await this.answered(this.current(targetId));
    if (this.hints.get(targetId) !== message) return;
    if (guarded === false && !this.is.url(info?.url)) {
      let pending = false;
      for (const [id, ticket] of this.quarantined) {
        if (ticket.hint !== message) continue;
        pending = true;
        this.startHint(id, ticket);
      }
      if (!pending) this.shownTarget(message, info);
      return;
    }
    for (const [id, entry] of this.sessions) {
      if (entry.targetId !== targetId || this.blocked.has(id)) continue;
      if (guarded === undefined) {
        this.cut(id);
        continue;
      }
      const ticket = this.quarantined.get(id) ?? this.quarantine(id, message);
      if (ticket.hint === message) this.startHint(id, ticket);
    }
    await Promise.all(
      [...this.quarantined.values()]
        .filter((ticket) => ticket.hint === message)
        .map((ticket) => ticket.checking)
    );
    const proof = guarded || this.is.url(info?.url) ? await this.stranded(targetId) : null;
    if (this.hints.get(targetId) === message && this.fresh(proof))
      this.shownTarget(message, info, message, proof);
  }

  async targetEvent(message) {
    const { method, params = {}, sessionId } = message;
    if (method === 'Target.attachedToTarget') {
      const info = params.targetInfo ?? {};
      if (await this.privateAttachment(info.targetId, params.sessionId)) return true;
      if (params.waitingForDebugger) this.waiting.add(params.sessionId);
      if (!info.url && (info.type === 'page' || info.type === 'iframe')) {
        void this.blank(message);
        return true;
      }
      this.learn(info);
      if (await this.watch(params.sessionId, info.targetId, sessionId)) {
        this.touch(info.targetId);
        const proof = this.is.url(info.url) ? await this.stranded(info.targetId) : null;
        this.shownTarget(message, info, message, proof);
      }
      return true;
    }
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      void this.targetHint(message).catch(() => {
        for (const [id, ticket] of this.quarantined) if (ticket.hint === message) this.cut(id);
      });
      return true;
    }
    if (method === 'Target.targetDestroyed') {
      const nav = this.navs.get(params.targetId);
      nav?.wiped?.();
      this.navs.delete(params.targetId);
      this.errored.delete(params.targetId);
      if (nav?.session) this.navSessions.delete(nav.session);
      return this.targets.get(params.targetId)?.guarded === true;
    }
    if (method === 'Target.detachedFromTarget') {
      this.discardPending(params.sessionId);
      this.watching.delete(params.sessionId);
      this.worlds.delete(params.sessionId);
      this.runtimes.delete(params.sessionId);
      this.primed.delete(params.sessionId);
      if (this.navSessions.has(params.sessionId)) {
        this.lost(params.sessionId);
        return true;
      }
      const notified = this.sessions.get(params.sessionId)?.cutNotified;
      this.sessions.delete(params.sessionId);
      this.waiting.delete(params.sessionId);
      return !this.shown.delete(params.sessionId) || notified === true;
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
    if (method === 'Runtime.executionContextsCleared') {
      this.worlds.delete(sessionId);
      return false;
    }
    if (method === 'Runtime.executionContextCreated' && params.context) {
      const { id, uniqueId, name, origin, auxData } = params.context;
      const hidden =
        (auxData?.type === 'isolated' && EXTENSIONS.test(origin ?? '')) ||
        this.errorFrames.has(auxData?.frameId);
      const world = this.world(sessionId);
      world.ids.set(id, hidden);
      if (uniqueId !== undefined) world.uniques.set(uniqueId, hidden);
      if (hidden && name) world.names.add(name);
      const judgedMain =
        !hidden &&
        !this.is.url(origin) &&
        uniqueId &&
        !world.main &&
        (auxData?.isDefault === true || (auxData?.type === 'default' && !name));
      if (judgedMain) world.main = uniqueId;
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

  protectedFrame(frame) {
    return (
      this.is.url(frame.url) ||
      this.is.url(frame.securityOrigin) ||
      (typeof frame.url === 'string' &&
        frame.url.startsWith('chrome-error:') &&
        this.unsafeUrl(frame.unreachableUrl))
    );
  }

  containedError(frame, root) {
    return Boolean(
      frame.id !== root &&
        frame.parentId &&
        typeof frame.url === 'string' &&
        frame.url.startsWith('chrome-error:') &&
        this.protectedFrame(frame)
    );
  }

  unsafeUrl(url) {
    return typeof url !== 'string' || !URL.canParse(url) || this.is.url(url);
  }

  recoverError(frame, sessionId, targetId) {
    if (!targetId || this.protectedFrame(frame) || this.unsafeUrl(frame.url) || inherits(frame.url))
      return;
    const target = this.targets.get(targetId);
    const root = this.frameRoots.get(targetId);
    if (
      root !== frame.id &&
      (frame.parentId || target?.type !== 'page' || !this.navSessions.has(sessionId))
    )
      return;
    if (root !== frame.id) {
      for (const [child, parent] of this.parents)
        if (parent === root) this.parents.set(child, frame.id);
      this.errorFrames.delete(root);
      this.errorUrls.delete(root);
      this.navs.get(targetId)?.errors?.delete(root);
    }
    this.frameRoots.set(targetId, frame.id);
    this.errored.delete(targetId);
    if (!target) return;
    target.url = frame.url;
    this.scope(targetId).committed = false;
    if (!target.real && frame.url !== BLANKED) {
      target.guarded = false;
      target.was = false;
    }
  }

  async rememberExistingNavError(tree, sessionId) {
    const frames = this.documentFrames(tree);
    const frame = frames?.length === 1 ? frames[0] : undefined;
    if (!frame || frame.parentId || frame.url !== ERROR_PAGE || !this.protectedFrame(frame)) return;
    const targetId = this.sessions.get(sessionId)?.targetId;
    const nav = this.navs.get(targetId);
    if (
      this.targets.get(targetId)?.type !== 'page' ||
      !this.tabs.get(targetId)?.admitted ||
      !nav?.admitted ||
      !nav.done ||
      nav.failed ||
      nav.retired ||
      !nav.session ||
      this.navSessions.get(nav.session) !== nav ||
      this.relatedHeld(targetId)
    )
      return;
    await this.answered(this.call('Page.getFrameTree', {}, nav.session));
  }

  rememberTreeError(tree, sessionId, nav, revision) {
    if (
      !nav ||
      this.navs.get(nav.targetId) !== nav ||
      this.revisions.get(nav.targetId) !== revision
    )
      return;
    const frames = this.documentFrames(tree);
    const frame = frames?.length === 1 ? frames[0] : undefined;
    if (
      !frame ||
      frame.parentId ||
      frame.url !== ERROR_PAGE ||
      typeof frame.unreachableUrl !== 'string' ||
      !URL.canParse(frame.unreachableUrl) ||
      !this.is.url(frame.unreachableUrl)
    )
      return;
    const origin = new URL(frame.unreachableUrl).origin;
    if (origin === 'null' || !this.is.url(origin)) return;
    this.rememberError({ ...frame, unreachableUrl: origin }, sessionId, nav.targetId, nav);
  }

  rememberError(frame, sessionId, targetId, nav) {
    const record = this.tabs.get(targetId);
    if (
      record?.admitted &&
      nav &&
      this.navSessions.get(sessionId) === nav &&
      this.targets.get(targetId)?.type === 'page' &&
      !frame.parentId &&
      this.protectedFrame(frame) &&
      frame.url?.startsWith('chrome-error:')
    ) {
      record.error = { id: frame.id, url: frame.unreachableUrl ?? ERROR_PAGE };
    }
  }

  noteError(frame, sessionId, committed = false) {
    const targetId =
      this.sessions.get(sessionId)?.targetId ?? this.navSessions.get(sessionId)?.targetId;
    const target = this.targets.get(targetId);
    const nav = this.navs.get(targetId);
    const root = this.frameRoots.get(targetId);
    if (committed) this.recoverError(frame, sessionId, targetId);
    this.frames.set(frame.id, this.framed(frame));
    if (this.protectedFrame(frame) && frame.url?.startsWith('chrome-error:')) {
      this.errorFrames.add(frame.id);
      this.errorUrls.set(frame.id, frame.unreachableUrl);
    } else if (committed) {
      this.errorFrames.delete(frame.id);
      this.errorUrls.delete(frame.id);
      nav?.errors?.delete(frame.id);
    }
    if (nav && this.errorFrames.has(frame.id)) {
      nav.errors ??= new Set();
      nav.errors.add(frame.id);
    }
    if (
      targetId &&
      (root === frame.id ||
        (!root &&
          (!frame.parentId || (target?.type === 'iframe' && this.navSessions.has(sessionId)))))
    )
      this.frameRoots.set(targetId, frame.id);
    for (const entry of this.sessions.values()) {
      if (entry.targetId !== targetId || (frame.parentId && entry.frameId !== frame.id)) continue;
      entry.frameId = frame.id;
      if (this.errorFrames.has(frame.id))
        this.errored.set(
          targetId,
          typeof frame.unreachableUrl === 'string' && URL.canParse(frame.unreachableUrl)
            ? frame.unreachableUrl
            : ERROR_PAGE
        );
    }
    if (frame.parentId) this.parents.set(frame.id, frame.parentId);
    this.taintContent();
  }

  taintContent() {
    for (const command of this.pendingContent)
      if (contentRead(command.method) && this.errorDocument(command.sessionId, command.method))
        this.unsafe.add(command);
  }

  errorDocument(sessionId, method = '') {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    const known = this.frameRoots.get(entry.targetId);
    if (
      (!known || this.targets.get(entry.targetId)?.type === 'iframe') &&
      [...(this.navs.get(entry.targetId)?.errors ?? [])].some((frame) =>
        this.errorFrames.has(frame)
      )
    )
      return true;
    const root = known ?? entry.frameId ?? entry.targetId;
    if (this.errorFrames.has(root)) return true;
    if (
      !RENDERED.has(method) &&
      !/^(?:DOM|DOMSnapshot|Accessibility|CSS|LayerTree|Log)\.|^Page\.capture/.test(method)
    )
      return false;
    for (const frame of this.errorFrames) {
      const seen = new Set();
      let id = frame;
      while (id && !seen.has(id)) {
        if (id === root) return true;
        seen.add(id);
        id = this.parents.get(id);
      }
    }
    return false;
  }

  frameError(params = {}, sessionId, names = this.errorFrames) {
    if (!names.size) return false;
    const pending = [params];
    let visited = 0;
    while (pending.length) {
      visited += 1;
      const value = pending.pop();
      if (typeof value === 'string' && names.has(value)) return true;
      if (!value || typeof value !== 'object') continue;
      for (const key of Object.keys(value)) {
        if (names.has(key)) return true;
        if (pending.length + visited >= 4096)
          return this.errorDocument(sessionId, 'Page.captureScreenshot');
        pending.push(value[key]);
      }
    }
    return false;
  }

  eventFrames(method) {
    if (!/^Page\.(?:javascriptDialogOpening|javascriptDialogClosed|windowOpen)$/.test(method))
      return this.errorFrames;
    return new Set([
      ...this.errorFrames,
      ...[...this.errorFrames]
        .map((frame) => this.errorUrls.get(frame))
        .filter((url) => typeof url === 'string' && url.length > 0),
    ]);
  }

  eventError(message) {
    return (
      this.quarantined.has(message.sessionId) ||
      this.frameError(message.params, message.sessionId, this.eventFrames(message.method)) ||
      this.errorDocument(message.sessionId, message.method)
    );
  }

  rememberUnsafe(message) {
    if (message.id !== undefined || this.navSessions.has(message.sessionId)) return;
    const named = this.frameError(
      message.params,
      message.sessionId,
      this.eventFrames(message.method)
    );
    if (named && message.method === 'Runtime.executionContextCreated') this.foreign(message);
    if (
      this.quarantined.has(message.sessionId) ||
      named ||
      this.errorDocument(message.sessionId, message.method)
    )
      this.unsafe.add(message);
  }

  entry(entry) {
    if (!this.unsafeUrl(entry.url) && !this.hides(entry) && !entry.url.startsWith('chrome-error:'))
      return entry;
    return { ...entry, url: ERROR_PAGE, userTypedURL: ERROR_PAGE, title: '' };
  }

  framed(frame) {
    const named = [frame.unreachableUrl, frame.securityOrigin].find((url) => this.is.url(url));
    return named ?? frame.url ?? '';
  }

  tree({ frame, childFrames, resources, ...rest }, sessionId) {
    if (frame.id !== undefined && !this.targets.has(frame.id)) {
      this.frames.set(frame.id, this.framed(frame));
      if (frame.parentId) this.parents.set(frame.id, frame.parentId);
    }
    const hidden = this.errorFrames.has(frame.id) || this.protectedFrame(frame);
    const { unreachableUrl, urlFragment, ...shown } = frame;
    return {
      ...rest,
      frame: hidden ? { ...shown, url: ERROR_PAGE, securityOrigin: '://' } : frame,
      ...(childFrames
        ? { childFrames: childFrames.map((child) => this.tree(child, sessionId)) }
        : {}),
      ...(resources
        ? {
            resources: hidden
              ? []
              : resources.filter(
                  (item) => !this.frameError(item, sessionId) && !this.is.url(item.url)
                ),
          }
        : {}),
    };
  }

  reaches(method) {
    if (typeof method !== 'string') return false;
    if (PAGE_CONTENT.has(method) || REACHES.test(method)) return true;
    if (method.startsWith('DOM.')) return method !== 'DOM.enable' && method !== 'DOM.disable';
    return method.startsWith('Runtime.') && !RUNTIME_META.has(method);
  }

  moveFrom(message) {
    if (!message.sessionId) return null;
    if (message.method === 'Page.navigateToHistoryEntry') return { kind: 'entry' };
    return null;
  }

  idle(move, now) {
    if (move.kind === 'back') return now.index <= 0;
    if (move.kind === 'forward') return now.index < 0 || now.index >= now.length - 1;
    return move.kind === 'go' && move.delta === 0;
  }

  within(work, limit) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), limit);
    });
    return Promise.race([
      work.then((value) => {
        clearTimeout(timer);
        return value;
      }),
      late,
    ]);
  }

  answered(work) {
    return this.within(work, ANSWER_MS);
  }

  racedTree(sessionId) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), FRAME_MS);
    });
    const tree = this.call('Page.getFrameTree', {}, sessionId);
    const raced = Promise.race([
      tree.then((value) => {
        clearTimeout(timer);
        return value;
      }),
      late,
    ]);
    return { tree, raced };
  }

  view(info, frames, history) {
    const entries = history.result.entries ?? [];
    const index = history.result.currentIndex;
    const entry = entries[index];
    const infoUrl = info.result?.targetInfo?.url;
    const hinted = [entry?.userTypedURL];
    for (const frame of frames) hinted.push(frame.unreachableUrl);
    const visible = [infoUrl, ...frames.flatMap((frame) => [frame.url, frame.securityOrigin])].some(
      (url) => this.is.url(url)
    );
    const live = visible || this.is.url(entry?.url);
    return {
      url: infoUrl || frames[0]?.url || '',
      index,
      length: entries.length,
      live,
      visible,
      protected:
        live ||
        hinted.some((url) => this.is.url(url)) ||
        frames.some((frame) => this.protectedFrame(frame)),
      frames,
      info: info.result?.targetInfo,
    };
  }

  lateTree(sessionId, tree) {
    if (tree.error) return;
    const frames = framed(tree.result?.frameTree);
    for (const frame of frames) this.noteError(frame, sessionId);
    const hidden = frames.some((frame) => this.frameLive(frame));
    if (!hidden) return;
    this.note(sessionId, { frames, info: null });
    this.cut(sessionId);
  }

  frameLive(frame) {
    return this.is.url(frame.url) || this.is.url(frame.securityOrigin);
  }

  pageShown(now) {
    return (now?.frames ?? []).some((frame) => this.frameLive(frame));
  }

  async openDocument(sessionId) {
    const tree = await this.answered(this.call('Page.getFrameTree', {}, sessionId));
    const frames = tree && !tree.error ? framed(tree.result?.frameTree) : [];
    return frames.length > 0 && !frames.some((frame) => this.frameLive(frame));
  }

  blankHistory() {
    return { result: { currentIndex: 0, entries: [] } };
  }

  unattached(info, frames, treeNow) {
    const child = info.result?.targetInfo?.type === 'iframe';
    const readable = child && treeNow && !treeNow.error && frames.length;
    const history = this.blankHistory();
    if (child && !readable) return null;
    if (readable) {
      if (frames.some((frame) => this.frameLive(frame))) {
        return { ...this.view(info, frames, history), probed: true };
      }
      if (!frames.some((frame) => /^https?:/i.test(frame.url ?? ''))) return null;
      return this.view(info, frames, history);
    }
    const infoUrl = info.result?.targetInfo?.url ?? '';
    if (frames.some((frame) => this.frameLive(frame)) || this.is.url(infoUrl)) {
      return { ...this.view(info, frames, history), probed: true };
    }
    return undefined;
  }

  async once(sessionId, budget) {
    const targetId = this.sessions.get(sessionId)?.targetId;
    const { tree, raced } = this.racedTree(sessionId);
    const limit = Math.max(0, budget);
    const [info, treeNow, history] = await Promise.all([
      targetId
        ? this.within(this.call('Target.getTargetInfo', { targetId }), Math.min(PROBE_WAIT, limit))
        : Promise.resolve(null),
      raced,
      this.within(
        this.call('Page.getNavigationHistory', {}, sessionId),
        Math.min(ANSWER_MS, limit)
      ),
    ]);
    if (treeNow === undefined) void tree.then((late) => this.lateTree(sessionId, late));
    const frames = treeNow && !treeNow.error ? framed(treeNow.result?.frameTree) : [];
    for (const frame of frames) this.noteError(frame, sessionId);
    const historyKnown =
      history &&
      !history.error &&
      Number.isInteger(history.result?.currentIndex) &&
      Array.isArray(history.result?.entries) &&
      history.result.currentIndex >= 0 &&
      history.result.currentIndex < history.result.entries.length;
    if (!info || info.error) return undefined;
    if (!historyKnown) return this.unattached(info, frames, treeNow);
    if (this.pendingHistory.has(sessionId) && !frames.length) return null;
    if (treeNow === undefined) return this.slowTree(sessionId, info, history, tree);
    if (treeNow.error || !frames.length) return undefined;
    return this.view(info, frames, history);
  }

  async surface(sessionId) {
    const started = Date.now();
    let now;
    for (let attempt = 0; attempt < PROBE_TRIES; attempt += 1) {
      const left = PROBE_BUDGET - (Date.now() - started);
      if (left <= 0) break;
      now = await this.once(sessionId, left);
      if (now !== undefined) break;
      const slot = Math.floor(((attempt + 1) * PROBE_BUDGET) / PROBE_TRIES);
      const wait = slot - (Date.now() - started);
      if (wait > 0 && attempt + 1 < PROBE_TRIES) await pause(wait);
    }
    if (now) {
      if (!now.probed && !now.pendingTree) this.settled.set(sessionId, now);
      return now;
    }
    if (this.pendingCommit.has(sessionId)) {
      return {
        url: '',
        index: 0,
        length: 0,
        live: true,
        protected: true,
        frames: [],
        info: null,
        probed: true,
      };
    }
    return null;
  }

  async slowTree(sessionId, info, history, tree) {
    const preview = this.view(info, [], history);
    if (preview.protected) return preview;
    if (this.uncommitted.has(sessionId)) return { ...preview, pendingTree: true };
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), TREE_WAIT);
    });
    const arrived = await Promise.race([
      tree.then((value) => {
        clearTimeout(timer);
        return value;
      }),
      late,
    ]);
    const frames = arrived && !arrived.error ? framed(arrived.result?.frameTree) : [];
    if (!frames.length) return { ...preview, pendingTree: true };
    const now = this.view(info, frames, history);
    if (now.protected) return now;
    if (frames.some((frame) => /^https?:/i.test(frame.url ?? ''))) return now;
    return { ...preview, pendingTree: true };
  }

  note(sessionId, now) {
    for (const frame of now.frames) {
      if (!frame.id) continue;
      this.noteError({ ...frame, url: `${frame.url ?? ''}${frame.urlFragment ?? ''}` }, sessionId);
    }
    if (now.info) this.learn(now.info);
  }

  async untilSettled(sessionId, before) {
    const deadline = Date.now() + HISTORY_WAIT;
    while (Date.now() < deadline) {
      const now = await this.surface(sessionId);
      if (now?.live) {
        this.pendingHistory.delete(sessionId);
        this.note(sessionId, now);
        this.cut(sessionId);
        return;
      }
      if (
        now?.frames?.length &&
        !now.live &&
        (now.url !== before.url || now.index !== before.index)
      ) {
        this.pendingHistory.delete(sessionId);
        this.note(sessionId, now);
        return;
      }
      await pause(HISTORY_POLL);
    }
    const now = await this.surface(sessionId);
    if (!now?.frames?.length) return;
    this.pendingHistory.delete(sessionId);
    this.note(sessionId, now);
    if (now.live) this.cut(sessionId);
  }

  boundSessions(sessionId) {
    const targetId =
      this.sessions.get(sessionId)?.targetId ?? this.navSessions.get(sessionId)?.targetId;
    const ids = new Set(sessionId ? [sessionId] : []);
    if (!targetId) return ids;
    for (const [id, entry] of this.sessions) if (entry.targetId === targetId) ids.add(id);
    for (const [id, nav] of this.navSessions) if (nav.targetId === targetId) ids.add(id);
    return ids;
  }

  rememberMain(sessionId, frameId) {
    if (!frameId) return;
    for (const id of this.boundSessions(sessionId)) this.mains.set(id, frameId);
  }

  mainFrame(sessionId) {
    const targetId = this.scopeTarget(sessionId);
    return (
      this.mains.get(sessionId) ??
      this.frameRoots.get(targetId) ??
      this.scopes.get(targetId)?.root ??
      this.sessions.get(sessionId)?.frameId
    );
  }

  noteStarted(id, frameId, url, loaderId, guardian, holdInput = true) {
    const main = this.mainFrame(id);
    if (main !== undefined && frameId !== undefined && frameId !== main) return;
    const former = this.opening.get(id);
    if (
      loaderId &&
      former?.loaderId === loaderId &&
      former.input === frameId &&
      former.url === url
    ) {
      former.guardian ||= guardian;
      if (holdInput) this.uncommitted.add(id);
      return;
    }
    const open = { input: frameId, url, loaderId, guardian };
    if (holdInput) this.uncommitted.add(id);
    else this.uncommitted.delete(id);
    if (this.is.url(url)) {
      this.pendingCommit.add(id);
      open.commit = frameId;
    } else this.pendingCommit.delete(id);
    this.opening.set(id, open);
  }

  noteCommitted(id, method, frameId, parentId, loaderId) {
    const top = method === 'Page.frameNavigated' && !parentId;
    const same =
      method === 'Page.navigatedWithinDocument' &&
      frameId !== undefined &&
      frameId === (this.mains.get(id) ?? this.sessions.get(id)?.frameId) &&
      !this.opening.has(id);
    if (top) this.worlds.delete(id);
    const open = this.opening.get(id) ?? {};
    if (open.loaderId && (top || same || open.input === frameId) && open.loaderId !== loaderId) {
      if (top && loaderId === undefined && !this.pendingCommit.has(id)) this.uncommitted.delete(id);
      return false;
    }
    if (top || same || open.input === frameId) {
      this.uncommitted.delete(id);
      delete open.input;
    }
    if (top || same || open.commit === frameId) {
      this.pendingCommit.delete(id);
      delete open.commit;
    }
    if (open.input === undefined && open.commit === undefined) this.opening.delete(id);
    else this.opening.set(id, open);
    return true;
  }

  noteNavigation(sessionId, method, params = {}) {
    const frameId = params.frameId ?? params.frame?.id;
    const guardian = this.navSessions.has(sessionId);
    if (
      method === 'Page.frameStoppedLoading' &&
      guardian &&
      frameId === this.mainFrame(sessionId)
    ) {
      const load = this.loadSnapshot(sessionId);
      if (load.every(([, open]) => open.guardian && open.input === frameId))
        this.settleLoad(load, true);
      return;
    }
    if (method === 'Page.frameNavigated' && frameId && !params.frame?.parentId) {
      this.rememberMain(sessionId, frameId);
    }
    const started = method === 'Page.frameStartedNavigating';
    const committed = method === 'Page.frameNavigated' || method === 'Page.navigatedWithinDocument';
    if (!started && !committed) return;
    const accepted = new Set();
    for (const id of this.boundSessions(sessionId)) {
      if (started)
        this.noteStarted(
          id,
          frameId,
          params.url,
          params.loaderId,
          guardian,
          HISTORY_NAV.has(params.navigationType) || this.is.url(params.url)
        );
      else if (
        this.noteCommitted(id, method, frameId, params.frame?.parentId, params.frame?.loaderId)
      )
        accepted.add(id);
    }
    if (started)
      for (const command of this.callerIds.values())
        if (this.pendingRecovery(command)) this.unsafe.add(command);
    return accepted;
  }

  pendingTarget(targetId) {
    return Boolean(
      targetId && [...this.pendingCommit].some((id) => this.scopeTarget(id) === targetId)
    );
  }

  pendingRecovery({ method, params = {}, sessionId }) {
    if (
      !OBSERVED.has(method) &&
      method !== 'Target.getTargetInfo' &&
      method !== 'Target.attachToTarget'
    )
      return false;
    const targetId = method.startsWith('Target.')
      ? (params.targetId ?? this.scopeTarget(sessionId))
      : this.scopeTarget(sessionId);
    return this.pendingTarget(targetId);
  }

  async workerSession(sessionId) {
    const targetId = this.sessions.get(sessionId)?.targetId;
    if (!targetId) return undefined;
    const kind = (await this.lookup(targetId))?.type;
    if (!WORKER_TYPES.has(kind)) return undefined;
    return (await this.target(targetId)) ? PROTECTED : null;
  }

  prelude(sessionId, method) {
    if (method.startsWith('Input.') && this.uncommitted.has(sessionId)) return PROTECTED;
    if (
      method === 'Page.handleJavaScriptDialog' &&
      !this.pendingCommit.has(sessionId) &&
      !this.settled.get(sessionId)?.protected
    ) {
      return null;
    }
    if (
      (this.pendingCommit.has(sessionId) || this.pendingTarget(this.scopeTarget(sessionId))) &&
      !NAVIGATES.has(method)
    )
      return PROTECTED;
    return false;
  }

  async confirmed(sessionId, method) {
    const shot = method === 'Page.captureScreenshot';
    if (this.pendingHistory.has(sessionId) || this.blocked.has(sessionId)) {
      if (shot && this.blocked.has(sessionId) && (await this.blankShot(sessionId))) return null;
      return PROTECTED;
    }
    const early = this.prelude(sessionId, method);
    if (early !== false) return early;
    const worker = await this.workerSession(sessionId);
    if (worker !== undefined) return worker;
    const now = await this.surface(sessionId);
    const navigating = NAVIGATES.has(method);
    if (!now) return navigating && (await this.openDocument(sessionId)) ? null : PROTECTED;
    if (now.pendingTree) return navigating ? null : PROTECTED;
    this.note(sessionId, now);
    if (!now.protected) return null;
    if (shot && this.blankFrames(now)) return null;
    if (this.pageShown(now) && !now.probed) this.cut(sessionId);
    if (!now.live && navigating) return null;
    if (!now.live && shot && this.blankShown(now)) return null;
    return PROTECTED;
  }

  blankFrames(now) {
    const frames = now?.frames ?? [];
    return (
      frames.length > 0 &&
      frames.every((frame) => {
        const url = frame?.url;
        return (
          !this.is.url(frame?.securityOrigin) &&
          (url === BLANKED || (typeof url === 'string' && url.startsWith('about:blank')))
        );
      })
    );
  }

  async blankShot(sessionId) {
    const now = await this.surface(sessionId);
    return Boolean(now && this.blankFrames(now));
  }

  async noteShot(message) {
    if (message.method !== 'Page.captureScreenshot') return;
    if (
      (await this.blankShot(message.sessionId)) &&
      !this.finished.has(message) &&
      this.owns(message)
    )
      this.shots.add(requestKey(message));
  }

  blankShown(now) {
    const urls = [now.url, now.info?.url, ...now.frames.map((frame) => frame.url)].filter(
      (url) => typeof url === 'string' && url
    );
    return urls.length > 0 && urls.every((url) => url === BLANKED || url.startsWith('about:blank'));
  }

  async back(params, sessionId) {
    const history = await this.answered(this.call('Page.getNavigationHistory', {}, sessionId));
    if (!history || history.error) return true;
    const entries = history.result?.entries;
    if (!Array.isArray(entries)) return true;
    const entry = entries.find((item) => item.id === params.entryId);
    return !entry || this.unsafeUrl(entry.url) || this.hides(entry);
  }

  shownTarget(message, info, source = message, proof) {
    if (this.unsafe.has(source) || this.eventError(source)) {
      this.deliver(this.metadataEvent(message, proof), true, source, proof);
      return;
    }
    const raw = info ?? {};
    const originOnly = message.method === 'Target.attachedToTarget' && this.fresh(proof);
    const shown = this.masked(raw, originOnly);
    const names = (value) =>
      typeof value === 'string' && value.includes('://') && this.is.url(value);
    const origin = originOnly && this.is.url(raw.url) && shown.url === shown.title;
    if ([raw.url, raw.title, shown.url, shown.title].some(names) && !origin) return;
    this.deliver(
      {
        ...message,
        params: { ...message.params, targetInfo: shown },
      },
      true,
      source,
      proof
    );
  }

  masked(info, stranded = false) {
    return this.redact(this.masking(info, stranded)).params;
  }

  masking(info, stranded = false) {
    if (stranded && this.is.url(info.url) && URL.canParse(info.url)) {
      const { origin } = new URL(info.url);
      return { ...info, url: origin, title: origin };
    }
    const failed = this.errored.get(info.targetId);
    const entries = [...this.sessions.values()].filter((entry) => entry.targetId === info.targetId);
    const error =
      this.errorFrames.has(this.frameRoots.get(info.targetId)) ||
      entries.some((entry) => this.errorFrames.has(entry.frameId));
    if (
      info.url?.startsWith('chrome-error:') &&
      !entries.some((entry) => this.frames.get(entry.frameId)?.startsWith('chrome-error:'))
    )
      info = { ...info, title: '' };
    if (error) return { ...info, url: ERROR_PAGE, title: ERROR_PAGE };
    if (info.url === undefined || failed === undefined) return info;
    if (![failed, '', ERROR_PAGE].includes(bare(info.url))) return info;
    const origin =
      !this.is.url(failed) && URL.canParse(failed) ? new URL(failed).origin : ERROR_PAGE;
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
    const method = message.method ?? '';
    const { params = {} } = message;
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

  async contentEvent(message) {
    if (message.method === 'Page.screencastFrame' && !this.casts.has(message.sessionId))
      return true;
    if (message.method === 'Runtime.executionContextCreated') {
      const record = this.contextChecks.get(message.sessionId)?.get(message.params?.context?.id);
      if (record?.message === message && (!(await record.promise) || record.loading)) return true;
    }
    return this.failedScope(message.sessionId) && contentRead(message.method);
  }

  async event(message) {
    const method = message.method ?? '';
    const { sessionId } = message;
    const foreign = this.foreign({ ...message, method });
    if (this.navSessions.has(sessionId))
      return this.navEvent(message, this.navSessions.get(sessionId));
    if (this.placements.has(sessionId)) return;
    if (await this.settledRecoveryLoad(message))
      return this.deliver({ method, sessionId, params: { timestamp: message.params.timestamp } });
    if (method.startsWith('Target.') && (await this.targetEvent(message))) return;
    if (this.deferredStyle(message)) return;
    if (this.locked(sessionId) && (pageScoped(method) || method === 'Page.screencastFrame')) return;
    if (this.blocked.has(sessionId) && PAUSES.has(method)) return this.release(message);
    if (this.hidden(sessionId)) return;
    if (foreign) return;
    if (await this.contentEvent(message)) return;
    if (this.walked({ ...message, method })) return this.cut(sessionId);
    if (sessionId && method.startsWith('Runtime.') && !this.runtimes.has(sessionId)) return;
    if (await this.swallowed(message)) return;
    if (this.stored(message)) return;
    if (sessionId && this.naming({ ...message, method })) return;
    if (sessionId && method.startsWith('Page.') && !this.pages.has(sessionId)) return;
    if (PAUSES.has(method)) this.offered.add(message.params?.requestId);
    this.redacted(message);
  }

  async searched(method, params, sessionId) {
    const [read, args] = SEARCHES[method](params);
    const { result, error } = await this.call(read, args, sessionId);
    return (
      error ||
      !result ||
      !['body', 'data', 'content'].some((field) => typeof result[field] === 'string') ||
      this.mentions(result)
    );
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
      const guarded = (await this.current(info.targetId)) || this.is.url(info.url);
      const proof = guarded ? await this.stranded(info.targetId) : null;
      if (!guarded || this.fresh(proof)) targetInfos.push(this.masked(info, Boolean(proof)));
    }
    return this.deliver({ ...message, result: { ...result, targetInfos } });
  }

  pageAnswer(was) {
    if (
      !pageScoped(was?.method) ||
      (!was.locked && (!this.locked(was.sessionId) || this.blankAdmission(was)))
    )
      return false;
    if (was.method === 'Page.startScreencast')
      void this.call('Page.stopScreencast', {}, was.sessionId);
    this.refuse(was);
    return true;
  }

  endedAnswer(was) {
    if (this.finished.has(was)) {
      const key = requestKey(was);
      if (
        this.callerIds.get(key) === was &&
        this.asked.get(key) !== was &&
        !this.answering.has(was)
      )
        this.callerIds.delete(key);
      if (was.method === 'Page.startScreencast')
        void this.call('Page.stopScreencast', {}, was.sessionId);
      return true;
    }
    if (
      !this.blocked.has(was?.sessionId) ||
      (was?.method === 'Page.captureScreenshot' && this.shots.has(requestKey(was)))
    )
      return false;
    this.refuse(was);
    return true;
  }

  unsafeContent(message) {
    return (
      this.unsafe.has(message) ||
      this.pendingRecovery(message) ||
      (this.quarantined.has(message.sessionId) && !RECOVERS.has(message.method)) ||
      (contentRead(message.method) && this.errorDocument(message.sessionId, message.method))
    );
  }

  replyProtected(was) {
    return this.blocked.has(was.sessionId) || this.unsafeContent(was);
  }

  owns(message) {
    return (
      !this.closing &&
      !this.closed &&
      (message.id === undefined || this.callerIds.get(requestKey(message)) === message)
    );
  }

  sealed(was) {
    if (was && this.moved.delete(requestKey(was))) return true;
    return Boolean(was?.sessionId && this.replyProtected(was));
  }

  async keptShot(was) {
    const admitted = was?.method === 'Page.captureScreenshot' && this.shots.delete(requestKey(was));
    if (!admitted) return false;
    return this.blankShot(was.sessionId);
  }

  async openShot(was) {
    const now = await this.surface(was?.sessionId);
    return Boolean(now && !now.protected && !now.pendingTree);
  }

  async shotAnswer(message, was) {
    if (await this.keptShot(was)) return this.deliver(message);
    if (this.sealed(was) || !(await this.openShot(was))) return this.refuse(was);
    return this.deliver(message);
  }

  async entryAnswer(message, was) {
    const sessionId = was.sessionId;
    const deadline = Date.now() + HISTORY_WAIT;
    while (sessionId && this.pendingHistory.has(sessionId) && Date.now() < deadline) {
      await pause(HISTORY_POLL);
    }
    if (sessionId && this.blocked.has(sessionId)) return this.refuse(was);
    const now = await this.surface(sessionId);
    if (!now || now.protected || now.pendingTree) return this.refuse(was);
    return this.deliver(message);
  }

  async routed(message, was) {
    if (was?.method === 'Page.captureScreenshot') {
      await this.shotAnswer(message, was);
      return true;
    }
    if (was?.method !== 'Page.navigateToHistoryEntry' || !this.moved.delete(requestKey(was)))
      return false;
    await this.entryAnswer(message, was);
    return true;
  }

  worldReply(was, result) {
    if (was?.method === 'Page.createIsolatedWorld' && result?.executionContextId !== undefined) {
      const world = this.world(was.sessionId);
      if (!world.ids.has(result.executionContextId))
        world.ids.set(result.executionContextId, false);
    }
  }

  async settledRecoveryLoad(message) {
    if (
      message.method !== 'Page.loadEventFired' ||
      typeof message.params?.timestamp !== 'number' ||
      !Number.isFinite(message.params.timestamp)
    )
      return false;
    const { sessionId } = message;
    const entry = this.sessions.get(sessionId);
    const nav = this.navs.get(entry?.targetId);
    const owned = this.proofCommits.get(entry?.targetId);
    let ticket = this.quarantined.get(sessionId);
    const commit = ticket?.commit;
    if (
      !entry ||
      !nav ||
      !ticket ||
      !owned?.accepted ||
      this.targets.get(entry.targetId)?.type !== 'page' ||
      !URL.canParse(owned.url)
    )
      return false;
    const url = new URL(owned.url);
    url.hash = '';
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (commit) {
      if (owned.id !== commit.id || owned.loader !== commit.loaderId || url.href !== commit.url)
        return false;
    } else {
      const hint = ticket.hint?.params?.targetInfo;
      if (hint?.targetId !== entry.targetId || hint.url !== owned.url) return false;
    }
    const deadline = Date.now() + ANSWER_MS;
    while (ticket?.checking && Date.now() < deadline) {
      await this.answered(ticket.checking);
      const next = this.quarantined.get(sessionId);
      if (next === ticket) break;
      ticket = next;
    }
    if (!(await this.placed(sessionId))) return false;
    return Boolean(
      this.sessions.get(sessionId) === entry &&
        this.navs.get(entry.targetId) === nav &&
        this.navSessions.get(nav.session) === nav &&
        !nav.failed &&
        !nav.retired &&
        this.proofCommits.get(entry.targetId) === owned &&
        owned.epoch === this.proofEpoch.get(entry.targetId) &&
        !this.quarantined.has(sessionId) &&
        !this.blocked.has(sessionId) &&
        !this.gone.has(sessionId) &&
        this.shown.has(sessionId) &&
        !this.pendingTarget(entry.targetId) &&
        !this.errorDocument(sessionId, message.method) &&
        !this.locked(sessionId)
    );
  }

  async finishRecovery(was) {
    if (!this.recoveries.has(was)) return;
    const ticket = this.quarantined.get(was.sessionId);
    if (!ticket) return;
    this.startHint(was.sessionId, ticket);
    await ticket.checking;
  }

  targetAnswer(message, was) {
    const proof = this.recoveries.get(was);
    if (proof && !this.fresh(proof)) return this.refuse(was);
    this.deliver({
      ...message,
      result: { targetInfo: this.masked(message.result.targetInfo, Boolean(proof)) },
    });
  }

  async answer(message, was) {
    await this.finishRecovery(was);
    this.pendingContent.delete(was);
    if (this.endedAnswer(was) || !this.owns(was)) return;
    if (this.unsafeContent(was)) return this.refuse(was);
    if (this.pageAnswer(was)) return;
    if (await this.routed(message, was)) return;
    if (this.sealed(was)) return this.refuse(was);
    const { method, params = {} } = was ?? {};
    const { result } = message;
    this.worldReply(was, result);
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
        result: { ...result, frameTree: this.tree(result.frameTree, message.sessionId) },
      });
    }
    if (this.contents(message, was)) return;
    if (method === 'Target.getTargetInfo' && result?.targetInfo)
      return this.targetAnswer(message, was);
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
    const method = message.method ?? '';
    const { params = {} } = message;
    if (!STORED.some((domain) => method.startsWith(domain))) return false;
    if (
      method === 'ServiceWorker.workerRegistrationUpdated' &&
      Array.isArray(params.registrations)
    ) {
      const registrations = params.registrations.filter((item) => this.worker(item));
      if (registrations.length)
        this.deliver({ ...message, params: { ...params, registrations } }, true, message);
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
    if (sessionId !== undefined && this.hidden(sessionId)) {
      if (method === 'Page.captureScreenshot' && this.blocked.has(sessionId)) return false;
      return !(this.blocked.has(sessionId) && OBSERVED.has(method));
    }
    return (
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
    if (!(await this.reread(sessionId))) return UNGUARDED;
    if (method === 'Page.captureScreenshot') return this.locked(sessionId, true) ? PROTECTED : null;
    return this.locked(sessionId) ? PROTECTED : null;
  }

  async reread(sessionId) {
    const targetId = this.scopeTarget(sessionId);
    if (!this.holding(targetId)) return true;
    const session = this.scopes.get(targetId)?.sessionId;
    const { error, result } = await this.call('Page.getFrameTree', {}, session);
    return !error && Boolean(result?.frameTree);
  }

  async recover(message) {
    const { method, sessionId } = message;
    if (!RECOVERS.has(method) || sessionId === undefined) return false;
    const ticket = this.quarantined.get(sessionId);
    if (ticket?.checking && !ticket.verified && !NAVIGATES.has(method)) return true;
    const targetId = this.sessions.get(sessionId)?.targetId;
    const target = this.targets.get(targetId);
    if (!ticket && !target?.guarded && !this.errorDocument(sessionId)) return false;
    const proof = await this.stranded(targetId);
    if (!proof) return true;
    this.recoveries.set(message, proof);
    return false;
  }

  async precheck(message) {
    if (this.unsafeContent(message) || (await this.recover(message))) return PROTECTED;
    return this.pageCheck(message.method, message.sessionId);
  }

  async check(message) {
    const { method, params = {}, sessionId } = message;
    if (typeof method !== 'string') return null;
    const early = await this.precheck(message);
    if (early) return early;
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
    return this.reaching(method, params, sessionId, message);
  }

  async reachTarget(message) {
    const { method, params = {} } = message;
    if (params.targetId === undefined) return false;
    const limit =
      method === 'Target.attachToTarget' && this.navs.get(params.targetId)?.admitted
        ? PROBE_WAIT
        : ANSWER_MS;
    const guarded = await this.current(params.targetId, limit);
    const target = this.targets.get(params.targetId);
    if (method === 'Target.attachToTarget' && !guarded) {
      this.touch(params.targetId);
      await this.navs.get(params.targetId)?.ready;
    }
    const nav = this.navs.get(params.targetId);
    const error =
      STRANDED.has(method) &&
      nav?.admitted &&
      (target?.url?.startsWith('chrome-error:') || nav.scrub);
    if (!guarded && !error) return false;
    const proof = STRANDED.has(method) ? await this.stranded(params.targetId) : null;
    if (!proof) return true;
    this.recoveries.set(message, proof);
    return false;
  }

  async reaching(method, params, sessionId, message) {
    if (await this.reachTarget(message)) return PROTECTED;
    const proof = this.recoveries.get(message);
    if (method === 'Target.attachToTarget') {
      this.touch(params.targetId);
      const nav = this.navs.get(params.targetId);
      if (nav) await nav.ready;
      if (nav?.scrub && !proof) await nav.scrub;
      if (nav?.failed) return UNGUARDED;
    }
    if (
      params.frameId !== undefined &&
      !(proof && params.frameId === this.frameRoots.get(proof.targetId) && NAVIGATES.has(method)) &&
      (await this.frame(params.frameId, true))
    )
      return PROTECTED;
    if (method === 'Page.navigateToHistoryEntry' && (await this.back(params, sessionId))) {
      return PROTECTED;
    }
    return this.unseen(method, params);
  }

  async create(message) {
    if (this.finished.has(message) || !this.owns(message)) return;
    const { id, params, sessionId } = message;
    const answer = await this.call('Target.createTarget', {
      ...params,
      background: params.background ?? true,
      url: 'about:blank',
    });
    const targetId = answer.result?.targetId;
    if (this.finished.has(message) || !this.owns(message)) return;
    if (!targetId) return this.deliver({ ...answer, id, ...(sessionId ? { sessionId } : {}) });
    this.learn({ targetId, url: 'about:blank', type: 'page' });
    this.touch(targetId);
    const nav = this.navs.get(targetId);
    await nav.ready;
    if (this.finished.has(message) || !this.owns(message)) return;
    if (!nav.failed) {
      nav.admitted = true;
      this.rememberTab(targetId);
    }
    if (!nav.failed && !inherits(params.url))
      await this.call('Page.navigate', { url: params.url }, nav.session);
    if (this.finished.has(message) || !this.owns(message)) return;
    this.deliver({ id, ...(sessionId ? { sessionId } : {}), result: answer.result });
  }

  async withMainWorld(message) {
    const { method, params = {}, sessionId } = message;
    if (method !== 'Runtime.evaluate' && method !== 'Runtime.callFunctionOn') return message;
    if (
      params.contextId !== undefined ||
      params.executionContextId !== undefined ||
      params.uniqueContextId !== undefined ||
      params.executionContextUniqueId !== undefined ||
      params.objectId !== undefined ||
      params.nodeId !== undefined
    ) {
      return message;
    }
    await this.queues.get(sessionId);
    const uniqueContextId = this.worlds.get(sessionId)?.main;
    if (!uniqueContextId) return message;
    return { ...message, params: { ...params, uniqueContextId } };
  }

  departing(message) {
    const proof = this.recoveries.get(message);
    if (proof && !this.fresh(proof)) return true;
    const targetId = this.sessions.get(message.sessionId)?.targetId ?? message.params?.targetId;
    if (message.method === 'Page.stopLoading')
      message.stopping = this.loadSnapshot(message.sessionId);
    if (
      message.method === 'Page.navigate' ||
      message.method === 'Page.reload' ||
      message.method === 'Page.navigateToHistoryEntry' ||
      message.method === 'Target.closeTarget'
    )
      this.navs.get(targetId)?.wiped?.();
    return false;
  }

  async pass(message) {
    if (this.finished.has(message) || !this.owns(message)) return;
    this.commands.set(requestKey(message), message);
    const outgoing = await this.withMainWorld(message);
    const { id, method, sessionId } = outgoing;
    if (this.finished.has(message) || !this.owns(message)) return;
    if (this.unsafeContent(message) || this.departing(message)) return this.refuse(message);
    if (
      this.blocked.has(sessionId) &&
      !(method === 'Page.captureScreenshot' && this.shots.has(requestKey(message)))
    )
      return this.refuse(message);
    if (pageScoped(method) && this.locked(sessionId) && !this.blankAdmission(message))
      return this.refuse(message);
    if (method === 'Page.startScreencast') this.casts.add(sessionId);
    if (method === 'Page.stopScreencast') this.casts.delete(sessionId);
    if (sessionId && method === 'Runtime.enable') this.runtimes.add(sessionId);
    if (sessionId && method === 'Runtime.disable') {
      this.runtimes.delete(sessionId);
      this.worlds.delete(sessionId);
    }
    if (sessionId && method === 'Page.enable') this.pages.add(sessionId);
    if (sessionId && method === 'Page.disable' && this.shown.has(sessionId)) {
      this.pages.delete(sessionId);
      return this.deliver({ id, sessionId, result: {} });
    }
    this.asked.set(requestKey(message), message);
    if (contentRead(method)) this.pendingContent.add(message);
    this.connection.send(JSON.stringify(outgoing));
  }

  commitScope(targetId) {
    const seen = new Set();
    let id = targetId;
    while (id && !seen.has(id)) {
      seen.add(id);
      this.scope(id).committed = true;
      id = this.scopes.get(id).parent;
    }
  }

  receiveNavigation(message) {
    const committed = this.noteNavigation(message.sessionId, message.method, message.params);
    const targetId =
      message.params?.targetInfo?.targetId ??
      message.params?.targetId ??
      this.scopeTarget(message.sessionId);
    if (
      targetId &&
      (message.method?.startsWith('Target.target') ||
        NAVIGATED.has(message.method) ||
        STRUCTURE.has(message.method))
    )
      this.revisions.set(targetId, {});
    if (message.method !== 'Page.frameNavigated' || !message.params?.frame) return;
    const { frame } = message.params;
    const nav = this.navs.get(targetId);
    if (
      nav &&
      this.navSessions.get(message.sessionId) === nav &&
      committed?.has(message.sessionId) &&
      !frame.parentId &&
      typeof frame.id === 'string' &&
      frame.id &&
      !this.protectedFrame(frame) &&
      !this.unsafeUrl(frame.url) &&
      !inherits(frame.url) &&
      frame.unreachableUrl === undefined
    ) {
      this.recalled.delete(targetId);
      const owned = this.proofCommits.get(targetId);
      if (owned?.url === `${frame.url}${frame.urlFragment ?? ''}`) owned.accepted = true;
      const record = this.tabs.get(targetId);
      if (record) delete record.error;
    }
    this.wiping(nav, frame);
    if (nav && !frame.parentId) nav.document = frame;
    if (targetId && this.frameLive(frame)) this.commitScope(targetId);
    this.refreshHint(message, committed);
  }

  completeStopping(message) {
    const stopping = this.asked.get(requestKey(message));
    if (
      stopping?.method === 'Page.stopLoading' &&
      !message.error &&
      stopping.stopping?.length &&
      stopping.stopping.every(
        ([id, open]) => this.opening.get(id) === open || (!this.opening.has(id) && open.stopped)
      )
    ) {
      this.settleLoad(stopping.stopping, true);
      if (
        stopping.stopping.every(
          ([, open]) => open.url && !open.url.startsWith('chrome-error:') && !this.is.url(open.url)
        )
      )
        this.navs.get(this.scopeTarget(stopping.sessionId))?.wiped?.();
    }
  }

  received(text) {
    const message = parse(text);
    this.loadingEvent(message);
    this.completeStopping(message);
    if (
      message.id === undefined &&
      /^(?:Network|Fetch)\./.test(message.method) &&
      this.failedScope(message.sessionId) &&
      !['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)
    )
      this.unsafe.add(message);
    this.receiveContext(message);
    this.receiveAttachment(message);
    this.receiveFrame(message);
    this.receiveNavigation(message);
    if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged')
      this.receiveHint(message);
    if (message.method === 'Target.targetDestroyed') {
      this.retireProof(message.params?.targetId);
      this.tabs.delete(message.params?.targetId);
      this.hints.delete(message.params?.targetId);
      for (const [id, entry] of this.sessions)
        if (entry.targetId === message.params?.targetId && this.quarantined.has(id)) this.cut(id);
    }
    if (
      message.method === 'Page.frameAttached' &&
      message.params?.frameId &&
      message.params.parentFrameId
    ) {
      this.parents.set(message.params.frameId, message.params.parentFrameId);
      this.taintContent();
    }
    if (message.method === 'Page.frameDetached' && message.params?.reason === 'remove') {
      this.retireProof(message.params.frameId);
      this.rememberUnsafe(message);
      this.errorFrames.delete(message.params.frameId);
      this.errorUrls.delete(message.params.frameId);
      this.parents.delete(message.params.frameId);
    }
    this.rememberUnsafe(message);
    if (STRUCTURE.has(message.method)) this.scopeEvent(message);
    if (this.internal.has(message.id)) {
      const resolve = this.internal.get(message.id);
      this.internal.delete(message.id);
      return resolve(message);
    }
    if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId) {
      this.quarantined.delete(message.params.sessionId);
      this.blocked.add(message.params.sessionId);
      this.discardPending(message.params.sessionId);
    }
    const key = requestKey(message);
    if (message.id !== undefined && !this.asked.has(key)) return;
    const was = message.id === undefined ? undefined : this.asked.get(key);
    this.queue(
      message.sessionId ?? was?.sessionId ?? '',
      async () => {
        if (this.asked.get(key) === was) this.asked.delete(key);
        if (message.id === undefined) return this.event(message);
        this.answering.add(was);
        try {
          await this.answer(message, was);
        } finally {
          this.answering.delete(was);
          if (this.finished.has(was) && this.callerIds.get(key) === was) {
            this.callerIds.delete(key);
            this.moved.delete(key);
            this.shots.delete(key);
          }
        }
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

  standIn(message) {
    if (this.finished.has(message)) return;
    const { id, sessionId } = message;
    const key = requestKey(message);
    const release = this.asked.get(key) !== message && !this.answering.has(message);
    const result = TREES.has(message.method)
      ? { frameTree: { frame: { id: '0', url: ERROR_PAGE, securityOrigin: '://' } } }
      : {
          currentIndex: 0,
          entries: [{ id: 0, url: ERROR_PAGE, userTypedURL: ERROR_PAGE, title: '' }],
        };
    this.deliver({ id, sessionId, result }, release);
    this.finished.add(message);
    if (this.commands.get(key) === message) this.commands.delete(key);
    this.pendingContent.delete(message);
  }

  async observing(message) {
    if (!OBSERVED.has(message.method)) return false;
    const { sessionId } = message;
    if (!sessionId || this.pendingHistory.has(sessionId)) {
      this.refuse(message);
      return true;
    }
    if (this.blocked.has(sessionId)) {
      this.standIn(message);
      return true;
    }
    const now = await this.surface(sessionId);
    if (this.finished.has(message) || !this.owns(message)) return true;
    if (!now || now.pendingTree) {
      this.refuse(message);
      return true;
    }
    this.note(sessionId, now);
    const blank = this.blankFrames(now) && !this.is.url(now.url) && !this.is.url(now.info?.url);
    if (!now.live || blank) return false;
    if (this.pageShown(now) && !now.probed) this.cut(sessionId);
    this.standIn(message);
    return true;
  }

  async recheck(message) {
    const recovery = this.recoveries.get(message);
    if (recovery && !this.fresh(recovery)) {
      this.refuse(message);
      return true;
    }
    if (recovery && message.method !== 'Page.navigateToHistoryEntry') return false;
    const move = this.moveFrom(message);
    if (move) {
      const now = await this.surface(message.sessionId);
      if (this.finished.has(message) || !this.owns(message)) return true;
      if (!now || (now.live && !recovery)) {
        if (now?.live) {
          this.note(message.sessionId, now);
          this.cut(message.sessionId);
        }
        this.refuse(message);
        return true;
      }
      if (!this.idle(move, now)) {
        this.pendingHistory.add(message.sessionId);
        this.uncommitted.add(message.sessionId);
        this.moved.add(requestKey(message));
        await this.pass(message);
        await this.untilSettled(message.sessionId, now);
        return true;
      }
    }
    if (await this.observing(message)) return true;
    if (this.finished.has(message) || !this.owns(message)) return true;
    if (!this.reaches(message.method)) return false;
    if (!message.sessionId) {
      this.refuse(message);
      return true;
    }
    const blocked = await this.confirmed(message.sessionId, message.method);
    if (this.finished.has(message) || !this.owns(message)) return true;
    if (!blocked) {
      await this.noteShot(message);
      return false;
    }
    this.refuse(message, blocked);
    return true;
  }

  async sendChecked(message) {
    if (message.method === 'Runtime.enable' && this.primed.delete(message.sessionId)) {
      await this.call('Runtime.disable', {}, message.sessionId);
    }
    if (message.method === 'Target.createTarget' && typeof message.params?.url === 'string') {
      return this.create(message);
    }
    if (await this.recheck(message)) return;
    return this.pass(message);
  }

  ownedBlank(sessionId) {
    const owner = this.sessions.get(sessionId)?.targetId;
    return this.proofCommits.get(owner)?.url === BLANKED;
  }

  start() {
    const { connection, guarded } = this;
    connection.onmessage = (text) => this.received(text);
    connection.onclose = (why) => {
      this.closing = true;
      this.closed = true;
      guarded.send = () => {};
      guarded.onmessage = null;
      for (const nav of this.navs.values()) nav.wiped?.();
      this.autoAttachments.clear();
      guarded.onclose?.(why);
    };
    guarded.send = (text) => {
      if (this.closing || this.closed) return;
      const message = parse(text);
      const key = requestKey(message);
      if (message.id !== undefined) {
        if (this.callerIds.has(key)) return this.refuse(message, FAILED, false);
        this.callerIds.set(key, message);
      }
      this.commands.set(key, message);
      if (
        (this.quarantined.has(message.sessionId) && !RECOVERS.has(message.method)) ||
        (contentRead(message.method) && this.errorDocument(message.sessionId, message.method))
      )
        this.unsafe.add(message);
      if (contentRead(message.method)) this.pendingContent.add(message);
      if (
        (this.blocked.has(message.sessionId) || this.gone.has(message.sessionId)) &&
        !(
          this.blocked.has(message.sessionId) &&
          (OBSERVED.has(message.method) || message.method === 'Page.captureScreenshot')
        )
      )
        return this.refuse(message);
      this.queue(
        `send:${message.sessionId ?? ''}`,
        async () => {
          if (this.finished.has(message) || !this.owns(message)) return;
          if (
            this.unsafeContent(message) &&
            (this.errorDocument(message.sessionId, message.method) ||
              !this.ownedBlank(message.sessionId))
          )
            return this.refuse(message);
          if (!(await this.proveContent(message))) return this.refuse(message);
          if (this.unsafeContent(message)) return this.refuse(message);
          const why = await this.check(message);
          if (this.finished.has(message) || !this.owns(message)) return;
          if (why) return this.refuse(message, why);
          return this.sendChecked(message);
        },
        (error) => {
          console.warn(`the CDP guard refused a command: ${error.message}`);
          this.refuse(message, FAILED);
        }
      );
    };
    guarded.close = () => {
      if (this.closing || this.closed) return;
      this.closing = true;
      guarded.send = () => {};
      guarded.onmessage = null;
      const pending = [...this.navs.values()].filter((nav) => nav.closeScrub);
      if (!pending.length && !this.evidence.size) {
        this.closed = true;
        return connection.close();
      }
      let timer;
      const finish = () => {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(timer);
        for (const nav of this.navs.values()) nav.wiped?.();
        connection.close();
      };
      timer = setTimeout(finish, CLOSE_MS);
      timer.unref?.();
      const settled = () => {
        if (this.closed || !this.evidence.size) return finish();
        void Promise.allSettled([...this.evidence]).then(settled);
      };
      void Promise.allSettled(pending.map((nav) => nav.closeScrub?.())).then(settled);
    };
    return guarded;
  }
}

const framed = (tree) =>
  tree?.frame ? [tree.frame, ...(tree.childFrames ?? []).flatMap((child) => framed(child))] : [];

export function guardProtected(connection, own, tabs = new Map()) {
  return new Guard(connection, own, tabs).start();
}
