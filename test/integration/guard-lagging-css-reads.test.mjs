import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { PROTECTED, guardProtected as stockGuard } from '../../src/seed/guard.js';

const SEVEN = 'https://seven.invalid';
const VAULT = 'https://vault.sliccy.ai/doc?n=lag-css';
const ORDINARY = 'https://ordinary.invalid/doc?n=lag-css';
const SECRET = 'lagging-css-secret';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const SEED = new URL('../../src/seed/', import.meta.url);

const MUTANTS = {
  'skip-style-reaches': [
    'guard.js',
    '    return DOCUMENT_STYLE_READS.has(method);',
    '    return false;',
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

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link' }],
  ['extension', { kind: 'extension' }],
];

const styleReads = [
  ['CSS.collectClassNames', { styleSheetId: 'sheet-1' }],
  ['CSS.getAnimatedStylesForNode', { nodeId: 1 }],
  ['CSS.getBackgroundColors', { nodeId: 1 }],
  ['CSS.getComputedStyleForNode', { nodeId: 1 }],
  ['CSS.getInlineStylesForNode', { nodeId: 1 }],
  ['CSS.getLayersForNode', { nodeId: 1 }],
  ['CSS.getLocationForSelector', { styleSheetId: 'sheet-1', selectorText: '.x' }],
  ['CSS.getLonghandProperties', { shorthandName: 'margin', value: '1px' }],
  ['CSS.getMatchedStylesForNode', { nodeId: 1 }],
  ['CSS.getMediaQueries', {}],
  ['CSS.getPlatformFontsForNode', { nodeId: 1 }],
  ['CSS.getStyleSheetText', { styleSheetId: 'sheet-1' }],
  ['CSS.resolveValues', { values: ['1em'], nodeId: 1 }],
  ['CSS.stopRuleUsageTracking', {}],
  ['CSS.takeComputedStyleUpdates', {}],
  ['CSS.takeCoverageDelta', {}],
  ['LayerTree.compositingReasons', { layerId: 1 }],
  ['LayerTree.loadSnapshot', { tiles: [] }],
  ['LayerTree.makeSnapshot', { layerId: 1 }],
  ['LayerTree.profileSnapshot', { snapshotId: 'snap-1' }],
  ['LayerTree.replaySnapshot', { snapshotId: 'snap-1' }],
  ['LayerTree.snapshotCommandLog', { snapshotId: 'snap-1' }],
];

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
  const stylePayload = {
    computedStyle: [{ name: 'content', value: SECRET }],
    text: SECRET,
    backgroundColors: [SECRET],
    fonts: [{ familyName: SECRET }],
    classNames: [SECRET],
    mediaQueries: [{ text: SECRET }],
    layers: [{ name: SECRET }],
    locations: [{ startLine: 0, startColumn: 0 }],
    longhands: [{ name: 'margin-top', value: SECRET }],
    resolved: [SECRET],
    ruleUsage: [{ styleSheetId: 'sheet-1', used: true }],
    coverage: [{ styleSheetId: 'sheet-1', startOffset: 0, endOffset: 1, used: true }],
    nodeIds: [1],
    snapshotId: 'snap-1',
    timings: [[0.1]],
    dataURL: `data:image/png;base64,${Buffer.from(SECRET).toString('base64')}`,
    commandLog: [{ method: 'Draw', params: [SECRET] }],
    compositingReasons: [SECRET],
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
        case 'CSS.getComputedStyleForNode':
        case 'CSS.getMatchedStylesForNode':
        case 'CSS.getInlineStylesForNode':
        case 'CSS.getAnimatedStylesForNode':
          return reply({ result: { computedStyle: stylePayload.computedStyle } });
        case 'CSS.getStyleSheetText':
          return reply({ result: { text: stylePayload.text } });
        case 'CSS.getBackgroundColors':
          return reply({ result: { backgroundColors: stylePayload.backgroundColors } });
        case 'CSS.getPlatformFontsForNode':
          return reply({ result: { fonts: stylePayload.fonts } });
        case 'CSS.collectClassNames':
          return reply({ result: { classNames: stylePayload.classNames } });
        case 'CSS.getMediaQueries':
          return reply({ result: { medias: stylePayload.mediaQueries } });
        case 'CSS.getLayersForNode':
          return reply({ result: { rootLayer: { name: SECRET, order: 0, subLayers: [] } } });
        case 'CSS.getLocationForSelector':
          return reply({ result: { ranges: stylePayload.locations } });
        case 'CSS.getLonghandProperties':
          return reply({ result: { longhandProperties: stylePayload.longhands } });
        case 'CSS.resolveValues':
          return reply({ result: { results: stylePayload.resolved } });
        case 'CSS.takeComputedStyleUpdates':
          return reply({ result: { nodeIds: stylePayload.nodeIds } });
        case 'CSS.stopRuleUsageTracking':
          return reply({ result: { ruleUsage: stylePayload.ruleUsage } });
        case 'CSS.takeCoverageDelta':
          return reply({
            result: { coverage: stylePayload.coverage, timestamp: 1 },
          });
        case 'LayerTree.compositingReasons':
          return reply({ result: { compositingReasons: stylePayload.compositingReasons } });
        case 'LayerTree.loadSnapshot':
        case 'LayerTree.makeSnapshot':
          return reply({ result: { snapshotId: stylePayload.snapshotId } });
        case 'LayerTree.profileSnapshot':
          return reply({ result: { timings: stylePayload.timings } });
        case 'LayerTree.replaySnapshot':
          return reply({ result: { dataURL: stylePayload.dataURL } });
        case 'LayerTree.snapshotCommandLog':
          return reply({ result: { commandLog: stylePayload.commandLog } });
        default:
          return reply({ result: {} });
      }
    },
  };
  return connection;
}

function harness(t, pages, route, options, protect = stockGuard) {
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
  const contentReached = (targetId, methods) =>
    raw.sent.some(
      (command) =>
        command.id < 2 ** 30 &&
        methods.includes(command.method) &&
        raw.owners.get(command.sessionId) === targetId
    );
  const leaked = (...values) => values.filter((value) => JSON.stringify(got).includes(value));
  return { raw, got, send, created, contentReached, leaked };
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
  for (const [method, params] of styleReads) {
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

    if (name !== 'extension') {
      test(`on ${name}, an ordinary foreign target still answers ${method}`, async (t) => {
        const pages = { foreign: blankPage() };
        const h = harness(t, pages, route);
        h.created('foreign');
        await tick();
        const attached = await h.send('Target.attachToTarget', {
          targetId: 'foreign',
          flatten: true,
        });
        assert.equal(attached?.error, undefined, JSON.stringify(attached));
        h.raw.navigate('foreign', ORDINARY);
        const answer = await h.send(method, params, attached.result.sessionId);
        assert.equal(answer?.error, undefined, JSON.stringify({ method, answer }));
        assert.ok(answer?.result, JSON.stringify({ method, answer }));
        assert.ok(h.contentReached('foreign', [method]));
        h.raw.announce('foreign');
        await tick();
      });
    }
  }
}

for (const [method, params] of [
  ['CSS.takeCoverageDelta', {}],
  ['CSS.stopRuleUsageTracking', {}],
  ['CSS.takeComputedStyleUpdates', {}],
]) {
  for (const [name, route] of routes) {
    if (name === 'extension') continue;
    test(`on ${name}, pendingCommit refuses ${method} on an ordinary page`, async (t) => {
      const pages = { foreign: blankPage() };
      const h = harness(t, pages, route);
      h.created('foreign');
      await tick();
      const attached = await h.send('Target.attachToTarget', {
        targetId: 'foreign',
        flatten: true,
      });
      assert.equal(attached?.error, undefined, JSON.stringify(attached));
      h.raw.navigate('foreign', ORDINARY);
      h.raw.announce('foreign');
      await tick();
      h.raw.emit({
        method: 'Page.frameStartedNavigating',
        sessionId: attached.result.sessionId,
        params: {
          frameId: 'foreign',
          url: SEVEN,
          loaderId: 'pending-protected-loader',
          navigationType: 'differentDocument',
        },
      });
      await tick();
      const answer = await h.send(method, params, attached.result.sessionId);
      assert.equal(answer?.error?.message, PROTECTED, JSON.stringify({ method, answer }));
      assert.equal(answer?.result, undefined, JSON.stringify({ method, answer }));
      assert.ok(!h.contentReached('foreign', [method]));
    });
  }
}

test('mutant: skipping document-style reads in reaches lets a lagging CSS read reach the browser', {
  timeout: 10000,
}, async (t) => {
  const protect = await loadGuard('skip-style-reaches');
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
  const answer = await h.send(
    'CSS.getComputedStyleForNode',
    { nodeId: 1 },
    attached.result.sessionId
  );
  assert.ok(
    h.contentReached('foreign', ['CSS.getComputedStyleForNode']) ||
      answer?.result?.computedStyle?.[0]?.value === SECRET,
    'mutant must turn the lagging CSS refusal row red'
  );
});
