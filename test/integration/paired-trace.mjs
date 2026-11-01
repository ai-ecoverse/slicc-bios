import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const traced = new Set();
const outcomes = new Map();
let halted = false;

function runtime() {
  const boot = crypto.randomUUID();
  const rows = [];
  const retries = [];
  const stats = { calls: 0, admitted: 0, refused: 0, bound: 0, interrupted: 0 };
  let seq = 0;
  const url = (value) => {
    if (typeof value !== 'string' || !value) return '';
    try {
      const parsed = new URL(value);
      const path = /^\/recovery-(seed|hop|destination)\.html$|^\/vault$/.test(parsed.pathname)
        ? parsed.pathname
        : '';
      return parsed.origin === 'null' ? `${parsed.protocol}//` : `${parsed.origin}${path}`;
    } catch {
      return 'opaque';
    }
  };
  const site = (error) =>
    String(error?.stack ?? '')
      .split('\n')
      .slice(1, 8)
      .map((line) => line.match(/at ([\w.]+)/)?.[1])
      .filter(Boolean);
  const reason = (error) => {
    const value = String(error?.message ?? error ?? '');
    if (value === "slicc: refused: target is on seven's origin") return 'origin-refusal';
    if (value.includes('navigation not settled')) return 'unsettled';
    return value.includes('slicc: refused:') ? 'other-refusal' : 'other';
  };
  const record = (name, data = {}) => {
    seq += 1;
    if (rows.length < 12000) rows.push({ seq, at: Date.now(), site: name, ...data });
  };
  const tab = (value) => ({
    tabId: value?.id,
    url: url(value?.url),
    pendingUrl: url(value?.pendingUrl),
    status: value?.status,
  });
  globalThis.__pairedTrace = { boot, rows, retries, stats, url, site, reason, record, tab };
  record('worker-start');
  return globalThis.__pairedTrace;
}

function swap(source, marker, replacement) {
  assert.equal(source.split(marker).length, 2, `unique telemetry site ${marker.slice(0, 60)}`);
  return source.replace(marker, replacement);
}

export async function traceExtension(root) {
  if (traced.has(root)) return;
  traced.add(root);
  const path = join(root, 'cdp.js');
  let source = await readFile(path, 'utf8');
  if (source.startsWith('const pairedTrace =')) return;
  source = `const pairedTrace = (${runtime.toString()})();\n${source}`;
  source = swap(
    source,
    '    this.closed = false;',
    `    this.closed = false;
    this.pairedId = crypto.randomUUID();
    if (typeof this.retryTab === 'function') {
      const originalRetry = this.retryTab.bind(this);
      this.retryTab = async (...args) => {
        const row = {connection:this.pairedId,tabId:args[0],at:Date.now(),pageUrl:pairedTrace.url(args[1]?.pageUrl),initialSite:pairedTrace.site(args[2])};
        pairedTrace.stats.calls += 1;
        pairedTrace.retries.push(row);
        try {
          const answer = await originalRetry(...args);
          row.outcome = 'admitted';
          pairedTrace.stats.admitted += 1;
          return answer;
        } catch (error) {
          row.outcome = 'refused';
          row.reason = pairedTrace.reason(error);
          pairedTrace.stats.refused += 1;
          throw error;
        } finally {
          row.ms = Date.now() - row.at;
          if (row.outcome === 'refused') {
            row.ending = row.ms >= 240 ? 'bound' : 'interrupted';
            pairedTrace.stats[row.ending] += 1;
          }
        }
      };
    }`
  );
  source = swap(
    source,
    "    const tab = await bounded(api.tabs.get(tabId), 2000, 'live tab');",
    "    const tab = await bounded(api.tabs.get(tabId), 2000, 'live tab');\n    pairedTrace.record('tab-read', pairedTrace.tab(tab));"
  );
  source = swap(
    source,
    '  if (blocked(url, opener)) refusal();',
    `  if (blocked(url, opener)) {
    pairedTrace.record('demand-url', {...pairedTrace.tab(tab),opener});
    refusal();
  }`
  );
  source = swap(
    source,
    '  if (pending && pending !== url && blocked(pending, opener, guard.url(url))) refusal();',
    `  if (pending && pending !== url && blocked(pending, opener, guard.url(url))) {
    pairedTrace.record('demand-pending', {...pairedTrace.tab(tab),opener});
    refusal();
  }`
  );
  source = swap(
    source,
    '    const entry = history?.entries?.[history.currentIndex];',
    "    const entry = history?.entries?.[history.currentIndex];\n    pairedTrace.record('history-read',{tabId,url:pairedTrace.url(entry?.url)});"
  );
  source = swap(
    source,
    '  watchFrame(tabId, tab, frame) {',
    `  watchFrame(tabId, tab, frame) {
    if (!frame.parentId) pairedTrace.record('root-commit',{tabId,url:pairedTrace.url(frame.url),securityOrigin:pairedTrace.url(frame.securityOrigin),unreachableUrl:pairedTrace.url(frame.unreachableUrl),loaderId:frame.loaderId,failed:this.state.failed.has(tabId)});`
  );
  source = swap(
    source,
    '  async run(message) {',
    "  async run(message) {\n    pairedTrace.record('command-start',{connection:this.pairedId,id:message.id,method:message.method,sessionId:message.sessionId});"
  );
  source = swap(
    source,
    '      this.post({ id: message.id, error: String(error?.message ?? error) });',
    "      pairedTrace.record('command-error',{connection:this.pairedId,id:message.id,method:message.method,sessionId:message.sessionId,reason:pairedTrace.reason(error),stack:pairedTrace.site(error)});\n      this.post({ id: message.id, error: String(error?.message ?? error) });"
  );
  await writeFile(path, source);
}

export async function armGuard(real) {
  const source = await readFile(new URL('../../src/seed/guard.js', import.meta.url), 'utf8');
  const marker = '  refuse(command, message = PROTECTED, release = true) {';
  real.overrides.set(
    '/seed/guard.js',
    'globalThis.__pairedGuardLoaded = true;\n' +
      swap(
        source,
        marker,
        `${marker}
    const rows = (globalThis.__pairedGuard ??= []);
    if (rows.length < 2000) rows.push({at:Date.now(),id:command?.id,method:command?.method,sessionId:command?.sessionId,release,caller:new Error().stack.split('\\n').slice(1,7).map(line=>line.match(/at ([\\w.]+)/)?.[1]).filter(Boolean)});`
      )
  );
}

async function workerTrace(real) {
  const { targetInfos } = await real.cdp.send('Target.getTargets');
  const worker = targetInfos.find(
    (target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension:')
  );
  assert.ok(worker, 'diagnostic worker exists');
  const { sessionId } = await real.cdp.send('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  });
  try {
    const answer = await real.cdp.send(
      'Runtime.evaluate',
      {
        expression:
          '(() => {const t=globalThis.__pairedTrace;return t?{boot:t.boot,rows:t.rows,retries:t.retries,stats:t.stats,saturated:t.rows.length>=12000}:null})()',
        returnByValue: true,
      },
      sessionId
    );
    assert.equal(answer.exceptionDetails, undefined, 'diagnostic worker evaluation');
    assert.ok(answer.result?.value, 'diagnostic counters exist');
    return answer.result.value;
  } finally {
    await real.cdp.send('Target.detachFromTarget', { sessionId });
  }
}

export function stopped() {
  return halted;
}

export async function finishPair(real, page, evidence, label, passed) {
  let timer;
  const collected = await Promise.race([
    Promise.all([
      workerTrace(real),
      evidence.report(label.scenario),
      page.evaluate(() => ({
        loaded: globalThis.__pairedGuardLoaded === true,
        rows: globalThis.__pairedGuard ?? [],
      })),
    ]),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('diagnostic collection exceeded 15s')), 15000);
    }),
  ]).finally(() => clearTimeout(timer));
  const [trace, protocol, guard] = collected;
  assert.equal(guard.loaded, true, 'guard telemetry executed');
  assert.equal(protocol.installed, true, 'seed CDP telemetry installed');
  assert.ok(protocol.rows.length > 0, 'seed CDP telemetry executed');
  assert.equal(trace.saturated, false, 'diagnostic rows were not capped');
  const firstRefusal = protocol.rows.find(
    (row) => row.side === 'cli' && row.channel === 4 && row.direction === 'receive' && row.error
  );
  const result = {
    ...label,
    passed,
    reportedCdpVersion: protocol.reportedCdpVersion,
    retry: trace.stats,
    retries: trace.retries,
    firstRefusal,
    firstRefusalSite: firstRefusal
      ? guard.rows.findLast(
          (row) => row.id === firstRefusal.id && row.method === firstRefusal.method
        )
      : undefined,
    firstExtensionRefusal: trace.rows.find((row) => row.site === 'command-error'),
    summary: protocol.summary,
    workerBoot: trace.boot,
    extensionRows: trace.rows.length,
    protocolRows: protocol.rows.length,
  };
  console.log('PAIRED_RESULT', JSON.stringify(result));
  for (const row of trace.rows)
    console.log('PAIRED_EXTENSION', JSON.stringify({ ...label, ...row }));
  for (const row of guard.rows) console.log('PAIRED_GUARD', JSON.stringify({ ...label, ...row }));
  for (const row of protocol.rows)
    console.log('PAIRED_PROTOCOL', JSON.stringify({ ...label, ...row }));
  const key = `${label.repeat}:${label.scenario}`;
  const pair = outcomes.get(key) ?? {};
  pair[label.side] = result;
  outcomes.set(key, pair);
  if (
    pair.baseline?.passed &&
    pair.candidate &&
    !pair.candidate.passed &&
    pair.candidate.retry.calls > 0
  ) {
    halted = true;
    console.log(
      'PAIRED_STOP',
      JSON.stringify({ key, baseline: pair.baseline, candidate: pair.candidate })
    );
  }
}
