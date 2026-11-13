import assert from 'node:assert/strict';
import test from 'node:test';
import { iconSnapshot, sharedIconBrowser } from './fixtures/shared-dom-icon.mjs';

const icon = 'data:image/svg+xml,%3Csvg/%3E';

test('favicon capture leaves an existing client frontend node usable on the shared extension DOM agent', async (t) => {
  const { browser, calls, client } = sharedIconBrowser(t);
  const c = client();
  const attached = await c.call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  const document = await c.call('DOM.getDocument', { depth: 1, pierce: false }, attached.sessionId);
  await browser.port.screenshot('tab');
  assert.deepEqual(
    await c.call(
      'DOM.querySelectorAll',
      { nodeId: document.root.nodeId, selector: 'iframe,frame' },
      attached.sessionId
    ),
    { nodeIds: [] }
  );
  assert.equal(calls.filter((call) => call.method === 'DOM.getDocument').length, 1);
  assert.equal(
    calls.some((call) => call.method === 'DOMSnapshot.captureSnapshot'),
    true
  );
  assert.equal(
    calls.some((call) => call.method === 'DOM.getAttributes'),
    false
  );
});

test('settling another observed client also samples without replacing existing frontend bindings', async (t) => {
  const { calls, client, privateRead } = sharedIconBrowser(t);
  const a = client(),
    b = client();
  const first = await a.call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  const second = await b.call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  const document = await a.call('DOM.getDocument', { depth: 1, pierce: false }, first.sessionId);
  await b.call('Target.detachFromTarget', { sessionId: second.sessionId });
  t.mock.timers.tick(1000);
  await privateRead;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    await a.call(
      'DOM.querySelectorAll',
      { nodeId: document.root.nodeId, selector: 'iframe,frame' },
      first.sessionId
    ),
    { nodeIds: [] }
  );
  assert.equal(calls.filter((call) => call.method === 'DOM.getDocument').length, 1);
  assert.equal(
    calls.some((call) => call.method === 'DOMSnapshot.captureSnapshot'),
    true
  );
});

test('snapshot favicon selection keeps case-insensitive light-DOM matching and ignores child and fragment links', async (t) => {
  const snapshot = iconSnapshot({
    links: [
      {
        fragment: true,
        attributes: { rel: 'icon', href: 'data:image/svg+xml,%3Csvg%20id%3D%22shadow%22/%3E' },
      },
      { attributes: { rel: 'stylesheet', href: icon } },
      { attributes: { REL: 'shortcut ICON', HREF: icon } },
    ],
    childLinks: [
      { attributes: { rel: 'icon', href: 'data:image/svg+xml,%3Csvg%20id%3D%22child%22/%3E' } },
    ],
  });
  const { browser, calls, client } = sharedIconBrowser(t, snapshot);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  await browser.port.screenshot('tab');
  assert.equal((await browser.port.list())[0].favicon, icon);
  await browser.port.screenshot('tab');
  assert.equal(calls.filter((call) => call.method === 'DOMSnapshot.captureSnapshot').length, 1);
});

for (const url of [
  'https://protected.invalid/root',
  'https://seven.sliccy.ai/',
  'https://signin.invalid/?client_id=experience-catalyst-prod',
]) {
  test(`known protected or sign-in tab is never DOM-snapshotted: ${url}`, async (t) => {
    const snapshot = iconSnapshot({ url, links: [{ attributes: { rel: 'icon', href: icon } }] });
    const { browser, calls, client } = sharedIconBrowser(t, snapshot, { tabURL: url });
    await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
    await assert.rejects(() => browser.port.screenshot('tab'), /not a tab SLICC is using/);
    assert.equal(
      calls.some((call) => call.method === 'DOMSnapshot.captureSnapshot'),
      false
    );
    assert.equal(
      calls.some((call) => call.method === 'Page.captureScreenshot'),
      false
    );
    assert.equal((await browser.port.list())[0].favicon, undefined);
  });
}

test('flattened Chromium shadow-tree links are ignored before the light-DOM icon', async (t) => {
  const shadow = 'data:image/svg+xml,%3Csvg%20id%3D%22shadow%22/%3E';
  const snapshot = iconSnapshot({
    links: [
      { shadow: true, attributes: { rel: 'icon', href: shadow } },
      { attributes: { rel: 'icon', href: icon } },
    ],
  });
  assert.equal(snapshot.strings.includes('#document-fragment'), false);
  const { browser, client } = sharedIconBrowser(t, snapshot);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  await browser.port.screenshot('tab');
  assert.equal((await browser.port.list())[0].favicon, icon);
});

test('a page that changes to a protected snapshot document URL remains undisplayed', async (t) => {
  const snapshot = iconSnapshot({
    url: 'https://protected.invalid/',
    links: [{ attributes: { rel: 'icon', href: icon } }],
  });
  const { browser, client } = sharedIconBrowser(t, snapshot);
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  await browser.port.screenshot('tab');
  assert.equal((await browser.port.list())[0].favicon, undefined);
});

test('a failed screenshot still samples the data: favicon from the DOM snapshot', async (t) => {
  const snapshot = iconSnapshot({
    links: [{ attributes: { rel: 'icon', href: icon } }],
  });
  const { browser, calls, client } = sharedIconBrowser(t, snapshot, {
    captureScreenshot: () => {
      throw new Error('Page.captureScreenshot timed out');
    },
  });
  await client().call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  await assert.rejects(() => browser.port.screenshot('tab'), /timed out/);
  assert.equal(
    calls.some((call) => call.method === 'DOMSnapshot.captureSnapshot'),
    true
  );
  assert.equal((await browser.port.list())[0].favicon, icon);
});

test('a finished open action settles the tab so its favicon is sampled without a detach', async (t) => {
  const snapshot = iconSnapshot({
    links: [{ attributes: { rel: 'icon', href: icon } }],
  });
  const { browser, calls, client } = sharedIconBrowser(t, snapshot);
  const { connection, call } = client();
  await call('Target.attachToTarget', { targetId: 'tab', flatten: true });
  const before = calls.filter((row) => row.method === 'DOMSnapshot.captureSnapshot').length;
  connection.send(
    JSON.stringify({
      method: 'Slicc.action',
      params: {
        phase: 'start',
        kind: 'open',
        url: 'https://ordinary.invalid/page',
        tab: 'tab',
        agent: 'cone:agent-1',
      },
    })
  );
  connection.send(
    JSON.stringify({
      method: 'Slicc.action',
      params: {
        phase: 'end',
        ok: true,
        tab: 'tab',
      },
    })
  );
  t.mock.timers.tick(0);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.filter((row) => row.method === 'DOMSnapshot.captureSnapshot').length > before);
  assert.equal((await browser.port.list())[0].favicon, icon);
});
