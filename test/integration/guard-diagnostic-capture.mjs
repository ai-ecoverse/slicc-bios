import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { originOnly } from '../../src/seed/guard-diagnostic.js';

const directory = process.env.SLICC_GUARD_DIAGNOSTIC_DIR;
const file = directory ? join(directory, 'decisions.ndjson') : null;
if (directory) mkdirSync(directory, { recursive: true });
let pages = 0;
let records = 0;

export function diagnosticEnabled() {
  return Boolean(file);
}

const text = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);
const allowedText = {
  point: new Set([
    'instance',
    'answer.attach',
    'deliver',
    'privateCall.answer',
    'privateCall.timeout',
    'refuse',
    'pass.hidden',
    'pass.generation',
    'cut',
    'invalidate',
    'checkDocument',
    'checkDocument.read',
    'checkDocument.reject',
    'checkDocument.accept',
    'arm',
    'verify.read',
    'verify.uninitialized',
    'verify.reject',
    'inspect.verify',
    'inspect.metadata',
    'inspect.accept',
    'blank',
    'network',
    'paused',
    'targetEvent',
    'metadata.mask',
    'event.pause',
    'event',
    'reply.revalidate',
    'answer',
    'documentCheck',
    'check',
    'check.world',
    'check.plainly',
    'check.guarding',
    'reaching',
  ]),
  reason: new Set([
    'start',
    'provider-error',
    'receipt-or-final-gate',
    'rpc-error',
    'bounded-deadline',
    'protected',
    'failed',
    'unguarded',
    'other-policy',
    'protected-or-unavailable-surface',
    'unclassified-frame-observation',
    'no-private-navigation',
    'private-navigation-unavailable',
    'rpc-error-or-deadline',
    'tree-answer',
    'unclassified-tree',
    'owner-changed',
    'revision-changed',
    'proof-changed',
    'content-positive',
    'metadata-positive',
    'setup-step-error-or-timeout',
    'private-navigation-ready',
    'existing-initial-completeness-retry',
    'protected-tree',
    'positive',
    'unconfirmed',
    'initial-metadata-unavailable',
    'positive-attachment',
    'target-info-or-initial-navigation-unavailable',
    'target-protected-or-navigation-unavailable',
    'awaiting-request-classification',
    'private-request-continuation',
    'receipt-or-generation-settlement',
    'private-request-settlement',
    'private-session-event',
    'attachment-withheld',
    'title-unconfirmed-or-mismatched',
    'hidden-session-settlement',
    'hidden-session',
    'foreign-extension-world',
    'protected-navigation-or-context',
    'content-receipt-or-generation',
    'runtime-not-subscribed',
    'stored-policy',
    'named-private-url',
    'page-not-subscribed',
    'original-source-unavailable-or-revoked',
    'fresh-scope-unconfirmed',
    'closed-or-failed-live-source-revalidation',
    'unconfirmed-document-scope',
    'fetch-needs-session',
    'inherited-navigation',
    'world-policy',
    'session-url-or-unsafe-policy',
    'private-arming-unavailable',
    'protected-target',
    'protected-or-unknown-frame',
  ]),
  classification: new Set(['retired', 'protected', 'ordinary', 'unconfirmed']),
  treeKind: new Set([
    'missing-frame-id',
    'protected',
    'uninitialized',
    'missing-or-invalid-url',
    'malformed-classification-field',
    'invalid-unreachable-url',
    'unknown-error-document',
    'duplicate-frame-id',
    'malformed-children',
    'bounded-tree-limit',
    'ordinary',
  ]),
};
const numeric = (value) => (Number.isFinite(value) ? value : null);
const cases = [
  [/real slicc-extension/, 'real-extension-opaque'],
  [/guard keeps seven/, 'framed-vault-parent'],
  [/directory it cannot write/, 'readonly-driving'],
  [/guard setup step/, 'slow-title-listing'],
  [/srcdoc editors/, 'opaque-srcdoc-editors'],
  [/sign-in tabs and their lineage/, 'sign-in-noopener'],
  [/redirect to seven or the vault/, 'redirect-observers'],
  [/shared guard vectors/, 'shared-vectors'],
];

function safeRecord(record) {
  const safe = {};
  for (const key of ['point', 'reason', 'classification', 'treeKind'])
    safe[key] = allowedText[key].has(record[key]) ? record[key] : null;
  safe.method = text(
    record.method,
    /^(?:Target|Runtime|Page|Network|Fetch|DOM|DOMSnapshot|CSS|Accessibility|Input|LayerTree|IO|Log|Console|Audits|ServiceWorker|Storage|CacheStorage|IndexedDB|DOMStorage|Profiler|HeapProfiler|Performance|HeadlessExperimental)\.[A-Za-z]{1,90}$/
  );
  for (const key of ['target', 'session', 'frame', 'loader'])
    safe[key] = text(record[key], /^(?:target|session|frame|loader)-\d+$/);
  for (const key of [
    'instance',
    'sequence',
    'elapsed',
    'revision',
    'checked',
    'classified',
    'proof',
    'opening',
    'reading',
    'planned',
    'rpcElapsed',
    'limit',
    'errorCode',
    'row',
  ])
    safe[key] = numeric(record[key]);
  for (const key of [
    'transport',
    'shown',
    'blocked',
    'armed',
    'navFailed',
    'privateSessionPresent',
    'privateNavigationTaken',
    'rootMatchesTarget',
    'loaderPresent',
    'sourceAlive',
  ])
    safe[key] = typeof record[key] === 'boolean' ? record[key] : null;
  safe.origins = Array.isArray(record.origins)
    ? record.origins
        .filter((value) => typeof value === 'string' && originOnly(value) === value)
        .slice(0, 8)
    : [];
  return safe;
}

export function saveDiagnostic(record, page, group) {
  if (!file || records++ >= 200000) return;
  const safe = {
    file: basename(process.env.SLICC_GUARD_DIAGNOSTIC_FILE ?? 'unknown'),
    page,
    group,
    ...safeRecord(record),
  };
  appendFileSync(file, `${JSON.stringify(safe)}\n`);
}

export async function exposeDiagnostic(opened, t) {
  if (!file) return;
  const page = ++pages;
  const group = cases.find(([pattern]) => pattern.test(t.name))?.[1] ?? 'other-selected-row';
  await opened.expose('__sliccGuardDiagnostic', (record) => saveDiagnostic(record, page, group));
  await opened.init(() => {
    globalThis.sliccGuardDiagnostic = (record) =>
      globalThis.__sliccGuardDiagnostic(JSON.stringify(record));
  });
}

export function saveVector(row) {
  if (!file) return;
  appendFileSync(
    file,
    `${JSON.stringify({ file: basename(process.env.SLICC_GUARD_DIAGNOSTIC_FILE ?? 'unknown'), point: 'vector.result', id: text(row.id, /^[A-Z]\d+\.[a-z-]{1,90}$/), targetKind: text(row.target, /^[a-z-]{1,50}$/), transport: text(row.transport, /^(?:proxy|extension|link)$/), variant: text(row.variant, /^(?:prompt|lagging)$/), control: text(row.control, /^(?:pass|fail|skip)$/), guarded: text(row.guarded, /^(?:pass|fail|skip)$/), live: text(row.live, /^(?:pass|fail|skip)$/) })}\n`
  );
}
