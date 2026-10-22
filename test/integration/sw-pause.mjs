const paused = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

const released = {
  ...paused,
  filter: [
    { type: 'service_worker', exclude: true },
    { type: 'shared_worker', exclude: true },
    { type: 'worker', exclude: true },
    { type: 'browser', exclude: true },
    { type: 'tab', exclude: true },
    {},
  ],
};

const nested = { ...released, waitForDebuggerOnStart: false };

export async function withoutWorkerPause(chrome) {
  const apply = (sessionId) =>
    chrome.cdp.send('Target.setAutoAttach', nested, sessionId).catch(() => {});
  await chrome.cdp.send('Target.setAutoAttach', released);
  const stop = chrome.cdp.on(({ method, params = {} }) => {
    if (method !== 'Target.attachedToTarget' || params.targetInfo?.type !== 'page') return;
    if (!params.sessionId) return;
    apply(params.sessionId);
  });
  return async () => {
    stop();
    await chrome.cdp.send('Target.setAutoAttach', paused);
  };
}
