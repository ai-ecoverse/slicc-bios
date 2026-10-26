const families = [
  ['noopener', /noopener|sign-in tabs and their lineage/],
  ['framed-vault', /the guard keeps seven/],
  ['real-extension', /real slicc-extension.*opaque origin/],
  ['popup-driving', /a tab created through the guard with an empty URL/],
  ['link-worlds', /kernel facade and slicc-cli link drive ordinary tabs/],
  ['wipe-driving', /wipes in place to the blocked data page/],
  ['redirect-observers', /redirect to seven or the vault/],
  ['shared-vectors', /the shared guard vectors|the shared set is complete/],
];
const numeric = (value) => (Number.isFinite(value) ? value : null);
const methodNames = new Set([
  'Runtime.evaluate',
  'Target.attachToTarget',
  'Page.createIsolatedWorld',
  'Page.getFrameTree',
  'Page.navigate',
  'Page.captureScreenshot',
  'DOM.getDocument',
  'Accessibility.getFullAXTree',
]);

const familyNames = new Set([...families.map(([name]) => name), 'selected-parent-or-child']);
const failureNames = new Set([
  'guard-refusal',
  'bounded-deadline',
  'module-unavailable',
  'assertion',
  'test-code-failure',
]);

export function canonicalRecord(value) {
  if (value?.point === 'summary')
    return {
      point: 'summary',
      tests: numeric(value.tests),
      passed: numeric(value.passed),
      failed: numeric(value.failed),
      cancelled: numeric(value.cancelled),
      skipped: numeric(value.skipped),
    };
  if (value?.point !== 'test.result' || !familyNames.has(value.family)) return null;
  return {
    point: 'test.result',
    family: value.family,
    status: ['pass', 'fail', 'not-run'].includes(value.status) ? value.status : 'not-run',
    elapsed: numeric(value.elapsed),
    line: numeric(value.line),
    column: numeric(value.column),
    reason: failureNames.has(value.reason) ? value.reason : null,
    method: methodNames.has(value.method) ? value.method : null,
    timeoutMs: numeric(value.timeoutMs),
  };
}

export function failureKind(error) {
  const value = [error?.message, error?.cause?.message]
    .filter((item) => typeof item === 'string')
    .join('\n');
  const method = value.match(/\b([A-Z][A-Za-z]+\.[A-Za-z]+):/)?.[1];
  return {
    reason: /slicc: refused:/.test(value)
      ? 'guard-refusal'
      : /no answer in|timed out|testTimeout|timeout/i.test(value)
        ? 'bounded-deadline'
        : /MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(value)
          ? 'module-unavailable'
          : /ERR_ASSERTION|Expected values|Expected.*equal|assertion/i.test(value)
            ? 'assertion'
            : 'test-code-failure',
    method: methodNames.has(method) ? method : null,
    timeoutMs: numeric(
      Number(value.match(/(?:no answer in|timed out after)\s+(\d+)/)?.[1]) || null
    ),
  };
}

export function safeEvent(event) {
  const data = event.data ?? {};
  if (event.type === 'test:summary') {
    const counts = data.counts ?? {};
    return {
      point: 'summary',
      tests: numeric(counts.tests),
      passed: numeric(counts.passed),
      failed: numeric(counts.failed),
      cancelled: numeric(counts.cancelled),
      skipped: numeric(counts.skipped),
    };
  }
  if (event.type !== 'test:pass' && event.type !== 'test:fail') return null;
  const family =
    families.find(([, pattern]) => pattern.test(data.name ?? ''))?.[0] ??
    'selected-parent-or-child';
  if (data.skip && family === 'selected-parent-or-child') return null;
  return {
    point: 'test.result',
    family,
    status: data.skip ? 'not-run' : event.type === 'test:pass' ? 'pass' : 'fail',
    elapsed: numeric(data.details?.duration_ms),
    line: numeric(data.line),
    column: numeric(data.column),
    ...(event.type === 'test:fail' ? failureKind(data.details?.error) : {}),
  };
}

export default async function* reporter(source) {
  for await (const event of source) {
    const safe = safeEvent(event);
    if (safe) yield `${JSON.stringify(canonicalRecord(safe))}\n`;
  }
}
