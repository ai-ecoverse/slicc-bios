const short = (value) => (typeof value === 'string' ? value.slice(0, 8) : '');
const STRUCTURE =
  /^(?:Runtime\.executionContext|Target\.(?:attachedToTarget|detachedFromTarget|targetDestroyed)$|Page\.frame(?:Navigated|Attached|Detached)$)/;
const EVALUATES = new Set(['Runtime.evaluate', 'Runtime.callFunctionOn']);
const ASKED = 1000;

export function cdpTrace({ frames = 300, contexts = 200, failures = 100 } = {}) {
  const rings = { frame: [], context: [], failed: [] };
  const sizes = { frame: frames, context: contexts, failed: failures };
  const asked = new Map();
  const keep = (kind, line) => {
    const ring = rings[kind];
    ring.push(line);
    if (ring.length > sizes[kind]) ring.shift();
  };
  const clock = () => new Date().toISOString().slice(11, 23);
  const describe = (way, message, was, extra) => {
    const params = message.params ?? {};
    const info = params.targetInfo;
    const context = params.context;
    const code = params.functionDeclaration ?? params.expression;
    const aux = context?.auxData ?? {};
    const value = message.result?.result?.value;
    return [
      clock(),
      way,
      message.method
        ? `${message.method}${message.id === undefined ? '' : ` #${message.id}`}`
        : `#${message.id}${was ? ` ${was.method}` : ''}`,
      message.sessionId ? `on ${short(message.sessionId)}` : '',
      params.sessionId ? `session ${short(params.sessionId)}` : '',
      info ? `${info.type} ${short(info.targetId)} ${info.url}` : '',
      params.targetId ? `target ${short(params.targetId)}` : '',
      params.waitingForDebugger ? 'paused' : '',
      context
        ? `ctx ${context.id} ${short(context.uniqueId)} frame ${short(aux.frameId)} ${aux.isDefault ? 'default' : (aux.type ?? '')} ${context.name ?? ''} ${context.origin ?? ''}`
        : '',
      params.executionContextId === undefined ? '' : `ctx ${params.executionContextId}`,
      params.contextId === undefined ? '' : `ctx ${params.contextId}`,
      params.uniqueContextId ? `ctx ${short(params.uniqueContextId)}` : '',
      typeof params.objectId === 'string' ? `object ${params.objectId.slice(0, 24)}` : '',
      params.frame ? `frame ${short(params.frame.id)} ${params.frame.url}` : '',
      params.frameId ? `frame ${short(params.frameId)}` : '',
      params.parentFrameId ? `parent ${short(params.parentFrameId)}` : '',
      EVALUATES.has(message.method) && typeof code === 'string'
        ? JSON.stringify(code.slice(0, 40))
        : '',
      message.result?.exceptionDetails ? 'exception' : '',
      EVALUATES.has(was?.method) && ['string', 'number', 'boolean'].includes(typeof value)
        ? `value ${JSON.stringify(typeof value === 'string' ? value.slice(0, 60) : value)}`
        : '',
      message.error ? `error ${String(message.error.message).slice(0, 80)}` : '',
      extra ?? '',
    ]
      .filter(Boolean)
      .join(' ');
  };
  return {
    note(way, message, extra) {
      if (!message || typeof message !== 'object') return;
      const answer = message.method === undefined && message.id !== undefined;
      const was = answer ? asked.get(message.id) : undefined;
      if (answer) asked.delete(message.id);
      if (message.method && message.id !== undefined) {
        asked.set(message.id, {
          method: message.method,
          sessionId: message.sessionId,
          at: Date.now(),
        });
        if (asked.size > ASKED) asked.delete(asked.keys().next().value);
      }
      const line = describe(way, message, was, extra);
      keep('frame', line);
      if (
        STRUCTURE.test(message.method ?? '') ||
        EVALUATES.has(message.method) ||
        EVALUATES.has(was?.method)
      )
        keep('context', line);
    },
    fail(message, error) {
      keep(
        'failed',
        describe(
          '<',
          message && typeof message === 'object' ? message : {},
          undefined,
          `failed ${String(error?.message ?? error).slice(0, 160)}`
        )
      );
    },
    trace() {
      const now = Date.now();
      return [
        ...rings.context.map((line) => `context ${line}`),
        ...rings.frame.map((line) => `frame ${line}`),
        ...[...asked].map(
          ([id, { method, sessionId, at }]) =>
            `pending #${id} ${method}${sessionId ? ` on ${short(sessionId)}` : ''} for ${now - at} ms`
        ),
        ...rings.failed.map((line) => `failed ${line}`),
      ];
    },
  };
}
