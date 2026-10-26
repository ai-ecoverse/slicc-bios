import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { argv } from 'node:process';

export function installGuardModes(row) {
  const methods = new Set([
    'Target.attachToTarget',
    'Target.getTargetInfo',
    'Target.getTargets',
    'Target.createTarget',
    'Target.closeTarget',
    'Target.detachFromTarget',
    'Page.getFrameTree',
    'Page.getResourceTree',
    'Page.captureScreenshot',
    'Page.navigate',
    'Page.reload',
    'Page.navigateToHistoryEntry',
    'Page.createIsolatedWorld',
    'Page.enable',
    'Runtime.enable',
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'DOM.getDocument',
    'DOM.getOuterHTML',
    'DOMSnapshot.captureSnapshot',
    'Network.getResponseBody',
    'Fetch.getResponseBody',
  ]);
  globalThis.__biosGuardModeRow = row;
  const emit = (record) => {
    try {
      const sent = globalThis.__biosGuardModeEvent?.(
        JSON.stringify({ row: globalThis.__biosGuardModeRow, ...record })
      );
      sent?.catch(() => {});
    } catch {}
  };
  globalThis.sliccGuardTrace = {
    push({ method, passed, refused }) {
      if (!methods.has(method) || (!passed && typeof refused !== 'string')) return;
      const reason = passed
        ? 'none'
        : refused.includes('execution context')
          ? 'context'
          : refused.includes('couldn’t keep')
            ? 'guard'
            : refused.includes('seven’s own pages')
              ? 'document'
              : refused.includes('held it back')
                ? 'private'
                : 'other';
      emit({ kind: 'command', method, outcome: passed ? 'passed' : 'refused', reason });
    },
    modes() {
      const instance = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
        value.toString(16).padStart(8, '0')
      ).join('');
      return ({ target, strict, evidence, phase, cause }) =>
        emit({ kind: 'mode', instance, target, strict, evidence, phase, cause });
    },
  };
}

export function guardModeCounts(row) {
  const allowed = new Set([row]);
  const methods = new Set([
    'Target.attachToTarget',
    'Target.getTargetInfo',
    'Target.getTargets',
    'Target.createTarget',
    'Target.closeTarget',
    'Target.detachFromTarget',
    'Page.getFrameTree',
    'Page.getResourceTree',
    'Page.captureScreenshot',
    'Page.navigate',
    'Page.reload',
    'Page.navigateToHistoryEntry',
    'Page.createIsolatedWorld',
    'Page.enable',
    'Runtime.enable',
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'DOM.getDocument',
    'DOM.getOuterHTML',
    'DOMSnapshot.captureSnapshot',
    'Network.getResponseBody',
    'Fetch.getResponseBody',
  ]);
  const rows = new Map();
  const phases = new Set(['enter', 'leave', 'observe']);
  const causes = new Set(['new', 'pending', 'evidence', 'tree', 'commit', 'worker']);
  const reasons = new Set(['none', 'context', 'guard', 'document', 'private', 'other']);
  const fields = [
    'seen',
    'entered',
    'left',
    'treeOnly',
    'worker',
    'commit',
    'evidence',
    'strict',
    'ordinary',
  ];
  const stateFor = (name) => {
    if (!rows.has(name))
      rows.set(name, {
        ...Object.fromEntries(fields.map((field) => [field, new Set()])),
        commands: new Map(),
      });
    return rows.get(name);
  };
  const handle = (record) => {
    if (!record || !allowed.has(record.row)) return;
    if (record.kind === 'command') {
      if (
        typeof record.method !== 'string' ||
        !methods.has(record.method) ||
        !['passed', 'refused'].includes(record.outcome) ||
        !reasons.has(record.reason)
      )
        return;
      const state = stateFor(record.row);
      const key = `${record.method}:${record.outcome}:${record.reason}`;
      state.commands.set(key, (state.commands.get(key) ?? 0) + 1);
      return;
    }
    if (
      typeof record.instance !== 'string' ||
      !/^[0-9a-f]{32}$/.test(record.instance) ||
      !Number.isSafeInteger(record.target) ||
      record.target < 1 ||
      typeof record.strict !== 'boolean' ||
      typeof record.evidence !== 'boolean' ||
      !phases.has(record.phase) ||
      !causes.has(record.cause)
    )
      return;
    const state = stateFor(record.row);
    const target = `${record.instance}:${record.target}`;
    state.seen.add(target);
    if (record.phase === 'enter') state.entered.add(target);
    if (record.phase === 'leave') state.left.add(target);
    if (record.cause === 'tree') state.treeOnly.add(target);
    if (record.cause === 'worker') state.worker.add(target);
    if (record.cause === 'commit') state.commit.add(target);
    if (record.evidence) state.evidence.add(target);
    state[record.strict ? 'strict' : 'ordinary'].add(target);
    state[record.strict ? 'ordinary' : 'strict'].delete(target);
  };
  const snapshot = () =>
    [...rows].map(([name, state]) => ({
      row: name,
      ...Object.fromEntries(fields.map((field) => [field, state[field].size])),
      commands: Object.fromEntries(state.commands),
    }));
  return {
    allow(name) {
      allowed.add(name);
    },
    handle,
    snapshot,
    async flush(t) {
      const file = basename(argv[1] ?? '');
      const result = {
        family: file.startsWith('guard-set-') ? 'guard-set.mjs' : file,
        rows: snapshot(),
      };
      t.diagnostic(`guard-mode-metadata ${JSON.stringify(result)}`);
      await mkdir('test-results', { recursive: true });
      await writeFile(
        join('test-results', `guard-mode-${randomUUID()}.json`),
        `${JSON.stringify(result)}\n`
      );
    },
  };
}
