import assert from 'node:assert/strict';
import test from 'node:test';
import { browserHook, browserHosts } from '../../src/seed/cdp.js';
import { guardProtected } from '../../src/seed/guard.js';
import { watchSignIns } from '../../src/seed/held.js';

const SEVEN = 'https://seven.invalid';
const MARK = 'CUT-SIGN-IN-BODY';
const CALLBACK = 'https://www.sliccy.ai/auth/callback';
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

const SIGN_INS = {
  'seven’s callback, encoded': idp(encodeURIComponent(CALLBACK)),
  'seven’s callback cut to its origin by slicc-cli’s link guard': idp('https://www.sliccy.ai'),
  'seven’s callback cut to its origin, encoded again': idp(
    encodeURIComponent('https://www.sliccy.ai')
  ),
  'seven’s callback cut to its host': idp('www.sliccy.ai'),
  'a sign-in nested in another URL whose callback was cut': `https://idp.example/login?next=${encodeURIComponent(
    'https://idp.example/ims/authorize/v2?client_id=any&redirect_uri='
  )}https://www.sliccy.ai${encodeURIComponent('&response_type=token')}`,
};

for (const [name, url] of Object.entries(SIGN_INS))
  test(`on the link route, a sign-in tab with ${name} is not listed, attached or read`, {
    timeout: 30000,
  }, async () => {
    const open = browser({
      signin: { type: 'page', url, title: `${MARK}-title` },
      ordinary: { type: 'page', url: 'https://ordinary.invalid/page', title: 'Ordinary' },
    });
    const hook = browserHook((connection) => connection, linked(open), [SEVEN]);
    const agent = await client(hook);
    try {
      const seen = await reach(agent, 'signin');
      assert.equal(seen.listed, false, JSON.stringify(seen));
      assert.match(seen.info, /^slicc: refused:/, JSON.stringify(seen));
      assert.match(seen.attach, /^slicc: refused:/, JSON.stringify(seen));
      assert.equal(
        seen.reached,
        false,
        `the sign-in page reached the client: ${JSON.stringify(seen)}`
      );
      const listed = (await agent.send('Target.getTargets')).result.targetInfos;
      assert.ok(
        listed.some((info) => info.targetId === 'ordinary'),
        'the ordinary tab is still listed'
      );
    } finally {
      agent.close();
    }
  });

test('on the link route, a page linking to another sliccy.ai address stays drivable', {
  timeout: 30000,
}, async () => {
  const open = browser({
    other: {
      type: 'page',
      url: idp(encodeURIComponent('https://vault.sliccy.ai')),
      title: 'Other',
    },
  });
  const hook = browserHook((connection) => connection, linked(open), [SEVEN]);
  const agent = await client(hook);
  try {
    const seen = await reach(agent, 'other');
    assert.equal(seen.listed, true, JSON.stringify(seen));
    assert.equal(seen.attach, 'attached', JSON.stringify(seen));
  } finally {
    agent.close();
  }
});

test('with only a linked seven browser, seven’s sign-in popup, shown by slicc-cli as plain about:blank, is held and stays out of reach on an ordinary page', {
  timeout: 30000,
}, async () => {
  const infos = {
    seven: { type: 'page', url: `${SEVEN}/os/`, title: 'seven' },
    popup: { type: 'page', url: 'about:blank', title: 'about:blank', openerId: 'seven' },
    ordinary: { type: 'page', url: 'https://ordinary.invalid/page', title: 'Ordinary' },
  };
  const open = browser(infos);
  const links = linked(open);
  const sent = [];
  let channel;
  const stop = watchSignIns({
    hosts: () => browserHosts(undefined, undefined, links),
    own: SEVEN,
    storage: undefined,
    listen: () => {
      channel = { postMessage: (data) => sent.push(data), close() {}, onmessage: null };
      return channel;
    },
  });
  try {
    channel.onmessage({ data: { type: 'hold', marker: 'link-held' } });
    for (let n = 0; n < 1200 && !sent.length; n++) await pause(5);
    assert.deepEqual(sent, [{ type: 'held', marker: 'link-held' }]);
    infos.popup = {
      type: 'page',
      url: 'https://ordinary.invalid/held',
      title: `${MARK}-held`,
      openerId: 'seven',
    };
    const hook = browserHook((connection) => connection, links, [SEVEN]);
    const agent = await client(hook);
    try {
      const seen = await reach(agent, 'popup');
      assert.equal(seen.listed, false, JSON.stringify(seen));
      assert.match(seen.attach, /^slicc: refused:/, JSON.stringify(seen));
      assert.equal(seen.reached, false, JSON.stringify(seen));
      const plain = await reach(agent, 'ordinary');
      assert.equal(plain.attach, 'attached', JSON.stringify(plain));
    } finally {
      agent.close();
    }
  } finally {
    stop();
  }
});

test('on a linked seven browser, an ordinary page’s about:blank popup is not taken for seven’s sign-in popup, and stays drivable', {
  timeout: 30000,
}, async () => {
  const infos = {
    plain: { type: 'page', url: 'https://ordinary.invalid/opener', title: 'Opener' },
    blank: { type: 'page', url: 'about:blank', title: 'about:blank', openerId: 'plain' },
  };
  const open = browser(infos);
  const links = linked(open);
  const sent = [];
  let channel;
  let now = 0;
  const stop = watchSignIns({
    hosts: () => browserHosts(undefined, undefined, links),
    own: SEVEN,
    storage: undefined,
    now: () => now,
    sleep: () => {
      now += 10000;
      return Promise.resolve();
    },
    listen: () => {
      channel = { postMessage: (data) => sent.push(data), close() {}, onmessage: null };
      return channel;
    },
  });
  try {
    channel.onmessage({ data: { type: 'hold', marker: 'not-ours' } });
    for (let n = 0; n < 1200 && !sent.length; n++) await pause(5);
    assert.deepEqual(sent, [{ type: 'unheld', marker: 'not-ours' }]);
    infos.blank = { ...infos.blank, url: 'https://ordinary.invalid/popup', title: 'Popup' };
    const agent = await client(browserHook((connection) => connection, links, [SEVEN]));
    try {
      const seen = await reach(agent, 'blank');
      assert.equal(seen.listed, true, JSON.stringify(seen));
      assert.equal(seen.attach, 'attached', JSON.stringify(seen));
    } finally {
      agent.close();
    }
  } finally {
    stop();
  }
});

const REFERS = 'https://ordinary.invalid/page?from=https://www.sliccy.ai';
const DEEPER = 'https://ordinary.invalid/page?from=https://www.sliccy.ai/blog/post';

test('an ordinary page naming https://www.sliccy.ai alone in its query is hidden on the link route only, and one naming a deeper sliccy.ai page is not', {
  timeout: 30000,
}, async () => {
  const infos = {
    refers: { type: 'page', url: REFERS, title: 'Refers' },
    deeper: { type: 'page', url: DEEPER, title: 'Deeper' },
  };
  const link = await client(
    browserHook((connection) => connection, linked(browser(infos)), [SEVEN])
  );
  const open = browser(infos);
  const devtools = await client(async () =>
    guardProtected(await open(), [SEVEN], new Map(), undefined)
  );
  try {
    const onLink = await reach(link, 'refers');
    assert.equal(onLink.listed, false, JSON.stringify(onLink));
    assert.match(onLink.attach, /^slicc: refused:/, JSON.stringify(onLink));
    const deeper = await reach(link, 'deeper');
    assert.equal(deeper.attach, 'attached', JSON.stringify(deeper));
    const elsewhere = await reach(devtools, 'refers');
    assert.equal(elsewhere.attach, 'attached', JSON.stringify(elsewhere));
  } finally {
    link.close();
    devtools.close();
  }
});
