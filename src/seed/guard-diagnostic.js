const probes = new WeakMap();
let next = 0;
const number = (value) => (Number.isFinite(value) ? value : null);

export function originOnly(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.origin !== 'null'
    ? url.origin
    : url.host
      ? `${url.protocol}//${url.host}`
      : url.protocol;
}

function frameKind(frame, is) {
  if (!frame || typeof frame.id !== 'string' || !frame.id) return 'missing-frame-id';
  if (is.url(frame.url) || is.url(frame.securityOrigin) || is.url(frame.unreachableUrl))
    return 'protected';
  if (frame.url === '' && frame.securityOrigin === '://') return 'uninitialized';
  if (typeof frame.url !== 'string' || !frame.url || !URL.canParse(frame.url))
    return 'missing-or-invalid-url';
  if (
    ['securityOrigin', 'unreachableUrl', 'parentId'].some(
      (key) => frame[key] !== undefined && typeof frame[key] !== 'string'
    )
  )
    return 'malformed-classification-field';
  if (frame.unreachableUrl && !URL.canParse(frame.unreachableUrl)) return 'invalid-unreachable-url';
  if (new URL(frame.url).protocol === 'chrome-error:' && !frame.unreachableUrl)
    return 'unknown-error-document';
  return null;
}

export function treeKind(tree, is) {
  const seen = new Set();
  const pending = [tree];
  for (let count = 0; pending.length && count < 1000; count++) {
    const node = pending.pop();
    const kind = frameKind(node?.frame, is);
    if (kind) return kind;
    const frame = node.frame;
    if (seen.has(frame.id)) return 'duplicate-frame-id';
    seen.add(frame.id);
    if (node.childFrames !== undefined && !Array.isArray(node.childFrames))
      return 'malformed-children';
    pending.push(...(node.childFrames ?? []));
  }
  return pending.length ? 'bounded-tree-limit' : 'ordinary';
}

function classification(guard, state, sessionId, targetId) {
  if (state?.retired) return 'retired';
  if (guard.blocked.has(sessionId) || guard.targets.get(targetId)?.guarded) return 'protected';
  return state && state.checked === state.revision ? 'ordinary' : 'unconfirmed';
}

function token(probe, kind, value) {
  if (typeof value !== 'string' || !value) return null;
  const key = `${kind}:${value}`;
  if (!probe.keys.has(key)) probe.keys.set(key, `${kind}-${probe.keys.size + 1}`);
  return probe.keys.get(key);
}

function fields(guard, probe, message, facts) {
  const sessionId = message.sessionId;
  const targetId = message.targetId ?? guard.documentTarget(sessionId);
  const state = guard.documents.get(targetId);
  const nav = guard.navs.get(targetId);
  const frame = facts.tree?.frame ?? facts.frame;
  return {
    method:
      typeof message.method === 'string' && /^[A-Za-z]+\.[A-Za-z]+$/.test(message.method)
        ? message.method
        : null,
    target: token(probe, 'target', targetId),
    session: token(probe, 'session', sessionId),
    frame: token(probe, 'frame', frame?.id ?? state?.frameId),
    loader: token(probe, 'loader', frame?.loaderId),
    classification: classification(guard, state, sessionId, targetId),
    treeKind: facts.tree ? treeKind(facts.tree, guard.is) : null,
    origins: [
      ...new Set(
        [
          guard.targets.get(targetId)?.url,
          guard.frames.get(state?.frameId),
          frame?.url,
          frame?.securityOrigin,
          frame?.unreachableUrl,
          facts.url,
        ]
          .map(originOnly)
          .filter(Boolean)
      ),
    ],
    revision: state?.revision ?? null,
    checked: state?.checked ?? null,
    classified: state?.classified ?? null,
    proof: state?.proof ?? null,
    opening: state?.opening.size ?? null,
    reading: state?.reading ?? null,
    planned: state?.planned ?? null,
    transport: state?.transport === true,
    shown: guard.shown.has(sessionId),
    blocked: guard.blocked.has(sessionId),
    armed: nav?.done === true && !nav.failed,
    navFailed: nav?.failed === true,
    privateSessionPresent: typeof nav?.session === 'string',
    privateNavigationTaken: nav?.taken === true,
    rootMatchesTarget: frame?.id !== undefined ? frame.id === targetId : null,
    loaderPresent: typeof frame?.loaderId === 'string' && Boolean(frame.loaderId),
    sourceAlive: state?.source?.alive === true,
    rpcElapsed: number(facts.elapsed),
    limit: number(facts.limit),
    errorCode: number(facts.error?.code),
  };
}

export function diagnostic(guard, point, reason, message = {}, facts = {}) {
  const emit = globalThis.sliccGuardDiagnostic;
  if (typeof emit !== 'function') return;
  try {
    if (!probes.has(guard))
      probes.set(guard, {
        instance: ++next,
        row: number(globalThis.sliccGuardDiagnosticRow),
        started: Date.now(),
        keys: new Map(),
        count: 0,
      });
    const probe = probes.get(guard);
    if (++probe.count > 100000) return;
    emit({
      point,
      reason,
      instance: probe.instance,
      row: probe.row,
      sequence: probe.count,
      elapsed: Date.now() - probe.started,
      ...fields(guard, probe, message, facts),
    });
  } catch {}
}
