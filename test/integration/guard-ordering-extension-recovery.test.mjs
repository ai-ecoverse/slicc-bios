import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import {
  failed,
  flush,
  ordinary,
  protectedOrigin,
  recoveryProtocol,
} from './guard-recovery-fixture.mjs';

async function knownTab(t, observed = true, id = 'known') {
  const wire = recoveryProtocol(t);
  wire.target(id);
  const original = await wire.connect();
  await original.attach(id);
  if (!observed) original.close();
  await flush();
  wire.blocked(id, observed);
  await flush();
  if (observed) original.close();
  await flush();
  return wire;
}

for (const [site, destination] of [
  ['seven', `${protectedOrigin}/os/`],
  ['vault', 'https://vault.sliccy.ai/page'],
]) {
  test(`a remembered extension error cannot issue a fresh session after an offline live ${site} commit`, {
    timeout: 5000,
  }, async (t) => {
    const wire = await knownTab(t);
    const stranded = await wire.connect();
    await stranded.attach('known');
    stranded.close();
    await flush();
    wire.commit('known', destination);
    await flush();
    const fresh = await wire.connect();
    for (const method of ['Target.getTargetInfo', 'Target.attachToTarget']) {
      const reply = await fresh.send(method, { targetId: 'known', flatten: true });
      assert.equal(reply.error?.message, PROTECTED);
      assert.equal(
        reply.result,
        undefined,
        'a live commit cannot produce recovery proof or a session'
      );
      assert.equal(JSON.stringify(reply).includes(destination), false);
    }
  });

  for (const [method, params] of [
    ['Page.enable', {}],
    ['Page.navigate', { url: ordinary }],
    ['Page.reload', {}],
    ['Page.navigateToHistoryEntry', { entryId: 1 }],
  ]) {
    test(`a fresh recalled extension session refuses ${method} after a live ${site} commit`, {
      timeout: 5000,
    }, async (t) => {
      const wire = await knownTab(t);
      const fresh = await wire.connect();
      const session = await fresh.attach('known');
      wire.commit('known', destination);
      await flush();
      const mark = wire.calls.length;
      for (const [read, result] of [
        [
          'Page.getFrameTree',
          {
            frameTree: {
              frame: { id: '0', url: 'chrome-error://chromewebdata/', securityOrigin: '://' },
            },
          },
        ],
        [
          'Page.getNavigationHistory',
          {
            currentIndex: 0,
            entries: [
              {
                id: 0,
                url: 'chrome-error://chromewebdata/',
                userTypedURL: 'chrome-error://chromewebdata/',
                title: '',
              },
            ],
          },
        ],
      ]) {
        const reply = await fresh.send(read, {}, session);
        if (reply.error) {
          assert.equal(reply.error.message, PROTECTED);
          assert.equal(reply.result, undefined);
        } else assert.deepEqual(reply, { id: reply.id, sessionId: session, result });
        for (const origin of [protectedOrigin, new URL(destination).origin])
          assert.equal(JSON.stringify(reply).includes(origin), false);
      }
      const refused = await fresh.send(method, params, session);
      assert.equal(refused.error?.message, PROTECTED);
      assert.equal(refused.result, undefined);
      assert.equal(
        wire.calls.slice(mark).some((call) => call.method === method),
        false,
        'the caller navigation never reaches the backend'
      );
    });
  }
}

test('a known extension tab without a recorded error refuses fresh identification and metadata', async (t) => {
  const wire = await knownTab(t, false);
  const mark = wire.calls.length;
  const fresh = await wire.connect();
  for (const method of ['Target.getTargetInfo', 'Target.attachToTarget']) {
    const reply = await fresh.send(method, { targetId: 'known', flatten: true });
    assert.equal(reply.error?.message, PROTECTED);
    assert.equal(reply.result, undefined);
    assert.equal(JSON.stringify(reply).includes(failed), false);
  }
  assert.deepEqual((await fresh.send('Target.getTargets')).result, { targetInfos: [] });
  assert.equal(
    wire.calls.slice(mark).some((call) => call.method === 'Target.attachToTarget'),
    false,
    'a fresh guard never probes a tab without a recorded error'
  );
});

test('a known extension tab retains recovery across fresh guards with an observed error', async (t) => {
  const wire = await knownTab(t);
  const metadata = await wire.connect();
  const info = await metadata.send('Target.getTargetInfo', { targetId: 'known' });
  assert.equal(info.error, undefined, 'a fresh connection can identify the stranded known tab');
  assert.equal(info.result.targetInfo.url, protectedOrigin);
  assert.equal(JSON.stringify(info).includes(failed), false);
  metadata.close();
  await flush();
  const recovery = await wire.connect();
  const session = await recovery.attach('known');
  for (const method of ['Runtime.evaluate', 'DOM.getDocument', 'Accessibility.getFullAXTree'])
    assert.match(
      (await recovery.send(method, {}, session)).error?.message ?? '',
      /^slicc: refused:/
    );
  const destination = `${ordinary}?recovered`;
  assert.equal(
    (await recovery.send('Page.navigate', { url: destination }, session)).error,
    undefined
  );
  recovery.close();
  await flush();
  const reader = await wire.connect();
  const attached = await reader.attach('known');
  const content = await reader.send(
    'Runtime.evaluate',
    { expression: 'location.href + document.title' },
    attached
  );
  assert.equal(content.error, undefined);
  assert.equal(content.result.result.value, `${destination} recovered`);
  assert.equal(
    (await reader.send('Accessibility.getFullAXTree', {}, attached)).result.nodes[0].name.value,
    'recovered'
  );
});

test('a protected error fetched by the guard survives withheld extension commits and ordinary reconnect hints', async (t) => {
  const wire = recoveryProtocol(t);
  wire.target('withheld-commit');
  const first = await wire.connect();
  await first.attach('withheld-commit');
  wire.blocked('withheld-commit', false);
  const entry = wire.targets.get('withheld-commit');
  entry.tree.frame.unreachableUrl = protectedOrigin;
  assert.equal(
    (await first.send('Target.getTargetInfo', { targetId: 'withheld-commit' })).error,
    undefined
  );
  first.close();
  await flush();
  entry.info = { ...entry.info, url: ordinary, title: 'ordinary' };
  entry.tree.frame = {
    id: 'root-withheld-commit',
    url: ordinary,
    securityOrigin: new URL(ordinary).origin,
    loaderId: 'unobserved-ordinary',
  };
  const next = await wire.connect();
  const attached = await next.attach('withheld-commit');
  assert.match(
    (await next.send('Runtime.evaluate', {}, attached)).error?.message ?? '',
    /^slicc: refused:/
  );
  wire.commit('withheld-commit', ordinary);
  await flush();
  assert.equal((await next.send('Runtime.evaluate', {}, attached)).error, undefined);
});

test('an older error tree cannot re-record an error after the guard accepted an ordinary commit', async (t) => {
  const wire = recoveryProtocol(t);
  wire.target('late-error-tree');
  const first = await wire.connect();
  await first.attach('late-error-tree');
  wire.blocked('late-error-tree', false);
  wire.targets.get('late-error-tree').tree.frame.unreachableUrl = protectedOrigin;
  assert.equal(
    (await first.send('Target.getTargetInfo', { targetId: 'late-error-tree' })).error,
    undefined
  );
  const gate = wire.pauseTree();
  t.after(gate.release);
  const pending = first.send('Target.getTargetInfo', { targetId: 'late-error-tree' });
  await gate.requested;
  wire.commit('late-error-tree', ordinary);
  await flush();
  gate.release();
  await pending;
  first.close();
  await flush();
  const next = await wire.connect();
  const attached = await next.attach('late-error-tree');
  assert.equal((await next.send('Runtime.evaluate', {}, attached)).error, undefined);
});

test('an unknown extension error tab stays refused across fresh guards', async (t) => {
  const wire = recoveryProtocol(t);
  wire.target('unknown');
  wire.blocked('unknown', false);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const connection = await wire.connect();
    for (const method of ['Target.getTargetInfo', 'Target.attachToTarget']) {
      const answer = await connection.send(method, { targetId: 'unknown', flatten: true });
      assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      assert.equal(answer.result, undefined);
    }
    connection.close();
    await flush();
  }
});

test('a known extension tab cannot admit a live protected document after reconnect', async (t) => {
  const wire = await knownTab(t);
  wire.targets.get('known').tree.frame = {
    id: 'root-known',
    url: `${protectedOrigin}/private`,
    securityOrigin: protectedOrigin,
    loaderId: 'protected-document',
  };
  const connection = await wire.connect();
  for (const method of [
    'Target.getTargetInfo',
    'Target.attachToTarget',
    'Target.activateTarget',
    'Target.closeTarget',
  ]) {
    const answer = await connection.send(method, { targetId: 'known', flatten: true });
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
  }
});

test('extension recovery state is not lent to another tab', async (t) => {
  const wire = await knownTab(t);
  wire.target('other');
  wire.blocked('other', false);
  const connection = await wire.connect();
  assert.match(
    (await connection.send('Target.getTargetInfo', { targetId: 'other' })).error?.message ?? '',
    /^slicc: refused:/
  );
  assert.equal(
    (await connection.send('Target.getTargetInfo', { targetId: 'known' })).error,
    undefined
  );
});

test('extension recovery state is not lent to a replacement browser', async (t) => {
  const wire = await knownTab(t);
  wire.replaceBrowser();
  const connection = await wire.connect();
  assert.match(
    (await connection.send('Target.getTargetInfo', { targetId: 'known' })).error?.message ?? '',
    /^slicc: refused:/
  );
});

test('destroying a closed extension tab removes its recovery record', async (t) => {
  const wire = await knownTab(t);
  wire.emit({ method: 'Target.targetDestroyed', params: { targetId: 'known' } });
  const connection = await wire.connect();
  assert.match(
    (await connection.send('Target.getTargetInfo', { targetId: 'known' })).error?.message ?? '',
    /^slicc: refused:/
  );
});

test('a remembered extension error resolves an ordinary opener before recovery', async (t) => {
  const wire = await knownTab(t);
  wire.target('ordinary-opener');
  const entry = wire.targets.get('known');
  entry.info = { ...entry.info, openerId: 'ordinary-opener', canAccessOpener: true };
  const connection = await wire.connect();
  assert.equal(
    (await connection.send('Target.getTargetInfo', { targetId: 'known' })).error,
    undefined
  );
});

test('an admitted extension tab is ordinary again after an offline ordinary commit without an error commit', async (t) => {
  const wire = recoveryProtocol(t);
  wire.target('offline-return');
  const first = await wire.connect();
  await first.attach('offline-return');
  const entry = wire.targets.get('offline-return');
  entry.info = { ...entry.info, url: `${protectedOrigin}/private` };
  entry.tree.frame = { ...entry.tree.frame, url: entry.info.url, securityOrigin: protectedOrigin };
  assert.match(
    (await first.send('Target.getTargetInfo', { targetId: 'offline-return' })).error?.message ?? '',
    /^slicc: refused:/
  );
  first.close();
  await flush();
  wire.commit('offline-return', ordinary);
  const next = await wire.connect();
  const session = await next.attach('offline-return');
  assert.equal((await next.send('Runtime.evaluate', {}, session)).error, undefined);
});

for (const shape of ['missing root', 'protected child', 'protected opener']) {
  test(`a remembered extension error does not admit ${shape}`, async (t) => {
    const id = shape === 'protected opener' ? 'opener-dependent' : 'known';
    const wire = await knownTab(t, true, id);
    const entry = wire.targets.get(id);
    if (shape === 'missing root') entry.tree = {};
    if (shape === 'protected child')
      entry.tree.childFrames = [
        {
          frame: {
            id: 'protected-child',
            parentId: `root-${id}`,
            url: `${protectedOrigin}/private`,
            securityOrigin: protectedOrigin,
          },
        },
      ];
    if (shape === 'protected opener') {
      wire.target('opener', `${protectedOrigin}/sign-in`);
      entry.info = { ...entry.info, openerId: 'opener', canAccessOpener: true };
    }
    const connection = await wire.connect();
    assert.match(
      (await connection.send('Target.getTargetInfo', { targetId: id })).error?.message ?? '',
      /^slicc: refused:/
    );
  });
}

for (const fresh of ['hint', 'client commit', 'own commit']) {
  test(`a remembered extension error is cleared only by its own fresh commit, not ${fresh}`, async (t) => {
    const wire = await knownTab(t);
    const entry = wire.targets.get('known');
    entry.info = { ...entry.info, url: ordinary, title: 'ordinary' };
    entry.tree.frame = {
      id: 'root-known',
      url: ordinary,
      securityOrigin: new URL(ordinary).origin,
      loaderId: 'unobserved-document',
    };
    const connection = await wire.connect();
    const session = await connection.attach('known');
    assert.match(
      (await connection.send('Runtime.evaluate', {}, session)).error?.message ?? '',
      /^slicc: refused:/
    );
    if (fresh === 'client commit') {
      await connection.send('Page.enable', {}, session);
      wire.commit('known', ordinary, { session });
    } else if (fresh === 'own commit') {
      wire.commit('known', ordinary);
    } else {
      wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    }
    await flush();
    const read = await connection.send('Runtime.evaluate', {}, session);
    if (fresh === 'own commit') assert.equal(read.error, undefined);
    else assert.match(read.error?.message ?? '', /^slicc: refused:/);
  });
}
