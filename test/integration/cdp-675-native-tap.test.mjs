import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { nativeTapFixture, nativeTapRead, tapNativeSource } from './cdp-675-native-tap.mjs';

const source = `class Connection {
  constructor() {
    this.state = { tabs: new Map(), sessions: new Map() };
    this.answers = new Map();
  }
  async sessionCommand() { throw this.error; }
  async admit() { return this.answer; }
  async seal() { throw this.error; }
  async bind() { return this.answer; }
  async send(tabId, method) { return this.answers.get(method); }
}
globalThis.Connection = Connection;`;

test('native refusal tap preserves return and error identity and names the exact private stage', async () => {
  const context = vm.createContext({ Date });
  vm.runInContext(tapNativeSource(source), context);
  const connection = new context.Connection();
  const tab = {
    seal: { visible: new Set(['root']), sealed: new Set(['child']), nodes: new Set([4]) },
  };
  connection.state.tabs.set(12, tab);
  connection.answer = { unchanged: true };
  connection.error = new Error('native refusal');
  const params = { expression: 'location.href' };
  connection.state.sessions.set('owned-session', { tabId: 12 });
  await assert.rejects(
    connection.sessionCommand({ method: 'Runtime.evaluate', sessionId: 'owned-session' }, params),
    (error) => error === connection.error
  );
  assert.equal(await connection.admit(12, tab, 'Runtime.evaluate', params), connection.answer);
  await assert.rejects(
    connection.seal(12, tab, 'Runtime.evaluate', params),
    (error) => error === connection.error
  );
  assert.equal(await connection.bind(12, tab, 'Runtime.evaluate', params), connection.answer);
  const tree = {
    frameTree: {
      frame: { id: 'root' },
      childFrames: [{ frame: { id: 'child', url: 'about:blank', securityOrigin: 'null' } }],
    },
  };
  connection.answers.set('Page.getFrameTree', tree);
  assert.equal(await connection.send(12, 'Page.getFrameTree', {}), tree);
  connection.answers.set('DOMSnapshot.captureSnapshot', {
    strings: ['root', 'child'],
    documents: [{ frameId: 0 }, { frameId: 1 }],
  });
  await connection.send(12, 'DOMSnapshot.captureSnapshot', {});
  const records = JSON.parse(JSON.stringify(context.cdp675NativeTrace));
  const refused = records.find(({ phase, outcome }) => phase === 'seal' && outcome === 'error');
  assert.equal(refused.error, 'native refusal');
  assert.match(refused.stack, /native refusal/);
  assert.equal(
    records.find(({ phase, outcome }) => phase === 'sessionCommand' && outcome === 'error').tabId,
    12
  );
  assert.deepEqual(refused.sealed, ['child']);
  assert.deepEqual(refused.nodes, [4]);
  assert.deepEqual(records.find(({ witness }) => witness?.frameTree)?.witness, tree);
  assert.deepEqual(records.find(({ witness }) => witness?.frames)?.witness.frames, [
    'root',
    'child',
  ]);
  const before = records.length;
  await connection.bind(12, tab, 'Runtime.evaluate', { expression: '0' });
  assert.equal(context.cdp675NativeTrace.length, before);
  context.cdp675NativeTrace = Array.from({ length: 20000 }, () => null);
  await connection.admit(12, {}, 'Runtime.evaluate', params);
  assert.equal(context.cdp675NativeTrace.length, 20000);
  assert.deepEqual(JSON.parse(JSON.stringify(context.cdp675NativeTrace.at(-1).sealed)), []);
  assert.throws(() => tapNativeSource(''), assert.AssertionError);
});

test('native fixture is a stamped test copy and never changes the candidate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cdp-675-tap-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'cdp.js'), source);
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({ key: Buffer.from('owned-candidate').toString('base64') })
  );
  const fixture = await nativeTapFixture(directory);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  assert.equal(await readFile(join(directory, 'cdp.js'), 'utf8'), source);
  assert.equal(await readFile(join(fixture.directory, 'cdp.js'), 'utf8'), tapNativeSource(source));
  assert.notEqual(fixture.sourceSha256, fixture.tappedSha256);
  assert.match(fixture.extensionId, /^[a-p]{32}$/);
});

test('native observer is raw and worker-owned and detaches on failed reads', async () => {
  const calls = [];
  const chrome = {
    cdp: {
      async send(method, params) {
        calls.push({ method, params });
        if (method === 'Target.getTargets')
          return {
            targetInfos: [
              {
                type: 'service_worker',
                targetId: 'other',
                url: 'chrome-extension://other/background.js',
              },
              {
                type: 'service_worker',
                targetId: 'ours',
                url: 'chrome-extension://owned/background.js',
              },
            ],
          };
        return { sessionId: 'raw-worker' };
      },
    },
  };
  const fixture = { extensionId: 'owned' };
  const result = await nativeTapRead(
    chrome,
    fixture,
    '12',
    async (_chrome, sessionId, method, params) => {
      assert.equal(sessionId, 'raw-worker');
      assert.equal(method, 'Runtime.evaluate');
      const context = vm.createContext({ cdp675NativeTrace: [{ tabId: 12 }, { tabId: 13 }] });
      return {
        result: { value: JSON.parse(JSON.stringify(vm.runInContext(params.expression, context))) },
      };
    }
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].tabId, 12);
  assert.deepEqual(calls[1], {
    method: 'Target.attachToTarget',
    params: { targetId: 'ours', flatten: true },
  });
  assert.equal(calls.at(-1).method, 'Target.detachFromTarget');
  await assert.rejects(
    nativeTapRead(chrome, fixture, '12', async () => {
      throw new Error('raw failed');
    }),
    /raw failed/
  );
  assert.equal(calls.at(-1).method, 'Target.detachFromTarget');
  await assert.rejects(
    nativeTapRead(chrome, fixture, '12', async () => ({ result: { value: { installed: false } } })),
    /not installed/
  );
  await assert.rejects(
    nativeTapRead(
      { cdp: { send: async () => ({ targetInfos: [] }) } },
      fixture,
      '12',
      async () => {}
    ),
    /owned candidate worker/
  );
});
