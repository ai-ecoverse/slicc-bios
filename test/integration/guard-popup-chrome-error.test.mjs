import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
  let createSeq = 0;
  let createOrder = 'reply-then-events';
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
    if (method === 'Target.createTarget') {
      const targetId = `created-${++createSeq}-${id}`;
      const entry = target(targetId, blankFrame(targetId));
      entry.info.url = 'about:blank';
      entry.info.title = '';
      const info = { ...entry.info, attached: true };
      const reply = { id, ...(sessionId ? { sessionId } : {}), result: { targetId } };
      const created = { method: 'Target.targetCreated', params: { targetInfo: { ...entry.info } } };
      const attached = {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: `client-${targetId}`,
          targetInfo: info,
          waitingForDebugger: false,
        },
      };
      sessions.set(`client-${targetId}`, targetId);
      if (createOrder === 'events-then-reply') {
        emit(created);
        emit(attached);
        emit(reply);
      } else if (createOrder === 'attach-race') {
        emit(attached);
        emit(reply);
        emit(created);
      } else {
        emit(reply);
        emit(created);
        emit(attached);
      }
      return;
    }
    const targetId = params.targetId ?? sessions.get(sessionId);
    const targetEntry = targets.get(targetId);
    let result = {};
    if (method === 'Target.getTargetInfo') result = { targetInfo: targetEntry.info };
    if (method === 'Target.getTargets')
      result = { targetInfos: [...targets.values()].map((entry) => entry.info) };
    if (method === 'Target.attachToTarget') {
      const attached = id >= 2 ** 30 ? `guard-${targetId}` : `client-${targetId}-${id}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Page.getFrameTree') result = { frameTree: targetEntry.tree };
    if (method === 'Page.getNavigationHistory')
      result = targetEntry.history ?? {
        currentIndex: 0,
        entries: [
          {
            id: 1,
            url: targetEntry.info.url,
            userTypedURL: targetEntry.info.url,
            title: '',
          },
        ],
      };
    if (method === 'DOM.getDocument')
      result = targetEntry?.document ?? {
        root: { nodeId: 1, nodeName: '#document', children: [] },
      };
    if (method === 'Runtime.evaluate')
      result = targetEntry?.evaluate ?? { result: { type: 'string', value: 'synthetic-content' } };
    if (method === 'Accessibility.getFullAXTree') result = targetEntry?.ax ?? { nodes: [] };
    if (method === 'DOMSnapshot.captureSnapshot')
      result = targetEntry?.snapshot ?? { documents: [], strings: [] };
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
    setCreateOrder(order) {
      createOrder = order;
    },
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
      t.mock.timers.reset();
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
      t.mock.timers.reset();
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
      t.mock.timers.reset();
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
      t.mock.timers.reset();
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
          assert.equal(event.params.targetInfo.title, '');
        }
        assert.equal(info.result.targetInfo.url, errorPage);
        assert.equal(info.result.targetInfo.title, '');
        const row = listed.result.targetInfos.find((item) => item.targetId === entry.info.targetId);
        assert.equal(row.url, errorPage);
        assert.equal(row.title, '');
      });
    }
  }
}

for (const [hostName, own] of hosts) {
  const failed = `${own}/doc?own-tab`;
  const hostOnly = new URL(own).hostname;
  for (const [routeName, route] of routes) {
    test(`E own-tab chrome-error stays attachable with redaction (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entry = wire.target(
        `own-${hostName}-${routeName}`,
        plainFrame(`own-${hostName}-${routeName}`)
      );
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      settleChromeError(entry, failed, { tree: 'error' });
      entry.info.title = hostOnly;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: attached.result.sessionId,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      const again = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(again.error, undefined);
      const info = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
      assert.equal(info.result.targetInfo.url, errorPage);
      assert.equal(info.result.targetInfo.title, errorPage);
      assert.equal(JSON.stringify(info).includes(hostOnly), false);
      assert.equal(JSON.stringify(info).includes(failed), false);
      const tree = await wire.send('Page.getFrameTree', {}, again.result.sessionId);
      assert.equal(JSON.stringify(tree).includes(failed), false);
      assert.equal(JSON.stringify(tree).includes(hostOnly), false);
    });

    test(`D1 blank popup attach then client navigate to ${hostName} stays held (${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entry = await openPopup(wire, `d1-${hostName}-${routeName}`, {
        url: 'about:blank',
        title: '',
        tree: blankFrame(`d1-${hostName}-${routeName}`),
      });
      entry.info.url = 'about:blank';
      const from = wire.delivered.length;
      autoAttach(wire, entry, `client-d1-${hostName}-${routeName}`, false);
      await wire.drain(20);
      await wire.tick(t.mock.timers, 500);
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      await wire.send('Page.navigate', { url: ordinary }, attached.result.sessionId);
      settleChromeError(entry, failed, { tree: 'error' });
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${entry.info.targetId}`,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      await wire.tick(t.mock.timers, 3000);
      assertNoChromeErrorAttach(wire, from, `D1/${hostName}/${routeName}`);
      const again = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(again.error === undefined, false, 'popup must not be re-admitted as own');
    });

    test(`R4 noopener chrome-error is attachable with origin-only surface (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      const entry = wire.target(
        `r4-${hostName}-${routeName}`,
        plainFrame(`r4-${hostName}-${routeName}`)
      );
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      settleChromeError(entry, failed, { tree: 'error' });
      entry.info.title = hostOnly;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: attached.result.sessionId,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      const again = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(again.error, undefined);
      const info = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
      const tree = await wire.send('Page.getFrameTree', {}, again.result.sessionId);
      const history = await wire.send('Page.getNavigationHistory', {}, again.result.sessionId);
      const blob = JSON.stringify({ info, tree, history });
      assert.equal(blob.includes(failed), false);
      assert.equal(blob.includes(`${hostOnly}/`), false);
      assert.equal(blob.includes('?own-tab'), false);
      assert.equal(info.result.targetInfo.url, errorPage);
      assert.equal(info.result.targetInfo.title, errorPage);
    });

    test(`N1 protected failed load blanks frame.name and history title (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      const entry = wire.target(
        `n1-${hostName}-${routeName}`,
        plainFrame(`n1-${hostName}-${routeName}`)
      );
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      settleChromeError(entry, failed, { tree: 'error' });
      entry.tree.frame.name = hostOnly;
      entry.history = {
        currentIndex: 0,
        entries: [{ id: 1, url: failed, userTypedURL: failed, title: hostOnly }],
      };
      const from = wire.delivered.length;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: attached.result.sessionId,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      const navigated = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.frameNavigated');
      if (navigated) {
        const name = navigated.params?.frame?.name;
        assert.equal(name === undefined || name === '', true, 'frame.name is blank');
        assert.equal(JSON.stringify(navigated).includes(hostOnly), false);
        assert.equal(JSON.stringify(navigated).includes(failed), false);
      }
      const tree = await wire.send('Page.getFrameTree', {}, attached.result.sessionId);
      const history = await wire.send('Page.getNavigationHistory', {}, attached.result.sessionId);
      assert.equal(tree.error, undefined, JSON.stringify(tree));
      assert.equal(history.error, undefined, JSON.stringify(history));
      const name = tree.result.frameTree.frame.name;
      assert.equal(name === undefined || name === '', true, 'frame.name is blank in the tree');
      assert.equal(history.result.entries[0].title, '');
      const blob = JSON.stringify({ tree, history });
      assert.equal(blob.includes(hostOnly), false);
      assert.equal(blob.includes(failed), false);
    });

    test(`N2 ordinary failed load keeps frame.name and history title (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      const entry = wire.target(
        `n2-${hostName}-${routeName}`,
        plainFrame(`n2-${hostName}-${routeName}`)
      );
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      settleChromeError(entry, ordinaryFail, { tree: 'error' });
      entry.tree.frame.name = 'ordinary-title';
      entry.history = {
        currentIndex: 0,
        entries: [
          { id: 1, url: ordinaryFail, userTypedURL: ordinaryFail, title: 'ordinary-title' },
        ],
      };
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: attached.result.sessionId,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      const tree = await wire.send('Page.getFrameTree', {}, attached.result.sessionId);
      const history = await wire.send('Page.getNavigationHistory', {}, attached.result.sessionId);
      assert.equal(tree.result.frameTree.frame.name, 'ordinary-title');
      assert.equal(history.result.entries[0].title, 'ordinary-title');
    });

    test(`W1 protected failed load blanks windowName and dialog names (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      const entry = wire.target(
        `w1-${hostName}-${routeName}`,
        plainFrame(`w1-${hostName}-${routeName}`)
      );
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      await wire.send('Page.enable', {}, attached.result.sessionId);
      settleChromeError(entry, failed, { tree: 'error' });
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: attached.result.sessionId,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      const from = wire.delivered.length;
      wire.emit({
        method: 'Page.windowOpen',
        sessionId: attached.result.sessionId,
        params: {
          url: ordinary,
          windowName: hostOnly,
          windowFeatures: ['popup'],
          userGesture: true,
        },
      });
      wire.emit({
        method: 'Page.javascriptDialogOpening',
        sessionId: attached.result.sessionId,
        params: {
          url: errorPage,
          message: hostOnly,
          type: 'prompt',
          hasBrowserHandler: true,
          defaultPrompt: hostOnly,
        },
      });
      wire.emit({
        method: 'Page.javascriptDialogClosed',
        sessionId: attached.result.sessionId,
        params: { result: true, userInput: hostOnly },
      });
      await wire.drain(10);
      const opened = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.windowOpen');
      const dialog = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.javascriptDialogOpening');
      const closed = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.javascriptDialogClosed');
      assert.ok(opened);
      assert.equal(opened.params.windowName, '');
      assert.deepEqual(opened.params.windowFeatures, ['popup']);
      assert.equal(opened.params.userGesture, true);
      assert.ok(dialog);
      assert.equal(dialog.params.message, '');
      assert.equal(dialog.params.defaultPrompt, '');
      assert.ok(closed);
      assert.equal(closed.params.userInput, '');
      assert.equal(closed.params.result, true);
      const blob = JSON.stringify({ opened, dialog, closed });
      assert.equal(blob.includes(hostOnly), false);
      assert.equal(blob.includes(failed), false);
    });

    test(`W1b unproven failed load blanks windowName and dialog names (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      const entry = wire.target(
        `w1b-${hostName}-${routeName}`,
        plainFrame(`w1b-${hostName}-${routeName}`)
      );
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      await wire.send('Page.enable', {}, attached.result.sessionId);
      const unproven = 'synthetic-unproven-failed-url';
      settleChromeError(entry, unproven, { tree: 'error' });
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: attached.result.sessionId,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      const from = wire.delivered.length;
      wire.emit({
        method: 'Page.windowOpen',
        sessionId: attached.result.sessionId,
        params: {
          url: ordinary,
          windowName: 'ordinary-window',
          windowFeatures: ['popup'],
          userGesture: true,
        },
      });
      wire.emit({
        method: 'Page.javascriptDialogOpening',
        sessionId: attached.result.sessionId,
        params: {
          url: errorPage,
          message: 'ordinary-dialog',
          type: 'prompt',
          hasBrowserHandler: true,
          defaultPrompt: 'ordinary-default',
        },
      });
      wire.emit({
        method: 'Page.javascriptDialogClosed',
        sessionId: attached.result.sessionId,
        params: { result: false, userInput: 'ordinary-input' },
      });
      await wire.drain(10);
      const opened = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.windowOpen');
      const dialog = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.javascriptDialogOpening');
      const closed = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.javascriptDialogClosed');
      assert.ok(opened);
      assert.equal(opened.params.windowName, '');
      assert.ok(dialog);
      assert.equal(dialog.params.message, '');
      assert.equal(dialog.params.defaultPrompt, '');
      assert.ok(closed);
      assert.equal(closed.params.userInput, '');
      assert.equal(JSON.stringify({ opened, dialog, closed }).includes(unproven), false);
    });

    test(`W2 ordinary failed load keeps windowName and dialog names (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      const entry = wire.target(
        `w2-${hostName}-${routeName}`,
        plainFrame(`w2-${hostName}-${routeName}`)
      );
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      await wire.send('Page.enable', {}, attached.result.sessionId);
      settleChromeError(entry, ordinaryFail, { tree: 'error' });
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: attached.result.sessionId,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      const from = wire.delivered.length;
      const openParams = {
        url: ordinary,
        windowName: 'ordinary-window',
        windowFeatures: ['popup'],
        userGesture: true,
      };
      const dialogParams = {
        url: ordinary,
        message: 'ordinary-dialog',
        type: 'prompt',
        hasBrowserHandler: true,
        defaultPrompt: 'ordinary-default',
      };
      const closedParams = { result: true, userInput: 'ordinary-input' };
      wire.emit({
        method: 'Page.windowOpen',
        sessionId: attached.result.sessionId,
        params: openParams,
      });
      wire.emit({
        method: 'Page.javascriptDialogOpening',
        sessionId: attached.result.sessionId,
        params: dialogParams,
      });
      wire.emit({
        method: 'Page.javascriptDialogClosed',
        sessionId: attached.result.sessionId,
        params: closedParams,
      });
      await wire.drain(10);
      const opened = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.windowOpen');
      const dialog = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.javascriptDialogOpening');
      const closed = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.javascriptDialogClosed');
      assert.ok(opened);
      assert.deepEqual(opened.params, openParams);
      assert.ok(dialog);
      assert.deepEqual(dialog.params, dialogParams);
      assert.ok(closed);
      assert.deepEqual(closed.params, closedParams);
    });

    test(`D1 protected failed load blanks suggestedFilename (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      const entry = wire.target(
        `d1-${hostName}-${routeName}`,
        plainFrame(`d1-${hostName}-${routeName}`)
      );
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      await wire.send('Page.enable', {}, attached.result.sessionId);
      settleChromeError(entry, failed, { tree: 'error' });
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: attached.result.sessionId,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      const from = wire.delivered.length;
      wire.emit({
        method: 'Page.downloadWillBegin',
        sessionId: attached.result.sessionId,
        params: {
          frameId: entry.info.targetId,
          guid: 'dl-protected',
          url: ordinary,
          suggestedFilename: hostOnly,
        },
      });
      await wire.drain(10);
      const download = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.downloadWillBegin');
      assert.ok(download);
      assert.equal(download.params.suggestedFilename, '');
      assert.equal(download.params.frameId, entry.info.targetId);
      assert.equal(JSON.stringify(download).includes(hostOnly), false);
      assert.equal(JSON.stringify(download).includes(failed), false);
    });

    test(`D1b unproven failed load blanks suggestedFilename (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      const entry = wire.target(
        `d1b-${hostName}-${routeName}`,
        plainFrame(`d1b-${hostName}-${routeName}`)
      );
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      await wire.send('Page.enable', {}, attached.result.sessionId);
      const unproven = 'synthetic-unproven-download-url';
      settleChromeError(entry, unproven, { tree: 'error' });
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: attached.result.sessionId,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      const from = wire.delivered.length;
      wire.emit({
        method: 'Page.downloadWillBegin',
        sessionId: attached.result.sessionId,
        params: {
          frameId: entry.info.targetId,
          guid: 'dl-unproven',
          url: ordinary,
          suggestedFilename: 'ordinary-download.bin',
        },
      });
      await wire.drain(10);
      const download = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.downloadWillBegin');
      assert.ok(download);
      assert.equal(download.params.suggestedFilename, '');
      assert.equal(JSON.stringify(download).includes(unproven), false);
    });

    test(`D2 ordinary failed load keeps suggestedFilename (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      const entry = wire.target(
        `d2-${hostName}-${routeName}`,
        plainFrame(`d2-${hostName}-${routeName}`)
      );
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      await wire.send('Page.enable', {}, attached.result.sessionId);
      settleChromeError(entry, ordinaryFail, { tree: 'error' });
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: attached.result.sessionId,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      const from = wire.delivered.length;
      const params = {
        frameId: entry.info.targetId,
        guid: 'dl-ordinary',
        url: ordinary,
        suggestedFilename: 'ordinary-download.bin',
      };
      wire.emit({
        method: 'Page.downloadWillBegin',
        sessionId: attached.result.sessionId,
        params,
      });
      await wire.drain(10);
      const download = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.downloadWillBegin');
      assert.ok(download);
      assert.deepEqual(download.params, params);
    });

    test(`positive ordinary page keeps protected host in AX/DOM/Runtime/Network/DOMSnapshot (${hostName}, ${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t, own, route);
      const entry = wire.target(
        `pos-${hostName}-${routeName}`,
        plainFrame(`pos-${hostName}-${routeName}`)
      );
      const linkName = hostOnly;
      const mention = `see ${hostOnly}/docs for help`;
      entry.ax = {
        nodes: [
          {
            nodeId: '1',
            ignore: false,
            role: { type: 'role', value: 'link' },
            name: { type: 'computedString', value: linkName },
          },
        ],
      };
      entry.document = {
        root: {
          nodeId: 1,
          nodeName: 'A',
          localName: 'a',
          nodeValue: '',
          attributes: ['href', '#', 'name', linkName],
          children: [],
        },
      };
      entry.evaluate = {
        result: {
          type: 'object',
          className: 'String',
          description: mention,
          value: mention,
        },
      };
      entry.snapshot = {
        documents: [{ nodes: { nodeName: [1], textValue: [2] } }],
        strings: ['#document', linkName],
      };
      const attached = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      await wire.send('Page.enable', {}, attached.result.sessionId);
      await wire.send('Network.enable', {}, attached.result.sessionId);
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: attached.result.sessionId,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      if (routeName !== 'extension') {
        const ax = await wire.send('Accessibility.getFullAXTree', {}, attached.result.sessionId);
        const dom = await wire.send('DOM.getDocument', {}, attached.result.sessionId);
        const snap = await wire.send(
          'DOMSnapshot.captureSnapshot',
          { computedStyles: [] },
          attached.result.sessionId
        );
        assert.equal(ax.error, undefined, JSON.stringify(ax));
        assert.equal(ax.result.nodes[0].name.value, linkName);
        assert.equal(dom.error, undefined, JSON.stringify(dom));
        assert.deepEqual(dom.result.root.attributes, ['href', '#', 'name', linkName]);
        assert.equal(snap.error, undefined, JSON.stringify(snap));
        assert.deepEqual(snap.result.strings, ['#document', linkName]);
      }
      const runtime = await wire.send(
        'Runtime.evaluate',
        { expression: 'document.title' },
        attached.result.sessionId
      );
      assert.equal(runtime.error, undefined, JSON.stringify(runtime));
      assert.equal(runtime.result.result.value, mention);
      assert.equal(runtime.result.result.description, mention);
      const from = wire.delivered.length;
      const networkParams = {
        requestId: `req-${hostName}`,
        loaderId: 'loader',
        documentURL: ordinary,
        request: {
          url: ordinary,
          method: 'GET',
          headers: { Referer: `https://ordinary.invalid/?from=${hostOnly}` },
        },
        timestamp: 1,
        wallTime: 1,
        initiator: { type: 'other' },
      };
      wire.emit({
        method: 'Network.requestWillBeSent',
        sessionId: attached.result.sessionId,
        params: networkParams,
      });
      await wire.drain(10);
      const network = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Network.requestWillBeSent');
      assert.ok(network, 'ordinary Network.requestWillBeSent is delivered');
      assert.equal(network.params.request.headers.Referer, networkParams.request.headers.Referer);
      const downloadParams = {
        frameId: entry.info.targetId,
        guid: 'dl-live',
        url: ordinary,
        suggestedFilename: `${hostOnly}-report.pdf`,
      };
      wire.emit({
        method: 'Page.downloadWillBegin',
        sessionId: attached.result.sessionId,
        params: downloadParams,
      });
      await wire.drain(10);
      const download = wire.delivered
        .slice(from)
        .find((message) => message.method === 'Page.downloadWillBegin');
      assert.ok(download);
      assert.deepEqual(download.params, downloadParams);
    });

    const oauthUrl = `${own}/oauth?code=SECRETCODE`;
    const carriers = [
      [
        'Page.windowOpen',
        {
          url: oauthUrl,
          windowName: 'vault-oauth',
          windowFeatures: ['popup'],
          userGesture: true,
        },
      ],
      [
        'Page.downloadWillBegin',
        {
          frameId: `drop-${hostName}-${routeName}`,
          guid: 'drop-dl',
          url: oauthUrl,
          suggestedFilename: `${hostOnly}-secret.bin`,
        },
      ],
      [
        'Page.javascriptDialogOpening',
        {
          url: oauthUrl,
          message: hostOnly,
          type: 'alert',
          hasBrowserHandler: true,
        },
      ],
      [
        'Page.frameNavigated',
        {
          frame: {
            id: `drop-${hostName}-${routeName}`,
            url: errorPage,
            securityOrigin: '://',
            unreachableUrl: failed,
            loaderId: 'drop-err',
            name: hostOnly,
          },
        },
      ],
    ];

    for (const [method, params] of carriers) {
      test(`drop ${method} on guard session never delivers (${hostName}, ${routeName})`, {
        timeout: 5000,
      }, async (t) => {
        const wire = protocol(t, own, route);
        const id = `drop-guard-${method.split('.').pop()}-${hostName}-${routeName}`;
        const entry = wire.target(id, plainFrame(id));
        const attached = await wire.send('Target.attachToTarget', {
          targetId: entry.info.targetId,
          flatten: true,
        });
        assert.equal(attached.error, undefined);
        await wire.send('Page.enable', {}, attached.result.sessionId);
        await wire.drain(20);
        const guardSession = `guard-${entry.info.targetId}`;
        assert.equal(
          wire.sessions.has(guardSession) ||
            wire.sent.some(
              (message) =>
                message.method === 'Target.attachToTarget' &&
                message.id >= 2 ** 30 &&
                message.params?.targetId === entry.info.targetId
            ),
          true,
          'guard session exists'
        );
        const from = wire.delivered.length;
        const shaped =
          method === 'Page.downloadWillBegin'
            ? { ...params, frameId: entry.info.targetId }
            : method === 'Page.frameNavigated'
              ? { frame: { ...params.frame, id: entry.info.targetId } }
              : params;
        wire.emit({ method, sessionId: guardSession, params: shaped });
        await wire.drain(10);
        const leaked = wire.delivered.slice(from).filter((message) => message.method === method);
        assert.deepEqual(leaked, [], `${method} on guard session must not reach the client`);
        assert.equal(JSON.stringify(wire.delivered.slice(from)).includes('SECRETCODE'), false);
        assert.equal(JSON.stringify(wire.delivered.slice(from)).includes(hostOnly), false);
      });

      test(`drop ${method} on blocked session never delivers (${hostName}, ${routeName})`, {
        timeout: 5000,
      }, async (t) => {
        const wire = protocol(t, own, route);
        const id = `drop-blocked-${method.split('.').pop()}-${hostName}-${routeName}`;
        const entry = wire.target(id, plainFrame(id));
        const attached = await wire.send('Target.attachToTarget', {
          targetId: entry.info.targetId,
          flatten: true,
        });
        assert.equal(attached.error, undefined);
        await wire.send('Page.enable', {}, attached.result.sessionId);
        await wire.drain(10);
        wire.emit({
          method: 'Page.frameNavigated',
          sessionId: attached.result.sessionId,
          params: {
            frame: {
              id: entry.info.targetId,
              url: `${own}/vault`,
              securityOrigin: own,
              loaderId: 'cut',
            },
          },
        });
        await wire.drain(10);
        const from = wire.delivered.length;
        const shaped =
          method === 'Page.downloadWillBegin'
            ? { ...params, frameId: entry.info.targetId }
            : method === 'Page.frameNavigated'
              ? { frame: { ...params.frame, id: entry.info.targetId } }
              : params;
        wire.emit({ method, sessionId: attached.result.sessionId, params: shaped });
        await wire.drain(10);
        const leaked = wire.delivered.slice(from).filter((message) => message.method === method);
        assert.deepEqual(leaked, [], `${method} on blocked session must not reach the client`);
        assert.equal(JSON.stringify(wire.delivered.slice(from)).includes('SECRETCODE'), false);
      });
    }
  }
}

function assertMaskedChromeError(info, label) {
  assert.equal(info?.url, errorPage, `${label}: url stays on the error page`);
  assert.equal(info?.title, errorPage, `${label}: title is scrubbed`);
  assert.equal(JSON.stringify(info).includes('seven.sliccy.ai'), false, `${label}: no seven host`);
  assert.equal(JSON.stringify(info).includes('vault.sliccy.ai'), false, `${label}: no vault host`);
}

describe('same-target failed-load proof', { concurrency: false }, () => {
  for (const [routeName, route] of routes) {
    test(`P1 ordinary then protected failed load on the same popup (${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const own = 'https://seven.sliccy.ai';
      const protectedFail = `${own}/doc?p1`;
      const wire = protocol(t, own, route);
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entry = await openPopup(wire, `p1-${routeName}`);
      const from = wire.delivered.length;
      autoAttach(wire, entry, `client-p1-${routeName}`, true);
      await wire.drain(20);
      settleChromeError(entry, ordinaryFail, { tree: 'error' });
      entry.tree.frame.loaderId = `p1-${routeName}-ordinary`;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${entry.info.targetId}`,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      await wire.tick(t.mock.timers, 3000);
      const ordinaryAttach = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(ordinaryAttach.error, undefined, 'ordinary proof is attachable');
      const ordinaryInfo = await wire.send('Target.getTargetInfo', {
        targetId: entry.info.targetId,
      });
      assertMaskedChromeError(ordinaryInfo.result.targetInfo, `P1 ordinary/${routeName}`);
      const afterOrdinary = wire.delivered.length;
      settleChromeError(entry, protectedFail, { tree: 'error' });
      entry.info.title = 'seven.sliccy.ai';
      entry.tree.frame.loaderId = `p1-${routeName}-protected`;
      wire.emit({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: { ...entry.info, attached: true } },
      });
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${entry.info.targetId}`,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      await wire.tick(t.mock.timers, 2000);
      assertNoChromeErrorAttach(wire, afterOrdinary, `P1/${routeName}`);
      const listed = await wire.send('Target.getTargets');
      const row = listed.result.targetInfos.find((info) => info.targetId === entry.info.targetId);
      assertMaskedChromeError(row, `P1 listed/${routeName}`);
      const again = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(again.error === undefined, false, 'protected second load stays refused');
    });

    test(`P2 protected then ordinary failed load on the same popup (${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const own = 'https://seven.sliccy.ai';
      const protectedFail = `${own}/doc?p2`;
      const wire = protocol(t, own, route);
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entry = await openPopup(wire, `p2-${routeName}`);
      const from = wire.delivered.length;
      autoAttach(wire, entry, `client-p2-${routeName}`, true);
      await wire.drain(20);
      settleChromeError(entry, protectedFail, { tree: 'error' });
      entry.info.title = 'seven.sliccy.ai';
      entry.tree.frame.loaderId = `p2-${routeName}-protected`;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${entry.info.targetId}`,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      await wire.tick(t.mock.timers, 2000);
      assertNoChromeErrorAttach(wire, from, `P2 protected/${routeName}`);
      const refused = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(refused.error === undefined, false, 'protected first load stays refused');
      entry.info.url = 'about:blank';
      entry.info.title = '';
      entry.tree.frame = blankFrame(entry.info.targetId);
      entry.tree.frame.loaderId = `p2-${routeName}-blank`;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${entry.info.targetId}`,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      settleChromeError(entry, ordinaryFail, { tree: 'error' });
      entry.tree.frame.loaderId = `p2-${routeName}-ordinary`;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${entry.info.targetId}`,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      await wire.tick(t.mock.timers, 3000);
      const admitted = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(
        admitted.error,
        undefined,
        'ordinary second load is attachable after its own proof'
      );
      const info = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
      assertMaskedChromeError(info.result.targetInfo, `P2/${routeName}`);
    });

    test(`P3 back-to-back ordinary then protected with no settle (${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const own = 'https://seven.sliccy.ai';
      const protectedFail = `${own}/doc?p3`;
      const wire = protocol(t, own, route);
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entry = await openPopup(wire, `p3-${routeName}`);
      const from = wire.delivered.length;
      autoAttach(wire, entry, `client-p3-${routeName}`, true);
      await wire.drain(20);
      settleChromeError(entry, ordinaryFail, { tree: 'error' });
      entry.tree.frame.loaderId = `p3-${routeName}-ordinary`;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${entry.info.targetId}`,
        params: { frame: entry.tree.frame },
      });
      settleChromeError(entry, protectedFail, { tree: 'error' });
      entry.info.title = 'seven.sliccy.ai';
      entry.tree.frame.loaderId = `p3-${routeName}-protected`;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${entry.info.targetId}`,
        params: { frame: entry.tree.frame },
      });
      wire.emit({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: { ...entry.info, attached: true } },
      });
      await wire.drain(10);
      await wire.tick(t.mock.timers, 3000);
      const released = wire.chromeErrorAttaches(from);
      for (const message of released) {
        assertMaskedChromeError(message.params.targetInfo, `P3 released/${routeName}`);
        assert.equal(
          JSON.stringify(message).includes(protectedFail),
          false,
          'protected markers never reach the client'
        );
      }
      const again = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(again.error === undefined, false, 'final protected document stays refused');
    });

    test(`P4 stale ordinary proof must not apply after a new navigation (${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const own = 'https://seven.sliccy.ai';
      const protectedFail = `${own}/doc?p4`;
      const wire = protocol(t, own, route);
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entry = await openPopup(wire, `p4-${routeName}`);
      autoAttach(wire, entry, `client-p4-${routeName}`, true);
      await wire.drain(20);
      const ordinaryTree = {
        id: entry.info.targetId,
        url: errorPage,
        securityOrigin: '://',
        loaderId: `p4-${routeName}-ordinary`,
      };
      const protectedTree = errorFrame(entry.info.targetId, protectedFail);
      protectedTree.loaderId = `p4-${routeName}-protected`;
      entry.info.url = errorPage;
      entry.info.title = errorPage;
      entry.tree.frame = ordinaryTree;
      entry.history = {
        currentIndex: 0,
        entries: [{ id: 1, url: ordinaryFail, userTypedURL: ordinaryFail, title: '' }],
      };
      let pendingHistory;
      wire.hold((message) => {
        if (message.method !== 'Page.getNavigationHistory' || pendingHistory) return false;
        pendingHistory = message;
        queueMicrotask(async () => {
          entry.info.title = 'seven.sliccy.ai';
          entry.tree.frame = protectedTree;
          entry.history = {
            currentIndex: 0,
            entries: [{ id: 1, url: protectedFail, userTypedURL: protectedFail, title: 'seven' }],
          };
          wire.emit({
            method: 'Page.frameNavigated',
            sessionId: `guard-${entry.info.targetId}`,
            params: { frame: protectedTree },
          });
          await wire.drain(8);
          wire.hold(() => false);
          const { id, sessionId } = pendingHistory;
          wire.emit({
            id,
            ...(sessionId ? { sessionId } : {}),
            result: {
              currentIndex: 0,
              entries: [{ id: 1, url: ordinaryFail, userTypedURL: ordinaryFail, title: '' }],
            },
          });
        });
        return true;
      });
      const from = wire.delivered.length;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${entry.info.targetId}`,
        params: { frame: ordinaryTree },
      });
      await wire.drain(20);
      await wire.tick(t.mock.timers, 3000);
      assertNoChromeErrorAttach(wire, from, `P4/${routeName}`);
      const listed = await wire.send('Target.getTargets');
      const row = listed.result.targetInfos.find((info) => info.targetId === entry.info.targetId);
      assertMaskedChromeError(row, `P4 listed/${routeName}`);
    });

    test(`P5 target-id verdict is bound to the document loader (${routeName})`, {
      timeout: 5000,
    }, async (t) => {
      const own = 'https://vault.sliccy.ai';
      const protectedFail = `${own}/doc?p5`;
      const wire = protocol(t, own, route);
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entry = await openPopup(wire, `p5-${routeName}`);
      const from = wire.delivered.length;
      autoAttach(wire, entry, `client-p5-${routeName}`, true);
      await wire.drain(20);
      settleChromeError(entry, ordinaryFail, { tree: 'error' });
      entry.tree.frame.loaderId = `p5-${routeName}-ordinary`;
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${entry.info.targetId}`,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      await wire.tick(t.mock.timers, 3000);
      assert.equal(wire.chromeErrorAttaches(from).length, 1);
      settleChromeError(entry, protectedFail, { tree: 'error' });
      entry.info.title = 'vault.sliccy.ai';
      entry.tree.frame.loaderId = `p5-${routeName}-protected`;
      const after = wire.delivered.length;
      wire.emit({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: { ...entry.info, attached: true } },
      });
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${entry.info.targetId}`,
        params: { frame: entry.tree.frame },
      });
      await wire.drain(10);
      await wire.tick(t.mock.timers, 2000);
      assertNoChromeErrorAttach(wire, after, `P5/${routeName}`);
      const info = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
      assertMaskedChromeError(info.result.targetInfo, `P5 info/${routeName}`);
    });
  }
});

for (const [routeName, route] of routes) {
  test(`ordinary unreachable chrome-error is released after proof (${routeName})`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t, 'https://seven.sliccy.ai', route);
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entry = await openPopup(wire, `ordinary-${routeName}`);
    const from = wire.delivered.length;
    autoAttach(wire, entry, `client-ordinary-${routeName}`, true);
    await wire.drain(20);
    settleChromeError(entry, ordinaryFail, { tree: 'error' });
    entry.tree.frame.loaderId = `ordinary-${routeName}-loader`;
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: `guard-${entry.info.targetId}`,
      params: { frame: entry.tree.frame },
    });
    await wire.drain(10);
    await wire.tick(t.mock.timers, 3000);
    const released = wire.chromeErrorAttaches(from);
    if (released.length === 1) {
      assert.equal(released[0].params.targetInfo.url, errorPage);
      assert.equal(released[0].params.targetInfo.title, errorPage);
      assert.equal(JSON.stringify(released[0]).includes(ordinaryFail), false);
      assert.equal(JSON.stringify(released[0]).includes('ordinary.invalid'), false);
    } else {
      const admitted = await wire.send('Target.attachToTarget', {
        targetId: entry.info.targetId,
        flatten: true,
      });
      assert.equal(admitted.error, undefined, 'ordinary proof is attachable');
      const info = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
      assertMaskedChromeError(info.result.targetInfo, `ordinary/${routeName}`);
      assert.equal(JSON.stringify(info).includes(ordinaryFail), false);
    }
  });

  test(`protected unreachable chrome-error stays held through the error document (${routeName})`, {
    timeout: 5000,
  }, async (t) => {
    const own = 'https://vault.sliccy.ai';
    const failed = `${own}/doc?held`;
    const wire = protocol(t, own, route);
    t.mock.timers.reset();
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

describe('createTarget provenance races', { concurrency: false }, () => {
  for (const [order, label] of [
    ['events-then-reply', 'C8a events before createTarget reply'],
    ['reply-then-events', 'C8b reply before target events'],
    ['attach-race', 'C8c attachedToTarget racing the reply'],
  ]) {
    for (const [routeName, route] of routes) {
      test(`${label} admits createTarget without an opener at once (${routeName})`, {
        timeout: 5000,
      }, async (t) => {
        const wire = protocol(t, 'https://seven.sliccy.ai', route);
        wire.setCreateOrder(order);
        t.mock.timers.reset();
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const from = wire.delivered.length;
        const created = await wire.send('Target.createTarget', {
          url: ordinary,
          background: true,
        });
        await wire.drain(20);
        await wire.tick(t.mock.timers, 500);
        assert.equal(created.error, undefined, JSON.stringify(created));
        assert.ok(created.result?.targetId, 'createTarget returns a targetId');
        const attaches = wire
          .clientAttaches(from)
          .filter((message) => message.params?.targetInfo?.targetId === created.result.targetId);
        assert.ok(attaches.length >= 1, `${label}: auto-attach is delivered`);
        assert.equal(
          attaches.every(
            (message) => !String(message.params.targetInfo.url).startsWith('chrome-error:')
          ),
          true,
          `${label}: createTarget attach is not held on chrome-error`
        );
        const again = await wire.send('Target.attachToTarget', {
          targetId: created.result.targetId,
          flatten: true,
        });
        assert.equal(again.error, undefined, `${label}: re-attach is admitted`);
        const info = await wire.send('Target.getTargetInfo', {
          targetId: created.result.targetId,
        });
        assert.equal(info.error, undefined);
        assert.equal(info.result.targetInfo.openerId, undefined);
      });
    }
  }
});
