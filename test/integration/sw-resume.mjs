const RESUME = new Set(['worker', 'shared_worker']);

export function pausedWorkers(chrome) {
  const targets = new Map();
  const off = chrome.cdp.on(({ method, params }) => {
    if (method !== 'Target.attachedToTarget') return;
    const info = params.targetInfo;
    if (!info) return;
    if (!RESUME.has(info.type) && info.type !== 'service_worker') return;
    targets.set(info.targetId, {
      type: info.type,
      url: info.url,
      waiting: params.waitingForDebugger === true,
      sessionId: params.sessionId,
    });
  });
  return {
    stop: off,
    async release() {
      const resumed = [];
      for (const target of targets.values()) {
        if (!RESUME.has(target.type)) continue;
        const error = await chrome.cdp
          .send('Runtime.runIfWaitingForDebugger', {}, target.sessionId)
          .then(() => null)
          .catch((failure) => failure.message);
        resumed.push({
          type: target.type,
          url: target.url,
          waiting: target.waiting,
          error,
        });
      }
      const paused = [...targets.values()]
        .filter((target) => target.waiting)
        .map(({ type, url }) => ({ type, url }));
      return { paused, resumed };
    },
  };
}
