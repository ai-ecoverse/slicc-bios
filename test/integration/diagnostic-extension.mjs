const connections = new Set();

const origin = (value) => {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.origin === 'null' ? `${url.protocol}//${url.hostname}` : url.origin;
  } catch {
    return value === '://' ? value : 'invalid';
  }
};

export const shape = (value = {}) => {
  const result = value.result ?? value;
  const frame = (item = {}) => ({
    fields: Object.keys(item).sort(),
    url: origin(item.url),
    unreachableUrl: origin(item.unreachableUrl),
    securityOrigin: origin(item.securityOrigin),
    parent: item.parentId !== undefined,
  });
  const tree = (item) =>
    item && { frame: frame(item.frame), children: (item.childFrames ?? []).map(tree) };
  return {
    fields: Object.keys(result ?? {}).sort(),
    frameTree: tree(result.frameTree),
    frame: value.frame && frame(value.frame),
    url: origin(value.url),
    requestUrl: origin(value.request?.url),
    resourceType: value.resourceType === 'Document' ? 'Document' : undefined,
    pendingUrl: origin(value.pendingUrl),
    unreachableUrl: origin(value.unreachableUrl),
    securityOrigin: origin(value.securityOrigin),
    errorReason: value.errorReason === 'BlockedByClient',
    error: typeof value.error === 'string' ? safeError(value.error) : undefined,
  };
};

const safeError = (value) => {
  const text = String(value?.message ?? value);
  const known = [
    "slicc: refused: target is on seven's origin",
    "slicc: refused: slicc can't keep seven's origin out of this target",
  ];
  return (
    known.find((item) => text.includes(item)) ??
    (text.includes('slicc: refused:') ? 'other-slicc-refusal' : 'other-error')
  );
};

export function trace(stage, detail = {}) {
  for (const connection of connections) connection.diagnostic(stage, detail);
}

export function instrument(connection) {
  connections.add(connection);
  const labels = new Map();
  const label = (value) => {
    if (value === undefined || value === null) return null;
    if (!labels.has(value)) labels.set(value, labels.size + 1);
    return labels.get(value);
  };
  connection.diagnostic = (stage, detail = {}) => {
    try {
      connection.port.postMessage({ diagnostic: { layer: 'extension', stage, ...detail } });
    } catch {}
  };
  for (const name of [
    'handle',
    'dispatch',
    'sessionCommand',
    'admit',
    'confirmed',
    'confirmedError',
    'failedAt',
    'view',
    'sessionOf',
    'check',
    'checkContent',
    'checkReturn',
    'committed',
    'watch',
    'watchFrame',
    'protectedDocument',
    'send',
    'post',
    'broadcast',
    'onUpdated',
    'onFrames',
    'onPaused',
    'candidates',
    'advance',
    'detach',
    'applyFetch',
    'settlePaused',
    'shutdown',
  ]) {
    const original = connection[name];
    connection[name] = function (...args) {
      const message = args[0];
      const method =
        message?.method ??
        (['send', 'broadcast', 'checkContent', 'checkReturn', 'watch', 'onPaused'].includes(name)
          ? args[name === 'checkReturn' || name === 'watch' ? 2 : 1]
          : name === 'check'
            ? message
            : undefined);
      const detail = {
        method: typeof method === 'string' ? method : undefined,
        request: message?.id,
        session: label(message?.sessionId),
        sessionKind: message?.sessionId === undefined ? 'browser' : 'tab',
        tab: label(typeof message === 'number' ? message : message?.id),
      };
      if (['dispatch', 'handle', 'sessionCommand', 'post'].includes(name))
        detail.shape = shape(message?.params ?? message);
      if (name === 'view') detail.shape = shape(message);
      if (name === 'watchFrame') detail.shape = shape({ frame: args[2] });
      if (name === 'protectedDocument') detail.shape = shape({ url: args[4] });
      if (name === 'onPaused') detail.shape = shape(args[2]);
      this.diagnostic(`${name}:enter`, detail);
      const done = (value) =>
        this.diagnostic(`${name}:return`, {
          ...detail,
          verdict: typeof value === 'boolean' ? value : value === null ? null : Boolean(value),
          ...(name === 'candidates' && Array.isArray(value) ? { owners: value.map(label) } : {}),
          ...(name === 'send' || name === 'view' || name === 'dispatch'
            ? { shape: shape(value ?? {}) }
            : {}),
          ...(typeof message === 'number'
            ? {
                failed: this.state.failed.has(message),
                failedOrigin: origin(this.state.failed.get(message)),
              }
            : {}),
        });
      const failed = (error) =>
        this.diagnostic(`${name}:throw`, { ...detail, error: safeError(error) });
      try {
        const result = original.apply(this, args);
        if (result?.then) result.then(done, failed);
        else done(result);
        if (name === 'shutdown') connections.delete(this);
        return result;
      } catch (error) {
        failed(error);
        throw error;
      }
    };
  }
}
