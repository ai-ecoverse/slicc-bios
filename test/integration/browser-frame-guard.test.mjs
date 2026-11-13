import assert from 'node:assert/strict';
import test from 'node:test';
import { SAMPLE_GAP, SHOT_GAP } from '../../src/seed/browser.js';
import { iconSnapshot, sharedIconBrowser } from './fixtures/shared-dom-icon.mjs';

const icon = 'data:image/svg+xml,%3Csvg/%3E';
const PROTECTED = [
  'https://protected.invalid/secret',
  'https://seven.sliccy.ai/',
  'https://signin.invalid/authorize?client_id=experience-catalyst-prod',
];

async function flush(t, ms = 0) {
  t.mock.timers.tick(ms);
  await new Promise((resolve) => setImmediate(resolve));
}

function framesOf(browser) {
  const seen = [];
  browser.port.on('frame', (frame) => seen.push(frame));
  return seen;
}

function counts(calls) {
  const of = (method) => calls.filter((call) => call.method === method).length;
  return {
    info: of('Target.getTargetInfo'),
    shot: of('Page.captureScreenshot'),
    snap: of('DOMSnapshot.captureSnapshot'),
    metrics: of('Page.getLayoutMetrics'),
  };
}

async function finish(connection, kind, url) {
  connection.send(
    JSON.stringify({
      method: 'Slicc.action',
      params: {
        phase: 'start',
        kind,
        url,
        tab: 'tab',
        agent: 'cone:agent-1',
      },
    })
  );
  connection.send(
    JSON.stringify({
      method: 'Slicc.action',
      params: { phase: 'end', ok: true, tab: 'tab' },
    })
  );
}

for (const url of PROTECTED) {
  for (const kind of ['reload', 'goto', 'open']) {
    test(`a finished ${kind} of ${url} captures nothing`, async (t) => {
      const snapshot = iconSnapshot({
        url,
        links: [{ attributes: { rel: 'icon', href: icon } }],
      });
      const { browser, calls, client, setURL } = sharedIconBrowser(t, snapshot, { tabURL: url });
      const frames = framesOf(browser);
      const { connection, call } = client();
      await call('Target.attachToTarget', { targetId: 'tab', flatten: true });
      setURL(url);
      await finish(connection, kind, url);
      await flush(t, 0);
      await flush(t, SHOT_GAP);
      const tallied = counts(calls);
      assert.equal(tallied.shot, 0, JSON.stringify(calls.map((c) => c.method)));
      assert.equal(tallied.snap, 0);
      assert.equal(tallied.metrics, 0);
      assert.equal(frames.length, 0);
      await assert.rejects(() => browser.port.screenshot('tab'), /not a tab SLICC is using/);
      assert.equal((await browser.port.list())[0]?.favicon, undefined);
    });
  }
}

test('a finished goto whose infos are still ordinary but the live URL is protected captures nothing', async (t) => {
  const protectedURL = 'https://protected.invalid/secret';
  const snapshot = iconSnapshot({
    url: protectedURL,
    links: [{ attributes: { rel: 'icon', href: icon } }],
  });
  const { browser, calls, client, setURL } = sharedIconBrowser(t, snapshot);
  const frames = framesOf(browser);
  const { connection, call } = client();
  await call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  await call('Target.getTargets');
  setURL(protectedURL);
  await finish(connection, 'goto', protectedURL);
  await flush(t, 0);
  await flush(t, SHOT_GAP);
  const tallied = counts(calls);
  assert.equal(tallied.shot, 0);
  assert.equal(tallied.snap, 0);
  assert.equal(frames.length, 0);
  assert.equal((await browser.port.list())[0]?.favicon, undefined);
});

test('navigate to a protected URL settles without a snapshot or screenshot', async (t) => {
  const protectedURL = 'https://protected.invalid/secret';
  const { browser, calls, client, setURL } = sharedIconBrowser(t);
  const frames = framesOf(browser);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  setURL(protectedURL);
  browser.port.navigate('tab', protectedURL);
  await flush(t, 0);
  await flush(t, SHOT_GAP);
  const tallied = counts(calls);
  assert.equal(tallied.shot, 0);
  assert.equal(tallied.snap, 0);
  assert.equal(frames.length, 0);
});

test('a session end on a protected tab settles without a snapshot or screenshot', async (t) => {
  const protectedURL = 'https://protected.invalid/secret';
  const { browser, calls, client, setURL } = sharedIconBrowser(t, iconSnapshot(), {
    tabURL: protectedURL,
  });
  const frames = framesOf(browser);
  const { call } = client();
  const attached = await call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  setURL(protectedURL);
  await call('Target.detachFromTarget', { sessionId: attached.sessionId });
  await flush(t, 0);
  await flush(t, SHOT_GAP);
  const tallied = counts(calls);
  assert.equal(tallied.shot, 0);
  assert.equal(tallied.snap, 0);
  assert.equal(frames.length, 0);
});

test('a URL that turns protected between the probe and the re-check discards the shot', async (t) => {
  const protectedURL = 'https://protected.invalid/secret';
  let probes = 0;
  const { browser, calls, client } = sharedIconBrowser(t, iconSnapshot(), {
    getTargetInfo: ({ url, title, params }) => {
      probes += 1;
      return {
        targetInfo: {
          targetId: params.targetId ?? 'tab',
          type: 'page',
          title,
          url: probes === 1 ? url : protectedURL,
        },
      };
    },
  });
  const frames = framesOf(browser);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  await assert.rejects(() => browser.port.screenshot('tab'), /not a tab SLICC is using/);
  assert.equal(counts(calls).shot, 1);
  assert.equal(frames.length, 0);
  await assert.rejects(() => browser.port.screenshot('tab'), /not a tab SLICC is using/);
});

test('screenshot does not return a cached frame after the tab turns protected', async (t) => {
  const protectedURL = 'https://protected.invalid/secret';
  const { browser, calls, client, setURL } = sharedIconBrowser(t);
  const frames = framesOf(browser);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  const src = await browser.port.screenshot('tab');
  assert.match(src, /^data:image\/jpeg/);
  assert.equal(frames.length, 1);
  const afterShot = counts(calls);
  setURL(protectedURL);
  await assert.rejects(() => browser.port.screenshot('tab'), /not a tab SLICC is using/);
  assert.equal(counts(calls).shot, afterShot.shot);
  await assert.rejects(() => browser.port.screenshot('tab'), /not a tab SLICC is using/);
});

for (const url of PROTECTED) {
  test(`a flowing screencast pauses without ack when the live URL turns ${url}`, async (t) => {
    const { browser, calls, client, setURL, emit } = sharedIconBrowser(t);
    const frames = framesOf(browser);
    await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
    browser.port.watch('tab', { width: 100, height: 100 });
    await flush(t, 0);
    const cast = calls.find((call) => call.method === 'Page.startScreencast');
    assert.ok(cast, 'watch must start a screencast on the held session');
    const acksBefore = calls.filter((call) => call.method === 'Page.screencastFrameAck').length;
    emit({
      method: 'Page.screencastFrame',
      sessionId: cast.session,
      params: { data: 'ordinary-frame', sessionId: 1 },
    });
    await flush(t, 0);
    await flush(t, 500);
    assert.equal(frames.length, 1);
    assert.ok(
      calls.filter((call) => call.method === 'Page.screencastFrameAck').length > acksBefore
    );
    const stopsBefore = calls.filter((call) => call.method === 'Page.stopScreencast').length;
    const infosBefore = counts(calls).info;
    setURL(url, 'VAULT-MARK');
    emit({
      method: 'Page.screencastFrame',
      sessionId: cast.session,
      params: { data: 'protected-frame', sessionId: 2 },
    });
    await flush(t, 0);
    await flush(t, 500);
    assert.equal(frames.length, 1);
    assert.ok(counts(calls).info > infosBefore);
    assert.ok(calls.filter((call) => call.method === 'Page.stopScreencast').length > stopsBefore);
    const acksAfter = calls.filter((call) => call.method === 'Page.screencastFrameAck');
    assert.ok(
      !acksAfter.some((call) => call.params?.sessionId === 2),
      'the protected frame must not be acked'
    );
    await assert.rejects(() => browser.port.screenshot('tab'), /not a tab SLICC is using/);
  });
}

test('a flowing screencast resumes after a protected URL returns to ordinary', async (t) => {
  const { browser, calls, client, setURL, emit } = sharedIconBrowser(t);
  const frames = framesOf(browser);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  browser.port.watch('tab', { width: 100, height: 100 });
  await flush(t, 0);
  const cast = calls.find((call) => call.method === 'Page.startScreencast');
  emit({
    method: 'Page.screencastFrame',
    sessionId: cast.session,
    params: { data: 'ordinary-frame', sessionId: 1 },
  });
  await flush(t, 0);
  await flush(t, 500);
  assert.equal(frames.length, 1);
  setURL('https://protected.invalid/secret', 'VAULT-MARK');
  emit({
    method: 'Page.screencastFrame',
    sessionId: cast.session,
    params: { data: 'protected-frame', sessionId: 2 },
  });
  await flush(t, 0);
  await flush(t, 500);
  assert.equal(frames.length, 1);
  assert.ok(
    !calls.some((call) => call.method === 'Page.screencastFrameAck' && call.params?.sessionId === 2)
  );
  setURL('https://ordinary.invalid/page', 'ordinary');
  const startsBefore = calls.filter((call) => call.method === 'Page.startScreencast').length;
  await flush(t, SAMPLE_GAP);
  await flush(t, 0);
  assert.ok(
    calls.filter((call) => call.method === 'Page.startScreencast').length > startsBefore,
    'a passing sample must restart the screencast'
  );
  const resumed = [...calls].reverse().find((call) => call.method === 'Page.startScreencast');
  emit({
    method: 'Page.screencastFrame',
    sessionId: resumed.session,
    params: { data: 'resumed-frame', sessionId: 3 },
  });
  await flush(t, 0);
  await flush(t, 500);
  assert.ok(frames.some((frame) => frame.src.includes('resumed-frame')));
  assert.ok(
    calls.some((call) => call.method === 'Page.screencastFrameAck' && call.params?.sessionId === 3)
  );
});

test('a probe failure during a screencast pauses it without acking the frame', async (t) => {
  let probes = 0;
  const { browser, calls, client, emit } = sharedIconBrowser(t, iconSnapshot(), {
    getTargetInfo: ({ params, url, title }) => {
      probes += 1;
      if (probes > 1) throw new Error('Target.getTargetInfo failed');
      return {
        targetInfo: { targetId: params.targetId ?? 'tab', type: 'page', title, url },
      };
    },
  });
  const frames = framesOf(browser);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  browser.port.watch('tab', { width: 100, height: 100 });
  await flush(t, 0);
  const cast = calls.find((call) => call.method === 'Page.startScreencast');
  emit({
    method: 'Page.screencastFrame',
    sessionId: cast.session,
    params: { data: 'ordinary-frame', sessionId: 1 },
  });
  await flush(t, 0);
  await flush(t, 500);
  assert.equal(frames.length, 1);
  const stopsBefore = calls.filter((call) => call.method === 'Page.stopScreencast').length;
  emit({
    method: 'Page.screencastFrame',
    sessionId: cast.session,
    params: { data: 'failed-probe-frame', sessionId: 2 },
  });
  await flush(t, 0);
  await flush(t, 500);
  assert.equal(frames.length, 1);
  assert.ok(calls.filter((call) => call.method === 'Page.stopScreencast').length > stopsBefore);
  assert.ok(
    !calls.some((call) => call.method === 'Page.screencastFrameAck' && call.params?.sessionId === 2)
  );
});

test('a screencast resumes after a failing-first probe then a passing sample', async (t) => {
  let failOnce = true;
  const { browser, calls, client, emit } = sharedIconBrowser(t, iconSnapshot(), {
    getTargetInfo: ({ params, url, title }) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('Target.getTargetInfo failed');
      }
      return {
        targetInfo: { targetId: params.targetId ?? 'tab', type: 'page', title, url },
      };
    },
  });
  const frames = framesOf(browser);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  browser.port.watch('tab', { width: 100, height: 100 });
  await flush(t, 0);
  const cast = calls.find((call) => call.method === 'Page.startScreencast');
  emit({
    method: 'Page.screencastFrame',
    sessionId: cast.session,
    params: { data: 'failed-first-frame', sessionId: 1 },
  });
  await flush(t, 0);
  await flush(t, 500);
  assert.equal(frames.length, 0);
  assert.ok(
    !calls.some((call) => call.method === 'Page.screencastFrameAck' && call.params?.sessionId === 1)
  );
  assert.ok(calls.some((call) => call.method === 'Page.stopScreencast'));
  const startsBefore = calls.filter((call) => call.method === 'Page.startScreencast').length;
  await flush(t, SAMPLE_GAP);
  await flush(t, 0);
  assert.ok(
    calls.filter((call) => call.method === 'Page.startScreencast').length > startsBefore,
    'a passing sample must restart the screencast'
  );
  const resumed = [...calls].reverse().find((call) => call.method === 'Page.startScreencast');
  emit({
    method: 'Page.screencastFrame',
    sessionId: resumed.session,
    params: { data: 'after-resume-frame', sessionId: 2 },
  });
  await flush(t, 0);
  await flush(t, 500);
  assert.ok(frames.some((frame) => frame.src.includes('after-resume-frame')));
  assert.ok(
    calls.some((call) => call.method === 'Page.screencastFrameAck' && call.params?.sessionId === 2)
  );
});

test('an ordinary screencast probes once per emitted frame and acks after the check', async (t) => {
  const { browser, calls, client, emit } = sharedIconBrowser(t);
  const frames = framesOf(browser);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  browser.port.watch('tab', { width: 100, height: 100 });
  await flush(t, 0);
  const cast = calls.find((call) => call.method === 'Page.startScreencast');
  const start = calls.length;
  for (const id of [1, 2, 3]) {
    emit({
      method: 'Page.screencastFrame',
      sessionId: cast.session,
      params: { data: `frame-${id}`, sessionId: id },
    });
    await flush(t, 0);
    await flush(t, 500);
  }
  assert.equal(frames.length, 3);
  const slice = calls.slice(start);
  const infos = slice.filter((call) => call.method === 'Target.getTargetInfo');
  const acks = slice.filter((call) => call.method === 'Page.screencastFrameAck');
  assert.equal(infos.length, 3);
  assert.equal(acks.length, 3);
  for (let i = 0; i < 3; i += 1) {
    const infoAt = slice.findIndex(
      (call, index) =>
        call.method === 'Target.getTargetInfo' &&
        slice.slice(0, index).filter((row) => row.method === 'Target.getTargetInfo').length === i
    );
    const ackAt = slice.findIndex(
      (call) => call.method === 'Page.screencastFrameAck' && call.params?.sessionId === i + 1
    );
    assert.ok(infoAt >= 0 && ackAt > infoAt);
  }
});

test('the #framed backstop drops a frame when #infos is already a protected URL', async (t) => {
  const protectedURL = 'https://protected.invalid/secret';
  const { browser, calls, client, setURL, emit } = sharedIconBrowser(t, iconSnapshot(), {
    tabURL: protectedURL,
  });
  const frames = framesOf(browser);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  setURL(protectedURL, 'VAULT-MARK');
  browser.port.watch('tab', { width: 100, height: 100 });
  await flush(t, 0);
  const cast = calls.find((call) => call.method === 'Page.startScreencast');
  assert.ok(cast);
  emit({
    method: 'Page.screencastFrame',
    sessionId: cast.session,
    params: { data: 'protected-infos-frame', sessionId: 1 },
  });
  await flush(t, 0);
  await flush(t, 500);
  assert.equal(frames.length, 0);
  assert.ok(calls.some((call) => call.method === 'Page.stopScreencast'));
  assert.equal(calls.filter((call) => call.method === 'Page.screencastFrameAck').length, 0);
});

test('a Target.getTargetInfo failure refuses the capture and drops any cached frame', async (t) => {
  const { browser, calls, client } = sharedIconBrowser(t, iconSnapshot(), {
    getTargetInfo: () => {
      throw new Error('Target.getTargetInfo failed');
    },
  });
  const frames = framesOf(browser);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  await assert.rejects(() => browser.port.screenshot('tab'), /not a tab SLICC is using/);
  assert.equal(counts(calls).shot, 0);
  assert.equal(counts(calls).snap, 0);
  assert.equal(frames.length, 0);
});

test('an ordinary capture probes once before the shot and once before storing the frame', async (t) => {
  const { browser, calls, client } = sharedIconBrowser(t);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  const before = counts(calls).info;
  await browser.port.screenshot('tab');
  const infoCalls = calls.filter((call) => call.method === 'Target.getTargetInfo').slice(before);
  assert.equal(infoCalls.length, 2);
  const shotAt = calls.findIndex((call) => call.method === 'Page.captureScreenshot');
  const infos = calls
    .map((call, index) => (call.method === 'Target.getTargetInfo' ? index : -1))
    .filter((index) => index >= 0);
  assert.ok(infos[0] < shotAt);
  assert.ok(infos[1] > shotAt);
  assert.match(await browser.port.screenshot('tab'), /^data:image\/jpeg/);
});
