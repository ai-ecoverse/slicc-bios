export const RECORDS = 500;
export const DETAIL_CHARS = 1000;
export const NAME_CHARS = 200;
export const TIMEOUT_MS = 30_000;
export const RELINK_MS = 3000;
export const FRAME = 'preview-frame';
export const LOADER = 'preview-loader';
export const GONE = "the visitor's tab is gone";
export const LATE = "the visitor's tab didn't answer within 30 s";
export const NO_BROWSER = "a preview bridge can't open or close the visitor's browser";
export const OBJECT_GONE =
  "the object is gone from the visitor's page (it navigated, or the handle was released)";
export const NOT_NODE = 'the object is not a DOM node';
export const NO_PROPERTIES = "the object's properties can't be read";
export const NO_DESCRIPTION = "the node can't be described";
export const NO_NODE_IDS =
  'the preview bridge has no DOM node ids; describe a node by its objectId';
export const BY_BACKEND = 'the preview bridge resolves nodes by backendNodeId only';
export const NO_HUB = "seven isn't connected to the tray hub";
export const NO_TARGET = 'No target with given id found';
export const STALE = 'the tray hub no longer had it after seven reconnected';
export const HANDLE = '7';
export const PREVIEW_ROUTE = { kind: 'preview' };
export const TARGET_PREFIX = 'preview:';
export const WEBHOOK = /^serve-[0-9a-f]{16}$/;
export const LIFECYCLE = 'x-slicc-preview-lifecycle';
export const CONN_HEADER = 'x-slicc-preview-conn';
export const TOKEN_HEADER = 'x-slicc-preview-token';

const REGISTRY = `const R = (globalThis[Symbol.for('seven.bridge')] ??= { h: new Map(), n: 0, nodes: new Map(), ids: new WeakMap(), b: 0 }); const keep = (v) => { const id = String(++R.n); R.h.set(id, v); return id; }; const get = (id) => { if (!R.h.has(id)) throw new Error('seven: gone'); return R.h.get(id); }; const node = (b) => { if (!R.nodes.has(b)) throw new Error('seven: gone'); return R.nodes.get(b); }; const bid = (n) => { let b = R.ids.get(n); if (b === undefined) { b = ++R.b; R.ids.set(n, b); R.nodes.set(b, n); } return b; }; const desc = (v) => { const t = typeof v; const o = v !== null && (t === 'object' || t === 'function'); return { t, s: v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof Error ? 'error' : typeof Node !== 'undefined' && v instanceof Node ? 'node' : undefined, c: o && v.constructor ? v.constructor.name : undefined, d: o ? String(v).slice(0, 1000) : undefined, v: v === null || t === 'string' || t === 'boolean' || (t === 'number' && Number.isFinite(v) && !Object.is(v, -0)) ? v : undefined, u: t === 'bigint' ? v + 'n' : t === 'number' && Object.is(v, -0) ? '-0' : t === 'number' && !Number.isFinite(v) ? String(v) : undefined, h: o ? keep(v) : undefined }; }; const plain = (v) => { const t = typeof v; if (t === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) return { t, u: Object.is(v, -0) ? '-0' : String(v) }; if (t === 'bigint') return { t, u: v + 'n' }; if (t === 'undefined' || t === 'function' || t === 'symbol') return { t }; return { t, v, s: v === null ? 'null' : Array.isArray(v) ? 'array' : undefined }; };`;

const text = (value, key) => (typeof value?.[key] === 'string' ? value[key] : '');
const literal = (source) => JSON.stringify(String(source ?? ''));
const wrap = (body) => `(() => { ${REGISTRY} ${body} })()`;
const finish = (byValue) => (byValue ? 'plain' : 'desc');

export const handleId = (world, page) => `${HANDLE}.${world}.${page}`;
const HANDLED = /^7\.(\d+)\.(\d+)$/;
export const isHandle = (objectId) => typeof objectId === 'string' && HANDLED.test(objectId);

export function pageId(world, objectId) {
  const found = typeof objectId === 'string' ? HANDLED.exec(objectId) : null;
  return found && Number(found[1]) === world ? found[2] : null;
}

export function evaluateExpression(source, byValue) {
  return wrap(
    `return Promise.resolve((0, eval)(${literal(source)})).then((v) => JSON.stringify(${finish(byValue)}(v)));`
  );
}

const NUMBERS = new Set(['NaN', 'Infinity', '-Infinity', '-0']);

export function argument(conn, arg) {
  if (typeof arg?.objectId === 'string') {
    const page = pageId(conn, arg.objectId);
    return page === null ? null : `get(${literal(page)})`;
  }
  if (typeof arg?.unserializableValue === 'string') {
    const value = arg.unserializableValue;
    if (NUMBERS.has(value)) return value;
    return /^-?\d+n$/.test(value) ? `BigInt(${literal(value.slice(0, -1))})` : null;
  }
  return arg && 'value' in arg ? JSON.stringify(arg.value) : 'undefined';
}

export function callExpression(self, declaration, args, byValue) {
  const target = self === null ? 'undefined' : `get(${literal(self)})`;
  return wrap(
    `const self = ${target}; const args = [${args.join(', ')}]; return Promise.resolve((${declaration}).apply(self, args)).then((v) => JSON.stringify(${finish(byValue)}(v)));`
  );
}

export function propertiesExpression(page) {
  return wrap(
    `const o = get(${literal(page)}); return JSON.stringify(Object.getOwnPropertyNames(o).map((name) => { let v; try { v = o[name]; } catch (e) { v = undefined; } return { name, value: desc(v) }; }));`
  );
}

export function releaseExpression(pages) {
  return wrap(`for (const id of [${pages.map(literal).join(', ')}]) R.h.delete(id); return '[]';`);
}

export function describeExpression(page, backend) {
  const target =
    page !== null ? `get(${literal(page)})` : backend !== null ? `node(${backend})` : 'undefined';
  return wrap(
    `const n = ${target}; if (typeof Node === 'undefined' || !(n instanceof Node)) throw new Error('seven: not a node'); return JSON.stringify({ backendNodeId: bid(n), nodeType: n.nodeType, nodeName: n.nodeName, localName: n.localName || '', nodeValue: n.nodeValue || '', childNodeCount: n.childNodes ? n.childNodes.length : 0, attributes: n.attributes ? Array.from(n.attributes).flatMap((a) => [a.name, a.value]) : [] });`
  );
}

export function resolveExpression(backend) {
  return wrap(`return JSON.stringify(desc(node(${backend})));`);
}

function unpack(reply) {
  if (typeof reply?.result?.value !== 'string') return undefined;
  try {
    return JSON.parse(reply.result.value);
  } catch {
    return undefined;
  }
}

const failure = (code, message) => ({ error: { code, message } });
const ok = (result = {}) => ({ result });

function thrown(reply) {
  if (!reply?.exceptionDetails) return null;
  const said = `${text(reply.exceptionDetails, 'text')} ${text(reply.exceptionDetails.exception, 'description')}`;
  if (said.includes('seven: gone')) return failure(-32000, OBJECT_GONE);
  if (said.includes('seven: not a node')) return failure(-32000, NOT_NODE);
  return ok(reply);
}

const REMOTE = [
  ['s', 'subtype'],
  ['c', 'className'],
  ['d', 'description'],
  ['u', 'unserializableValue'],
];

export function remote(conn, found) {
  const kind = typeof found?.t === 'string' ? found.t : 'undefined';
  const out = { type: kind };
  for (const [from, to] of REMOTE)
    if (found?.[from] !== undefined && found[from] !== null) out[to] = found[from];
  if (out.unserializableValue === undefined && kind !== 'undefined') {
    if (found && 'v' in found) out.value = found.v;
    else if (found?.s === 'null') out.value = null;
  }
  if (typeof found?.h === 'string') out.objectId = handleId(conn, found.h);
  return out;
}

export const SHAPES = {
  raw: (_conn, reply) => ok(reply),
  remote(conn, reply) {
    const error = thrown(reply);
    if (error) return error;
    const found = unpack(reply);
    return found === undefined ? ok(reply) : ok({ result: remote(conn, found) });
  },
  properties(conn, reply) {
    const error = thrown(reply);
    if (error) return error.error ? error : failure(-32000, NO_PROPERTIES);
    const items = unpack(reply);
    return ok({
      result: (Array.isArray(items) ? items : []).map((item) => ({
        name: item?.name ?? null,
        value: remote(conn, item?.value),
        configurable: true,
        enumerable: true,
        writable: true,
        isOwn: true,
      })),
    });
  },
  describe(_conn, reply) {
    const error = thrown(reply);
    if (error) return error.error ? error : failure(-32000, NO_DESCRIPTION);
    const found = unpack(reply);
    if (!found || typeof found !== 'object' || Array.isArray(found))
      return failure(-32000, NO_DESCRIPTION);
    return ok({ node: { ...found, nodeId: 0 } });
  },
  resolve(conn, reply) {
    const error = thrown(reply);
    if (error) return error.error ? error : failure(-32000, OBJECT_GONE);
    const found = unpack(reply);
    return found === undefined ? failure(-32000, OBJECT_GONE) : ok({ object: remote(conn, found) });
  },
};

function evaluation(expression, params) {
  const sent = { expression };
  for (const key of ['awaitPromise', 'userGesture', 'timeout'])
    if (key in params) sent[key] = params[key];
  return { method: 'Runtime.evaluate', params: sent };
}

const backendOf = (params) =>
  Number.isSafeInteger(params.backendNodeId) && params.backendNodeId >= 0
    ? params.backendNodeId
    : null;

function called(conn, params, byValue) {
  const self = params.objectId === undefined ? null : pageId(conn, params.objectId);
  if (params.objectId !== undefined && self === null) return failure(-32000, OBJECT_GONE);
  const args = [];
  for (const arg of Array.isArray(params.arguments) ? params.arguments : []) {
    const made = argument(conn, arg);
    if (made === null) return failure(-32000, OBJECT_GONE);
    args.push(made);
  }
  const expression = callExpression(self, text(params, 'functionDeclaration'), args, byValue);
  return { ...evaluation(expression, params), shape: 'remote' };
}

const TRANSLATE = {
  'Runtime.evaluate': (conn, params, byValue) => ({
    ...evaluation(evaluateExpression(text(params, 'expression'), byValue), params),
    shape: 'remote',
  }),
  'Runtime.callFunctionOn': called,
  'Runtime.getProperties': (conn, params) => {
    const page = pageId(conn, params.objectId);
    if (page === null) return failure(-32000, OBJECT_GONE);
    return { ...evaluation(propertiesExpression(page), params), shape: 'properties' };
  },
  'DOM.describeNode': (conn, params) => {
    const backend = backendOf(params);
    const page = params.objectId === undefined ? null : pageId(conn, params.objectId);
    if (params.objectId !== undefined && page === null) return failure(-32000, OBJECT_GONE);
    if (page === null && backend === null) return failure(-32000, NO_NODE_IDS);
    return { ...evaluation(describeExpression(page, backend), params), shape: 'describe' };
  },
  'DOM.resolveNode': (_conn, params) => {
    const backend = backendOf(params);
    if (backend === null) return failure(-32000, BY_BACKEND);
    return { ...evaluation(resolveExpression(backend), params), shape: 'resolve' };
  },
};

export function translate(conn, method, params) {
  const byValue = params.returnByValue === true;
  const made = TRANSLATE[method]?.(conn, params, byValue);
  if (made) return made;
  if (isHandle(params.objectId))
    return failure(-32000, `the preview bridge can't pass a page object to ${method}`);
  return { method, params, shape: 'raw' };
}

export const EMIT_BYTES = 16 * 1024;
export const REPLY_BYTES = 25 * 1024 * 1024;
export const URL_CHARS = 2048;
export const CLAIM_CHARS = 512;
export const NO_ORIGIN = 'about:invalid';
export const TOO_BIG = `the visitor's answer is over ${REPLY_BYTES / 1024 / 1024} MiB, so seven refused it`;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const encoder = new TextEncoder();

export function json(value) {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return null;
  }
}

export const bytesOf = (textValue) => encoder.encode(textValue).byteLength;

export function cut(detail, size = DETAIL_CHARS) {
  const whole = json(detail);
  if (whole === null) return '"[unreadable]"';
  const chars = [...whole];
  return chars.length > size ? `${chars.slice(0, size).join('')}…` : whole;
}

export function claim(value, size = CLAIM_CHARS) {
  return typeof value === 'string' ? [...value.replace(CONTROLS, ' ')].slice(0, size).join('') : '';
}

export function originOf(value) {
  const parsed = typeof value === 'string' ? URL.parse(value) : null;
  return parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
    ? parsed.origin
    : NO_ORIGIN;
}

export function emitted(detail) {
  const whole = json(detail);
  if (whole !== null && bytesOf(whole) <= EMIT_BYTES) return { detail: detail ?? null };
  return { detail: whole === null ? null : cut(detail, EMIT_BYTES / 4), truncated: true };
}

export function nameOf(name) {
  if (typeof name === 'string') return claim(name, NAME_CHARS);
  return name === undefined ? '' : cut(name);
}

export function sessionName(random = () => crypto.getRandomValues(new Uint8Array(16))) {
  return [...random()]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export function targetId(tab, conn) {
  return `${TARGET_PREFIX}${tab.token}:${conn}`;
}

export function targetInfo(tab, conn, attached) {
  return {
    targetId: targetId(tab, conn),
    type: 'page',
    title: tab.title,
    url: tab.url,
    attached,
    canAccessOpener: false,
    browserContextId: 'preview',
  };
}

export function frameOf(tab) {
  return {
    id: FRAME,
    loaderId: LOADER,
    url: tab.url,
    securityOrigin: tab.origin,
    mimeType: 'text/html',
  };
}

const QUIET = new Set([
  'Page.enable',
  'DOM.enable',
  'DOM.disable',
  'Page.bringToFront',
  'Runtime.runIfWaitingForDebugger',
  'Target.setAutoAttach',
  'Inspector.enable',
  'Fetch.enable',
  'Fetch.disable',
  'Network.enable',
  'Network.disable',
  'Network.setBypassServiceWorker',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
]);
const COOKIES = new Set(['Network.getAllCookies', 'Network.getCookies', 'Storage.getCookies']);

export function synthetic(method, tab, conn) {
  if (QUIET.has(method)) return ok();
  if (COOKIES.has(method)) return ok({ cookies: [] });
  if (method === 'Page.getFrameTree')
    return ok({ frameTree: { frame: frameOf(tab), childFrames: [] } });
  if (method === 'Page.getNavigationHistory')
    return ok({
      currentIndex: 0,
      entries: [
        { id: 0, url: tab.url, userTypedURL: tab.url, title: tab.title, transitionType: 'link' },
      ],
    });
  if (method === 'Page.createIsolatedWorld') return ok({ executionContextId: tab.world });
  if (method === 'Target.getTargetInfo') return ok({ targetInfo: targetInfo(tab, conn, true) });
  return null;
}
