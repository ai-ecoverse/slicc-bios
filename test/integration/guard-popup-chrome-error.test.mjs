import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, guardProtected } from '../../src/seed/guard.js';

const ordinary = 'https://ordinary.invalid/page';
const ordinaryFail = 'https://ordinary.invalid/unreachable';
const errorPage = 'chrome-error://chromewebdata/';
const flush = () => new Promise((resolve) => setImmediate(resolve));

const hosts = [
  ['seven', 'https://seven.sliccy.ai'],
  ['vault', 'https://vault.sliccy.ai'],
];

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link' }],
  ['extension', { kind: 'extension' }],
];

const plainFrame = (id, url = ordinary) => ({
  id,
  url,
  securityOrigin: new URL(url).origin,
  loaderId: `${id}-loader`,
});

const blankFrame = (id) => ({
  id,
  url: 'about:blank',
  securityOrigin: 'null',
  loaderId: `${id}-blank`,
});

const errorFrame = (id, unreachableUrl) => ({
  id,
  url: errorPage,
  securityOrigin: '://',
  unreachableUrl,
  loaderId: `${id}-error`,
});

function protocol(t, own, route) {
  const targets = new Map();
  const sessions = new Map();
  const sent = [];
  const delivered = [];
  const pending = new Map();
  let next = 0;
  let hold = () => false;
  const key = (id, sessionId) => JSON.stringify([sessionId ?? null, id]);
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      sent.push(message);
      if (hold(message)) return;
      queueMicrotask(() => respond(message));
    },
    close() {},
  };
  const guard = guardProtected(raw, own, new Map(), route);
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    delivered.push(message);
    pending.get(key(message.id, message.sessionId))?.(message);
    pending.delete(key(message.id, message.sessionId));
  };
  t.after(() => guard.close());
  const emit = (message) => raw.onmessage(JSON.stringify(message));
  function respond(message, payload) {
    const { id, method, params = {}, sessionId } = message;
    const targetId = params.targetId ?? sessions.get(sessionId);
    const target = targets.get(targetId);
    let result = {};
    if (method === 'Target.getTargetInfo') result = { targetInfo: target.info };
    if (method === 'Target.getTargets')
      result = { targetInfos: [...targets.values()].map((entry) => entry.info) };
    if (method === 'Target.attachToTarget') {
      const attached = `${id >= 2 ** 30 ? 'guard' : 'client'}-${targetId}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Page.getFrameTree') result = { frameTree: target.tree };
    if (method === 'Page.getNavigationHistory')
      result = target.history ?? {
        currentIndex: 0,
        entries: [{ id: 1, url: target.info.url, userTypedURL: target.info.url, title: '' }],
      };
    if (method === 'DOM.getDocument')
      result = { root: { nodeId: 1, nodeName: '#document', children: [] } };
    if (method === 'Runtime.evaluate')
      result = { result: { type: 'string', value: 'synthetic-content' } };
    if (method === 'Page.captureScreenshot') result = { data: 'c3ludGhldGlj' };
    emit({ id, ...(sessionId ? { sessionId } : {}), ...(payload ?? { result }) });
  }
  function request(method, params = {}, sessionId, id = ++next) {
    const answer = new Promise((resolve) => pending.set(key(id, sessionId), resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return { id, answer };
  }
  const send = (method, params, sessionId) => request(method, params, sessionId).answer;
  function target(id, frame = plainFrame(id)) {
    const entry = {
      info: { targetId: id, type: 'page', url: frame.url },
      tree: { frame },
    };
    targets.set(id, entry);
    return entry;
  }
  return {
    targets,
    sessions,
    sent,
    delivered,
    emit,
    send,
    request,
    target,
    hold(fn) {
      hold = fn;
    },
    async drain(n = 8) {
      for (let i = 0; i < n; i++) await flush();
    },
    async tick(timers, ms, step = 100) {
      for (let left = ms; left > 0; left -= step) {
        timers.tick(Math.min(step, left));
        await flush();
      }
    },
    clientAttaches(from = 0) {
      return delivered
        .slice(from)
        .filter(
          (message) =>
            message.method === 'Target.attachedToTarget' &&
            typeof message.params?.sessionId === 'string' &&
            message.params.sessionId.startsWith('client-')
        );
    },
    chromeErrorAttaches(from = 0) {
      return this.clientAttaches(from).filter((message) =>
        String(message.params?.targetInfo?.url ?? '').startsWith('chrome-error:')
      );
    },
  };
}

async function openPopup(wire, id, { url = '', title = '', tree } = {}) {
  wire.target('opener');
  const entry = wire.target(id, tree ?? { id, url: url || '', securityOrigin: '://' });
  entry.info.url = url;
  entry.info.title = title;
  entry.info.openerId = 'opener';
  entry.info.canAccessOpener = true;
  if (!tree) entry.tree.frame = { id, url: url || '', securityOrigin: '://' };
  return entry;
}

function autoAttach(wire, entry, sessionId, waitingForDebugger) {
  wire.sessions.set(sessionId, entry.info.targetId);
  wire.emit({
    method: 'Target.attachedToTarget',
    params: {
      sessionId,
      targetInfo: { ...entry.info, attached: true },
      waitingForDebugger,
    },
  });
}

function settleChromeError(entry, unreachableUrl, { tree = 'blank' } = {}) {
  entry.info.url = errorPage;
  entry.info.title = errorPage;
  entry.tree.frame =
    tree === 'error'
      ? errorFrame(entry.info.targetId, unreachableUrl)
      : blankFrame(entry.info.targetId);
  entry.history = {
    currentIndex: 0,
    entries: [
      {
        id: 1,
        url: unreachableUrl,
        userTypedURL: unreachableUrl,
        title: 'failed',
      },
    ],
  };
}

function assertNoChromeErrorAttach(wire, from, label) {
  const leaked = wire.chromeErrorAttaches(from);
  assert.deepEqual(
    leaked.map((message) => ({
      url: message.params.targetInfo.url,
      title: message.params.targetInfo.title,
      waitingForDebugger: message.params.waitingForDebugger,
    })),
    [],
    `${label}: no chrome-error attach reaches the client before proof or blank`
  );
}

for (const [hostName, own] of hosts) {
  const failed = `${own}/doc?popup=chrome-error`;
  for (const [routeName, route] of routes) {
    test(`A empty-url attach resumes then chrome-error before scrub (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entry = await openPopup(wire, `a-${hostName}-${routeName}`);
      const from = wire.delivered.length;
      autoAttach(wire, entry, `client-a-${hostName}-${routeName}`, true);
      await wire.drain(20);
      assert.equal(
        wire.sent.some((message) => message.method === 'Runtime.runIfWaitingForDebugger'),
        true,
        'the paused popup is resumed'
      );
      settleChromeError(entry, failed, { tree: 'blank' });
      await wire.tick(t.mock.timers, 3000);
      assert.equal(
        wire.sent.some(
          (message) => message.method === 'Page.navigate' && message.params?.url === BLANKED
        ),
        false,
        'scrub has not blanked yet'
      );
      assertNoChromeErrorAttach(wire, from, `A/${hostName}/${routeName}`);
    });

    test(`B targetInfo chrome-error while frame tree stays blank (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entry = await openPopup(wire, `b-${hostName}-${routeName}`);
      const from = wire.delivered.length;
      autoAttach(wire, entry, `client-b-${hostName}-${routeName}`, true);
      await wire.drain(20);
      entry.info.url = errorPage;
      entry.info.title = errorPage;
      entry.tree.frame = blankFrame(entry.info.targetId);
      entry.history = {
        currentIndex: 0,
        entries: [{ id: 1, url: failed, userTypedURL: failed, title: 'failed' }],
      };
      await wire.tick(t.mock.timers, 3000);
      assert.equal(entry.tree.frame.url, 'about:blank');
      assert.equal(entry.info.url, errorPage);
      assertNoChromeErrorAttach(wire, from, `B/${hostName}/${routeName}`);
    });

    test(`C attach already on chrome-error with pause lost (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entry = await openPopup(wire, `c-${hostName}-${routeName}`, {
        url: errorPage,
        title: errorPage,
        tree: blankFrame(`c-${hostName}-${routeName}`),
      });
      entry.info.openerId = 'opener';
      entry.info.canAccessOpener = true;
      entry.history = {
        currentIndex: 0,
        entries: [{ id: 1, url: failed, userTypedURL: failed, title: 'failed' }],
      };
      const from = wire.delivered.length;
      autoAttach(wire, entry, `client-c-${hostName}-${routeName}`, false);
      await wire.drain(20);
      await wire.tick(t.mock.timers, 1000);
      assertNoChromeErrorAttach(wire, from, `C/${hostName}/${routeName}`);
    });

    test(`D missed Fetch pause for the protected Document (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entry = await openPopup(wire, `d-${hostName}-${routeName}`);
      const from = wire.delivered.length;
      autoAttach(wire, entry, `client-d-${hostName}-${routeName}`, true);
      await wire.drain(20);
      assert.equal(
        wire.sent.some((message) => message.method === 'Fetch.requestPaused'),
        false
      );
      settleChromeError(entry, failed, { tree: 'blank' });
      await wire.tick(t.mock.timers, 3000);
      const failedFetch = wire.sent.some((message) => message.method === 'Fetch.failRequest');
      const continued = wire.sent.some((message) => message.method === 'Fetch.continueRequest');
      const leaked = wire.chromeErrorAttaches(from);
      assert.equal(failedFetch, false, 'no Fetch.failRequest without a pause');
      assert.equal(continued, false, 'no Fetch.continueRequest without a pause');
      assert.deepEqual(
        leaked.map((message) => ({
          url: message.params.targetInfo.url,
          title: message.params.targetInfo.title,
          waitingForDebugger: message.params.waitingForDebugger,
        })),
        [],
        `D/${hostName}/${routeName}: missed Fetch pause must not announce chrome-error (observed ${leaked.length} attach(es))`
      );
    });
  }
}

for (const [hostName, own] of hosts) {
  const failed = `${own}/doc?title-leak`;
  const hostOnly = new URL(own).hostname;
  for (const [routeName, route] of routes) {
    for (const title of [failed, hostOnly, own]) {
      test(`chrome-error discovery title ${JSON.stringify(title)} never names ${hostName} (${routeName})`, {
        timeout: 5000,
      }, async (t) => {
        const wire = protocol(t, own, route);
        const entry = wire.target(`title-${hostName}-${routeName}`);
        entry.info.url = errorPage;
        entry.info.title = title;
        entry.tree.frame = blankFrame(entry.info.targetId);
        const from = wire.delivered.length;
        for (const method of ['Target.targetCreated', 'Target.targetInfoChanged']) {
          wire.emit({
            method,
            params: {
              targetInfo: {
                targetId: entry.info.targetId,
                type: 'page',
                url: errorPage,
                title,
              },
            },
          });
        }
        await wire.drain(10);
        const listed = await wire.send('Target.getTargets');
        const info = await wire.send('Target.getTargetInfo', {
          targetId: entry.info.targetId,
        });
        const events = wire.delivered
          .slice(from)
          .filter((message) =>
            ['Target.targetCreated', 'Target.targetInfoChanged'].includes(message.method)
          );
        for (const message of [
          ...events,
          { result: listed.result },
          { result: { targetInfos: [info.result?.targetInfo] } },
        ]) {
          const text = JSON.stringify(message);
          assert.equal(text.includes(hostOnly), false, text.slice(0, 400));
          assert.equal(text.includes(new URL(own).host), false);
          assert.equal(text.includes(failed), false);
        }
        for (const event of events) {
          assert.equal(event.params.targetInfo.url, errorPage);
          assert.equal(event.params.targetInfo.title, errorPage);
        }
        assert.equal(info.result.targetInfo.url, errorPage);
        assert.equal(info.result.targetInfo.title, errorPage);
        const row = listed.result.targetInfos.find((item) => item.targetId === entry.info.targetId);
        assert.equal(row.url, errorPage);
        assert.equal(row.title, errorPage);
      });
    }
  }
}

for (const [routeName, route] of routes) {
  test(`ordinary unreachable chrome-error is released after proof (${routeName})`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t, 'https://seven.sliccy.ai', route);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entry = await openPopup(wire, `ordinary-${routeName}`);
    const from = wire.delivered.length;
    autoAttach(wire, entry, `client-ordinary-${routeName}`, true);
    await wire.drain(20);
    settleChromeError(entry, ordinaryFail, { tree: 'error' });
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: `guard-${entry.info.targetId}`,
      params: { frame: entry.tree.frame },
    });
    await wire.drain(10);
    await wire.tick(t.mock.timers, 3000);
    const released = wire.chromeErrorAttaches(from);
    assert.equal(released.length, 1, 'the ordinary error page is released once');
    assert.equal(released[0].params.targetInfo.url, errorPage);
    assert.equal(released[0].params.targetInfo.title, errorPage);
    assert.equal(JSON.stringify(released[0]).includes(ordinaryFail), false);
    assert.equal(JSON.stringify(released[0]).includes('ordinary.invalid'), false);
  });

  test(`protected unreachable chrome-error stays held through the error document (${routeName})`, {
    timeout: 5000,
  }, async (t) => {
    const own = 'https://vault.sliccy.ai';
    const failed = `${own}/doc?held`;
    const wire = protocol(t, own, route);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entry = await openPopup(wire, `held-${routeName}`, {
      url: errorPage,
      title: errorPage,
      tree: errorFrame(`held-${routeName}`, failed),
    });
    entry.info.openerId = 'opener';
    entry.info.canAccessOpener = true;
    entry.history = {
      currentIndex: 0,
      entries: [{ id: 1, url: failed, userTypedURL: failed, title: 'failed' }],
    };
    const from = wire.delivered.length;
    autoAttach(wire, entry, `client-held-${routeName}`, false);
    await wire.drain(20);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: `guard-${entry.info.targetId}`,
      params: { frame: entry.tree.frame },
    });
    await wire.drain(10);
    await wire.tick(t.mock.timers, 2000);
    assertNoChromeErrorAttach(wire, from, `held/${routeName}`);
  });
}
