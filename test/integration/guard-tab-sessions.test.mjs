import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionConnection } from '../../src/seed/cdp.js';
import { guardProtected, NO_AUTO_ATTACH, PROTECTED, TAB_FOREIGN } from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';

const SEVEN = 'https://seven.invalid';
const IDP = 'https://idp.example/authorize?state=s3cret&code_challenge=c0de&client_id=cl1ent';
const IDP_TITLE = 'Sign in to Example';
const VAULT = 'https://vault.sliccy.ai/unlock';
const VAULT_TITLE = 'Vault: unlock';
const ORDINARY = 'https://ordinary.invalid/page';
const PUPPETEER_TABS = [{ type: 'page', exclude: true }, {}];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const origin = (url) => (URL.canParse(url) ? new URL(url).origin : '://');

function frameTree(url, owner) {
  return {
    frameTree: {
      frame: { id: `frame-${owner}`, loaderId: 'loader', url, securityOrigin: origin(url) },
    },
  };
}

function extension(pages) {
  const listeners = new Set();
  const sent = [];
  let sessions = 0;
  const owners = new Map();
  const info = (targetId) => ({ targetId, attached: false, ...pages[targetId] });
  const answers = {
    'Target.setAutoAttach': () => {
      throw new Error(NO_AUTO_ATTACH);
    },
    'Target.getTargets': () => ({ targetInfos: Object.keys(pages).map(info) }),
    'Target.getTargetInfo': ({ targetId }, sessionId) => ({
      targetInfo: info(targetId ?? owners.get(sessionId)),
    }),
    'Target.attachToTarget': ({ targetId }) => {
      sessions += 1;
      const sessionId = `${targetId}~${sessions}`;
      owners.set(sessionId, targetId);
      return { sessionId };
    },
    'Page.getFrameTree': (_, sessionId) =>
      frameTree(pages[owners.get(sessionId)]?.url ?? ORDINARY, owners.get(sessionId)),
    'Page.getNavigationHistory': (_, sessionId) => ({
      currentIndex: 0,
      entries: [{ id: 0, url: pages[owners.get(sessionId)]?.url, title: '' }],
    }),
    'DOM.getDocument': () => ({ root: { nodeId: 1, nodeName: '#document', children: [] } }),
    'Browser.getVersion': () => ({ product: 'Chrome/157', protocolVersion: '1.3' }),
  };
  return {
    sent,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(method, params, sessionId) {
      sent.push({ method, params, sessionId });
      await Promise.resolve();
      return answers[method]?.(params ?? {}, sessionId) ?? {};
    },
  };
}

function devtools(infos) {
  const sent = [];
  const owners = new Map();
  let sessions = 0;
  const own = (sessionId) => owners.get(sessionId) ?? sessionId?.split('~')[0];
  const connection = {
    sent,
    owners,
    onmessage: null,
    onclose: null,
    close() {},
    emit(message) {
      connection.onmessage?.(JSON.stringify(message));
    },
    send(text) {
      const command = JSON.parse(text);
      sent.push(command);
      const owner = own(command.sessionId);
      const answer = (() => {
        switch (command.method) {
          case 'Target.getTargetInfo': {
            const targetId = command.params?.targetId ?? owner;
            return { targetInfo: { targetId, attached: true, ...infos[targetId] } };
          }
          case 'Target.attachToTarget':
            sessions += 1;
            return { sessionId: `${command.params.targetId}~${sessions}` };
          case 'Target.getTargets':
            return {
              targetInfos: Object.entries(infos).map(([targetId, info]) => ({
                targetId,
                attached: false,
                ...info,
              })),
            };
          case 'Page.getFrameTree':
            return frameTree(infos[owner]?.url ?? ORDINARY, owner);
          case 'DOM.getDocument':
            return { root: { nodeId: 1, nodeName: '#document', children: [] } };
          default:
            return {};
        }
      })();
      queueMicrotask(() =>
        connection.emit({
          id: command.id,
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
          result: answer,
        })
      );
    },
  };
  return connection;
}

function drive(transport, route) {
  const guarded = guardProtected(transport, [SEVEN], new Map(), route);
  const got = [];
  guarded.onmessage = (text) => got.push(JSON.parse(text));
  let id = 0;
  const send = async (method, params = {}, sessionId) => {
    id += 1;
    const mine = id;
    guarded.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
    for (let n = 0; n < 600 && !got.some((message) => message.id === mine); n++) await pause(5);
    const answer = got.find((message) => message.id === mine);
    assert.ok(answer, `${method} got an answer through the guard`);
    return answer;
  };
  const leaked = (...values) => values.filter((value) => JSON.stringify(got).includes(value));
  const attachedTabs = () =>
    got.filter(
      (message) =>
        message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'tab'
    );
  return { guarded, got, send, leaked, attachedTabs };
}

test('on the extension route, Puppeteer-shaped tab auto-attach with a held sign-in popup, seven and the vault open shows only the ordinary tab, and never their URLs or titles', {
  timeout: 30000,
}, async () => {
  hold('popup');
  const pages = {
    ordinary: { type: 'page', url: ORDINARY, title: 'Ordinary' },
    popup: { type: 'page', url: IDP, title: IDP_TITLE, openerId: 'seven' },
    seven: { type: 'page', url: `${SEVEN}/os/`, title: 'seven' },
    vault: { type: 'page', url: VAULT, title: VAULT_TITLE },
  };
  const cdp = extension(pages);
  const transport = extensionConnection(cdp, 20);
  const seen = [];
  const spied = {
    send: (text) => transport.send(text),
    close: () => transport.close(),
    set onmessage(fn) {
      transport.onmessage = (text) => {
        seen.push(JSON.parse(text));
        fn?.(text);
      };
    },
    set onclose(fn) {
      transport.onclose = fn;
    },
  };
  const { guarded, got, send, leaked, attachedTabs } = drive(spied, {
    kind: 'extension',
    version: '7.10.0',
  });
  assert.deepEqual(
    (
      await send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: PUPPETEER_TABS,
      })
    ).result,
    {}
  );
  await pause(600);
  assert.deepEqual(
    attachedTabs().map((message) => message.params.targetInfo.targetId),
    ['tab-ordinary']
  );
  const tab = attachedTabs()[0].params.sessionId;
  assert.equal(
    (await send('Target.getTargetInfo', { targetId: 'popup' }, tab)).error.message,
    TAB_FOREIGN
  );
  const own = await send('Target.getTargetInfo', {}, tab);
  assert.equal(own.result.targetInfo.url, '', 'an unplaced tab shows no URL');
  const adopted = (targetId) =>
    seen.filter(
      (message) =>
        message.method === 'Target.attachedToTarget' &&
        message.params.targetInfo.targetId === targetId
    ).length;
  for (const targetId of ['tab-popup', 'tab-seven', 'tab-vault'])
    assert.equal(adopted(targetId), 1, `${targetId} was cut once and not adopted again`);
  assert.deepEqual(
    leaked(
      IDP_TITLE,
      'idp.example',
      's3cret',
      'c0de',
      'cl1ent',
      VAULT_TITLE,
      'vault.sliccy.ai',
      SEVEN
    ),
    []
  );
  guarded.close?.();
  transport.close();
});

test('over the DevTools port, a raw client without discovery never learns a held popup tab URL, and cannot close it', {
  timeout: 30000,
}, async () => {
  hold('devtools-popup');
  const infos = {
    'devtools-tab': { type: 'tab', url: '', title: '' },
    'devtools-popup': { type: 'page', url: IDP, title: IDP_TITLE },
  };
  const raw = devtools(infos);
  const { got, send, leaked, attachedTabs } = drive(raw);
  raw.owners.set('tab-session', 'devtools-tab');
  raw.emit({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: 'tab-session',
      targetInfo: { targetId: 'devtools-tab', attached: true, ...infos['devtools-tab'] },
      waitingForDebugger: true,
    },
  });
  for (let n = 0; n < 200 && !attachedTabs().length; n++) await pause(5);
  infos['devtools-tab'] = { type: 'tab', url: IDP, title: IDP_TITLE };
  const later = await send('Target.getTargetInfo', {}, 'tab-session');
  assert.equal(later.result.targetInfo.url, '');
  assert.equal(
    (await send('Target.getTargetInfo', { targetId: 'devtools-popup' }, 'tab-session')).error
      .message,
    TAB_FOREIGN
  );
  assert.equal(
    (await send('Target.closeTarget', { targetId: 'devtools-tab' })).error.message,
    PROTECTED
  );
  const listed = await send('Target.getTargets');
  assert.ok(Array.isArray(listed.result.targetInfos));
  assert.deepEqual(leaked(IDP_TITLE, 'idp.example', 's3cret', 'c0de', 'cl1ent'), []);
});

test('on the extension route, a tab adopted while its page had no URL is refused, without attaching the page, once the page moves to the vault', {
  timeout: 30000,
}, async () => {
  const pages = { moving: { type: 'page', url: '', title: '' } };
  const cdp = extension(pages);
  const transport = extensionConnection(cdp, 20);
  const { guarded, send, leaked, attachedTabs } = drive(transport, {
    kind: 'extension',
    version: '7.10.0',
  });
  await send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: PUPPETEER_TABS,
  });
  for (let n = 0; n < 200 && !attachedTabs().length; n++) await pause(5);
  const tab = attachedTabs()[0]?.params.sessionId;
  assert.ok(tab, 'the blank page got a tab');
  const lookedUp = cdp.sent.length;
  pages.moving = { type: 'page', url: VAULT, title: VAULT_TITLE };
  const answer = await send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{}] },
    tab
  );
  assert.equal(answer.error?.message, PROTECTED);
  assert.ok(
    !cdp.sent
      .slice(lookedUp)
      .some(
        (call) => call.method === 'Target.attachToTarget' && call.params?.targetId === 'moving'
      ),
    'the vault page was never attached'
  );
  assert.deepEqual(leaked(VAULT_TITLE, 'vault.sliccy.ai'), []);
  guarded.close?.();
  transport.close();
});

test('on the extension route, a page already placed under a tab that moves to the vault gives the tab no vault URL or title, and the tab is cut', {
  timeout: 30000,
}, async () => {
  const pages = { moving: { type: 'page', url: ORDINARY, title: 'Ordinary' } };
  const cdp = extension(pages);
  const transport = extensionConnection(cdp, 20);
  const { guarded, got, send, leaked, attachedTabs } = drive(transport, {
    kind: 'extension',
    version: '7.10.0',
  });
  await send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: PUPPETEER_TABS,
  });
  for (let n = 0; n < 200 && !attachedTabs().length; n++) await pause(5);
  const tab = attachedTabs()[0]?.params.sessionId;
  assert.ok(tab, 'the ordinary page got a tab');
  await send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] },
    tab
  );
  const page = () =>
    got.find(
      (message) =>
        message.method === 'Target.attachedToTarget' &&
        message.sessionId === tab &&
        message.params.targetInfo.type === 'page'
    );
  for (let n = 0; n < 400 && !page(); n++) await pause(5);
  assert.ok(page(), 'the ordinary page was placed under the tab');
  const before = await send('Target.getTargetInfo', {}, tab);
  assert.equal(before.result?.targetInfo.url, ORDINARY, 'a fresh ordinary read shows the URL');
  pages.moving = {
    type: 'page',
    url: 'https://vault.sliccy.ai/unlock?token=abc',
    title: 'Vault: unlock',
  };
  const info = await send('Target.getTargetInfo', {}, tab);
  assert.equal(info.error?.message, PROTECTED, JSON.stringify(info));
  const again = await send(
    'Target.setAutoAttach',
    { autoAttach: true, flatten: true, filter: [{ type: 'page' }] },
    tab
  );
  assert.ok(again.error, `the cut tab takes no more commands: ${JSON.stringify(again)}`);
  assert.deepEqual(leaked('Vault: unlock', 'vault.sliccy.ai', 'token=abc'), []);
  guarded.close?.();
  transport.close();
});
