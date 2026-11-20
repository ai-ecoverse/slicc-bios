import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';

const SEVEN = 'https://seven.invalid';
const SEVEN_PAGE = `${SEVEN}/os/`;
const VAULT = 'https://vault.sliccy.ai/doc?n=lag';
const VIEW_SOURCE_VAULT = `view-source:${VAULT}`;
const ORDINARY = 'https://ordinary.invalid/doc?n=lag';
const SECRET = 'lagging-attach-secret';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link' }],
  ['extension', { kind: 'extension' }],
];

const protectedPages = [
  ['a seven page', SEVEN_PAGE],
  ['view-source of the vault', VIEW_SOURCE_VAULT],
];

function originOf(url) {
  if (url.startsWith('view-source:')) {
    const inner = url.slice('view-source:'.length);
    return URL.canParse(inner) ? new URL(inner).origin : '://';
  }
  return URL.canParse(url) ? new URL(url).origin : '://';
}

function chrome(pages, { staleInfo = false } = {}) {
  const sent = [];
  const owners = new Map();
  let sessions = 0;
  const own = (sessionId) => owners.get(sessionId) ?? sessionId?.split('~')[0];
  const infoOf = (targetId) => {
    const page = pages[targetId];
    const url = staleInfo ? page.reported : page.current;
    return {
      targetId,
      type: 'page',
      title: url,
      url,
      attached: Boolean(owners.size),
      canAccessOpener: false,
      browserContextId: 'context',
    };
  };
  const connection = {
    sent,
    owners,
    onmessage: null,
    onclose: null,
    close() {},
    emit(message) {
      connection.onmessage?.(JSON.stringify(message));
    },
    announce(targetId) {
      const page = pages[targetId];
      page.reported = page.current;
      connection.emit({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: infoOf(targetId) },
      });
    },
    navigate(targetId, url) {
      const page = pages[targetId];
      page.current = url;
      page.frame = {
        id: targetId,
        loaderId: `loader-${url}`,
        url,
        securityOrigin: originOf(url),
        mimeType: 'text/html',
      };
    },
    send(text) {
      const command = JSON.parse(text);
      sent.push(command);
      const owner = own(command.sessionId);
      const reply = (payload) =>
        queueMicrotask(() =>
          connection.emit({
            id: command.id,
            ...(command.sessionId ? { sessionId: command.sessionId } : {}),
            ...payload,
          })
        );
      switch (command.method) {
        case 'Target.getTargetInfo': {
          const asked = command.params?.targetId ?? owner;
          if (!pages[asked])
            return reply({ error: { code: -32602, message: `no target ${asked}` } });
          return reply({ result: { targetInfo: infoOf(asked) } });
        }
        case 'Target.attachToTarget': {
          const targetId = command.params?.targetId;
          if (!pages[targetId])
            return reply({ error: { code: -32602, message: 'No target with given id found' } });
          sessions += 1;
          const sessionId = `${targetId}~${sessions}`;
          owners.set(sessionId, targetId);
          return reply({ result: { sessionId } });
        }
        case 'Target.detachFromTarget': {
          owners.delete(command.params?.sessionId);
          return reply({ result: {} });
        }
        case 'Target.getTargets':
          return reply({
            result: {
              targetInfos: Object.keys(pages).map((targetId) => infoOf(targetId)),
            },
          });
        case 'Page.getFrameTree':
          return reply({
            result: {
              frameTree: { frame: pages[owner]?.frame },
            },
          });
        case 'Page.getNavigationHistory':
          return reply({
            result: {
              currentIndex: 0,
              entries: [
                {
                  id: 0,
                  url: pages[owner]?.current,
                  userTypedURL: pages[owner]?.current,
                  title: '',
                },
              ],
            },
          });
        case 'DOM.getDocument':
          return reply({ result: { root: { nodeId: 1, nodeName: '#document', children: [] } } });
        case 'Runtime.evaluate':
          return reply({
            result: {
              result: {
                type: 'string',
                value:
                  command.params?.expression === 'location.href' ? pages[owner]?.current : SECRET,
              },
            },
          });
        case 'Network.getResponseBody':
          return reply({ result: { body: SECRET, base64Encoded: false } });
        case 'Page.captureScreenshot':
          return reply({ result: { data: Buffer.from(SECRET).toString('base64') } });
        default:
          return reply({ result: {} });
      }
    },
  };
  return connection;
}

function harness(t, pages, route, options) {
  const raw = chrome(pages, options);
  const guarded = guardProtected(raw, [SEVEN], new Map(), route);
  t.after(() => guarded.close?.());
  const got = [];
  guarded.onmessage = (text) => got.push(JSON.parse(text));
  let id = 0;
  const send = async (method, params = {}, sessionId) => {
    id += 1;
    const mine = id;
    guarded.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
    for (let n = 0; n < 800 && !got.some((message) => message.id === mine); n++) await tick();
    return got.find((message) => message.id === mine);
  };
  const created = (targetId) => {
    pages[targetId].reported = pages[targetId].current;
    raw.emit({
      method: 'Target.targetCreated',
      params: {
        targetInfo: {
          targetId,
          type: 'page',
          title: pages[targetId].reported,
          url: pages[targetId].reported,
          attached: false,
          canAccessOpener: false,
          browserContextId: 'context',
        },
      },
    });
  };
  const attachSent = (targetId) =>
    raw.sent.some(
      (command) =>
        command.method === 'Target.attachToTarget' &&
        command.params?.targetId === targetId &&
        command.id < 2 ** 30
    );
  const contentReached = (targetId) =>
    raw.sent.some(
      (command) =>
        command.id < 2 ** 30 &&
        [
          'Runtime.evaluate',
          'DOM.getDocument',
          'Network.getResponseBody',
          'Page.captureScreenshot',
        ].includes(command.method) &&
        raw.owners.get(command.sessionId) === targetId
    );
  const leaked = (...values) => values.filter((value) => JSON.stringify(got).includes(value));
  return { raw, got, send, created, attachSent, contentReached, leaked };
}

function blankPage() {
  return {
    reported: 'about:blank',
    current: 'about:blank',
    frame: {
      id: 'foreign',
      loaderId: 'blank',
      url: 'about:blank',
      securityOrigin: '://',
      mimeType: 'text/html',
    },
  };
}

for (const [name, route] of routes) {
  for (const [label, url] of protectedPages) {
    test(`on ${name}, explicit attach to another connection's target that navigated to ${label} is refused while targetInfoChanged still lags`, async (t) => {
      const pages = { foreign: blankPage() };
      const h = harness(t, pages, route);
      h.created('foreign');
      await tick();
      h.raw.navigate('foreign', url);
      const attached = await h.send('Target.attachToTarget', {
        targetId: 'foreign',
        flatten: true,
      });
      assert.equal(attached?.error?.message, PROTECTED, JSON.stringify(attached));
      assert.equal(attached?.result, undefined);
      assert.ok(!h.attachSent('foreign'));
      assert.ok(!h.contentReached('foreign'));
      assert.deepEqual(h.leaked(SECRET, 'vault.sliccy.ai', SEVEN_PAGE, VIEW_SOURCE_VAULT), []);
      h.raw.announce('foreign');
      await tick();
      const again = await h.send('Target.attachToTarget', {
        targetId: 'foreign',
        flatten: true,
      });
      assert.equal(again?.error?.message, PROTECTED, JSON.stringify(again));
      assert.equal(again?.result, undefined);
      assert.ok(!h.contentReached('foreign'));
      assert.deepEqual(h.leaked(SECRET, 'vault.sliccy.ai', SEVEN_PAGE, VIEW_SOURCE_VAULT), []);
    });

    test(`on ${name}, when getTargetInfo still reports about:blank after a navigate to ${label}, inspect refuses the attach answer before any content read`, async (t) => {
      const pages = { foreign: blankPage() };
      const h = harness(t, pages, route, { staleInfo: true });
      h.created('foreign');
      await tick();
      h.raw.navigate('foreign', url);
      const attached = await h.send('Target.attachToTarget', {
        targetId: 'foreign',
        flatten: true,
      });
      if (attached?.result?.sessionId) {
        const session = attached.result.sessionId;
        const evaluated = await h.send(
          'Runtime.evaluate',
          { expression: 'document.body.innerText' },
          session
        );
        const body = await h.send('Network.getResponseBody', { requestId: 'r1' }, session);
        const shot = await h.send('Page.captureScreenshot', {}, session);
        const dom = await h.send('DOM.getDocument', {}, session);
        assert.ok(
          evaluated?.error && body?.error && shot?.error && dom?.error,
          JSON.stringify({ attached, evaluated, body, shot, dom })
        );
        assert.ok(!h.contentReached('foreign'));
      } else {
        assert.ok(attached?.error, JSON.stringify(attached));
        assert.equal(attached?.result, undefined);
      }
      assert.ok(!h.contentReached('foreign'));
      assert.deepEqual(h.leaked(SECRET), []);
      h.raw.announce('foreign');
      await tick();
      const again = await h.send('Target.attachToTarget', {
        targetId: 'foreign',
        flatten: true,
      });
      assert.ok(again?.error, JSON.stringify(again));
      assert.equal(again?.result, undefined);
      assert.ok(!h.contentReached('foreign'));
      assert.deepEqual(h.leaked(SECRET), []);
    });
  }

  test(`on ${name}, an ordinary foreign target with a lagging targetInfoChanged still attaches and can be read`, async (t) => {
    const pages = { foreign: blankPage() };
    const h = harness(t, pages, route);
    h.created('foreign');
    await tick();
    h.raw.navigate('foreign', ORDINARY);
    const attached = await h.send('Target.attachToTarget', {
      targetId: 'foreign',
      flatten: true,
    });
    assert.equal(attached?.error, undefined, JSON.stringify(attached));
    assert.ok(attached?.result?.sessionId);
    const evaluated = await h.send(
      'Runtime.evaluate',
      { expression: 'document.body.innerText' },
      attached.result.sessionId
    );
    assert.equal(evaluated?.error, undefined, JSON.stringify(evaluated));
    assert.equal(evaluated?.result?.result?.value, SECRET);
    h.raw.announce('foreign');
    await tick();
  });
}
