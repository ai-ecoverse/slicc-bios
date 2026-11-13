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
  const shape = (type, tab) => ({
    type,
    url: tab.url,
    title: tab.title ?? tab.url,
    ...(tab.opener ? { openerId: tab.opener, canAccessOpener: true } : {}),
  });
  const pages = Object.fromEntries(
    Object.values(tabs).map((tab) => [tab.page, shape('page', tab)])
  );
  const infos = {
    ...pages,
    ...Object.fromEntries(Object.entries(tabs).map(([id, tab]) => [id, shape('tab', tab)])),
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

const HELD_TITLE = 'HELD-TAB-TITLE';
const OPENER = 'opener-of-held';
const AUTO = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{}] };

function client(route, tabs) {
  const guarded = guardProtected(chrome(tabs), [SEVEN], new Map(), route);
  const got = [];
  guarded.onmessage = (text) => got.push(JSON.parse(text));
  let id = 0;
  const send = async (method, params = {}, sessionId) => {
    id += 1;
    const mine = id;
    guarded.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
    for (let n = 0; n < 1200 && !got.some((message) => message.id === mine); n++) await pause(5);
    return got.find((message) => message.id === mine);
  };
  const tab = (targetId) =>
    got.find(
      (message) =>
        message.method === 'Target.attachedToTarget' &&
        message.sessionId === undefined &&
        message.params.targetInfo.targetId === targetId
    );
  const destroyed = (targetId) =>
    got.filter(
      (message) =>
        message.method === 'Target.targetDestroyed' && message.params.targetId === targetId
    ).length;
  const pageUnder = (session) =>
    got.find(
      (message) => message.method === 'Target.attachedToTarget' && message.sessionId === session
    );
  const until = async (check) => {
    for (let n = 0; n < 1000 && !check(); n++) await pause(10);
    return check();
  };
  return { send, got, tab, destroyed, pageUnder, until };
}

const ROUTES = [
  ['devtools', undefined],
  ['link', { kind: 'link', version: '1.67.4' }],
];
const PATHS = {
  'a refused Target.setAutoAttach': async (c, session) => {
    await c.send('Target.setAutoAttach', AUTO, session);
  },
  'Runtime.runIfWaitingForDebugger first, then Target.setAutoAttach': async (c, session) => {
    await c.send('Runtime.runIfWaitingForDebugger', {}, session);
    await c.send('Target.setAutoAttach', AUTO, session);
  },
  'both at once, as Puppeteer sends them': async (c, session) => {
    await Promise.all([
      c.send('Target.setAutoAttach', AUTO, session),
      c.send('Runtime.runIfWaitingForDebugger', {}, session),
    ]);
  },
};

for (const [name, route] of ROUTES)
  for (const [path, drive] of Object.entries(PATHS))
    test(`on the ${name} route, a held sign-in tab cut on ${path} shows the client only its id, and goes away once, while the ordinary tab gets its page`, {
      timeout: 30000,
    }, async () => {
      const page = `held-${name}-${Object.keys(PATHS).indexOf(path)}`;
      hold(page);
      const c = client(route, {
        'tab-held': { page, url: HELD_URL, title: HELD_TITLE, opener: OPENER },
        'tab-plain': { page: 'plain-page', url: ORDINARY },
      });
      await c.send('Target.setDiscoverTargets', { discover: true, filter: [{}] });
      await c.send('Target.setAutoAttach', { ...AUTO, filter: PUPPETEER_TABS });
      const held = c.tab('tab-held');
      const plain = c.tab('tab-plain');
      assert.ok(held && plain, JSON.stringify(c.got));
      assert.deepEqual(
        { url: held.params.targetInfo.url, title: held.params.targetInfo.title },
        { url: '', title: '' }
      );
      assert.equal(held.params.targetInfo.openerId, undefined);
      await drive(c, held.params.sessionId);
      await c.send('Target.setAutoAttach', AUTO, plain.params.sessionId);
      assert.ok(await c.until(() => c.destroyed('tab-held') > 0), JSON.stringify(c.got));
      assert.ok(
        await c.until(() => c.pageUnder(plain.params.sessionId)),
        'the ordinary tab got its page'
      );
      await pause(100);
      assert.equal(c.destroyed('tab-held'), 1, 'the held tab went away once');
      assert.equal(c.destroyed('tab-plain'), 0, 'the ordinary tab was destroyed');
      assert.equal(
        c.pageUnder(held.params.sessionId),
        undefined,
        'a page under the held tab was shown'
      );
      const text = JSON.stringify(c.got);
      for (const secret of [page, OPENER, HELD_TITLE, '/held'])
        assert.ok(!text.includes(secret), `${secret} reached the client: ${text}`);
    });

for (const [name, route] of ROUTES)
  test(`on the ${name} route, an ordinary tab whose page is held later goes away once on its next command, and an ordinary tab never does`, {
    timeout: 30000,
  }, async () => {
    const page = `later-${name}`;
    const c = client(route, {
      'tab-later': { page, url: HELD_URL, title: HELD_TITLE },
      'tab-plain': { page: 'plain-page', url: ORDINARY },
    });
    await c.send('Target.setAutoAttach', { ...AUTO, filter: PUPPETEER_TABS });
    const later = c.tab('tab-later');
    const plain = c.tab('tab-plain');
    for (const one of [later, plain])
      await c.send('Target.setAutoAttach', AUTO, one.params.sessionId);
    assert.ok(
      await c.until(
        () => c.pageUnder(later.params.sessionId) && c.pageUnder(plain.params.sessionId)
      )
    );
    assert.equal(c.destroyed('tab-later'), 0);
    hold(page);
    const refused = await c.send('Runtime.runIfWaitingForDebugger', {}, later.params.sessionId);
    assert.match(refused.error?.message ?? '', /^slicc: refused:/, JSON.stringify(refused));
    assert.ok(await c.until(() => c.destroyed('tab-later') > 0), JSON.stringify(c.got));
    const again = await c.send('Target.getTargetInfo', {}, later.params.sessionId);
    assert.ok(again.error, JSON.stringify(again));
    assert.ok((await c.send('Target.getTargetInfo', {}, plain.params.sessionId)).result);
    await pause(100);
    assert.equal(c.destroyed('tab-later'), 1);
    assert.equal(c.destroyed('tab-plain'), 0);
  });
