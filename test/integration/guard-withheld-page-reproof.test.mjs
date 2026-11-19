import assert from 'node:assert/strict';
import test from 'node:test';
import { RELAY } from '../../src/seed/adobe.js';
import { extensionConnection } from '../../src/seed/cdp.js';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';

const SEVEN = 'https://seven.invalid';
const ORDINARY = 'https://ordinary.invalid/doc?n=host';
const VAULT = 'https://vault.sliccy.ai/doc?n=frame';
const CALLBACK = `${RELAY}?code=withheld-code&state=withheld-state`;
const TABS = [{ type: 'page', exclude: true }, {}];
const BOUND = 10000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const origin = (url) => (URL.canParse(url) ? new URL(url).origin : '://');

function browser(pages) {
  const listeners = new Set();
  const sent = [];
  const owners = new Map();
  const broken = new Set();
  let count = 0;
  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const reported = (targetId) => {
    const page = pages[targetId];
    if (page.reveal) {
      page.reveal = false;
      page.navigating = true;
      return page.next;
    }
    return page.navigating ? '' : page.url;
  };
  const info = (targetId, url = pages[targetId].url) => ({
    targetId,
    type: 'page',
    title: url,
    url,
    attached: true,
    canAccessOpener: false,
    browserContextId: 'context',
  });
  const answers = {
    'Target.getTargets': () => ({
      targetInfos: Object.keys(pages).map((targetId) => info(targetId)),
    }),
    'Target.getTargetInfo': ({ targetId }, sessionId) => {
      const id = targetId ?? owners.get(sessionId);
      return { targetInfo: info(id, reported(id)) };
    },
    'Target.attachToTarget': ({ targetId }) => {
      if (!pages[targetId]) throw new Error('No target with given id found');
      count += 1;
      const sessionId = `${targetId}~${count}`;
      owners.set(sessionId, targetId);
      if (pages[targetId].racing) {
        pages[targetId].racing = false;
        pages[targetId].reveal = true;
        pages[targetId].session = sessionId;
      }
      if (pages[targetId].breaking) {
        pages[targetId].breaking = false;
        pages[targetId].session = sessionId;
        broken.add(sessionId);
      }
      return { sessionId };
    },
    'Target.detachFromTarget': ({ sessionId }) => {
      const targetId = owners.get(sessionId);
      owners.delete(sessionId);
      queueMicrotask(() =>
        emit({ method: 'Target.detachedFromTarget', params: { sessionId, targetId } })
      );
      return {};
    },
    'Page.getFrameTree': (_, sessionId) => {
      if (broken.has(sessionId)) throw new Error('No frame tree for this session');
      const targetId = owners.get(sessionId);
      const url = pages[targetId].url;
      return {
        frameTree: {
          frame: {
            id: targetId,
            loaderId: pages[targetId].loader ?? 'loader-0',
            url,
            securityOrigin: origin(url),
            mimeType: 'text/html',
          },
        },
      };
    },
    'Page.getNavigationHistory': (_, sessionId) => ({
      currentIndex: 0,
      entries: [{ id: 0, url: pages[owners.get(sessionId)].url, title: '' }],
    }),
    'DOMSnapshot.captureSnapshot': () => ({ documents: [], strings: [] }),
    'Runtime.evaluate': () => ({ result: { type: 'string', value: 'framed' } }),
  };
  return {
    sent,
    owners,
    broken,
    emit,
    sessionsOf: (targetId) =>
      [...owners].filter(([, owner]) => owner === targetId).map(([sessionId]) => sessionId),
    announce(targetId, url) {
      const page = pages[targetId];
      page.navigating = false;
      page.url = url;
      page.loader = `loader-${url}`;
      emit({ method: 'Target.targetInfoChanged', params: { targetInfo: info(targetId, url) } });
    },
    commit(targetId, url) {
      const page = pages[targetId];
      page.navigating = false;
      page.url = url;
      page.loader = `loader-${url}`;
      for (const sessionId of this.sessionsOf(targetId))
        emit({
          method: 'Page.frameNavigated',
          sessionId,
          params: {
            frame: {
              id: targetId,
              loaderId: page.loader,
              url,
              securityOrigin: origin(url),
              mimeType: 'text/html',
            },
            type: 'Navigation',
          },
        });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(method, params, sessionId) {
      sent.push({ method, params, sessionId, at: Date.now() });
      await Promise.resolve();
      return answers[method]?.(params ?? {}, sessionId) ?? {};
    },
  };
}

function client(t, pages) {
  const cdp = browser(pages);
  const transport = extensionConnection(cdp, 20);
  const guarded = guardProtected(transport, [SEVEN], new Map(), {
    kind: 'extension',
    version: '7.12.2',
  });
  t.after(() => {
    guarded.close?.();
    transport.close();
  });
  const got = [];
  guarded.onmessage = (text) => got.push({ ...JSON.parse(text), at: Date.now() });
  let id = 0;
  const send = async (method, params = {}, sessionId) => {
    id += 1;
    const mine = id;
    guarded.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
    for (let n = 0; n < 1200 && !got.some((message) => message.id === mine); n++) await pause(5);
    const answer = got.find((message) => message.id === mine);
    assert.ok(answer, `${method} got an answer through the guard`);
    return answer;
  };
  const until = async (check, ms, what) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = check();
      if (found) return found;
      await pause(10);
    }
    assert.fail(`${what} within ${ms} ms; the client got ${JSON.stringify(got).slice(0, 3000)}`);
  };
  const tab = (pageId) =>
    got.find(
      (message) =>
        message.method === 'Target.attachedToTarget' &&
        message.params.targetInfo.targetId === `tab-${pageId}`
    )?.params.sessionId;
  const page = (tabSession) =>
    got.find(
      (message) =>
        message.method === 'Target.attachedToTarget' &&
        message.sessionId === tabSession &&
        message.params.targetInfo.type === 'page'
    );
  const cut = (tabSession, pageId) =>
    got.some(
      (message) =>
        message.method === 'Target.detachedFromTarget' && message.params.sessionId === tabSession
    ) &&
    got.some(
      (message) =>
        message.method === 'Target.targetDestroyed' && message.params.targetId === `tab-${pageId}`
    );
  const open = async (pageId, race = true) => {
    await until(() => tab(pageId), 3000, `the client got the tab of ${pageId}`);
    if (race) pages[pageId].racing = true;
    else pages[pageId].breaking = true;
    const answer = await send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{}] },
      tab(pageId)
    );
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    await until(
      () => (race ? pages[pageId].navigating : !pages[pageId].breaking),
      3000,
      `the page of ${pageId} was attached under its tab`
    );
    return tab(pageId);
  };
  const start = async () => {
    const answer = await send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: TABS,
    });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
  };
  const leaked = (...values) => values.filter((value) => JSON.stringify(got).includes(value));
  return { cdp, got, send, until, tab, page, cut, open, start, leaked };
}

const racing = (...ids) =>
  Object.fromEntries(
    ids.map((id) => [id, { url: 'about:blank', next: ORDINARY, navigating: false }])
  );

test('a page auto-attached under its tab while the first read says url "" is delivered after it commits to an ordinary URL, and its evaluate is admitted', {
  timeout: 30000,
}, async (t) => {
  const pages = racing('host');
  const wire = client(t, pages);
  await wire.start();
  const tabSession = await wire.open('host');
  await pause(50);
  assert.equal(wire.page(tabSession), undefined, 'nothing is shown before the page commits');
  wire.cdp.commit('host', ORDINARY);
  const attached = await wire.until(
    () => wire.page(tabSession),
    3000,
    'the page session was delivered under its tab after the ordinary commit'
  );
  const evaluated = await wire.send(
    'Runtime.evaluate',
    { expression: "'framed'", returnByValue: true },
    attached.params.sessionId
  );
  assert.equal(evaluated.error, undefined, JSON.stringify(evaluated));
  assert.equal(evaluated.result.result.value, 'framed');
  assert.equal(wire.cut(tabSession, 'host'), false, 'the ordinary tab stays');
});

for (const [name, url, secrets] of [
  ['seven', `${SEVEN}/os/`, ['seven.invalid']],
  ['the vault', VAULT, ['vault.sliccy.ai']],
  ['the sign-in callback', CALLBACK, ['withheld-code', 'withheld-state', 'www.sliccy.ai']],
]) {
  test(`a page withheld while its first read says url "" that commits to ${name} is cut at once and never shown`, {
    timeout: 30000,
  }, async (t) => {
    const pages = racing('host');
    const wire = client(t, pages);
    await wire.start();
    const tabSession = await wire.open('host');
    pages.host.next = url;
    const committed = Date.now();
    wire.cdp.commit('host', url);
    await wire.until(
      () => wire.cut(tabSession, 'host'),
      3000,
      'the tab was detached and destroyed after the protected commit'
    );
    const cutAt = wire.got.find(
      (message) =>
        message.method === 'Target.targetDestroyed' && message.params.targetId === 'tab-host'
    ).at;
    assert.ok(cutAt - committed < 3000, `cut ${cutAt - committed} ms after the commit`);
    await pause(200);
    assert.equal(wire.page(tabSession), undefined, 'the protected page was never shown');
    assert.deepEqual(wire.leaked(...secrets), []);
  });
}

test('a page withheld while its reads say url "" and that never commits is cut at the bound with detach and destroyed, never admitted', {
  timeout: 40000,
}, async (t) => {
  const pages = racing('host');
  const wire = client(t, pages);
  await wire.start();
  const started = Date.now();
  const tabSession = await wire.open('host');
  await wire.until(
    () => wire.cut(tabSession, 'host'),
    BOUND + 5000,
    'the undecided tab was detached and destroyed at the bound'
  );
  const cutAt = wire.got.find(
    (message) =>
      message.method === 'Target.targetDestroyed' && message.params.targetId === 'tab-host'
  ).at;
  assert.ok(cutAt - started >= BOUND - 500, `not cut early: ${cutAt - started} ms`);
  assert.equal(wire.page(tabSession), undefined, 'the unproven page was never shown');
});

test('a withheld page session that detaches is not read again, and its later commit delivers nothing', {
  timeout: 30000,
}, async (t) => {
  const pages = racing('host');
  const wire = client(t, pages);
  await wire.start();
  const tabSession = await wire.open('host');
  const withheld = pages.host.session;
  assert.ok(withheld, 'the auto-attached page session exists');
  await wire.cdp.send('Target.detachFromTarget', { sessionId: withheld });
  await pause(100);
  const mark = wire.cdp.sent.length;
  wire.cdp.commit('host', ORDINARY);
  await pause(1500);
  assert.deepEqual(
    wire.cdp.sent.slice(mark).filter((call) => call.sessionId === withheld),
    [],
    'no command went to the detached session'
  );
  assert.equal(wire.page(tabSession), undefined, 'the detached session was never shown');
});

test('two pages in the same race are decided independently: the ordinary commit is delivered, the other is cut at the bound', {
  timeout: 40000,
}, async (t) => {
  const pages = racing('first', 'second');
  const wire = client(t, pages);
  await wire.start();
  const first = await wire.open('first');
  const second = await wire.open('second');
  wire.cdp.commit('first', ORDINARY);
  const attached = await wire.until(
    () => wire.page(first),
    3000,
    'the first page was delivered after its ordinary commit'
  );
  const evaluated = await wire.send(
    'Runtime.evaluate',
    { expression: "'framed'", returnByValue: true },
    attached.params.sessionId
  );
  assert.equal(evaluated.error, undefined, JSON.stringify(evaluated));
  assert.equal(wire.page(second), undefined, 'the second page is still undecided');
  await wire.until(
    () => wire.cut(second, 'second'),
    BOUND + 5000,
    'the second tab was detached and destroyed at the bound'
  );
  assert.equal(wire.page(second), undefined, 'the second page was never shown');
  assert.equal(wire.cut(first, 'first'), false, 'the first tab stays');
});

test('a page withheld while its first read says url "" is delivered when only Target.targetInfoChanged announces its ordinary URL', {
  timeout: 30000,
}, async (t) => {
  const pages = racing('host');
  const wire = client(t, pages);
  await wire.start();
  const tabSession = await wire.open('host');
  wire.cdp.announce('host', ORDINARY);
  const attached = await wire.until(
    () => wire.page(tabSession),
    3000,
    'the page session was delivered after targetInfoChanged named its ordinary URL'
  );
  assert.equal(attached.params.targetInfo.url, ORDINARY);
});

test('a content read on a shown session is proved through that session while another session of the same page keeps failing its tree read', {
  timeout: 40000,
}, async (t) => {
  const pages = { host: { url: ORDINARY, navigating: false } };
  const wire = client(t, pages);
  await wire.start();
  const tabSession = await wire.open('host', false);
  await pause(300);
  assert.equal(wire.page(tabSession), undefined, 'the session whose tree read fails is withheld');
  const explicit = await wire.send('Target.attachToTarget', { targetId: 'host', flatten: true });
  assert.equal(explicit.error, undefined, JSON.stringify(explicit));
  const evaluated = await wire.send(
    'Runtime.evaluate',
    { expression: "'framed'", returnByValue: true },
    explicit.result.sessionId
  );
  assert.equal(evaluated.error, undefined, JSON.stringify(evaluated));
  assert.equal(evaluated.result.result.value, 'framed');
  wire.cdp.broken.add(explicit.result.sessionId);
  const unproved = await wire.send(
    'Runtime.evaluate',
    { expression: "'framed'", returnByValue: true },
    explicit.result.sessionId
  );
  assert.equal(unproved.error?.message, PROTECTED, 'no session of the page proves it any more');
  await wire.until(
    () => wire.cut(tabSession, 'host'),
    BOUND + 5000,
    'the undecided session was cut with its tab at the bound'
  );
  assert.equal(wire.page(tabSession), undefined, 'the failing session was never shown');
  assert.ok(
    !wire.got.some(
      (message) => message.method === 'Target.targetDestroyed' && message.params.targetId === 'host'
    ),
    'the page the client still holds is not announced destroyed'
  );
});
