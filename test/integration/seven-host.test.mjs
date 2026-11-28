import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { isSevenLabel } from '@ai-ecoverse/slicc-browsers/seven.mjs';
import { relayed } from '../../src/seed/adobe.js';
import { biosUrl, enter, LOADER } from '../../src/seed/entry.js';
import { forgetHandOffs, PREFIX } from '../../src/seed/handoff.js';
import { HUB_KEY, serveHubBase } from '../../src/seed/serve-hub.js';
import { notSevenText, refusesBoot, sevenHost } from '../../src/seed/seven-host.js';
import * as rule from '../../src/seed/seven-rule.js';
import {
  AGENT,
  AGENT_REFUSED,
  agentRefused,
  MCP_CALLBACK,
  POLICY_UNAVAILABLE,
} from '../../src/sw/agent.js';

const START = new URL('../../src/seed/start.js', import.meta.url).href;
const SEVEN_HOST = new URL('../../src/seed/seven-host.js', import.meta.url).href;
const CATALOG = import.meta.resolve('@ai-ecoverse/slicc-browsers/catalog.json');
const HOME = 'https://home.test';
const STORED = 'https://hub.test';

const PILOT = [
  'https://lease-pilot.sliccy.ai/',
  'https://LEASE-PILOT.SLICCY.AI/',
  'https://lease-pilot.sliccy.ai./',
  'https://Lease-Pilot.Sliccy.Ai../',
  'https://lease-pilot.sliccy.ai:443/',
  'https://lease-pilot.sliccy.ai:8443/',
  'https://a.lease-pilot.sliccy.ai/',
  'https://A.B.LEASE-PILOT.SLICCY.AI.:8443/',
];
const EXCLUDED = [
  ...catalog.seven.excludedLabels.flatMap((label) => [
    `https://${label}.sliccy.ai/`,
    `https://${label.toUpperCase()}.sliccy.ai./`,
    `https://x.${label}.sliccy.ai/`,
  ]),
  ...catalog.seven.excludedLabelPrefixes.flatMap((prefix) => [
    `https://${prefix}x.sliccy.ai/`,
    `https://y.${prefix}x.sliccy.ai:8443/`,
  ]),
];
const SEVEN = [
  'https://seven.sliccy.ai/',
  'https://www.sliccy.ai/',
  'https://bb-x.sliccy.ai/',
  'https://preview-seven.sliccy.ai/',
  'https://seven.sliccy.ai:8443/',
  'https://a.seven.sliccy.ai/',
  'https://lease-pilot-x.sliccy.ai/',
  'https://xlease-pilot.sliccy.ai/',
  'https://lease-pilots.sliccy.ai/',
  'https://lease.sliccy.ai/',
  'https://pilot.sliccy.ai/',
  'https://lease-pilot.x.sliccy.ai/',
  'https://vaultx.sliccy.ai/',
  'https://xn--fsq.sliccy.ai/',
];
const APEX = ['https://sliccy.ai/', 'https://SLICCY.AI./', 'https://sliccy.ai:8443/'];
const ELSEWHERE = [
  'https://lease-pilot.sliccy.ai.example.test/',
  'https://lease-pilot-sliccy.ai/',
  'https://seven.sliccy.aix/',
  'http://127.0.0.1:8080/',
  'http://localhost:8080/',
  'https://example.test/',
];
const PLAIN = [
  'http://seven.sliccy.ai/',
  'http://bb-x.sliccy.ai/',
  'http://lease-pilot.sliccy.ai/',
];

const at = (href) => new URL(href);
const named = (href) => ({ protocol: 'https:', hostname: new URL(href).hostname.toUpperCase() });

test('sevenHost: lease-pilot.sliccy.ai and every name under it, in any case, with trailing dots and on any port, is not seven', () => {
  for (const href of PILOT) {
    assert.equal(sevenHost(at(href)), false, href);
    assert.equal(sevenHost(named(href)), false, `${href} upper-cased`);
    assert.equal(sevenHost({ protocol: 'https:', hostname: `${at(href).hostname}.` }), false);
  }
});

test('sevenHost: every label and prefix the pinned catalog excludes, and every name under one, is not seven', () => {
  assert.ok(catalog.seven.excludedLabels.includes('lease-pilot'));
  for (const href of EXCLUDED) assert.equal(sevenHost(at(href)), false, href);
});

test('sevenHost: seven, www, previews, deeper names and lookalikes of the excluded labels stay seven', () => {
  for (const href of SEVEN) {
    assert.equal(sevenHost(at(href)), true, href);
    assert.equal(sevenHost(named(href)), true, `${href} upper-cased`);
    assert.equal(sevenHost({ protocol: 'https:', hostname: `${at(href).hostname}.` }), true);
  }
});

test('sevenHost: a host off sliccy.ai, and the bare sliccy.ai, is not seven', () => {
  for (const href of [...APEX, ...ELSEWHERE]) assert.equal(sevenHost(at(href)), false, href);
  for (const place of [{}, { protocol: 'https:' }, { protocol: 'https:', hostname: null }])
    assert.equal(sevenHost(place), false, JSON.stringify(place));
  assert.equal(sevenHost(), false);
});

test('sevenHost: no sliccy.ai host is seven over http:, or any scheme but https:', () => {
  for (const href of [...PLAIN, ...SEVEN.map((href) => href.replace('https:', 'http:'))])
    assert.equal(sevenHost(at(href)), false, href);
  for (const protocol of ['http:', 'wss:', 'ws:', 'ftp:', 'HTTPS:', '', undefined])
    assert.equal(sevenHost({ protocol, hostname: 'seven.sliccy.ai' }), false, String(protocol));
});

test('sevenHost: empty labels immediately under sliccy.ai refuse', () => {
  for (const hostname of [
    '.sliccy.ai',
    '..sliccy.ai',
    'leading..sliccy.ai',
    '.leading..sliccy.ai.',
  ]) {
    const place = { protocol: 'https:', hostname };
    assert.equal(sevenHost(place), false, hostname);
    assert.equal(refusesBoot(place), true, hostname);
  }
});

test('refusesBoot: an excluded label, a name under one, the bare sliccy.ai and any http: sliccy.ai host refuse; seven, previews and hosts off sliccy.ai boot', () => {
  for (const href of [...PILOT, ...EXCLUDED, ...PLAIN, ...APEX, 'http://sliccy.ai./'])
    assert.equal(refusesBoot(at(href)), true, href);
  for (const href of [...SEVEN, ...ELSEWHERE]) assert.equal(refusesBoot(at(href)), false, href);
  for (const place of [{}, { protocol: 'https:', hostname: '' }])
    assert.equal(refusesBoot(place), false);
  assert.equal(refusesBoot(), false);
});

test('adobe relayed(): the IMS relay never gets lease-pilot.sliccy.ai or an excluded label, and keeps seven and previews but not www', () => {
  for (const href of [...PILOT, ...EXCLUDED, ...PLAIN]) {
    assert.equal(relayed(at(href).origin), false, href);
    assert.equal(relayed(href.replace(/\/$/, '')), false, href);
  }
  for (const origin of [
    'https://seven.sliccy.ai',
    'https://bb-x.sliccy.ai',
    'https://lease-pilot-x.sliccy.ai',
  ])
    assert.equal(relayed(origin), true, origin);
  for (const origin of [
    'https://www.sliccy.ai',
    'https://a.seven.sliccy.ai',
    'https://seven.sliccy.ai:8443',
    'https://sliccy.ai',
    'http://127.0.0.1:8080',
    undefined,
    null,
    'null',
  ])
    assert.equal(relayed(origin), false, String(origin));
});

function storage(stored) {
  return { getItem: (key) => (key === HUB_KEY ? stored : null) };
}

test('serveHubBase(): lease-pilot.sliccy.ai and excluded labels use the stored serve hub or none, never their own origin', () => {
  for (const href of [...PILOT, ...EXCLUDED, ...PLAIN]) {
    const { protocol, hostname } = at(href);
    assert.equal(
      serveHubBase({ protocol, hostname, home: HOME, storage: storage(null) }),
      null,
      href
    );
    assert.equal(
      serveHubBase({ protocol, hostname, home: HOME, storage: storage(`${STORED}/`) }),
      STORED,
      href
    );
  }
  for (const href of SEVEN) {
    const { protocol, hostname } = at(href);
    assert.equal(
      serveHubBase({ protocol, hostname, home: HOME, storage: storage(STORED) }),
      HOME,
      href
    );
  }
});

function fakeDocument() {
  const body = {
    children: [],
    replaceChildren(...nodes) {
      this.children = nodes;
    },
  };
  const createElement = (tag) => ({
    tag,
    dataset: {},
    children: [],
    textContent: '',
    listeners: {},
    append(...nodes) {
      this.children.push(...nodes);
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  });
  return { body, createElement, location: { hash: '', reload() {} } };
}

function shown(doc) {
  const [box] = doc.body.children;
  if (!box) return null;
  return {
    refused: box.dataset.refused,
    text: box.children.map((node) => `${node.tag}: ${node.textContent}`),
  };
}

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
    keys: () => [...map.keys()],
  };
}

const POLICIES = {
  missing: undefined,
  null: null,
  empty: {},
  'no labels': { excludedLabels: [] },
  'an empty label': { excludedLabels: [''] },
  'labels as a string': { excludedLabels: 'lease-pilot' },
  'a number label': { excludedLabels: [7] },
  'a null label': { excludedLabels: ['lease-pilot', null] },
  'no prefixes': { excludedLabels: ['lease-pilot'], excludedLabelPrefixes: [] },
  'an empty prefix': { excludedLabels: ['lease-pilot'], excludedLabelPrefixes: [''] },
  'prefixes as a string': { excludedLabels: ['lease-pilot'], excludedLabelPrefixes: 'vault-' },
  'null prefixes': { excludedLabels: ['lease-pilot'], excludedLabelPrefixes: null },
};
const VALID = {
  pinned: catalog.seven,
  'labels only': { excludedLabels: ['lease-pilot'] },
};

const imported = [];
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === START) imported.push(specifier);
    const resolved = next(specifier, context);
    const policy = URL.parse(context.parentURL ?? '')?.searchParams.get('policy');
    if (!policy || !context.parentURL.startsWith(SEVEN_HOST) || resolved.url !== CATALOG)
      return resolved;
    return { ...resolved, url: `${CATALOG}?policy=${encodeURIComponent(policy)}` };
  },
  load(url, context, next) {
    if (!url.startsWith(`${CATALOG}?policy=`)) return next(url, context);
    const policy = new URL(url).searchParams.get('policy');
    if (policy === 'rejected') throw new Error('the catalog didn’t load');
    const seven = policy in POLICIES ? POLICIES[policy] : VALID[policy];
    const { seven: _, ...rest } = catalog;
    const source = JSON.stringify(seven === undefined ? rest : { ...rest, seven });
    return { format: 'json', source, shortCircuit: true };
  },
});
const withPolicy = (name) => import(`${SEVEN_HOST}?policy=${encodeURIComponent(name)}`);

const requests = [];
globalThis.fetch = (...args) => {
  requests.push(String(args[0]));
  return Promise.reject(new TypeError('no network in this test'));
};
globalThis.addEventListener = () => {};
globalThis.location = new URL('https://lease-pilot.sliccy.ai/os/');
globalThis.document = fakeDocument();
for (const name of ['localStorage', 'sessionStorage'])
  Object.defineProperty(globalThis, name, { value: memory(), configurable: true });
const loaded = await import(START);

const refusal = (origin) => ({
  refused: 'not-seven',
  text: ['h1: Seven doesn’t run here', `p: ${notSevenText(origin)}`],
});
const loader = {
  refused: 'loader',
  text: ['h1: Seven couldn’t open this page', `p: ${LOADER}`, 'button: Reload'],
};

test('start.js loaded on lease-pilot.sliccy.ai shows the refusal, imports only seven-host.js, and fetches nothing itself', () => {
  assert.deepEqual(shown(globalThis.document), refusal('https://lease-pilot.sliccy.ai'));
  assert.deepEqual(imported, ['./seven-host.js']);
  assert.deepEqual(requests, []);
});

function boot(href, { host = () => import(SEVEN_HOST), ...overrides } = {}) {
  const calls = [];
  const doc = fakeDocument();
  const kept = memory();
  const called =
    (name, value) =>
    (...args) => {
      calls.push(name);
      return value?.(...args);
    };
  const run = loaded.start({
    at: at(href),
    doc,
    worker: () => true,
    storage: called('storage', () => kept),
    go: called('go'),
    target: called('target', async () => 'https://bios.test/'),
    host: called('host', host),
    seat: called('seat', () => null),
    handoff: called('handoff', async () => ({
      clearHandOff: called('clearHandOff'),
      dropped: called('dropped', () => null),
      droppedLine: () => '',
      forgetHandOffs: called('forgetHandOffs'),
    })),
    follow: called('follow', async () => ({ takeFollow: () => false })),
    follower: called('follower', async () => {}),
    os: called('os', async () => {}),
    fail: called('fail', (_doc, _go, why) =>
      doc.body.replaceChildren({ dataset: {}, children: [{ tag: 'p', textContent: why }] })
    ),
    check: called('check', async () => null),
    ...overrides,
  });
  return run.then(() => ({ calls, shown: shown(doc), kept }));
}

test('start(): on lease-pilot.sliccy.ai, an excluded label or an http: sliccy.ai host the refusal shows, and it loads no os.js, follower or guest seat and fetches nothing', async () => {
  for (const href of [...PILOT, ...EXCLUDED, ...PLAIN, ...APEX]) {
    requests.length = 0;
    const { calls, shown: page } = await boot(href);
    assert.deepEqual(calls, ['host', 'storage'], href);
    assert.deepEqual(page, refusal(at(href).origin), href);
    assert.deepEqual(requests, [], href);
  }
});

test('start(): seven, www, previews and hosts off sliccy.ai still boot as before', async () => {
  for (const href of [...SEVEN, ...ELSEWHERE]) {
    const { calls, shown: page } = await boot(href);
    assert.deepEqual(
      calls,
      ['host', 'storage', 'handoff', 'dropped', 'seat', 'follow', 'os'],
      href
    );
    assert.equal(page, null, href);
  }
});

test('start(): the host check comes first, before any storage access, redirect or other import, on every host and when it can’t load', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const href of [...PILOT, ...EXCLUDED, ...PLAIN, ...APEX, ...SEVEN, ...ELSEWHERE]) {
    const { calls } = await boot(href);
    assert.equal(calls[0], 'host', href);
  }
  for (const worker of [true, false]) {
    const { calls } = await boot('https://lease-pilot.sliccy.ai/', {
      worker: () => worker,
      host: () => Promise.reject(new TypeError('no module')),
    });
    assert.equal(calls[0], 'host', `controlled: ${worker}`);
  }
});

test('start(): a refusal removes every hand-off key and the trip marker it finds, and the hand-off from the address', async () => {
  const href = 'https://lease-pilot.sliccy.ai/os/#handoff=a&keep=1';
  const now = Date.now();
  globalThis.location = new URL(href);
  const replaced = [];
  globalThis.history = { state: null, replaceState: (_state, _title, url) => replaced.push(url) };
  Object.defineProperty(globalThis, 'localStorage', {
    value: memory({
      [`${PREFIX}a`]: JSON.stringify({ at: now, values: { 'slicc-pair': 'p' } }),
      [`${PREFIX}b`]: JSON.stringify({ at: now, values: { tailscale: 't' } }),
      [`${PREFIX}c`]: 'not json',
      'slicc-os.kept': 'yes',
    }),
    configurable: true,
  });
  try {
    const trip = memory({ 'slicc-os.uncontrolled': '1' });
    const result = await boot(href, { storage: () => trip });
    assert.deepEqual(result.calls, ['host']);
    assert.deepEqual(result.shown, refusal('https://lease-pilot.sliccy.ai'));
    assert.deepEqual(localStorage.keys(), ['slicc-os.kept']);
    assert.deepEqual(trip.keys(), []);
    assert.deepEqual(replaced, ['/os/#keep=1']);
  } finally {
    globalThis.location = new URL('https://lease-pilot.sliccy.ai/os/');
    delete globalThis.history;
    Object.defineProperty(globalThis, 'localStorage', { value: memory(), configurable: true });
  }
});

test('start(): when the host check can’t load on a page seven’s service worker controls, seven fails closed with its refusal page and starts nothing', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (error) => logged.push(error.message));
  const { calls, shown: page } = await boot('https://seven.sliccy.ai/', {
    host: async () => {
      throw new TypeError('Failed to resolve module specifier');
    },
  });
  assert.deepEqual(calls, ['host', 'handoff', 'forgetHandOffs', 'check', 'fail']);
  assert.deepEqual(logged, ['Failed to resolve module specifier']);
  assert.deepEqual(page.text, [
    'p: Seven stopped while starting: TypeError: Failed to resolve module specifier',
  ]);
});

test('start(): on a page without seven’s service worker, where the check can’t load, it goes back through the BIOS once and then says why, as before', async (t) => {
  t.mock.method(console, 'error', () => {});
  const failing = async () => {
    throw new TypeError('Failed to resolve module specifier');
  };
  const trip = memory();
  const first = await boot('https://seven.sliccy.ai/', {
    worker: () => false,
    host: failing,
    storage: () => trip,
  });
  assert.deepEqual(first.calls, ['host', 'target', 'go']);
  assert.deepEqual(trip.keys(), ['slicc-os.uncontrolled']);
  const second = await boot('https://seven.sliccy.ai/', {
    worker: () => false,
    host: failing,
    storage: () => trip,
  });
  assert.deepEqual(second.calls, ['host', 'handoff', 'forgetHandOffs', 'check', 'fail']);
  assert.match(second.shown.text[0], /service worker isn’t running in this page/);
});

test('the policy check agrees with the pinned catalog’s own isSevenLabel for every label it can meet', () => {
  const labels = [
    ...catalog.seven.excludedLabels,
    ...catalog.seven.excludedLabelPrefixes.flatMap((prefix) => [
      prefix,
      `${prefix}x`,
      `x${prefix}`,
    ]),
    ...catalog.seven.excludedLabels.flatMap((label) => [`${label}-x`, `x${label}`, `${label}s`]),
    'seven',
    'www',
    'bb-x',
    'bb',
    'preview-seven',
    'xn--fsq',
    'a',
    '',
  ];
  for (const label of labels) {
    const at = { protocol: 'https:', hostname: `${label}.sliccy.ai` };
    assert.equal(rule.sevenHost(catalog.seven, at), isSevenLabel(catalog.seven, label), label);
    assert.equal(sevenHost(at), isSevenLabel(catalog.seven, label), label);
  }
});

for (const [name, seven] of Object.entries(POLICIES)) {
  test(`a catalog whose seven policy is ${name} (${JSON.stringify(seven) ?? 'absent'}) fails closed through the real loader: no sliccy.ai host is seven and every one refuses`, async () => {
    const host = await withPolicy(name);
    for (const href of [
      'https://seven.sliccy.ai/',
      'https://www.sliccy.ai/',
      'https://bb-x.sliccy.ai/',
      'https://lease-pilot.sliccy.ai/',
      'https://sliccy.ai/',
    ]) {
      assert.equal(host.sevenHost(at(href)), false, href);
      assert.equal(host.refusesBoot(at(href)), true, href);
      assert.equal(rule.sevenHost(seven, at(href)), false, href);
    }
    for (const href of ELSEWHERE) assert.equal(host.refusesBoot(at(href)), false, href);
    const { calls, shown: page } = await boot('https://seven.sliccy.ai/', {
      host: () => withPolicy(name),
    });
    assert.deepEqual(calls, ['host', 'storage'], name);
    assert.deepEqual(page, refusal('https://seven.sliccy.ai'), name);
    const doc = fakeDocument();
    let opened = false;
    await enter(
      async () => {
        opened = true;
      },
      { at: at('https://seven.sliccy.ai/os/join.html'), doc, host: () => withPolicy(name) }
    );
    assert.deepEqual([opened, shown(doc)], [false, refusal('https://seven.sliccy.ai')], name);
    assert.equal(
      (await agentRefused(MCP_CALLBACK, at('https://seven.sliccy.ai/'), () => seven)).status,
      503
    );
  });
}

for (const [name, seven] of Object.entries(VALID)) {
  test(`a catalog whose seven policy is ${name} loads through the real loader and classifies as before`, async () => {
    const host = await withPolicy(name);
    assert.equal(host.sevenHost(at('https://seven.sliccy.ai/')), true);
    assert.equal(host.sevenHost(at('https://bb-x.sliccy.ai/')), true);
    assert.equal(host.refusesBoot(at('https://lease-pilot.sliccy.ai/')), true);
    assert.equal(host.sevenHost(at('https://vault-x.sliccy.ai/')), name === 'labels only');
    assert.equal(rule.validPolicy(seven), true);
    const { calls } = await boot('https://seven.sliccy.ai/', { host: () => withPolicy(name) });
    assert.deepEqual(calls, ['host', 'storage', 'handoff', 'dropped', 'seat', 'follow', 'os']);
  });
}

test('a catalog import the real loader rejects fails closed: start.js shows its refusal page, the guest page and the callback show theirs, and nothing starts', async (t) => {
  t.mock.method(console, 'error', () => {});
  await assert.rejects(withPolicy('rejected'), /the catalog didn’t load/);
  const { calls, shown: page } = await boot('https://seven.sliccy.ai/', {
    host: () => withPolicy('rejected'),
  });
  assert.deepEqual(calls, ['host', 'handoff', 'forgetHandOffs', 'check', 'fail']);
  assert.match(page.text[0], /^p: Seven stopped while starting: Error: the catalog didn’t load/);
  const doc = fakeDocument();
  let opened = false;
  let forgotten = 0;
  await enter(
    async () => {
      opened = true;
    },
    {
      at: at('https://seven.sliccy.ai/os/join.html'),
      doc,
      host: () => withPolicy('rejected'),
      forget: () => {
        forgotten += 1;
      },
    }
  );
  assert.deepEqual([opened, forgotten, shown(doc)], [false, 1, loader]);
});

test('loader refusals for start, guest, and sign-in remove every hand-off before rendering', async (t) => {
  t.mock.method(console, 'error', () => {});
  const previousLocation = globalThis.location;
  const previousStorage = globalThis.localStorage;
  try {
    for (const page of ['start', 'uncontrolled start', 'guest', 'sign-in']) {
      const href = 'https://seven.sliccy.ai/os/#handoff=key&keep=1';
      globalThis.location = at(href);
      const replaced = [];
      globalThis.history = {
        state: null,
        replaceState: (_state, _title, url) => replaced.push(url),
      };
      Object.defineProperty(globalThis, 'localStorage', {
        value: memory({ [`${PREFIX}key`]: 'kept', other: 'other' }),
        configurable: true,
      });
      const clean = () => {
        assert.deepEqual(localStorage.keys(), ['other'], page);
        assert.deepEqual(replaced, ['/os/#keep=1'], page);
      };
      const host = () => withPolicy('rejected');
      if (page.endsWith('start')) {
        await boot(href, {
          host,
          worker: () => page === 'start',
          storage: () => memory({ 'slicc-os.uncontrolled': '1' }),
          handoff: async () => ({ forgetHandOffs }),
          fail: clean,
        });
      } else {
        const doc = fakeDocument();
        const render = doc.body.replaceChildren.bind(doc.body);
        doc.body.replaceChildren = (...children) => {
          clean();
          render(...children);
        };
        await enter(() => assert.fail('page code ran'), { at: at(href), doc, host });
        assert.deepEqual(shown(doc), loader);
      }
      clean();
    }
  } finally {
    globalThis.location = previousLocation;
    delete globalThis.history;
    Object.defineProperty(globalThis, 'localStorage', {
      value: previousStorage,
      configurable: true,
    });
  }
});

test('hand-off cleanup strips an empty fragment parameter and keeps other parameters', () => {
  const replaced = [];
  forgetHandOffs({
    location: at('https://seven.sliccy.ai/os/#handoff=&keep=1'),
    history: { state: null, replaceState: (_state, _title, url) => replaced.push(url) },
    storage: memory(),
  });
  assert.deepEqual(replaced, ['/os/#keep=1']);
});

test('start cleans up hand-offs on a dropped link or a failed app import and still refuses when cleanup cannot load', async (t) => {
  t.mock.method(console, 'error', () => {});
  let cleared = 0;
  const hand = {
    forgetHandOffs() {
      cleared += 1;
    },
    dropped: () => ['name'],
    droppedLine: () => 'The settings were dropped.',
  };
  const href = 'https://seven.sliccy.ai/os/';
  await boot(href, { handoff: () => hand });
  assert.equal(cleared, 1);
  const appFailed = await boot(href, {
    handoff: () => ({ ...hand, dropped: () => null }),
    os: async () => {
      throw new Error('app failed');
    },
  });
  assert.equal(cleared, 2);
  assert.match(appFailed.shown.text[0], /app failed/);
  const cleanupFailed = await boot(href, {
    host: () => withPolicy('rejected'),
    handoff: async () => {
      throw new Error('cleanup failed');
    },
  });
  assert.match(cleanupFailed.shown.text[0], /the catalog didn’t load/);
});

test('entry wrappers: the check comes first, a refused host never loads the page’s code, an allowed one does, and a failed load shows a refusal with Reload, not a loading page', async (t) => {
  t.mock.method(console, 'error', () => {});
  const run = async (href, { host = () => import(SEVEN_HOST), app } = {}) => {
    const doc = fakeDocument();
    const order = [];
    let forgotten = 0;
    const result = await enter(
      async () => {
        order.push('app');
        return app?.();
      },
      {
        at: at(href),
        doc,
        host: async () => {
          order.push('host');
          return host();
        },
        forget: () => {
          forgotten += 1;
        },
      }
    );
    return { order, forgotten, shown: shown(doc), result, doc };
  };
  for (const href of [...PILOT, ...EXCLUDED, ...APEX]) {
    const { order, forgotten, shown: page } = await run(href);
    assert.deepEqual([order, forgotten, page], [['host'], 1, refusal(at(href).origin)], href);
  }
  for (const href of [...SEVEN, ...ELSEWHERE]) {
    const { order, forgotten, shown: page } = await run(href);
    assert.deepEqual([order, forgotten, page], [['host', 'app'], 0, null], href);
  }
  const broken = await run('https://seven.sliccy.ai/os/join.html', {
    app: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
  });
  assert.deepEqual([broken.order, broken.forgotten, broken.shown], [['host', 'app'], 1, loader]);
  const replaced = [];
  broken.doc.location = { hash: '#seat=x', replace: (url) => replaced.push(url) };
  await broken.doc.body.children[0].children[2].listeners.click();
  assert.deepEqual(replaced, [
    `${new URL('../', new URL('../../src/seed/entry.js', import.meta.url)).href}#seat=x`,
  ]);
  const worker = { active: { scriptURL: 'https://www.sliccy.ai/7/sw.js' } };
  assert.equal(await biosUrl({ getRegistration: async () => worker }), 'https://www.sliccy.ai/7/');
  assert.equal(
    await biosUrl({ getRegistration: async () => null }),
    new URL('../', new URL('../../src/seed/entry.js', import.meta.url)).href
  );
  const unchecked = await run('https://seven.sliccy.ai/os/join.html', {
    host: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
  });
  assert.deepEqual([unchecked.order, unchecked.forgotten, unchecked.shown], [['host'], 1, loader]);
});

const AGENT_CALLBACK = `${AGENT}node_modules/@ai-ecoverse/slicc-agent/dist/oauth/mcp-callback.html`;

test('the service worker serves nothing from the agent on lease-pilot.sliccy.ai or an excluded label: not /oauth/mcp-callback and not the callback page by its own path', async () => {
  for (const href of [...PILOT, ...EXCLUDED, ...APEX, ...PLAIN]) {
    for (const path of [MCP_CALLBACK, AGENT_CALLBACK, `${AGENT}x.js`]) {
      assert.deepEqual(
        await agentRefused(path, at(href), () => catalog.seven),
        {
          status: 403,
          text: AGENT_REFUSED,
        },
        href
      );
    }
    assert.equal(await agentRefused('/os/', at(href), () => catalog.seven), null, href);
  }
  assert.match(AGENT_REFUSED, /^sw: /);
});

test('the service worker still serves the agent on seven, www, previews and hosts off sliccy.ai, and reads no policy off sliccy.ai', async () => {
  for (const href of SEVEN) {
    assert.equal(await agentRefused(MCP_CALLBACK, at(href), () => catalog.seven), null, href);
    assert.equal(await agentRefused(AGENT_CALLBACK, at(href), () => catalog.seven), null, href);
  }
  for (const href of ELSEWHERE) {
    const unread = () => {
      throw new Error('read the policy');
    };
    assert.equal(await agentRefused(MCP_CALLBACK, at(href), unread), null, href);
    assert.equal(await agentRefused(AGENT_CALLBACK, at(href), unread), null, href);
  }
});

test('the service worker fails closed on sliccy.ai when it can’t read the policy', async () => {
  const unreadable = () => Promise.reject(new Error('NotFoundError'));
  for (const href of [
    'https://seven.sliccy.ai/',
    'https://bb-x.sliccy.ai/',
    'https://lease-pilot.sliccy.ai/',
  ]) {
    for (const path of [MCP_CALLBACK, AGENT_CALLBACK]) {
      assert.deepEqual(
        await agentRefused(path, at(href), unreadable),
        {
          status: 503,
          text: POLICY_UNAVAILABLE,
        },
        href
      );
    }
  }
});
