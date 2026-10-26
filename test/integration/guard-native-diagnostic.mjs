import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const points = new Set([
  'instance',
  'rpc',
  'tree-admitted',
  'cleanup-start',
  'cleanup-verified',
  'attachment',
  'context',
]);
const kinds = new Set([
  'missing',
  'invalid',
  'ordinary',
  'protected',
  'opaque-error',
  'blanked',
  'data',
  'blank',
  'browser',
  'other',
]);
const methods = new Set([
  'Page.getFrameTree',
  'Page.navigate',
  'Runtime.evaluate',
  'Target.attachToTarget',
  'Target.getTargetInfo',
]);
const flags = new Set(['ok', 'error', 'missing', 'protected', 'unknown', 'rejected']);
const numbers = new Set([
  'guard',
  'frame',
  'session',
  'revision',
  'checked',
  'frames',
  'errors',
  'unknowns',
  'protectedFrames',
  'elapsed',
]);
const booleans = new Set([
  'current',
  'ackFrame',
  'subscribed',
  'verified',
  'published',
  'positive',
]);

export function sanitize(record) {
  if (!record || !points.has(record.point)) return null;
  const output = { point: record.point };
  if (methods.has(record.method)) output.method = record.method;
  for (const key of ['kind', 'rootKind', 'valueKind'])
    if (kinds.has(record[key])) output[key] = record[key];
  if (flags.has(record.outcome)) output.outcome = record.outcome;
  for (const key of numbers)
    if (Number.isFinite(record[key]) && Math.abs(record[key]) < 1e12) output[key] = record[key];
  for (const key of booleans) if (typeof record[key] === 'boolean') output[key] = record[key];
  for (const key of ['origin', 'valueOrigin']) {
    if (typeof record[key] !== 'string') continue;
    try {
      const url = new URL(record[key]);
      if (
        ['http:', 'https:'].includes(url.protocol) &&
        url.origin === record[key] &&
        !url.username &&
        !url.password
      )
        output[key] = url.origin;
    } catch {}
  }
  return output;
}

export function captureRecord(record) {
  const safe = sanitize(record);
  if (!safe || !process.env.SLICC_GUARD_DIAGNOSTIC_TRACE) return;
  mkdirSync(dirname(process.env.SLICC_GUARD_DIAGNOSTIC_TRACE), { recursive: true });
  appendFileSync(process.env.SLICC_GUARD_DIAGNOSTIC_TRACE, `${JSON.stringify(safe)}\n`);
}

const browser = String.raw`
const __guardDiagIds = new Map();
const __guardDiagGuards = new WeakMap();
const __guardDiagId = (value) => {
  if (value === undefined || value === null) return 0;
  if (!__guardDiagIds.has(value)) __guardDiagIds.set(value, __guardDiagIds.size + 1);
  return __guardDiagIds.get(value);
};
const __guardDiagKind = (value) => {
  if (typeof value !== 'string' || !value) return 'missing';
  if (value === BLANKED) return 'blanked';
  if (value === ERROR_PAGE) return 'opaque-error';
  if (!URL.canParse(value)) return 'invalid';
  if (value.startsWith('data:')) return 'data';
  if (value.startsWith('about:')) return 'blank';
  if (value.startsWith('chrome:') || value.startsWith('chrome-untrusted:')) return 'browser';
  return /^https?:/.test(value) ? 'ordinary' : 'other';
};
const __guardDiagOrigin = (value) => {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : undefined;
  } catch { return undefined; }
};
const __guardDiag = (guard, record) => {
  if (!__guardDiagGuards.has(guard)) __guardDiagGuards.set(guard, __guardDiagId(guard));
  try { globalThis.__biosGuardDiagnostic?.(JSON.stringify({ guard: __guardDiagGuards.get(guard), ...record })); } catch {}
};
const __guardDiagRPC = (guard, method, params, sessionId, message) => {
  if (!['Page.getFrameTree', 'Page.navigate', 'Runtime.evaluate', 'Target.attachToTarget', 'Target.getTargetInfo'].includes(method)) return;
  if (method === 'Runtime.evaluate' && params.expression !== 'location.href') return;
  const record = { point: 'rpc', method, session: __guardDiagId(sessionId), outcome: message.error ? 'error' : message.result ? 'ok' : 'missing' };
  if (method === 'Page.getFrameTree') {
    let all = [];
    try { all = framed(message.result?.frameTree); } catch {}
    record.frames = all.length;
    record.rootKind = __guardDiagKind(all[0]?.url);
    record.errors = all.filter((frame) => frame.url === ERROR_PAGE).length;
    record.unknowns = all.filter((frame) => !guard.knownFrame(frame) && !guard.opaqueError(frame)).length;
    record.protectedFrames = all.filter((frame) => guard.is.url(guard.framed(frame)) && !guard.opaqueError(frame)).length;
    record.origin = __guardDiagOrigin(all[0]?.url);
  }
  if (method === 'Page.navigate') {
    record.frame = __guardDiagId(params.frameId);
    record.kind = __guardDiagKind(params.url);
    record.ackFrame = message.result?.frameId === params.frameId;
    if (message.result?.errorText) record.outcome = 'error';
  }
  if (method === 'Runtime.evaluate') {
    record.valueKind = __guardDiagKind(message.result?.result?.value);
    record.valueOrigin = __guardDiagOrigin(message.result?.result?.value);
    if (message.result?.exceptionDetails) record.outcome = 'error';
  }
  __guardDiag(guard, record);
};
`;

function replace(source, oldText, newText) {
  if (source.split(oldText).length !== 2) throw new Error('diagnostic patch anchor unavailable');
  return source.replace(oldText, newText);
}

export function instrument(root = process.cwd()) {
  const guardPath = resolve(root, 'src/seed/guard.js');
  const chromePath = resolve(root, 'test/integration/chrome.mjs');
  const originalGuard = readFileSync(guardPath, 'utf8');
  const originalChrome = readFileSync(chromePath, 'utf8');
  let guard = originalGuard;
  guard = replace(
    guard,
    "import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };",
    "import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };"
  );
  guard += browser;
  guard = replace(
    guard,
    '    this.guarded = { onmessage: null, onclose: null };',
    "    this.guarded = { onmessage: null, onclose: null };\n    __guardDiag(this, { point: 'instance' });"
  );
  guard = replace(
    guard,
    '        clearTimeout(timer);\n        resolve(message.error',
    '        clearTimeout(timer);\n        __guardDiagRPC(this, method, params, sessionId, message);\n        resolve(message.error'
  );
  guard = replace(
    guard,
    '    state.url = all[0].url;',
    "    state.url = all[0].url;\n    __guardDiag(this, { point: 'tree-admitted', revision, checked: state.checked, frames: all.length, rootKind: __guardDiagKind(all[0].url), origin: __guardDiagOrigin(all[0].url) });"
  );
  guard = replace(
    guard,
    '    this.invalidate(nav.targetId);\n    const answer',
    "    __guardDiag(this, { point: 'cleanup-start', frame: __guardDiagId(frame.id), session: __guardDiagId(owner.session), kind: __guardDiagKind(frame.url), current: this.navs.get(nav.targetId) === nav });\n    this.invalidate(nav.targetId);\n    const answer"
  );
  guard = replace(
    guard,
    '    this.checked(nav.targetId, fresh, revision);\n    return true;',
    "    this.checked(nav.targetId, fresh, revision);\n    __guardDiag(this, { point: 'cleanup-verified', frame: __guardDiagId(frame.id), revision, frames: fresh.length, positive: true, current: this.navs.get(nav.targetId) === nav });\n    return true;"
  );
  guard = replace(
    guard,
    '    if (verified !== true) {',
    "    __guardDiag(this, { point: 'attachment', session: __guardDiagId(sessionId), outcome: verified === true ? 'ok' : verified === PROTECTED ? 'protected' : 'rejected', revision: this.documents.get(targetId)?.revision, checked: this.documents.get(targetId)?.checked });\n    if (verified !== true) {"
  );
  guard = replace(
    guard,
    '    this.world(message.sessionId).notified.get(message.params.context.id).verified = true;',
    "    this.world(message.sessionId).notified.get(message.params.context.id).verified = true;\n    __guardDiag(this, { point: 'context', session: __guardDiagId(message.sessionId), frame: __guardDiagId(message.params.context.auxData?.frameId), subscribed: this.runtimes.has(message.sessionId), verified: true, published: this.world(message.sessionId).notified.get(message.params.context.id)?.published === true, kind: __guardDiagKind(this.contextURL(message)) });"
  );
  let chrome = "import { captureRecord } from './guard-native-diagnostic.mjs';\n" + originalChrome;
  chrome = replace(
    chrome,
    '    const opened = await page(t);',
    "    const opened = await page(t);\n    await opened.expose('__biosGuardDiagnostic', captureRecord);"
  );
  writeFileSync(guardPath, guard);
  writeFileSync(chromePath, chrome);
  return () => {
    writeFileSync(guardPath, originalGuard);
    writeFileSync(chromePath, originalChrome);
  };
}
