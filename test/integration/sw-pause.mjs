const paused = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

export async function withoutWorkerPause(chrome) {
  await chrome.cdp.send('Target.setAutoAttach', {
    ...paused,
    filter: [
      { type: 'service_worker', exclude: true },
      { type: 'shared_worker', exclude: true },
      { type: 'worker', exclude: true },
      { type: 'browser', exclude: true },
      { type: 'tab', exclude: true },
      {},
    ],
  });
  return () => chrome.cdp.send('Target.setAutoAttach', paused);
}
