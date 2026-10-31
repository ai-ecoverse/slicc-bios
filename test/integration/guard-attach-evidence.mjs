import * as guard from '../../src/seed/guard.js';

export function attachRecorder() {
  const selected = new Set([
    'Target.getTargetInfo',
    'Target.getTargets',
    'Target.attachToTarget',
    'Target.detachFromTarget',
    'Target.setAutoAttach',
    'Target.attachedToTarget',
    'Target.detachedFromTarget',
    'Target.targetInfoChanged',
    'Target.targetDestroyed',
    'Page.getFrameTree',
    'Page.getNavigationHistory',
    'Page.enable',
    'Page.navigate',
    'Page.frameAttached',
    'Page.frameDetached',
    'Page.frameNavigated',
    'Page.frameStartedNavigating',
    'Page.frameStoppedLoading',
    'Page.loadEventFired',
    'DOM.getDocument',
    'DOM.disable',
    'DOM.documentUpdated',
    'Fetch.enable',
    'Network.enable',
    'Network.setBypassServiceWorker',
    'Runtime.executionContextCreated',
    'Runtime.executionContextDestroyed',
    'Runtime.executionContextsCleared',
    'Runtime.runIfWaitingForDebugger',
  ]);
  const methods = new Map();
  const rows = [];
  const failures = new Map();
  const attaches = new Map();
  let next = 0;
  const key = (message) => JSON.stringify([message.sessionId ?? null, message.id]);
  return {
    publicCommand(command) {
      if (command.method !== 'Target.attachToTarget') return false;
      const count = (attaches.get(command.params?.targetId) ?? 0) + 1;
      attaches.set(command.params?.targetId, count);
      return count > 1;
    },
    record(direction, message) {
      const id = key(message);
      if (direction === 'out') methods.set(id, message.method);
      const method = message.method ?? methods.get(id);
      if (direction === 'in' && message.id !== undefined) methods.delete(id);
      if (!selected.has(method) && !message.error) return;
      const seq = next++;
      rows[seq % 1024] = {
        seq,
        at: Date.now(),
        direction,
        method,
        id: message.id,
        sessionId: message.sessionId,
        params: selected.has(method) ? message.params : undefined,
        result: selected.has(method) ? message.result : undefined,
        error: message.error,
      };
    },
    capture(command, answer) {
      if (command?.method !== 'Target.attachToTarget' || !answer.error) return;
      failures.set(command.id, {
        capturedAt: Date.now(),
        command,
        answer,
        truncated: next > 1024,
        records: rows.slice().sort((a, b) => a.seq - b.seq),
      });
    },
    take(id) {
      const report = failures.get(id);
      failures.delete(id);
      return report;
    },
  };
}

export function attachUrl(value) {
  if (typeof value !== 'string' || !value || value === 'null' || value === '://') return value;
  try {
    const url = new URL(value);
    return url.origin === 'null' ? `${url.protocol}//${url.hostname}` : url.origin;
  } catch {
    return 'opaque';
  }
}

const known = new Set(
  Object.values(guard).filter(
    (value) => typeof value === 'string' && value.startsWith('slicc: refused:')
  )
);
const native = new Set([
  'Target closed',
  'Session closed',
  'Session with given id not found.',
  'No target with given id found',
  'No target with given id found.',
  'No frame with given id found',
  'Cannot find context with specified id',
  'Not attached to an active page',
  'Not allowed',
  'Invalid parameters',
  'Target.attachToTarget got no answer through the guard',
]);

function error(value) {
  if (!value) return undefined;
  const message = value.message;
  return {
    code: value.code,
    message:
      known.has(message) ||
      native.has(message) ||
      message === "slicc: refused: target is on seven's origin"
        ? message
        : 'other error',
  };
}

function frame(value) {
  if (!value) return undefined;
  return {
    id: value.id,
    parentId: value.parentId,
    loaderId: value.loaderId,
    url: attachUrl(value.url),
    securityOrigin: attachUrl(value.securityOrigin),
    unreachableUrl: attachUrl(value.unreachableUrl),
  };
}

function tree(value, left = { count: 0 }) {
  if (!value) return undefined;
  if (left.count++ >= 64) return { capped: true };
  return {
    frame: frame(value.frame),
    childFrames: Array.isArray(value.childFrames)
      ? value.childFrames.map((child) => tree(child, left))
      : value.childFrames,
  };
}

function target(value) {
  if (!value) return undefined;
  return {
    targetId: value.targetId,
    type: value.type,
    url: attachUrl(value.url),
    openerId: value.openerId,
    parentId: value.parentId,
    parentFrameId: value.parentFrameId,
    canAccessOpener: value.canAccessOpener,
    browserContextId: value.browserContextId,
  };
}

function owners(root) {
  if (!root) return { root: false };
  const pending = [root];
  const frames = [];
  let count = 0;
  while (pending.length && count++ < 10000) {
    const node = pending.pop();
    if (!node) continue;
    if (node.nodeName === 'IFRAME' || node.nodeName === 'FRAME') {
      const source = (node.attributes ?? []).indexOf('src');
      if (frames.length < 64)
        frames.push({
          frameId: node.frameId,
          contentDocument: Boolean(node.contentDocument),
          source: attachUrl(source < 0 ? undefined : node.attributes[source + 1]),
          documentURL: attachUrl(node.contentDocument?.documentURL),
        });
    }
    pending.push(
      ...(node.children ?? []),
      ...(node.shadowRoots ?? []),
      node.contentDocument,
      node.templateContent
    );
  }
  return { root: true, owners: frames, capped: pending.length > 0 || frames.length === 64 };
}

function message(value) {
  const params = value.params ?? {};
  const result = value.result ?? {};
  return {
    id: value.id,
    method: value.method,
    sessionId: value.sessionId,
    targetId: params.targetId,
    frameId: params.frameId ?? result.frameId,
    parentFrameId: params.parentFrameId,
    loaderId: params.loaderId ?? result.loaderId,
    attached: result.sessionId,
    autoAttach: params.autoAttach,
    waitingForDebugger: params.waitingForDebugger,
    waitForDebuggerOnStart: params.waitForDebuggerOnStart,
    flatten: params.flatten,
    filter: params.filter,
    url: attachUrl(params.url),
    navigationType: params.navigationType,
    frame: frame(params.frame),
    frameTree: tree(result.frameTree),
    targetInfo: target(params.targetInfo ?? result.targetInfo),
    targets: result.targetInfos?.slice(0, 64).map(target),
    placement: result.root
      ? owners(result.root)
      : value.direction === 'in' && value.method === 'DOM.getDocument' && !value.error
        ? { root: false }
        : undefined,
    context: params.context && {
      id: params.context.id,
      origin: attachUrl(params.context.origin),
      frameId: params.context.auxData?.frameId,
      type: params.context.auxData?.type,
      isDefault: params.context.auxData?.isDefault,
    },
    error: error(value.error),
  };
}

export function attachReport(snapshot, details) {
  if (!snapshot) return { ...details, unavailable: true };
  return {
    ...details,
    capturedAt: snapshot.capturedAt,
    truncated: snapshot.truncated,
    command: message(snapshot.command),
    answer: message(snapshot.answer),
    records: snapshot.records.map((row) => ({
      seq: row.seq,
      at: row.at,
      direction: row.direction,
      method: row.method,
      ...message(row),
    })),
  };
}
