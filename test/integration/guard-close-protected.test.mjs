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
  wire.emit({
    method: 'Page.navigatedWithinDocument',
    sessionId: 'guard-within-tab',
    params: { frameId: 'within-tab', url: 'https://seven.sliccy.ai/os/index.html' },
  });
  await flush();
  const mark = wire.sent.length;
  const answer = await wire.send('Target.closeTarget', { targetId: 'within-tab' });
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'within-tab'), false);
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
