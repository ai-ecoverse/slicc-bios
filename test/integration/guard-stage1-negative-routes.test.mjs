import assert from 'node:assert/strict';
import test from 'node:test';
import { browserHook } from '../../src/seed/cdp.js';
import { guardProtected } from '../../src/seed/guard.js';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';
import { routeGlobals, routeMemory } from './guard-route-memory.mjs';

const five = [
  'Debugger.enable',
  'Debugger.disable',
  'Debugger.resume',
  'Debugger.setInstrumentationBreakpoint',
  'Debugger.removeBreakpoint',
];

for (const route of [
  { kind: 'extension' },
  { kind: 'link' },
  { kind: 'extension', version: '7.11.99' },
  { kind: 'link', version: '1.59.99' },
  { kind: 'extension', version: '7.9.0' },
  { kind: 'link', version: '1.9.0' },
  { kind: 'extension', version: '7.12.0-beta' },
  { kind: 'link', version: '1.60.0-beta' },
]) {
  test(`every Stage1 method remains refused on an old or unversioned route: ${JSON.stringify(route)}`, async (t) => {
    const p = protocol(t, (raw, own) => guardProtected(raw, own, new Map(), route));
    p.target('ordinary');
    const session = await p.attach('ordinary');
    for (const method of five) {
      const start = p.sent.length;
      const reply = await p.send(
        method,
        { version: '99.0.0', route: { kind: route.kind, version: '99.0.0' } },
        session
      );
      assert.match(reply.error.message, /slicc: refused:/);
      assert.equal(p.clients(start).filter((command) => command.method === method).length, 0);
    }
  });
}

for (const route of [
  { kind: 'extension', version: '7.9.0' },
  { kind: 'link', version: '1.9.0' },
]) {
  test(`string-ordered below-floor ${JSON.stringify(route)} stays refused with a private frame reader`, async (t) => {
    const p = protocol(t, (raw, own) =>
      guardProtected(raw, own, new Map(), route, async (id) => ({
        version: 1,
        revision: 0,
        rootFrameId: id,
        rootLoaderId: 'loader',
        rootDocumentId: 'native',
        remoteOwners: [],
        frames: [
          {
            frameId: 0,
            parentFrameId: -1,
            documentId: 'native',
            url: 'https://ordinary.invalid/page',
          },
        ],
      }))
    );
    p.target('ordinary').tree.frame.loaderId = 'loader';
    const session = await p.attach('ordinary');
    for (const method of five) {
      const start = p.sent.length;
      const reply = await p.send(method, {}, session);
      assert.match(reply.error.message, /slicc: refused:/);
      assert.equal(p.clients(start).filter((command) => command.method === method).length, 0);
    }
  });
}

for (const kind of ['extension', 'link']) {
  for (const url of ['https://seven.sliccy.ai/', 'https://vault.sliccy.ai/']) {
    test(`all five methods refuse protected ${url} even with a future ${kind} version`, async (t) => {
      const p = protocol(t, (raw, own) =>
        guardProtected(raw, own, new Map(), { kind, version: '99.0.0' }, async () =>
          assert.fail('protected content must not request a private frame snapshot')
        )
      );
      p.target('blocked', 'page', {
        ...plainFrame('blocked'),
        url,
        securityOrigin: new URL(url).origin,
      });
      const attach = await p.send('Target.attachToTarget', { targetId: 'blocked', flatten: true });
      assert.match(attach.error.message, /slicc: refused:/);
      const session = p.attached('blocked');
      await flush();
      for (const method of five) {
        const start = p.sent.length;
        const reply = await p.send(method, {}, session);
        assert.match(reply.error.message, /slicc: refused:/);
        assert.equal(p.clients(start).filter((command) => command.method === method).length, 0);
      }
    });
  }
}

for (const version of ['1.59.99', undefined]) {
  test(`caller route/version fields cannot replace linked HELLO metadata (${version})`, async (t) => {
    const m = routeMemory();
    routeGlobals(t, undefined, undefined, m.Socket);
    const connection = await browserHook(
      undefined,
      m.links(version),
      'https://protected.invalid'
    )({ runtime: 'owned/chrome', version: '99.0.0', route: { kind: 'link', version: '99.0.0' } });
    t.after(() => connection.close());
    const attached = await m.request(connection, 'Target.attachToTarget', {
      targetId: '1',
      flatten: true,
    });
    assert.equal(attached.error, undefined);
    for (const method of five) {
      const reply = await m.request(
        connection,
        method,
        { version: '99.0.0', route: { kind: 'link', version: '99.0.0' } },
        attached.result.sessionId
      );
      assert.match(reply.error.message, /slicc: refused:/);
      assert.equal(
        m.sent.some((command) => command.method === method),
        false
      );
    }
  });
}

test('caller-supplied versions cannot replace the frozen old extension bridge version', async (t) => {
  const m = routeMemory();
  const extension = m.extension('7.11.1');
  routeGlobals(t, extension, undefined, m.Socket);
  assert.throws(() => {
    extension.version = '7.12.0';
  }, TypeError);
  const connection = await browserHook(
    undefined,
    undefined,
    'https://protected.invalid'
  )({ runtime: 'extension', version: '7.12.0', route: { kind: 'extension', version: '7.12.0' } });
  t.after(() => connection.close());
  const attached = await m.request(connection, 'Target.attachToTarget', {
    targetId: '1',
    flatten: true,
  });
  assert.equal(attached.error, undefined);
  for (const method of five) {
    const reply = await m.request(
      connection,
      method,
      { version: '7.12.0' },
      attached.result.sessionId
    );
    assert.match(reply.error.message, /slicc: refused:/);
    assert.equal(
      m.sent.some((command) => command.method === method),
      false
    );
  }
});

test('a current version string without the extension private-frame capability cannot satisfy the gate', async (t) => {
  const m = routeMemory();
  const complete = m.extension('7.12.0');
  routeGlobals(
    t,
    Object.freeze({ version: complete.version, cdp: complete.cdp }),
    undefined,
    m.Socket
  );
  const connection = await browserHook(
    undefined,
    undefined,
    'https://protected.invalid'
  )({ runtime: 'extension' });
  t.after(() => connection.close());
  const attached = await m.request(connection, 'Target.attachToTarget', {
    targetId: '1',
    flatten: true,
  });
  assert.equal(attached.error, undefined);
  for (const method of five) {
    const reply = await m.request(connection, method, {}, attached.result.sessionId);
    assert.match(reply.error.message, /slicc: refused:/);
    assert.equal(
      m.sent.some((command) => command.method === method),
      false
    );
  }
});

test('an unversioned extension bridge never opens even with a caller-provided current version', async (t) => {
  const m = routeMemory();
  routeGlobals(t, m.extension(undefined), undefined, m.Socket);
  await assert.rejects(
    browserHook(
      undefined,
      undefined,
      'https://protected.invalid'
    )({ runtime: 'extension', version: '7.12.0' }),
    /slicc: refused:/
  );
  assert.equal(m.sent.length, 0);
});

test('host DevTools cannot borrow the floor from an attested linked route or a caller', async (t) => {
  const m = routeMemory();
  routeGlobals(t, undefined, { webSocketDebuggerUrl: 'ws://memory.invalid/owned' }, m.Socket);
  const connection = await browserHook(
    undefined,
    m.links('99.0.0'),
    'https://protected.invalid'
  )({ runtime: 'devtools', version: '99.0.0', route: { kind: 'link', version: '99.0.0' } });
  t.after(() => connection.close());
  const attached = await m.request(connection, 'Target.attachToTarget', {
    targetId: '1',
    flatten: true,
  });
  assert.equal(attached.error, undefined);
  for (const method of five) {
    const reply = await m.request(connection, method, {}, attached.result.sessionId);
    assert.match(reply.error.message, /slicc: refused:/);
    assert.equal(
      m.sent.some((command) => command.method === method),
      false
    );
  }
});
