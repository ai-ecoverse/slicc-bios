import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, run } from './bios.mjs';
import { launch } from './chrome.mjs';
import { follower, model, startHub } from './fake-hub.mjs';

const chrome = await launch();
after(() => chrome.close());

async function dialed(hub, path) {
  const end = Date.now() + 60000;
  while (!hub.sockets.some((socket) => socket.path.startsWith(path))) {
    assert.ok(Date.now() < end, `no socket on ${path}: ${hub.sockets.map((s) => s.path)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('seven leads a tray: a follower joins and links, rotation moves it to a new URL, unlink refuses it after', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate((url) => {
    localStorage.setItem('slicc-os.tray-hub', url);
  }, hub.url);
  await page.reload();
  await ready(page);
  await page.until(() => document.querySelector('slicc-app').model.network.status().links?.joinUrl);
  const links = await model(page, (network) => network.status().links);
  assert.deepEqual(links, {
    joinUrl: `${hub.url}/join/j1`,
    followUrl: `${new URL(chrome.url).origin}/#follow=${encodeURIComponent(`${hub.url}/join/j1`)}`,
    joinCommand: `npx sliccy@next ${hub.url}/join/j1 follow`,
    devices: [],
    permission: null,
    webhookUrl: `${hub.url}/webhook/w1`,
    sync: 'ready',
    pairing: { state: 'idle' },
  });
  assert.deepEqual(
    await page.evaluate(() => {
      const { connection, role, kind, joinUrl, followers } = document
        .querySelector('slicc-app')
        .model.tray.status();
      return { connection, role, kind, joinUrl, followers };
    }),
    {
      connection: 'live',
      role: 'leader',
      kind: 'hosted',
      joinUrl: `${hub.url}/join/j1`,
      followers: [],
    }
  );
  assert.equal(hub.sockets[0].path, '/controller/c1?leaderKey=lk');

  await page.evaluate(follower);
  hub.send({
    type: 'follower.join_requested',
    trayId: 't1',
    controllerId: 'dev1',
    bootstrapId: 'b1',
    attempt: 1,
    runtime: 'slicc-link/1',
    iceServers: [],
  });
  const offer = await hub.next('bootstrap.offer');
  assert.deepEqual(
    [offer.controllerId, offer.bootstrapId, offer.offer.type],
    ['dev1', 'b1', 'offer']
  );
  const answer = await page.evaluate((sdp) => globalThis.followerAccept(sdp), offer.offer.sdp);
  hub.send({
    type: 'bootstrap.answer',
    trayId: 't1',
    controllerId: 'dev1',
    bootstrapId: 'b1',
    answer: { type: 'answer', sdp: answer },
  });
  const relay = setInterval(() => {
    const found = hub.fromLeader.filter((m) => m.type === 'bootstrap.ice_candidate');
    hub.fromLeader = hub.fromLeader.filter((m) => m.type !== 'bootstrap.ice_candidate');
    for (const m of found)
      page.evaluate((c) => globalThis.followerCandidate(c), m.candidate).catch(() => {});
  }, 50);
  t.after(() => clearInterval(relay));
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((d) => d.state === 'connected')
  );
  const [device] = await model(page, (network) => network.status().links.devices);
  assert.match(device.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    [device.name, device.host, device.mode, device.state, device.exit],
    ['slicc on far', 'far.slicc.internal', 'remote', 'connected', true]
  );
  assert.equal(
    (await page.evaluate(() => globalThis.followerLog[0])).name.startsWith('seven on '),
    true
  );

  await run(
    page,
    "curl -s --noproxy '*' http://far.slicc.internal:8080/ > /home/far.txt; echo $? > /home/far.done"
  );
  await page.until(async () => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return home.getFileHandle('far.done').then(
      async (h) => (await h.getFile()).size > 0,
      () => false
    );
  });
  const far = await page.evaluate(async () => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return (await (await home.getFileHandle('far.txt')).getFile()).text();
  });
  assert.equal(far.trim(), 'from far');

  await page.evaluate(() => {
    window.deep = (root, selector) => {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && window.deep(element.shadowRoot, selector);
        if (inner) return inner;
      }
      return null;
    };
    const app = document.querySelector('slicc-app');
    const status = {
      name: 'harbor',
      kind: 'hosted',
      connection: 'live',
      role: 'leader',
      followers: [
        { id: 'f1', name: 'bay-laptop', device: 'browser', since: Date.now() - 40 * 60000 },
        { id: 'f2', name: 'reef-phone', device: 'phone', since: Date.now() - 5 * 60000 },
      ],
      spent: 3.42,
      rate: 0.18,
      budget: { percent: 42, window: 'weekly', resets: '2026-10-15T00:00:00Z' },
      joinUrl: 'https://www.sliccy.ai/join/dummy-join-0000',
    };
    const tray = { status: () => status, reconnect() {}, disconnect() {}, on: () => () => {} };
    window.untrayed = app.model;
    app.model = { ...app.model, tray };
  });
  const color = (wanted) =>
    page.evaluate((value) => {
      const app = document.querySelector('slicc-app');
      if (app.color !== value) app.toggleColor();
    }, wanted);
  const sync = async (name) => {
    await page.until(
      () => !!window.deep(document, 'slicc-tray')?.shadowRoot?.querySelector('#chip')
    );
    await page.evaluate(() =>
      window.deep(document, 'slicc-tray').shadowRoot.querySelector('#chip').click()
    );
    await page.until(() => !!window.deep(document, '[data-sync]'));
    await page.screenshot(new URL(`network-sync-${name}.png`, page.dir));
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .dock.api.panels.find((panel) => panel.id === 'network')
        ?.api.close()
    );
  };
  for (const theme of ['light', 'dark']) {
    await color(theme);
    await page.until(() => !!window.deep(document, '.selected[data-visible]'));
    await page.screenshot(new URL(`rail-${theme}-1280.png`, page.dir));
    await sync(`${theme}-1280`);
  }
  await color('light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.evaluate(() => document.querySelector('slicc-app').show('terminal'));
  await page.until(
    () =>
      !!window.deep(document, '.rail.bottom [data-surface="chat"]') &&
      !!window.deep(document, '.rail.bottom .selected[data-visible][data-surface="terminal"]')
  );
  await page.screenshot(new URL('rail-light-420.png', page.dir));
  await sync('light-420');
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await page.evaluate(() => {
    document.querySelector('slicc-app').model = window.untrayed;
  });

  await model(page, (network) => network.rotateJoinUrl());
  assert.equal(hub.trays, 2);
  assert.deepEqual(
    (await page.evaluate(() => globalThis.followerLog)).filter((m) => m.kind === 'join'),
    [{ kind: 'join', url: `${hub.url}/join/j2` }]
  );
  await page.until(() =>
    document.querySelector('slicc-app').model.network.status().links?.joinUrl?.endsWith('/j2')
  );
  await dialed(hub, '/controller/c2');
  assert.equal(hub.sockets.at(-1).path, '/controller/c2?leaderKey=lk');

  await model(page, (network, id) => network.unlink(id), device.id);
  assert.deepEqual((await page.evaluate(() => globalThis.followerLog)).at(-1), { kind: 'unlink' });
  assert.deepEqual(await model(page, (network) => network.status().links.devices), []);
  hub.send({
    type: 'follower.join_requested',
    trayId: 't2',
    controllerId: 'dev1-again',
    bootstrapId: 'b2',
    attempt: 1,
    runtime: 'slicc-link/1',
  });
  const reoffer = await hub.next('bootstrap.offer');
  const reanswer = await page.evaluate((sdp) => globalThis.followerAccept(sdp), reoffer.offer.sdp);
  hub.send({
    type: 'bootstrap.answer',
    trayId: 't2',
    controllerId: 'dev1-again',
    bootstrapId: 'b2',
    answer: { type: 'answer', sdp: reanswer },
  });
  const refused = await hub.next('bootstrap.failed');
  assert.deepEqual(
    [refused.controllerId, refused.code, refused.retryable],
    ['dev1-again', 'UNLINKED', false]
  );
  await page.evaluate(() => {
    localStorage.removeItem('slicc-os.tray-hub');
  });
});
