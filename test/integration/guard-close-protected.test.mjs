import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';
import {
  errorFrame,
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-state-fixture.mjs';

const secret = `${protectedOrigin}/?code=SECRET-CODE`;
const protectedFrame = (id, url = secret) => ({
  ...plainFrame(id),
  url,
  securityOrigin: new URL(url).origin,
});

function locked(t, id, type = 'page', url = secret) {
  const wire = protocol(t);
  const entry = wire.target(id, type, protectedFrame(id, url));
  entry.info.title = 'SECRET-TITLE';
  return { wire, entry };
}

const forwarded = (wire, mark, method, targetId) =>
  wire
    .clients(mark)
    .some((message) => message.method === method && message.params?.targetId === targetId);

const unreached = async (wire, targetId) => {
  for (const [method, params] of [
    ['Target.getTargetInfo', { targetId }],
    ['Target.attachToTarget', { targetId, flatten: true }],
    ['Target.activateTarget', { targetId }],
    ['Browser.getWindowForTarget', { targetId }],
  ]) {
    const mark = wire.sent.length;
    const answer = await wire.send(method, params);
    assert.equal(answer.error?.message, PROTECTED, method);
    assert.equal(answer.result, undefined, method);
    assert.equal(forwarded(wire, mark, method, targetId), false, method);
  }
};

test('a protected tab can be closed while every way to reach it stays refused', async (t) => {
  const { wire } = locked(t, 'locked-tab');
  await unreached(wire, 'locked-tab');
  assert.equal((await wire.send('Target.getTargets')).result.targetInfos.length, 0);
  const mark = wire.sent.length;
  const closed = await wire.send('Target.closeTarget', { targetId: 'locked-tab' });
  assert.equal(closed.error, undefined);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'locked-tab'), true);
  assert.equal(JSON.stringify(wire.delivered).includes('SECRET'), false);
});

test('a tab that turns protected under its session stays cut but can be closed', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('turned');
  const session = await wire.attach('turned');
  entry.tree.frame = protectedFrame('turned');
  entry.info.url = secret;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-turned',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  for (const [method, params] of [
    ['Runtime.evaluate', { expression: 'document.title' }],
    ['Page.navigate', { url: ordinary }],
    ['Page.captureScreenshot', {}],
    ['Target.closeTarget', { targetId: 'turned' }],
  ]) {
    const mark = wire.sent.length;
    const answer = await wire.send(method, params, session);
    assert.match(answer.error?.message ?? '', /^slicc: refused:/, method);
    assert.equal(
      wire.clients(mark).some((message) => message.method === method),
      false,
      method
    );
  }
  await unreached(wire, 'turned');
  const mark = wire.sent.length;
  assert.equal((await wire.send('Target.closeTarget', { targetId: 'turned' })).error, undefined);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'turned'), true);
  assert.equal(JSON.stringify(wire.delivered).includes('SECRET'), false);
});

test('a held sign-in tab can be closed but not reached', async (t) => {
  const wire = protocol(t);
  wire.target('held-sign-in');
  hold('held-sign-in');
  await unreached(wire, 'held-sign-in');
  const mark = wire.sent.length;
  assert.equal(
    (await wire.send('Target.closeTarget', { targetId: 'held-sign-in' })).error,
    undefined
  );
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'held-sign-in'), true);
});

for (const type of ['iframe', 'service_worker', 'browser_ui', 'other']) {
  test(`a protected ${type} target stays unclosable`, async (t) => {
    const { wire } = locked(t, `locked-${type}`, type);
    const mark = wire.sent.length;
    const answer = await wire.send('Target.closeTarget', { targetId: `locked-${type}` });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(forwarded(wire, mark, 'Target.closeTarget', `locked-${type}`), false);
  });
}

const kept = [
  ['seven’s UI', `${protectedOrigin}/os/`],
  ['a seven UI page', `${protectedOrigin}/os/index.html?x=1`],
  ['seven’s UI on another seven origin', 'https://www.sliccy.ai/os/'],
  ['seven’s UI on seven.sliccy.ai', 'https://seven.sliccy.ai./os/terminal'],
  ['the vault', 'https://vault.sliccy.ai/landing?k=SECRET'],
  ['a vault preview', 'https://vault-x.sliccy.ai/'],
  ['the vault with a trailing dot', 'https://vault.sliccy.ai./'],
  ['the vault over http on another port', 'http://vault.sliccy.ai:8080/'],
];
for (const [what, url] of kept) {
  test(`a live document of ${what} stays unclosable and unreachable`, async (t) => {
    const { wire } = locked(t, 'kept-tab', 'page', url);
    await unreached(wire, 'kept-tab');
    const mark = wire.sent.length;
    const answer = await wire.send('Target.closeTarget', { targetId: 'kept-tab' });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'kept-tab'), false);
  });
}

const closable = [
  ['seven’s sign-in callback', `${protectedOrigin}/os/callback.html`],
  ['a page on seven’s origin outside its UI', `${protectedOrigin}/oauth?code=SECRET-CODE`],
  ['a seven origin outside its UI', 'https://www.sliccy.ai/?code=SECRET-CODE'],
  ['seven’s UI path on a non-seven sliccy.ai host', 'https://get.sliccy.ai/os/'],
  ['seven’s UI path on a non-default port', 'https://www.sliccy.ai:8443/os/'],
  ['the sliccy.ai apex', 'https://sliccy.ai/os/'],
];
for (const [what, url] of closable) {
  test(`a live document of ${what} can be closed but not reached`, async (t) => {
    const { wire } = locked(t, 'open-tab', 'page', url);
    await unreached(wire, 'open-tab');
    const mark = wire.sent.length;
    assert.equal(
      (await wire.send('Target.closeTarget', { targetId: 'open-tab' })).error,
      undefined
    );
    assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'open-tab'), true);
  });
}

const wrapped = [
  ['view-source of the vault', 'view-source:https://vault.sliccy.ai/secret?k=SECRET'],
  ['a blob of the vault', 'blob:https://vault.sliccy.ai/11111111-1111-1111-1111-111111111111'],
  ['filesystem of the vault', 'filesystem:https://vault.sliccy.ai/temporary/a'],
  ['view-source of seven’s UI', 'view-source:https://seven.sliccy.ai/os/'],
];
for (const [what, url] of wrapped) {
  test(`a live document of ${what} stays unclosable`, async (t) => {
    const { wire } = locked(t, 'wrapped-tab', 'page', url);
    const mark = wire.sent.length;
    const answer = await wire.send('Target.closeTarget', { targetId: 'wrapped-tab' });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'wrapped-tab'), false);
  });
}

test('seven’s UI with userinfo stays unclosable', async (t) => {
  const { wire } = locked(t, 'userinfo-tab', 'page', 'https://user:x@seven.sliccy.ai/os/');
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'userinfo-tab' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'userinfo-tab'), false);
});

test('a tab navigating to the vault stays unclosable', async (t) => {
  const wire = protocol(t);
  wire.target('pending-tab');
  await wire.attach('pending-tab');
  wire.emit({
    method: 'Page.frameStartedNavigating',
    sessionId: 'guard-pending-tab',
    params: {
      frameId: 'pending-tab',
      url: 'https://vault.sliccy.ai/app?k=SECRET',
      loaderId: 'pending-loader',
    },
  });
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'pending-tab' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'pending-tab'), false);
});

for (const [what, url] of kept) {
  test(`an error page whose target URL is still ${what} stays unclosable`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('failed-tab');
    await wire.attach('failed-tab');
    entry.tree.frame = { ...errorFrame('failed-tab'), unreachableUrl: url };
    entry.info.url = url;
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-failed-tab',
      params: { frame: entry.tree.frame },
    });
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    await flush();
    const mark = wire.sent.length;
    const answer = await wire.send('Target.closeTarget', { targetId: 'failed-tab' });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'failed-tab'), false);
  });
}

test('a scrubbed chrome-error page left by a failed protected load can be closed', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('scrubbed-tab');
  await wire.attach('scrubbed-tab');
  entry.tree.frame = {
    ...errorFrame('scrubbed-tab'),
    unreachableUrl: 'https://vault.sliccy.ai/failed',
  };
  entry.info.url = 'chrome-error://chromewebdata/';
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-scrubbed-tab',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  const mark = wire.sent.length;
  assert.equal(
    (await wire.send('Target.closeTarget', { targetId: 'scrubbed-tab' })).error,
    undefined
  );
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'scrubbed-tab'), true);
});

for (const [what, openerUrl, origin, suffix] of [
  ['the vault', 'https://vault.sliccy.ai/landing', 'https://vault.sliccy.ai', 'vault'],
  ['seven’s UI', 'https://seven.sliccy.ai/os/', 'https://seven.sliccy.ai', 'seven'],
]) {
  test(`about:blank opened from ${what} stays unclosable`, async (t) => {
    const wire = protocol(t);
    const openerId = `opener-${suffix}`;
    const blankId = `blank-${suffix}`;
    const opener = wire.target(openerId, 'page', {
      ...plainFrame(openerId),
      url: openerUrl,
      securityOrigin: origin,
    });
    opener.info.url = openerUrl;
    const blank = { id: blankId, url: 'about:blank', securityOrigin: origin };
    const child = wire.target(blankId, 'page', blank);
    child.info.url = 'about:blank';
    child.info.openerId = openerId;
    const mark = wire.sent.length;
    const answer = await wire.send('Target.closeTarget', { targetId: blankId });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(forwarded(wire, mark, 'Target.closeTarget', blankId), false);
  });
}

for (const [what, id] of [
  ['while target info is still ordinary', 'stale-tab'],
  ['after a drained queue while target info is still ordinary', 'stale-drained'],
]) {
  test(`a committed vault document stays unclosable ${what}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target(id);
    await wire.attach(id);
    entry.tree.frame = {
      id,
      url: 'https://vault.sliccy.ai/app?k=SECRET',
      securityOrigin: 'https://vault.sliccy.ai',
    };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: `guard-${id}`,
      params: { frame: entry.tree.frame },
    });
    await flush();
    if (id === 'stale-drained') {
      await wire.send('Target.getTargets');
      await flush();
    }
    const mark = wire.sent.length;
    const answer = await wire.send('Target.closeTarget', { targetId: id });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(forwarded(wire, mark, 'Target.closeTarget', id), false);
  });
}

test('a same-document move onto seven’s UI stays unclosable while target info is still outside /os/', async (t) => {
  const wire = protocol(t);
  const start = 'https://seven.sliccy.ai/oauth?code=1';
  const kept = 'https://seven.sliccy.ai/os/index.html';
  const entry = wire.target('within-tab');
  await wire.attach('within-tab');
  entry.info.url = start;
  entry.tree.frame = {
    id: 'within-tab',
    url: start,
    securityOrigin: 'https://seven.sliccy.ai',
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-within-tab',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  entry.tree.frame = {
    id: 'within-tab',
    url: kept,
    securityOrigin: 'https://seven.sliccy.ai',
  };
  wire.emit({
    method: 'Page.navigatedWithinDocument',
    sessionId: 'guard-within-tab',
    params: { frameId: 'within-tab', url: kept },
  });
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'within-tab' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'within-tab'), false);
});

const leave = async (wire, entry, id, url) => {
  entry.info.url = url;
  entry.tree.frame = {
    id,
    url,
    securityOrigin: URL.canParse(url) && /^https?:/i.test(url) ? new URL(url).origin : '://',
    ...(url.startsWith('chrome-error:')
      ? { unreachableUrl: 'https://vault.sliccy.ai/failed' }
      : {}),
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${id}`,
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  await wire.send('Target.getTargets');
  await flush();
};

for (const [what, keptUrl, nextUrl, id] of [
  ['the vault for an ordinary page', 'https://vault.sliccy.ai/app', ordinary, 'left-vault'],
  [
    'seven’s UI for a page outside /os/',
    'https://seven.sliccy.ai/os/index.html',
    'https://seven.sliccy.ai/oauth',
    'left-os',
  ],
  [
    'the vault for a scrubbed chrome-error page',
    'https://vault.sliccy.ai/app',
    'chrome-error://chromewebdata/',
    'left-scrub',
  ],
]) {
  test(`a tab that leaves ${what} can be closed`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target(id);
    await wire.attach(id);
    await leave(wire, entry, id, keptUrl);
    await leave(wire, entry, id, nextUrl);
    const mark = wire.sent.length;
    assert.equal((await wire.send('Target.closeTarget', { targetId: id })).error, undefined);
    assert.equal(forwarded(wire, mark, 'Target.closeTarget', id), true);
  });
}

test('a lagging chrome-error target info does not clear a committed vault frame', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('lag-error');
  await wire.attach('lag-error');
  await leave(wire, entry, 'lag-error', 'https://vault.sliccy.ai/app');
  entry.info.url = 'chrome-error://chromewebdata/';
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  await wire.send('Target.getTargets');
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'lag-error' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'lag-error'), false);
});

test('a stale getFrameTree after a same-document /os/ commit does not clear close protection', async (t) => {
  const wire = protocol(t);
  const start = 'https://seven.sliccy.ai/oauth?code=1';
  const kept = 'https://seven.sliccy.ai/os/index.html';
  const entry = wire.target('stale-tree');
  await wire.attach('stale-tree');
  entry.info.url = start;
  entry.tree.frame = {
    id: 'stale-tree',
    url: start,
    securityOrigin: 'https://seven.sliccy.ai',
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-stale-tree',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  const held = [];
  wire.hold((message) => {
    if (message.method === 'Page.getFrameTree' && message.id >= 2 ** 30) {
      held.push(message);
      return true;
    }
  });
  entry.tree.frame = {
    id: 'stale-tree',
    url: kept,
    securityOrigin: 'https://seven.sliccy.ai',
  };
  wire.emit({
    method: 'Page.navigatedWithinDocument',
    sessionId: 'guard-stale-tree',
    params: { frameId: 'stale-tree', url: kept },
  });
  await flush();
  for (const message of held.splice(0)) {
    wire.release(message, {
      result: {
        frameTree: {
          frame: {
            id: 'stale-tree',
            url: start,
            securityOrigin: 'https://seven.sliccy.ai',
          },
        },
      },
    });
  }
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'stale-tree' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'stale-tree'), false);
});

test('a stale getFrameTree and ordinary target info do not clear a vault frame commit', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('stale-vault-tree');
  await wire.attach('stale-vault-tree');
  const held = [];
  wire.hold((message) => {
    if (message.method === 'Page.getFrameTree' && message.id >= 2 ** 30) {
      held.push(message);
      return true;
    }
  });
  entry.info.url = 'https://vault.sliccy.ai/app';
  entry.tree.frame = {
    id: 'stale-vault-tree',
    url: 'https://vault.sliccy.ai/app',
    securityOrigin: 'https://vault.sliccy.ai',
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-stale-vault-tree',
    params: { frame: entry.tree.frame },
  });
  await flush();
  for (const message of held.splice(0)) {
    wire.release(message, {
      result: {
        frameTree: {
          frame: {
            id: 'stale-vault-tree',
            url: ordinary,
            securityOrigin: new URL(ordinary).origin,
          },
        },
      },
    });
  }
  await flush();
  entry.info.url = ordinary;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'stale-vault-tree' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'stale-vault-tree'), false);
});

test('a getFrameTree vault answer after targetInfoChanged still refuses close', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('tree-vault');
  await wire.attach('tree-vault');
  await flush();
  const held = [];
  wire.hold((message) => {
    if (message.method === 'Page.getFrameTree' && message.id >= 2 ** 30) {
      held.push(message);
      return true;
    }
  });
  wire.emit({
    method: 'Page.frameAttached',
    sessionId: 'guard-tree-vault',
    params: { frameId: 'tree-vault-child', parentFrameId: 'tree-vault' },
  });
  await flush();
  entry.info.url = ordinary;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  assert.ok(held.length > 0);
  for (const message of held.splice(0)) {
    wire.release(message, {
      result: {
        frameTree: {
          frame: {
            id: 'tree-vault',
            url: 'https://vault.sliccy.ai/app',
            securityOrigin: 'https://vault.sliccy.ai',
          },
        },
      },
    });
  }
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'tree-vault' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'tree-vault'), false);
});

test('a getFrameTree issued before leaving the vault does not re-pin after the leave', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('drop-vault-tree');
  await wire.attach('drop-vault-tree');
  await leave(wire, entry, 'drop-vault-tree', 'https://vault.sliccy.ai/app');
  const held = [];
  wire.hold((message) => {
    if (message.method === 'Page.getFrameTree' && message.id >= 2 ** 30) {
      held.push(message);
      return true;
    }
  });
  wire.emit({
    method: 'Page.frameAttached',
    sessionId: 'guard-drop-vault-tree',
    params: { frameId: 'drop-vault-child', parentFrameId: 'drop-vault-tree' },
  });
  await flush();
  assert.ok(held.length > 0);
  entry.info.url = ordinary;
  entry.tree.frame = {
    id: 'drop-vault-tree',
    url: ordinary,
    securityOrigin: new URL(ordinary).origin,
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-drop-vault-tree',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  const stale = held.splice(0);
  wire.hold(() => false);
  for (const message of stale) {
    wire.release(message, {
      result: {
        frameTree: {
          frame: {
            id: 'drop-vault-tree',
            url: 'https://vault.sliccy.ai/app',
            securityOrigin: 'https://vault.sliccy.ai',
          },
        },
      },
    });
  }
  await flush();
  const mark = wire.sent.length;
  assert.equal(
    (await wire.send('Target.closeTarget', { targetId: 'drop-vault-tree' })).error,
    undefined
  );
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'drop-vault-tree'), true);
});

test('an opaque blank stays unclosable while its opener frame is still the vault', async (t) => {
  const wire = protocol(t);
  const opener = wire.target('frame-opener', 'page', plainFrame('frame-opener'));
  await wire.attach('frame-opener');
  opener.info.url = 'https://vault.sliccy.ai/landing';
  opener.tree.frame = {
    id: 'frame-opener',
    url: 'https://vault.sliccy.ai/landing',
    securityOrigin: 'https://vault.sliccy.ai',
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-frame-opener',
    params: { frame: opener.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: opener.info } });
  await flush();
  const child = wire.target('frame-child', 'page', {
    id: 'frame-child',
    url: 'about:blank',
    securityOrigin: '://',
  });
  child.info.url = 'about:blank';
  child.info.openerId = 'frame-opener';
  opener.info.url = ordinary;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: opener.info } });
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'frame-child' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'frame-child'), false);
});

test('a targetInfoChanged oauth URL does not clear a committed /os/ frame', async (t) => {
  const wire = protocol(t);
  const start = 'https://seven.sliccy.ai/oauth?code=1';
  const kept = 'https://seven.sliccy.ai/os/index.html';
  const entry = wire.target('info-os');
  await wire.attach('info-os');
  entry.info.url = start;
  entry.tree.frame = {
    id: 'info-os',
    url: start,
    securityOrigin: 'https://seven.sliccy.ai',
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-info-os',
    params: { frame: entry.tree.frame },
  });
  await flush();
  entry.tree.frame = {
    id: 'info-os',
    url: kept,
    securityOrigin: 'https://seven.sliccy.ai',
  };
  wire.emit({
    method: 'Page.navigatedWithinDocument',
    sessionId: 'guard-info-os',
    params: { frameId: 'info-os', url: kept },
  });
  await flush();
  entry.info.url = start;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'info-os' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'info-os'), false);
});

test('an about:blank child of an opener that left the vault can be closed', async (t) => {
  const wire = protocol(t);
  const opener = wire.target('left-opener', 'page', {
    ...plainFrame('left-opener'),
    url: 'https://vault.sliccy.ai/landing',
    securityOrigin: 'https://vault.sliccy.ai',
  });
  opener.info.url = 'https://vault.sliccy.ai/landing';
  const child = wire.target('left-child', 'page', {
    id: 'left-child',
    url: 'about:blank',
    securityOrigin: '://',
  });
  child.info.url = 'about:blank';
  child.info.openerId = 'left-opener';
  await wire.send('Target.getTargetInfo', { targetId: 'left-child' });
  await flush();
  opener.info.url = ordinary;
  opener.tree.frame = {
    id: 'left-opener',
    url: ordinary,
    securityOrigin: new URL(ordinary).origin,
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-left-opener',
    params: { frame: opener.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: opener.info } });
  await flush();
  await wire.send('Target.getTargets');
  await flush();
  const mark = wire.sent.length;
  assert.equal(
    (await wire.send('Target.closeTarget', { targetId: 'left-child' })).error,
    undefined
  );
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'left-child'), true);
});

test('about:blank with a vault securityOrigin and no openerId stays unclosable', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('inherit-tab');
  await wire.attach('inherit-tab');
  entry.info.url = 'about:blank';
  entry.tree.frame = {
    id: 'inherit-tab',
    url: 'about:blank',
    securityOrigin: 'https://vault.sliccy.ai',
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-inherit-tab',
    params: { frame: entry.tree.frame },
  });
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'inherit-tab' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'inherit-tab'), false);
});

test('an opaque about:blank without an inherited origin can be closed', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('opaque-tab');
  await wire.attach('opaque-tab');
  entry.info.url = 'about:blank';
  entry.tree.frame = {
    id: 'opaque-tab',
    url: 'about:blank',
    securityOrigin: '://',
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-opaque-tab',
    params: { frame: entry.tree.frame },
  });
  await flush();
  const mark = wire.sent.length;
  assert.equal(
    (await wire.send('Target.closeTarget', { targetId: 'opaque-tab' })).error,
    undefined
  );
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'opaque-tab'), true);
});

test('an ordinary tab stays reachable after its seven opener is destroyed', async (t) => {
  const wire = protocol(t);
  const openerUrl = 'https://seven.sliccy.ai/production/closed%20opener';
  const opener = wire.target('closed-opener', 'page', {
    ...plainFrame('closed-opener'),
    url: openerUrl,
    securityOrigin: 'https://seven.sliccy.ai',
  });
  opener.info.url = openerUrl;
  const child = wire.target('closed-child', 'page', {
    ...plainFrame('closed-child'),
    url: ordinary,
    securityOrigin: new URL(ordinary).origin,
  });
  child.info.url = ordinary;
  child.info.openerId = 'closed-opener';
  await wire.attach('closed-child');
  wire.targets.delete('closed-opener');
  wire.emit({ method: 'Target.targetDestroyed', params: { targetId: 'closed-opener' } });
  const { targetId, type, url } = child.info;
  child.info = { targetId, type, url, canAccessOpener: false };
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: child.info } });
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Target.attachToTarget', {
    targetId: 'closed-child',
    flatten: true,
  });
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  assert.ok(answer.result?.sessionId);
  assert.equal(forwarded(wire, mark, 'Target.attachToTarget', 'closed-child'), true);
});

test('about:blank with canAccessOpener but no openerId can be closed', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('opaque-access');
  await wire.attach('opaque-access');
  entry.info.url = 'about:blank';
  entry.info.canAccessOpener = true;
  entry.tree.frame = {
    id: 'opaque-access',
    url: 'about:blank',
    securityOrigin: '://',
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-opaque-access',
    params: { frame: entry.tree.frame },
  });
  await flush();
  const mark = wire.sent.length;
  assert.equal(
    (await wire.send('Target.closeTarget', { targetId: 'opaque-access' })).error,
    undefined
  );
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'opaque-access'), true);
});

test('nine view-source wrappers of the vault stay unclosable', async (t) => {
  const url = `${'view-source:'.repeat(9)}https://vault.sliccy.ai/secret`;
  const { wire } = locked(t, 'deep-wrap', 'page', url);
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'deep-wrap' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'deep-wrap'), false);
});

test('an ordinary tab with an unknown-URL opening still admits evaluate', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('open-ordinary');
  const session = await wire.attach('open-ordinary');
  wire.emit({
    method: 'Page.frameStartedNavigating',
    sessionId: 'guard-open-ordinary',
    params: { frameId: 'open-ordinary', loaderId: 'L-unknown' },
  });
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Runtime.evaluate', { expression: '1' }, session);
  assert.equal(answer.error, undefined);
  assert.equal(
    wire.clients(mark).some((message) => message.method === 'Runtime.evaluate'),
    true
  );
  assert.equal(entry.info.url, ordinary);
});

for (const [what, url, id] of [
  ['a percent-encoded /os/ path', 'https://seven.sliccy.ai/os%2Findex.html', 'encoded-slash'],
  ['a percent-encoded /os/ prefix', 'https://seven.sliccy.ai/%6Fs/', 'encoded-prefix'],
]) {
  test(`${what} stays unclosable`, async (t) => {
    const { wire } = locked(t, id, 'page', url);
    const mark = wire.sent.length;
    const answer = await wire.send('Target.closeTarget', { targetId: id });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(forwarded(wire, mark, 'Target.closeTarget', id), false);
  });
}

test('seven’s UI path without a trailing slash can be closed', async (t) => {
  const { wire } = locked(t, 'os-noslash', 'page', 'https://seven.sliccy.ai/os');
  const mark = wire.sent.length;
  assert.equal(
    (await wire.send('Target.closeTarget', { targetId: 'os-noslash' })).error,
    undefined
  );
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'os-noslash'), true);
});

test('an uppercase /OS/ path can be closed because the service worker is case-sensitive', async (t) => {
  const { wire } = locked(t, 'os-upper', 'page', 'https://seven.sliccy.ai/OS/');
  const mark = wire.sent.length;
  assert.equal((await wire.send('Target.closeTarget', { targetId: 'os-upper' })).error, undefined);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'os-upper'), true);
});
