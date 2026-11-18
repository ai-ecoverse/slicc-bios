import assert from 'node:assert/strict';
import test from 'node:test';
import { browserHook } from '../../src/seed/cdp.js';
import { guardProtected, signsIn } from '../../src/seed/guard.js';

const SEVEN = 'https://seven.invalid';
const MARK = 'ORIGIN-SIGN-IN-BODY';
const ORIGIN = 'https://www.sliccy.ai';
const idp = (redirect) =>
  `https://idp.example/ims/authorize/v2?client_id=any&redirect_uri=${redirect}&response_type=token`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const origin = (url) => (URL.canParse(url) ? new URL(url).origin : '://');

function browser(infos) {
  const owners = new Map();
  let sessions = 0;
  const own = (sessionId) => owners.get(sessionId) ?? sessionId?.split('~')[0];
  const answer = (command) => {
    const owner = own(command.sessionId);
    switch (command.method) {
      case 'Target.getTargetInfo': {
        const targetId = command.params?.targetId ?? owner;
        return { targetInfo: { targetId, attached: false, ...infos[targetId] } };
      }
      case 'Target.getTargets':
        return {
          targetInfos: Object.entries(infos).map(([targetId, info]) => ({
            targetId,
            attached: false,
            ...info,
          })),
        };
      case 'Target.attachToTarget': {
        sessions += 1;
        const sessionId = `${command.params.targetId}~${sessions}`;
        owners.set(sessionId, command.params.targetId);
        return { sessionId };
      }
      case 'Page.getFrameTree': {
        const url = infos[owner]?.url;
        return {
          frameTree: {
            frame: { id: `frame-${owner}`, loaderId: 'loader', url, securityOrigin: origin(url) },
          },
        };
      }
      case 'Page.getNavigationHistory':
        return { currentIndex: 0, entries: [{ id: 0, url: infos[owner]?.url, title: '' }] };
      case 'DOM.getDocument':
        return { root: { nodeId: 1, nodeName: '#document', children: [] } };
      case 'Runtime.evaluate':
        return { result: { type: 'string', value: `${infos[owner]?.title} ${MARK}` } };
      case 'Browser.getVersion':
        return { product: 'Chrome/157', protocolVersion: '1.3' };
      default:
        return {};
    }
  };
  return () => {
    const connection = {
      onmessage: null,
      onclose: null,
      close() {},
      send(text) {
        const command = JSON.parse(text);
        const result = answer(command);
        queueMicrotask(() =>
          connection.onmessage?.(
            JSON.stringify({
              id: command.id,
              ...(command.sessionId ? { sessionId: command.sessionId } : {}),
              result,
            })
          )
        );
      },
    };
    return Promise.resolve(connection);
  };
}

function linked(open) {
  return () => ({
    links: new Map([
      [
        'node',
        {
          label: 'seven-browser',
          mode: 'local',
          peer: { version: '1.67.4' },
          exit: { browsers: () => [{ id: 'chrome', seven: true }], cdp: () => open() },
        },
      ],
    ]),
  });
}

async function client(hook) {
  const connection = await hook({ caller: { kind: 'device', id: 'b', name: 'B' } });
  const got = [];
  connection.onmessage = (text) => got.push(JSON.parse(text));
  let id = 0;
  const send = async (method, params = {}, sessionId) => {
    id += 1;
    const mine = id;
    connection.send(
      JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) })
    );
    for (let n = 0; n < 1600 && !got.some((message) => message.id === mine); n++) await pause(5);
    const found = got.find((message) => message.id === mine);
    assert.ok(found, `${method} got an answer through the guard`);
    return found;
  };
  return { send, got, close: () => connection.close() };
}

async function reach(agent, targetId) {
  const listed = (await agent.send('Target.getTargets')).result?.targetInfos ?? [];
  const attached = await agent.send('Target.attachToTarget', { targetId, flatten: true });
  const seen = {
    listed: listed.some((info) => info.targetId === targetId),
    info: (await agent.send('Target.getTargetInfo', { targetId })).error?.message ?? 'answered',
    attach: attached.error?.message ?? 'attached',
  };
  const sessionId = attached.result?.sessionId;
  if (sessionId) {
    const read = await agent.send(
      'Runtime.evaluate',
      { expression: 'document.title + " " + document.body.innerText', returnByValue: true },
      sessionId
    );
    seen.read = read.error?.message ?? read.result?.result?.value;
  }
  seen.reached = JSON.stringify(agent.got).includes(MARK);
  return seen;
}

const ROUTES = {
  link: (open) => browserHook((connection) => connection, linked(open), [SEVEN]),
  devtools: (open) => async () => guardProtected(await open(), [SEVEN], new Map(), undefined),
  extension: (open) => async () =>
    guardProtected(await open(), [SEVEN], new Map(), { kind: 'extension' }, async () => []),
};

const HELD = {
  'seven’s bare origin': idp(ORIGIN),
  'seven’s bare origin, percent-encoded': idp(encodeURIComponent(ORIGIN)),
  'seven’s origin with a trailing slash': idp(`${ORIGIN}/`),
  'seven’s origin with a trailing slash, percent-encoded': idp(encodeURIComponent(`${ORIGIN}/`)),
  'a path on seven’s origin': idp(`${ORIGIN}/some/path`),
  'a path on seven’s origin, percent-encoded': idp(encodeURIComponent(`${ORIGIN}/some/path`)),
};

const DRIVABLE = {
  'an authorize URL whose redirect_uri names an ordinary origin': idp(
    'http://ordinary.example.test/cb'
  ),
  'an authorize URL whose redirect_uri names another sliccy.ai address': idp(
    encodeURIComponent('https://vault.sliccy.ai/cb')
  ),
  'an ordinary page naming www.sliccy.ai in its path and query':
    'http://ordinary.example.test/www.sliccy.ai/page?q=www.sliccy.ai/docs',
};

async function seen(route, url) {
  const open = browser({
    tab: { type: 'page', url, title: `${MARK}-title` },
    ordinary: { type: 'page', url: 'https://ordinary.invalid/page', title: 'Ordinary' },
  });
  const agent = await client(ROUTES[route](open));
  try {
    const tab = await reach(agent, 'tab');
    const listed = (await agent.send('Target.getTargets')).result.targetInfos;
    assert.ok(
      listed.some((info) => info.targetId === 'ordinary'),
      'the ordinary tab is still listed'
    );
    return tab;
  } finally {
    agent.close();
  }
}

for (const route of Object.keys(ROUTES)) {
  for (const [name, url] of Object.entries(HELD))
    test(`on the ${route} route, an authorize tab whose redirect_uri is ${name} is not listed, attached or read`, {
      timeout: 30000,
    }, async () => {
      const tab = await seen(route, url);
      assert.equal(tab.listed, false, JSON.stringify(tab));
      assert.match(tab.info, /^slicc: refused:/, JSON.stringify(tab));
      assert.match(tab.attach, /^slicc: refused:/, JSON.stringify(tab));
      assert.equal(
        tab.reached,
        false,
        `the sign-in page reached the client: ${JSON.stringify(tab)}`
      );
    });
  for (const [name, url] of Object.entries(DRIVABLE))
    test(`on the ${route} route, ${name} stays listed, attached and read`, {
      timeout: 30000,
    }, async () => {
      const tab = await seen(route, url);
      assert.equal(tab.listed, true, JSON.stringify(tab));
      assert.equal(tab.attach, 'attached', JSON.stringify(tab));
      assert.equal(tab.reached, true, JSON.stringify(tab));
    });
}

test('a page on seven’s origin that is not an authorize URL is not taken for a sign-in page on any route', () => {
  for (const url of [`${ORIGIN}/docs/`, `${ORIGIN}/7/`]) {
    assert.equal(signsIn(url), false, url);
    assert.equal(signsIn(url, { cut: true }), false, url);
  }
});
