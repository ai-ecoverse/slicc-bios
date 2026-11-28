const ABORTED_TRANSITION =
  'InvalidStateError: Transition was aborted because of invalid state. ViewTransition opt-in disabled';

export const errorsOf = (page) => page.errors.filter((text) => text !== ABORTED_TRANSITION);

export function observeNetwork(cdp) {
  const observed = [];
  const detached = new Set();
  const kinds = new Map();
  const sent = [];
  cdp.on(({ method, params, sessionId }) => {
    if (method === 'Target.attachedToTarget') {
      const { type, url } = params.targetInfo;
      const foreign = /^(?:chrome|chrome-extension|devtools):/.test(url);
      kinds.set(params.sessionId, foreign ? `foreign ${type}` : type);
      if (foreign) return;
      observed.push(
        cdp.send('Network.enable', {}, params.sessionId).then(
          () => null,
          (error) => {
            const state = detached.has(params.sessionId) ? ' detached before enabling' : '';
            return `${type} ${params.sessionId}${state}: ${error.message}`;
          }
        )
      );
      return;
    }
    if (method === 'Target.detachedFromTarget') detached.add(params.sessionId);
    if (method !== 'Network.requestWillBeSent') return;
    const url = URL.parse(params.request.url);
    if (!url || !/^(?:https?|wss?):$/.test(url.protocol)) return;
    sent.push({
      kind: kinds.get(sessionId) ?? 'unknown',
      origin: url.origin,
      path: url.pathname,
      method: params.request.method,
      url: url.href,
    });
  });
  return {
    sent,
    failures: async () => (await Promise.all(observed)).filter(Boolean),
  };
}

export function workerPath(path, { network, installer, bios }) {
  return network.has(path) || (bios && installer.has(path));
}
