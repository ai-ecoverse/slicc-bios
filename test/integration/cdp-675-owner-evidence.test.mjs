import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerEvidenceFixture } from './cdp-675-owner-evidence-fixture.mjs';

function fakeOwner() {
  const row = {
    deadline: {},
    target: 'controlled',
    rawTargetId: 'raw',
    traceStart: 1,
    guardConnectionFloor: 10,
    pause: { at: Date.now() },
    status: 'pass',
  };
  const calls = [];
  let closed = false;
  let reads = 0;
  let fixture;
  const page = {
    async evaluate(fn, argument) {
      reads++;
      if (closed) throw new Error('Runtime.evaluate: Session with given id not found');
      return fixture.evaluate(fn, argument);
    },
    async send(method) {
      assert.equal(method, 'Target.getTargetInfo');
      return { targetInfo: { type: 'page', targetId: 'owner' } };
    },
  };
  const chrome = {
    cdp: {
      async send(method, params) {
        calls.push({ method, params });
        if (method === 'Target.closeTarget' && params.targetId === 'owner') {
          closed = true;
          return { success: true };
        }
        return {};
      },
    },
  };
  const targetTrace = [{ targetId: 'other' }, { targetId: 'controlled', marker: 42 }];
  fixture = ownerEvidenceFixture(
    {
      page,
      chrome,
      row,
      rawSession: 'live-raw',
      targetId: 'raw',
      setupError: null,
      bfcacheOff: undefined,
      bfcacheDriver: undefined,
      scene: {},
      guardLevel: true,
      nativeFixture: undefined,
      unobserve: () => calls.push({ method: 'unobserve' }),
      deadline: { end: () => calls.push({ method: 'deadline.end' }) },
      countRow: (value) => {
        assert.equal(value, row);
        row.counted = true;
      },
      persist: async () => calls.push({ method: 'persist' }),
      console: { log() {} },
      route: 'extension',
      mode: 'owner-death',
      cdp675Connections: new Map([
        [1, { connectionId: 9 }],
        [2, { connectionId: 11 }],
      ]),
      cdp675Trace: [
        { packet: { method: 'old' } },
        { packet: { method: 'Debugger.enable' }, at: 0 },
      ],
      cdp675FrameReadTrace: targetTrace,
      cdp675WorldTrace: targetTrace,
      cdp675PrivateDocumentTrace: [],
      cdp675PublicationTrace: targetTrace,
      cdp675FramePredicateTrace: targetTrace,
      cdp675Lifecycle: { events: [], calls: [], close() {} },
      async rawBounded(_chrome, session, method) {
        assert.equal(session, 'live-raw');
        assert.equal(method, 'Runtime.evaluate');
        calls.push({ method: 'raw-read' });
        return { result: { value: row.nextReloadAt ? 3 : 2 } };
      },
      async rawLoad(_chrome, session, method) {
        assert.equal(session, 'live-raw');
        assert.equal(method, 'Page.reload');
        calls.push({ method: 'raw-reload' });
      },
    },
    process.env.CDP_675_EVIDENCE_SOURCE
      ? new URL(`file://${process.env.CDP_675_EVIDENCE_SOURCE}`)
      : undefined
  );
  return {
    row,
    calls,
    page,
    chrome,
    fixture,
    get reads() {
      return reads;
    },
  };
}

test('owner-death rig captures evidence before close and finishes only on live raw sessions', async () => {
  const fake = fakeOwner();
  await fake.fixture.rescue(fake.page, fake.chrome, 'live-raw', fake.row, 'owner-gone');
  const readsBeforeFinally = fake.reads;
  await fake.fixture.finish();
  assert.equal(fake.reads, readsBeforeFinally);
  assert.deepEqual(Array.from(fake.row.guardConnections), [11]);
  assert.equal(fake.row.methods[0].packet.method, 'Debugger.enable');
  for (const key of ['frameReadTrace', 'worldTrace', 'publicationTrace', 'framePredicateTrace']) {
    assert.equal(fake.row[key].length, 1);
    assert.equal(fake.row[key][0].marker, 42);
  }
  assert.equal(fake.row.continued.result.value, 2);
  assert.equal(fake.row.nextReloadContinued.result.value, 3);
  assert.equal(fake.row.counted, true);
  assert.deepEqual(
    fake.calls.map(({ method }) => method),
    [
      'Target.closeTarget',
      'raw-read',
      'raw-reload',
      'raw-read',
      'unobserve',
      'Target.detachFromTarget',
      'Target.closeTarget',
      'deadline.end',
      'persist',
    ]
  );
});
