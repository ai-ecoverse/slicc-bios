import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, run } from './bios.mjs';
import { launch } from './chrome.mjs';
import { follower, model, startHub } from './fake-hub.mjs';

const chrome = await launch();
after(() => chrome.close());

test('seven leads a tray: a follower joins and links, rotation moves it to a new URL, unlink refuses it after', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page);
  await page.until(() => document.querySelector('slicc-app').model.network.status().links?.joinUrl);
  const links = await model(page, (network) => network.status().links);
  assert.deepEqual(links, {
    joinUrl: `${hub.url}/join/j1`,
    joinCommand: `npx sliccy ${hub.url}/join/j1 follow`,
    devices: [],
    permission: null,
  });
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

  await model(page, (network) => network.rotateJoinUrl());
  assert.equal(hub.trays, 2);
  assert.deepEqual(
    (await page.evaluate(() => globalThis.followerLog)).filter((m) => m.kind === 'join'),
    [{ kind: 'join', url: `${hub.url}/join/j2` }]
  );
  await page.until(() =>
    document.querySelector('slicc-app').model.network.status().links?.joinUrl?.endsWith('/j2')
  );
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
  await page.evaluate(() => localStorage.removeItem('slicc-os.tray-hub'));
});
