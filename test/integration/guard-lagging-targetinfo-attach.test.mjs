import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { FAILED, PROTECTED, guardProtected as stockGuard } from '../../src/seed/guard.js';

const SEVEN = 'https://seven.invalid';
const SEVEN_PAGE = `${SEVEN}/os/`;
const VAULT = 'https://vault.sliccy.ai/doc?n=lag';
const ORDINARY = 'https://ordinary.invalid/doc?n=lag';
const SECRET = 'lagging-attach-secret';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const SEED = new URL('../../src/seed/', import.meta.url);

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link' }],
  ['extension', { kind: 'extension' }],
];

const wrapped = [
  ['view-source of the vault', `view-source:${VAULT}`],
  ['view-source of seven', `view-source:${SEVEN_PAGE}`],
  ['blob of the vault', `blob:${VAULT}/uuid`],
  ['blob of seven', `blob:${SEVEN_PAGE}/uuid`],
  ['filesystem of the vault', `filesystem:${VAULT}/temporary/x`],
  ['filesystem of seven', `filesystem:${SEVEN_PAGE}/temporary/x`],
];

const reads = [
  ['Runtime.evaluate', { expression: 'document.body.innerText' }],
  ['DOM.getDocument', {}],
  ['Page.captureScreenshot', {}],
];

const contentClasses = [
  ['Page.printToPDF', {}],
  ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
  ['Accessibility.getFullAXTree', {}],
  ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }],
  ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left' }],
  ['DOM.getOuterHTML', { nodeId: 1 }],
];

const MUTANTS = {
  'skip-recheck': [
    'guard.js',
    '    if (await this.recheck(message)) return;\n    return this.pass(message);',
    '    return this.pass(message);',
  ],
};

registerHooks({
  resolve(specifier, context, next) {
    const mutant = context.parentURL && URL.parse(context.parentURL)?.searchParams.get('mutant');
    const resolved = next(specifier, context);
    if (
      !mutant ||
      !MUTANTS[mutant] ||
      !specifier.startsWith('./') ||
      specifier.slice(2) !== 'guard.js'
    )
      return resolved;
    return { ...resolved, url: `${resolved.url}?mutant=${mutant}` };
  },
  load(url, context, next) {
    const mutant = URL.parse(url)?.searchParams.get('mutant');
    const loaded = next(url, context);
    if (!mutant || !MUTANTS[mutant] || !url.split('?')[0].endsWith('/guard.js')) return loaded;
    const [, from, to] = MUTANTS[mutant];
    const source = String(loaded.source);
    assert.ok(source.includes(from), `mutant ${mutant}: patch site missing`);
    return { ...loaded, source: source.replace(from, to) };
  },
});

const loadGuard = async (mutant) => {
  if (!mutant) return stockGuard;
  return (await import(`${new URL('guard.js', SEED).href}?mutant=${mutant}`)).guardProtected;
};

const guardProtected = stockGuard;

function originOf(url) {
  for (const scheme of ['view-source:', 'blob:', 'filesystem:']) {
    if (url.startsWith(scheme)) {
      const inner = url.slice(scheme.length);
      return URL.canParse(inner) ? new URL(inner).origin : '://';
    }
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
        case 'Page.printToPDF':
          return reply({ result: { data: Buffer.from(SECRET).toString('base64') } });
        case 'DOMSnapshot.captureSnapshot':
          return reply({
            result: { documents: [{ nodes: { nodeName: [SECRET] } }], strings: [SECRET] },
          });
        case 'Accessibility.getFullAXTree':
          return reply({
            result: { nodes: [{ role: { value: 'WebArea' }, name: { value: SECRET } }] },
          });
        case 'CSS.getComputedStyleForNode':
        case 'CSS.getMatchedStylesForNode':
          return reply({ result: { computedStyle: [{ name: 'content', value: SECRET }] } });
        case 'DOM.getOuterHTML':
          return reply({ result: { outerHTML: `<div>${SECRET}</div>` } });
        case 'Input.dispatchKeyEvent':
        case 'Input.dispatchMouseEvent':
          return reply({ result: {} });
        default:
          return reply({ result: {} });
      }
    },
  };
  return connection;
}

function harness(t, pages, route, options, protect = guardProtected) {
  const raw = chrome(pages, options);
  const guarded = protect(raw, [SEVEN], new Map(), route);
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
  const contentReached = (targetId, methods = reads.map(([method]) => method)) =>
    raw.sent.some(
      (command) =>
        command.id < 2 ** 30 &&
        methods.includes(command.method) &&
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
  for (const [label, url] of wrapped) {
    test(`on ${name}, attach admitted on blank then a first content read before targetInfoChanged of ${label} is refused`, async (t) => {
      const pages = { foreign: blankPage() };
      const h = harness(t, pages, route, { staleInfo: true });
      h.created('foreign');
      await tick();
      const attached = await h.send('Target.attachToTarget', {
        targetId: 'foreign',
        flatten: true,
      });
      assert.equal(attached?.error, undefined, JSON.stringify(attached));
      assert.ok(attached?.result?.sessionId);
      assert.ok(h.attachSent('foreign'));
      h.raw.navigate('foreign', url);
      const session = attached.result.sessionId;
      for (const [method, params] of reads) {
        const answer = await h.send(method, params, session);
        assert.equal(answer?.error?.message, PROTECTED, JSON.stringify({ method, answer }));
        assert.equal(answer?.result, undefined, JSON.stringify({ method, answer }));
      }
      assert.ok(!h.contentReached('foreign'));
      assert.deepEqual(h.leaked(SECRET, url, 'vault.sliccy.ai', SEVEN_PAGE), []);
      h.raw.announce('foreign');
      await tick();
      for (const [method, params] of reads) {
        const answer = await h.send(method, params, session);
        assert.ok(answer?.error, JSON.stringify({ method, answer }));
        assert.equal(answer?.result, undefined, JSON.stringify({ method, answer }));
      }
      assert.ok(!h.contentReached('foreign'));
      assert.deepEqual(h.leaked(SECRET), []);
    });
  }

  test(`on ${name}, an ordinary foreign target with a lagging targetInfoChanged still attaches and can be read`, async (t) => {
    const pages = { foreign: blankPage() };
    const h = harness(t, pages, route);
    h.created('foreign');
    await tick();
    const attached = await h.send('Target.attachToTarget', {
      targetId: 'foreign',
      flatten: true,
    });
    assert.equal(attached?.error, undefined, JSON.stringify(attached));
    assert.ok(attached?.result?.sessionId);
    h.raw.navigate('foreign', ORDINARY);
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

  for (const [method, params] of contentClasses) {
    test(`on ${name}, lagging attach refuses ${method} before targetInfoChanged of the vault`, async (t) => {
      const pages = { foreign: blankPage() };
      const h = harness(t, pages, route, { staleInfo: true });
      h.created('foreign');
      await tick();
      const attached = await h.send('Target.attachToTarget', {
        targetId: 'foreign',
        flatten: true,
      });
      assert.equal(attached?.error, undefined, JSON.stringify(attached));
      h.raw.navigate('foreign', `view-source:${VAULT}`);
      const answer = await h.send(method, params, attached.result.sessionId);
      assert.equal(answer?.error?.message, PROTECTED, JSON.stringify({ method, answer }));
      assert.equal(answer?.result, undefined, JSON.stringify({ method, answer }));
      assert.ok(!h.contentReached('foreign', [method]));
      assert.deepEqual(h.leaked(SECRET, 'vault.sliccy.ai'), []);
    });
  }
}

test('mutant: skipping recheck lets a lagging first read reach the browser', {
  timeout: 10000,
}, async (t) => {
  const protect = await loadGuard('skip-recheck');
  const pages = { foreign: blankPage() };
  const h = harness(t, pages, undefined, { staleInfo: true }, protect);
  h.created('foreign');
  await tick();
  const attached = await h.send('Target.attachToTarget', {
    targetId: 'foreign',
    flatten: true,
  });
  assert.equal(attached?.error, undefined, JSON.stringify(attached));
  h.raw.navigate('foreign', `view-source:${VAULT}`);
  const answer = await h.send('Page.printToPDF', {}, attached.result.sessionId);
  assert.ok(
    h.contentReached('foreign', ['Page.printToPDF']) ||
      answer?.result?.data === Buffer.from(SECRET).toString('base64'),
    'mutant must turn the lagging printToPDF refusal row red'
  );
});

test('a lagging first read whose private frame tree never answers refuses with the check-failed message', {
  timeout: 10000,
}, async (t) => {
  const pages = { foreign: blankPage() };
  const h = harness(t, pages, undefined, { staleInfo: true });
  h.created('foreign');
  await tick();
  const attached = await h.send('Target.attachToTarget', {
    targetId: 'foreign',
    flatten: true,
  });
  assert.equal(attached?.error, undefined, JSON.stringify(attached));
  h.raw.navigate('foreign', `view-source:${VAULT}`);
  const holdTree = h.raw.send;
  h.raw.send = (text) => {
    const command = JSON.parse(text);
    if (command.method === 'Page.getFrameTree' && command.id >= 2 ** 30) return;
    return holdTree.call(h.raw, text);
  };
  const answer = await h.send('DOM.getOuterHTML', { nodeId: 1 }, attached.result.sessionId);
  assert.ok(answer?.error, JSON.stringify(answer));
  assert.match(answer.error.message, /^slicc: refused:/);
  assert.ok(
    answer.error.message === PROTECTED ||
      answer.error.message === FAILED ||
      /timeout/i.test(answer.error.message),
    `client refusal names the check failure or timeout: ${answer.error.message}`
  );
  assert.equal(answer?.result, undefined);
  assert.ok(!h.contentReached('foreign', ['DOM.getOuterHTML']));
  assert.deepEqual(h.leaked(SECRET), []);
});
