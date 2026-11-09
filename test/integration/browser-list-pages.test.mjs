import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowser, pageClient } from '../../src/seed/browser.js';
import { extensionConnection } from '../../src/seed/cdp.js';

const targets = [
  {
    targetId: 'page-tab',
    type: 'page',
    title: 'Gmail',
    url: 'https://mail.google.com/mail/u/0/',
  },
  {
    targetId: 'iframe-tab',
    type: 'iframe',
    title: 'mole',
    url: 'https://chat.google.com/u/1/mole/hidden',
  },
  {
    targetId: 'worker-tab',
    type: 'service_worker',
    title: '',
    url: 'https://chat.google.com/sw.js',
  },
];

function listedBrowser(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5000 });
  let nextSession = 0;
  const gate = Promise.withResolvers();
  let holdTargets = true;
  const api = {
    on() {
      return () => {};
    },
    async send(method) {
      if (method === 'Target.getTargets') {
        if (holdTargets) await gate.promise;
        return { targetInfos: targets };
      }
      if (method === 'Target.attachToTarget') return { sessionId: `virtual-${++nextSession}` };
      return {};
    },
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'sliccExtension');
  Object.defineProperty(globalThis, 'sliccExtension', {
    configurable: true,
    value: Object.freeze({ version: '7.12.0', cdp: api }),
  });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'sliccExtension', saved);
    else delete globalThis.sliccExtension;
  });
  const browser = createBrowser({}, { storage: null, own: 'https://protected.invalid' });
  const connection = browser.observe(extensionConnection(api));
  t.after(() => connection.close());
  const call = pageClient(async () => connection, globalThis).call;
  return {
    browser,
    call,
    releaseTargets() {
      holdTargets = false;
      gate.resolve();
    },
  };
}

test('BrowserPort.list keeps owned page targets and omits iframe and worker targets', async (t) => {
  const { browser, call, releaseTargets } = listedBrowser(t);
  for (const info of targets) {
    await call('Target.attachToTarget', { targetId: info.targetId, flatten: true });
  }
  releaseTargets();
  const listed = await new Promise((resolve, reject) => {
    let steps = 0;
    const poll = () => {
      const tabs = browser.port.list();
      if (tabs.some((tab) => tab.id === 'page-tab')) return resolve(tabs);
      if (++steps > 1000) {
        return reject(new Error(`page never listed: ${JSON.stringify(tabs)}`));
      }
      queueMicrotask(poll);
    };
    poll();
  });
  assert.deepEqual(
    listed.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, hidden: tab.hidden })),
    [
      {
        id: 'page-tab',
        title: 'Gmail',
        url: 'https://mail.google.com/mail/u/0/',
        hidden: undefined,
      },
    ]
  );
});
