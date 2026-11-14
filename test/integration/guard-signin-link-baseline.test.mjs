import assert from 'node:assert/strict';
import test from 'node:test';
import { signIn } from '../../src/seed/adobe.js';
import { browserHook, browserHosts } from '../../src/seed/cdp.js';
import { guardProtected } from '../../src/seed/guard.js';
import { isHeld, watchSignIns } from '../../src/seed/held.js';

const SEVEN = 'https://seven.invalid';
const MARK = 'BASELINE-IDP-BODY';
const IDP = 'https://ims-na1.adobelogin.com/login';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const origin = (url) => (URL.canParse(url) ? new URL(url).origin : '://');

function bus() {
  const channels = new Set();
  const posted = [];
  const listen = (name) => {
    const channel = {
      name,
      onmessage: null,
      postMessage(data) {
        posted.push(data);
        for (const other of channels)
          if (other !== channel && other.name === name)
            queueMicrotask(() => other.onmessage?.({ data: structuredClone(data) }));
      },
      close() {
        channels.delete(channel);
      },
    };
    channels.add(channel);
    return channel;
  };
  return { listen, posted };
}

function browser(infos, { redacted }) {
  const owners = new Map();
  const later = [];
  let sessions = 0;
  let listings = 0;
  const own = (sessionId) => owners.get(sessionId) ?? sessionId?.split('~')[0];
  const shown = (info) =>
    redacted && info.url.startsWith('about:blank') ? { ...info, url: 'about:blank' } : info;
  const answer = (command) => {
    const owner = own(command.sessionId);
    switch (command.method) {
      case 'Target.getTargetInfo': {
        const targetId = command.params?.targetId ?? owner;
        if (!infos[targetId]) return { error: { code: -32602, message: 'No target' } };
        return { result: { targetInfo: { targetId, attached: false, ...shown(infos[targetId]) } } };
      }
      case 'Target.getTargets': {
        listings += 1;
        for (const step of later.filter((one) => one.at <= listings)) {
          later.splice(later.indexOf(step), 1);
          step.run();
        }
        return {
          result: {
            targetInfos: Object.entries(infos).map(([targetId, info]) => ({
              targetId,
              attached: false,
              ...shown(info),
            })),
          },
        };
      }
      case 'Target.attachToTarget': {
        sessions += 1;
        const sessionId = `${command.params.targetId}~${sessions}`;
        owners.set(sessionId, command.params.targetId);
        return { result: { sessionId } };
      }
      case 'Page.getFrameTree': {
        const url = infos[owner]?.url;
        return {
          result: {
            frameTree: {
              frame: { id: `frame-${owner}`, loaderId: 'l', url, securityOrigin: origin(url) },
            },
          },
        };
      }
      case 'Page.getNavigationHistory':
        return { result: { currentIndex: 0, entries: [{ id: 0, url: infos[owner]?.url }] } };
      case 'DOM.getDocument':
        return { result: { root: { nodeId: 1, nodeName: '#document', children: [] } } };
      case 'Runtime.evaluate':
        return { result: { result: { type: 'string', value: `${infos[owner]?.title} ${MARK}` } } };
      case 'Browser.getVersion':
        return { result: { product: 'Chrome/157', protocolVersion: '1.3' } };
      default:
        return { result: {} };
    }
  };
  const open = () => {
    const connection = {
      onmessage: null,
      onclose: null,
      close() {},
      send(text) {
        const command = JSON.parse(text);
        const reply = answer(command);
        queueMicrotask(() =>
          connection.onmessage?.(
            JSON.stringify({
              id: command.id,
              ...(command.sessionId ? { sessionId: command.sessionId } : {}),
              ...reply,
            })
          )
        );
      },
    };
    return Promise.resolve(connection);
  };
  open.after = (count, run) => later.push({ at: listings + count, run });
  return open;
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
      { expression: 'document.title', returnByValue: true },
      sessionId
    );
    seen.read = read.error?.message ?? read.result?.result?.value;
  }
  seen.reached = JSON.stringify(agent.got).includes(MARK);
  return seen;
}

function blank(id, opener = 'seven') {
  return { type: 'page', url: 'about:blank', title: 'about:blank', openerId: opener };
}

function opener(infos, open, { id, after = 0, idps, front = false }) {
  return (url) => {
    const appear = () => {
      const rest = Object.entries(infos).filter(([key]) => key !== 'seven');
      if (front) for (const [key] of rest) delete infos[key];
      infos[id] = { ...blank(id), url };
      if (front) Object.assign(infos, Object.fromEntries(rest));
    };
    if (after) open.after(after, appear);
    else appear();
    return {
      location: {
        set href(_) {
          idps.push({ id, held: isHeld(id, undefined), listed: Boolean(infos[id]) });
          infos[id] = {
            type: 'page',
            url: IDP,
            title: `${MARK}-idp`,
            openerId: 'seven',
            canAccessOpener: false,
          };
        },
      },
      close() {},
    };
  };
}

function owner({ route, open, listen }) {
  const hosts =
    route === 'link'
      ? () => browserHosts(undefined, undefined, linked(open))
      : () => ({ [route]: open });
  return watchSignIns({ hosts, own: SEVEN, storage: undefined, listen });
}

function guardFor(route, open) {
  if (route === 'link') return browserHook((connection) => connection, linked(open), [SEVEN]);
  const kind = route === 'extension' ? { kind: 'extension' } : undefined;
  return async () => guardProtected(await open(), [SEVEN], new Map(), kind, async () => []);
}

function start({ open: popup, listen, controller }) {
  const login = signIn({
    open: popup,
    listen,
    force: true,
    origin: SEVEN,
    holdWait: 3000,
    timeout: 60000,
  });
  return login
    .grant('adobe', async () => ({ clientId: 'baseline-client', scopes: 'openid' }), {
      signal: controller.signal,
    })
    .then(
      () => 'signed in',
      (error) => error.message
    );
}

async function navigated(idps, count = 1) {
  for (let n = 0; n < 1200 && idps.length < count; n++) await pause(5);
  return idps;
}

async function unreachable(route, open, ids) {
  const agent = await client(guardFor(route, open));
  try {
    for (const id of ids) {
      const seen = await reach(agent, id);
      assert.equal(seen.listed, false, `${id} is listed: ${JSON.stringify(seen)}`);
      assert.match(seen.attach, /^slicc: refused:/, `${id}: ${JSON.stringify(seen)}`);
      assert.equal(seen.reached, false, `${id} was read: ${JSON.stringify(seen)}`);
    }
  } finally {
    agent.close();
  }
}

const SCENES = {
  'a leftover seven about:blank, and the sign-in popup listed only later': {
    leftovers: ['L1'],
    popups: [{ id: 'R1', after: 2 }],
  },
  'two leftover seven about:blanks': {
    leftovers: ['L2a', 'L2b'],
    popups: [{ id: 'R2', after: 2 }],
  },
  'the sign-in popup listed before a leftover': {
    leftovers: ['L3'],
    popups: [{ id: 'R3', after: 0 }],
    first: true,
  },
  'a leftover that closes during the ask': {
    leftovers: ['L4'],
    popups: [{ id: 'R4', after: 3 }],
    closes: { id: 'L4', after: 2 },
  },
};

for (const [name, scene] of Object.entries(SCENES))
  test(`on the link route, with ${name}, the sign-in answers held only once its own popup is held, before the IdP, and the leftover isn't taken`, {
    timeout: 30000,
  }, async () => {
    const infos = { seven: { type: 'page', url: `${SEVEN}/os/`, title: 'seven' } };
    for (const id of scene.leftovers) infos[id] = blank(id);
    infos.ordinary = { type: 'page', url: 'https://ordinary.invalid/page', title: 'Ordinary' };
    const open = browser(infos, { redacted: true });
    if (scene.closes)
      open.after(scene.closes.after, () => {
        delete infos[scene.closes.id];
      });
    const { listen } = bus();
    const stop = owner({ route: 'link', open, listen });
    const controller = new AbortController();
    const idps = [];
    try {
      const [popup] = scene.popups;
      const real = opener(infos, open, { ...popup, idps, front: scene.first });
      const ended = start({ open: real, listen, controller });
      const [first] = await navigated(idps);
      assert.ok(
        first,
        `the sign-in never went to the IdP: ${await Promise.race([ended, pause(1)])}`
      );
      assert.deepEqual(first, { id: popup.id, held: true, listed: true });
      for (const id of scene.leftovers)
        assert.equal(isHeld(id, undefined), false, `the sign-in's hold took the leftover ${id}`);
      await unreachable('link', open, [popup.id]);
    } finally {
      controller.abort();
      stop();
    }
  });

test('on the link route, two overlapping sign-ins each answer held only once their own popup is held', {
  timeout: 30000,
}, async () => {
  const infos = { seven: { type: 'page', url: `${SEVEN}/os/`, title: 'seven' } };
  const open = browser(infos, { redacted: true });
  const { listen } = bus();
  const stop = owner({ route: 'link', open, listen });
  const controller = new AbortController();
  const idps = [];
  try {
    const one = start({
      open: opener(infos, open, { id: 'O1', after: 2, idps }),
      listen,
      controller,
    });
    const two = start({
      open: opener(infos, open, { id: 'O2', after: 4, idps }),
      listen,
      controller,
    });
    const both = await navigated(idps, 2);
    assert.equal(
      both.length,
      2,
      `both sign-ins went to the IdP: ${JSON.stringify(both)} ${await Promise.race([
        Promise.all([one, two]),
        pause(1),
      ])}`
    );
    assert.deepEqual(
      both.toSorted((a, b) => a.id.localeCompare(b.id)),
      [
        { id: 'O1', held: true, listed: true },
        { id: 'O2', held: true, listed: true },
      ]
    );
    await unreachable('link', open, ['O1', 'O2']);
  } finally {
    controller.abort();
    stop();
  }
});

test('on the link route, a sign-in whose popup never shows up is refused before the IdP, and the leftover is not taken', {
  timeout: 30000,
}, async () => {
  const infos = {
    seven: { type: 'page', url: `${SEVEN}/os/`, title: 'seven' },
    L5: blank('L5'),
  };
  const open = browser(infos, { redacted: true });
  const { listen } = bus();
  const stop = owner({ route: 'link', open, listen });
  const controller = new AbortController();
  const idps = [];
  try {
    let ended;
    void start({
      open: () => ({
        location: {
          set href(_) {
            idps.push('navigated');
          },
        },
        close() {},
      }),
      listen,
      controller,
    }).then((answer) => {
      ended = answer;
    });
    for (let n = 0; n < 2000 && ended === undefined && !idps.length; n++) await pause(5);
    assert.deepEqual(idps, []);
    assert.equal(
      ended,
      "Seven couldn't keep the sign-in window out of reach of browser automation, so it didn't open the sign-in. Try again."
    );
    assert.equal(isHeld('L5', undefined), false);
  } finally {
    controller.abort();
    stop();
  }
});

for (const route of ['devtools', 'extension'])
  test(`on the ${route} route, the sign-in still finds its popup by the marker, waits for it, and leaves a leftover seven about:blank alone`, {
    timeout: 30000,
  }, async () => {
    const id = `M-${route}`;
    const leftover = `L-${route}`;
    const infos = {
      seven: { type: 'page', url: `${SEVEN}/os/`, title: 'seven' },
      [leftover]: blank(leftover),
    };
    const open = browser(infos, { redacted: false });
    const { listen } = bus();
    const stop = owner({ route, open, listen });
    const controller = new AbortController();
    const idps = [];
    try {
      start({ open: opener(infos, open, { id, after: 2, idps }), listen, controller });
      const [first] = await navigated(idps);
      assert.deepEqual(first, { id, held: true, listed: true });
      assert.equal(isHeld(leftover, undefined), false);
      await unreachable(route, open, [id]);
    } finally {
      controller.abort();
      stop();
    }
  });
