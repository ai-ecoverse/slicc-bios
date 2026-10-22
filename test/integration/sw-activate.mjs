export function retryReplacedWorker(chrome) {
  const targetOf = new Map();
  const order = [];
  const crashed = new Set();
  let left = 4;
  const scopeURL = new URL('/', chrome.url).href;
  const poke = (reloaded) => {
    const latest = order.at(-1);
    const previous = targetOf.get(reloaded);
    const older = previous ? previous !== latest : order.length >= 2;
    if (left <= 0 || !latest || !older) return;
    left -= 1;
    chrome.cdp.send('ServiceWorker.skipWaiting', { scopeURL }).catch(() => {});
    for (const [sessionId, target] of targetOf) {
      if (target !== latest) continue;
      chrome.cdp
        .send(
          'Runtime.evaluate',
          { expression: 'self.skipWaiting()', awaitPromise: true },
          sessionId
        )
        .catch(() => {});
    }
  };
  chrome.cdp.send('ServiceWorker.enable').catch(() => {});
  chrome.cdp
    .send('Target.getTargets')
    .then(({ targetInfos }) => {
      for (const info of targetInfos) {
        if (info.type !== 'service_worker' || !String(info.url).includes('/sw.js')) continue;
        if (!order.includes(info.targetId)) order.unshift(info.targetId);
      }
    })
    .catch(() => {});
  return chrome.cdp.on(({ method, params = {}, sessionId }) => {
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'service_worker') {
      const url = params.targetInfo.url ?? '';
      if (!params.sessionId || !url.includes('/sw.js')) return;
      targetOf.set(params.sessionId, params.targetInfo.targetId);
      if (!order.includes(params.targetInfo.targetId)) order.push(params.targetInfo.targetId);
    }
    if (!sessionId) return;
    if (method === 'Inspector.targetCrashed') crashed.add(sessionId);
    if (method === 'Inspector.workerScriptLoaded' && crashed.delete(sessionId)) poke(sessionId);
  });
}
