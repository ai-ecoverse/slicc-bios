import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { CHANNEL, relayed } from '../../src/seed/adobe.js';
import { relay } from '../../src/seed/callback.js';
import { enter } from '../../src/seed/entry.js';
import { HUB_KEY, serveHubBase } from '../../src/seed/serve-hub.js';
import { notSevenText, refusesBoot, sevenHost } from '../../src/seed/seven-host.js';
import { TRAY_HUB_KEY } from '../../src/seed/tray.js';
import { AGENT, agentRefused, MCP_CALLBACK } from '../../src/sw/agent.js';

const SEED = new URL('../../src/seed/', import.meta.url);
const HOME = 'https://home.test';
const STORED = 'https://hub.test';
const STOP = 'the test stops the module here';

const handler = {
  get(_target, key) {
    if (key === 'then') return undefined;
    if (key === Symbol.iterator) return function* () {};
    if (key === Symbol.asyncIterator) return async function* () {};
    if (key === Symbol.toPrimitive) return () => '';
    if (typeof key === 'symbol') return undefined;
    return universal;
  },
  apply: () => {
    seen.called = (seen.called ?? 0) + 1;
    return universal;
  },
  construct: () => {
    seen.called = (seen.called ?? 0) + 1;
    return universal;
  },
  set: () => true,
  has: () => false,
};
const universal = new Proxy(() => {}, handler);
const seen = {};
globalThis.sevenHostSites = { universal, seen, STOP };

const real = (file) => new URL(file, SEED).href;
const PRELUDE =
  'const U = globalThis.sevenHostSites.universal; const seen = globalThis.sevenHostSites.seen; const STOP = globalThis.sevenHostSites.STOP;';
const SITE = `export const home = () => '${HOME}'; export const BIOS = '${HOME}/'; export const sharesOrigin = () => false; export const neverCached = () => {};`;

const own = {
  'os.js': {
    '@ai-ecoverse/slicc-kernel':
      'export const attachKernel = U; export const createKernel = U; export const serveHostfsPort = U;',
    '@ai-ecoverse/slicc-spectrum/ui': 'export const confirm = U; export const surfaces = [];',
    './site.js': SITE,
    './leaders.js': 'export const proxyOf = (hub) => { seen.hub = hub; return U; };',
    './tray.js': `export { TRAY_HUB_KEY } from '${real('tray.js')}';`,
    './serve.js': `export { serveHubBase } from '${real('serve-hub.js')}'; export const publicPreviews = ({ base }) => { seen.base = base; throw new Error(STOP); };`,
  },
  'follower.js': {
    './site.js': SITE,
    './follow.js': 'export const takeFollow = () => { seen.took = true; return null; };',
  },
  'join.js': {
    '@ai-ecoverse/slicc-spectrum/ui': '',
    './site.js': SITE,
    './follow.js':
      'export const hubClient = ({ origin }) => { seen.origin = origin; throw new Error(STOP); };',
  },
};
const unrefused = `export { notSeven, notSevenText, sevenHost } from '${real('seven-host.js')}'; export const refusesBoot = () => false;`;

function importsOf(file) {
  const source = readFileSync(new URL(file, SEED), 'utf8');
  const names = new Map();
  for (const [, clause, from] of source.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)';/gm)) {
    const list = /\{([\s\S]*)\}/.exec(clause)?.[1] ?? '';
    names.set(
      from,
      list
        .split(',')
        .map((part) => part.trim().split(/\s+as\s+/)[0])
        .filter(Boolean)
    );
  }
  return names;
}
const imports = Object.fromEntries(Object.keys(own).map((file) => [file, importsOf(file)]));

function target(parentURL) {
  const url = URL.parse(parentURL ?? '');
  if (!url?.href.startsWith(SEED.href) || !url.searchParams.has('sites')) return null;
  const file = url.pathname.split('/').at(-1);
  return file in own ? { file, url } : null;
}

registerHooks({
  resolve(specifier, context, next) {
    const from = target(context.parentURL);
    if (!from) return next(specifier, context);
    if (specifier === './seven-host.js') {
      if (from.url.searchParams.get('refusal') !== 'off') return next(specifier, context);
      return { url: `stub:${from.file}:unrefused`, shortCircuit: true };
    }
    return { url: `stub:${from.file}:${encodeURIComponent(specifier)}`, shortCircuit: true };
  },
  load(url, context, next) {
    if (!url.startsWith('stub:')) return next(url, context);
    const [, file, encoded] = url.split(':');
    if (encoded === 'unrefused') return { format: 'module', source: unrefused, shortCircuit: true };
    const specifier = decodeURIComponent(encoded);
    const given = own[file][specifier] ?? '';
    const names = (imports[file].get(specifier) ?? []).filter(
      (name) =>
        name !== 'default' &&
        !given.includes(`const ${name} `) &&
        !given.includes(` ${name} }`) &&
        !given.includes(`{ ${name},`)
    );
    const source = [
      PRELUDE,
      'export default U;',
      given,
      ...names.map((name) => `export const ${name} = U;`),
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});

function memory(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function page() {
  const elements = new Map();
  const element = () => ({ hidden: false, className: '', textContent: '', setAttribute() {} });
  const body = {
    children: [],
    replaceChildren(...nodes) {
      this.children = nodes;
    },
  };
  return {
    documentElement: { style: {}, dataset: {} },
    body,
    location: { hash: '' },
    createElement: (tag) => ({
      tag,
      dataset: {},
      children: [],
      textContent: '',
      append(...nodes) {
        this.children.push(...nodes);
      },
      addEventListener() {},
    }),
    getElementById: (id) => elements.get(`#${id}`) ?? null,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    addEventListener() {},
    said: () => elements.get('[data-seat-state]')?.textContent ?? null,
    shown() {
      const [box] = body.children;
      if (!box) return null;
      return {
        refused: box.dataset.refused,
        text: box.children.map((node) => `${node.tag}: ${node.textContent}`),
      };
    },
  };
}

const refusal = (origin) => ({
  refused: 'not-seven',
  text: ['h1: Seven doesn’t run here', `p: ${notSevenText(origin)}`],
});

function place(href, stored = {}) {
  for (const key of Object.keys(seen)) delete seen[key];
  globalThis.location = new URL(href);
  globalThis.document = page();
  globalThis.history = { state: null, replaceState() {} };
  for (const [name, value] of [
    ['localStorage', memory(stored)],
    ['sessionStorage', memory()],
    ['navigator', universal],
  ])
    Object.defineProperty(globalThis, name, { value, configurable: true });
}

let run = 0;
let module = null;
const load = (file, query = '') =>
  import(`${new URL(file, SEED).href}?sites=${++run}${query}`).then(
    (loaded) => {
      module = loaded;
      return null;
    },
    (error) => error.message
  );

const START = new URL('../../src/seed/start.js', import.meta.url).href;
place('https://lease-pilot.sliccy.ai/os/');
globalThis.addEventListener = () => {};
const started = await import(START);
assert.deepEqual(document.shown(), refusal('https://lease-pilot.sliccy.ai'));

const PILOT = [
  'https://lease-pilot.sliccy.ai/os/',
  'https://LEASE-PILOT.SLICCY.AI/os/',
  'https://lease-pilot.sliccy.ai./os/',
  'https://lease-pilot.sliccy.ai:443/os/',
  'https://lease-pilot.sliccy.ai:8443/os/',
  'https://a.lease-pilot.sliccy.ai/os/',
  'https://vault.sliccy.ai/os/',
  'https://x.vault-preview.sliccy.ai/os/',
  'https://echo.sliccy.ai/os/',
  'https://vault-x.sliccy.ai/os/',
  'http://seven.sliccy.ai/os/',
];
const SEVEN = [
  'https://seven.sliccy.ai/os/',
  'https://www.sliccy.ai/7/os/',
  'https://bb-x.sliccy.ai/os/',
  'https://seven.sliccy.ai:8443/os/',
  'https://a.seven.sliccy.ai/os/',
  'https://lease-pilot-x.sliccy.ai/os/',
  'https://xlease-pilot.sliccy.ai/os/',
];
const ELSEWHERE = ['http://127.0.0.1:8080/os/', 'https://example.test/os/'];

test('os.js tray leader: lease-pilot.sliccy.ai and the excluded labels lead no tray through their own origin, only the stored tray hub', async () => {
  for (const href of [...PILOT, ...ELSEWHERE]) {
    place(href);
    assert.equal(await load('os.js', '&refusal=off'), STOP, href);
    assert.equal(seen.hub, null, href);
    place(href, { [TRAY_HUB_KEY]: STORED });
    assert.equal(await load('os.js', '&refusal=off'), STOP, href);
    assert.equal(seen.hub, STORED, href);
  }
});

test('os.js tray leader: seven, www, previews and their lookalikes still lead the tray through their own origin', async () => {
  for (const href of SEVEN) {
    place(href, { [TRAY_HUB_KEY]: STORED });
    assert.equal(await load('os.js'), STOP, href);
    assert.equal(seen.hub, HOME, href);
  }
});

test('os.js serve hub: lease-pilot.sliccy.ai and the excluded labels publish previews only through a stored serve hub; seven and previews through their own origin', async () => {
  for (const href of [...PILOT, ...ELSEWHERE]) {
    place(href);
    assert.equal(await load('os.js', '&refusal=off'), STOP, href);
    assert.equal(seen.base, null, href);
    place(href, { [HUB_KEY]: STORED });
    assert.equal(await load('os.js', '&refusal=off'), STOP, href);
    assert.equal(seen.base, STORED, href);
  }
  for (const href of SEVEN) {
    place(href, { [HUB_KEY]: STORED });
    assert.equal(await load('os.js'), STOP, href);
    assert.equal(seen.base, HOME, href);
  }
});

test('follower.js proxied(): a follower on lease-pilot.sliccy.ai or an excluded label calls the hub itself, not through its own origin', async () => {
  place('https://seven.sliccy.ai/os/');
  assert.equal(await load('follower.js'), null);
  const { proxied } = module;
  for (const href of [...PILOT, ...ELSEWHERE]) assert.equal(proxied(new URL(href)), null, href);
  for (const href of PILOT.filter((href) => href.startsWith('https:'))) {
    const { hostname } = new URL(href);
    for (const name of [hostname.toUpperCase(), `${hostname}.`])
      assert.equal(proxied({ protocol: 'https:', hostname: name }), null, name);
  }
  for (const href of SEVEN) assert.equal(proxied(new URL(href)), HOME, href);
});

test('join.js: a guest link on lease-pilot.sliccy.ai or an excluded label shows the refusal and builds no hub client', async () => {
  for (const href of PILOT) {
    place(`${href}join.html`);
    assert.equal(await load('join.js'), null, href);
    assert.deepEqual(document.shown(), refusal(new URL(href).origin), href);
    assert.equal('origin' in seen, false, href);
  }
  for (const href of [...SEVEN, ...ELSEWHERE]) {
    place(`${href}join.html`);
    assert.equal(await load('join.js'), STOP, href);
  }
});

test('join.js hub origin: past the refusal, lease-pilot.sliccy.ai and the excluded labels call the hub itself; seven and previews go through their own origin', async () => {
  for (const href of [...PILOT, ...ELSEWHERE]) {
    place(`${href}join.html`);
    assert.equal(await load('join.js', '&refusal=off'), STOP, href);
    assert.equal(seen.origin, null, href);
  }
  for (const href of SEVEN) {
    place(`${href}join.html`);
    assert.equal(await load('join.js', '&refusal=off'), STOP, href);
    assert.equal(seen.origin, HOME, href);
  }
});

test('os.js loaded straight on lease-pilot.sliccy.ai or an excluded label shows the refusal, throws it and calls nothing it imports', async () => {
  for (const href of PILOT) {
    place(href, { [TRAY_HUB_KEY]: STORED, [HUB_KEY]: STORED });
    assert.equal(await load('os.js'), notSevenText(new URL(href).origin), href);
    assert.deepEqual(document.shown(), refusal(new URL(href).origin), href);
    assert.deepEqual(seen, {}, href);
  }
  for (const href of [...SEVEN, ...ELSEWHERE]) {
    place(href);
    assert.equal(await load('os.js'), STOP, href);
    assert.equal(document.shown(), null, href);
    assert.ok(seen.called > 0, href);
  }
});

test('follower.js loaded straight on lease-pilot.sliccy.ai or an excluded label shows the refusal and never reads the follow link', async () => {
  for (const href of PILOT) {
    place(`${href}#follow=${encodeURIComponent(`${STORED}/join/j1`)}`);
    assert.equal(await load('follower.js'), null, href);
    assert.deepEqual(document.shown(), refusal(new URL(href).origin), href);
    assert.deepEqual(seen, {}, href);
  }
  for (const href of [...SEVEN, ...ELSEWHERE]) {
    place(href);
    assert.equal(await load('follower.js'), null, href);
    assert.equal(document.shown(), null, href);
    assert.equal(seen.took, true, href);
  }
});

function callbackPage(href) {
  const msg = { textContent: 'Returning to SLICC…' };
  const opened = [];
  const posted = [];
  const location = new URL(href);
  const doc = page();
  doc.getElementById = (id) => (id === 'msg' ? msg : null);
  return {
    msg,
    opened,
    posted,
    doc,
    page: {
      location,
      history: { replaceState() {} },
      document: doc,
      close() {},
      listen(name) {
        opened.push(name);
        return { postMessage: (data) => posted.push(data), close() {} };
      },
      taken: `${location.origin}/auth/callback?nonce=n1#access_token=t0k3n&expires_in=60`,
    },
  };
}

test('callback.js (the sign-in callback) on lease-pilot.sliccy.ai or an excluded label hands no grant over and shows the refusal; on seven it still does', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const href of PILOT) {
    const {
      doc,
      opened,
      posted,
      page: at,
    } = callbackPage(`${href.replace(/os\/$/, '')}auth/callback`);
    relay(at);
    assert.deepEqual([opened, posted], [[], []], href);
    assert.deepEqual(doc.shown(), refusal(at.location.origin), href);
  }
  for (const href of [...SEVEN, ...ELSEWHERE]) {
    const {
      msg,
      opened,
      posted,
      page: at,
    } = callbackPage(`${href.replace(/os\/$/, '')}auth/callback`);
    relay(at);
    assert.deepEqual(opened, [CHANNEL], href);
    assert.equal(posted.length, 1, href);
    assert.equal(posted[0].nonce, 'n1', href);
    assert.equal(msg.textContent, 'Signed in. You can close this window.', href);
  }
});

function boot(href) {
  const calls = [];
  const doc = page();
  const called =
    (name, value) =>
    (...args) => {
      calls.push(name);
      return value?.(...args);
    };
  return started
    .start({
      at: new URL(href),
      doc,
      worker: () => true,
      storage: () => memory(),
      go: called('go'),
      target: called('target', async () => 'https://bios.test/'),
      seat: called('seat', () => null),
      handoff: async () => ({
        clearHandOff: called('clearHandOff'),
        dropped: called('dropped', () => null),
        droppedLine: () => '',
      }),
      follow: called('follow', async () => ({ takeFollow: () => true })),
      follower: called('follower', async () => {}),
      os: called('os', async () => {}),
      fail: called('fail'),
      check: called('check', async () => null),
    })
    .then(() => ({ calls, shown: doc.shown() }));
}

const LISTED = ['vault', 'vault-preview', 'get', 'mcpcat', 'echo', 'lease-pilot'];
const LABELS = [
  ...catalog.seven.excludedLabels.map((label) => [label, label]),
  ...catalog.seven.excludedLabelPrefixes.map((prefix) => [`${prefix}*`, `${prefix}x`]),
];

test('the pinned catalog excludes vault, vault-preview, get, mcpcat, echo, lease-pilot and every vault-* label from seven', () => {
  for (const label of LISTED) assert.ok(catalog.seven.excludedLabels.includes(label), label);
  assert.ok(catalog.seven.excludedLabelPrefixes.includes('vault-'));
});

for (const [name, label] of LABELS) {
  test(`${name}.sliccy.ai is not seven at any site, and every os/ entry refuses there`, async () => {
    const hosts = [
      `https://${label}.sliccy.ai/os/`,
      `https://${label.toUpperCase()}.SLICCY.AI/os/`,
      `https://${label}.sliccy.ai./os/`,
      `https://${label}.sliccy.ai:8443/os/`,
      `https://a.${label}.sliccy.ai/os/`,
    ];
    for (const href of hosts) {
      const at = new URL(href);
      const { protocol, hostname, origin } = at;
      assert.equal(sevenHost(at), false, href);
      assert.equal(refusesBoot(at), true, href);
      assert.equal(relayed(origin), false, href);
      assert.equal(serveHubBase({ protocol, hostname, home: HOME, storage: memory() }), null);
      assert.equal(
        serveHubBase({ protocol, hostname, home: HOME, storage: memory({ [HUB_KEY]: STORED }) }),
        STORED
      );

      place(href);
      assert.equal(await load('os.js'), notSevenText(origin), `os.js on ${href}`);
      assert.deepEqual([document.shown(), seen], [refusal(origin), {}], `os.js on ${href}`);
      place(href);
      assert.equal(await load('os.js', '&refusal=off'), STOP, href);
      assert.deepEqual([seen.hub, seen.base], [null, null], `os.js hubs on ${href}`);

      place(href);
      assert.equal(await load('follower.js'), null, `follower.js on ${href}`);
      assert.deepEqual([document.shown(), seen], [refusal(origin), {}], `follower.js on ${href}`);
      assert.equal(module.proxied(at), null, `proxied() on ${href}`);

      place(`${href}join.html`);
      assert.equal(await load('join.js'), null, `join.js on ${href}`);
      assert.deepEqual(document.shown(), refusal(origin), `join.js on ${href}`);
      assert.equal('origin' in seen, false, `join.js on ${href}`);
      place(`${href}join.html`);
      assert.equal(await load('join.js', '&refusal=off'), STOP, href);
      assert.equal(seen.origin, null, `join.js hub on ${href}`);

      assert.deepEqual(await boot(href), { calls: [], shown: refusal(origin) });

      const callback = callbackPage(`${origin}/auth/callback`);
      relay(callback.page);
      assert.deepEqual([callback.opened, callback.posted], [[], []], `callback on ${href}`);
      assert.deepEqual(callback.doc.shown(), refusal(origin), `callback on ${href}`);

      for (const asked of [
        MCP_CALLBACK,
        `${AGENT}node_modules/@ai-ecoverse/slicc-agent/dist/oauth/mcp-callback.html`,
      ])
        assert.equal(
          (await agentRefused(asked, at, () => catalog.seven))?.status,
          403,
          `${asked} on ${href}`
        );

      const wrapped = page();
      let opened = false;
      await enter(
        async () => {
          opened = true;
        },
        { at, doc: wrapped }
      );
      assert.deepEqual([opened, wrapped.shown()], [false, refusal(origin)], `wrapper on ${href}`);
    }
  });
}
