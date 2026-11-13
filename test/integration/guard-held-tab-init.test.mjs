import assert from 'node:assert/strict';
import test from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';

const SEVEN = 'https://seven.invalid';
const ORDINARY = 'https://ordinary.invalid/page';
const HELD_URL = 'https://ordinary.invalid/held';
const PUPPETEER_TABS = [{ type: 'page', exclude: true }, {}];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const origin = (url) => (URL.canParse(url) ? new URL(url).origin : '://');

function chrome(tabs) {
  const pages = Object.fromEntries(
    Object.values(tabs).map((tab) => [tab.page, { type: 'page', url: tab.url, title: tab.url }])
  );
  const infos = {
    ...pages,
    ...Object.fromEntries(
      Object.entries(tabs).map(([id, tab]) => [id, { type: 'tab', url: tab.url, title: tab.url }])
    ),
  };
  const owners = new Map();
  let sessions = 0;
  const connection = {
    onmessage: null,
    onclose: null,
    close() {},
    emit(message) {
      connection.onmessage?.(JSON.stringify(message));
    },
    send(text) {
      const command = JSON.parse(text);
      const owner = owners.get(command.sessionId);
      const reply = (result) =>
        queueMicrotask(() =>
          connection.emit({
            id: command.id,
            ...(command.sessionId ? { sessionId: command.sessionId } : {}),
            result,
          })
        );
      const attach = (targetId, parent) => {
        sessions += 1;
        const sessionId = `${targetId}~${sessions}`;
        owners.set(sessionId, targetId);
        connection.emit({
          method: 'Target.attachedToTarget',
          ...(parent ? { sessionId: parent } : {}),
          params: {
            sessionId,
            targetInfo: { targetId, attached: true, ...infos[targetId] },
            waitingForDebugger: false,
          },
        });
      };
      switch (command.method) {
        case 'Target.setAutoAttach':
          if (command.sessionId === undefined) {
            if (command.params?.filter?.some?.((entry) => entry.type === 'tab' && !entry.exclude))
              for (const id of Object.keys(tabs)) attach(id);
          } else if (tabs[owner]) attach(tabs[owner].page, command.sessionId);
          return reply({});
        case 'Target.getTargetInfo': {
          const targetId = command.params?.targetId ?? owner;
          return reply({ targetInfo: { targetId, attached: true, ...infos[targetId] } });
        }
        case 'Target.getTargets':
          return reply({
            targetInfos: Object.entries(pages).map(([targetId, info]) => ({
              targetId,
              attached: true,
              ...info,
            })),
          });
        case 'Target.attachToTarget': {
          sessions += 1;
          const sessionId = `${command.params.targetId}~${sessions}`;
          owners.set(sessionId, command.params.targetId);
          return reply({ sessionId });
        }
        case 'Page.getFrameTree': {
          const url = infos[owner]?.url ?? ORDINARY;
          return reply({
            frameTree: {
              frame: { id: `frame-${owner}`, loaderId: 'l', url, securityOrigin: origin(url) },
            },
          });
        }
        case 'Page.getNavigationHistory':
          return reply({
            currentIndex: 0,
            entries: [{ id: 0, url: infos[owner]?.url, title: '' }],
          });
        case 'DOM.getDocument':
          return reply({ root: { nodeId: 1, nodeName: '#document', children: [] } });
        default:
          return reply({});
      }
    },
  };
  return connection;
}

for (const route of [undefined, { kind: 'link', version: '1.67.4' }])
  test(`on the ${route?.kind ?? 'devtools'} route, a Puppeteer-shaped client that saw a held sign-in tab attach learns the tab is gone, so its connect can finish`, {
    timeout: 30000,
  }, async () => {
    hold(`held-page-${route?.kind ?? 'devtools'}`);
    const raw = chrome({
      'tab-held': { page: `held-page-${route?.kind ?? 'devtools'}`, url: HELD_URL },
      'tab-plain': { page: 'plain-page', url: ORDINARY },
    });
    const guarded = guardProtected(raw, [SEVEN], new Map(), route);
    const got = [];
    guarded.onmessage = (text) => got.push(JSON.parse(text));
    let id = 0;
    const send = async (method, params = {}, sessionId) => {
      id += 1;
      const mine = id;
      guarded.send(
        JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) })
      );
      for (let n = 0; n < 1200 && !got.some((message) => message.id === mine); n++) await pause(5);
      return got.find((message) => message.id === mine);
    };
    await send('Target.setDiscoverTargets', { discover: true, filter: [{}] });
    await send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: PUPPETEER_TABS,
    });
    const tabs = got.filter(
      (message) =>
        message.method === 'Target.attachedToTarget' &&
        message.sessionId === undefined &&
        message.params.targetInfo.type === 'tab'
    );
    const waiting = new Set(tabs.map((message) => message.params.targetInfo.targetId));
    for (const message of tabs)
      void send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{}] },
        message.params.sessionId
      );
    const settle = () => {
      for (const message of got) {
        if (message.method === 'Target.targetDestroyed') waiting.delete(message.params.targetId);
        if (message.method !== 'Target.attachedToTarget' || message.sessionId === undefined)
          continue;
        const parent = tabs.find((tab) => tab.params.sessionId === message.sessionId);
        if (parent) waiting.delete(parent.params.targetInfo.targetId);
      }
      return waiting.size === 0;
    };
    for (let n = 0; n < 1000 && !settle(); n++) await pause(10);
    assert.deepEqual(
      [...waiting],
      [],
      'every tab the client saw attach either got a page or went away'
    );
    const pagesShown = got
      .filter(
        (message) =>
          message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'page'
      )
      .map((message) => message.params.targetInfo.targetId);
    assert.deepEqual(pagesShown, ['plain-page']);
    assert.ok(!JSON.stringify(got).includes('/held'), 'the held page’s URL reached the client');
  });
