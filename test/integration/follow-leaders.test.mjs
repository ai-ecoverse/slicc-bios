import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { actPackage, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { leader, model, startHub } from './fake-hub.mjs';
import { shoot } from './shots.mjs';

const STEP = 3 * 60 * 1000;
const owners = await launch({ timeout: 120000 });
const followers = await launch({ timeout: 120000 });
const hub = await startHub();
after(async () => {
  hub.close();
  await Promise.all([owners.close(), followers.close()]);
});

const keyOf = (url) => createHash('sha256').update(url).digest('hex');
const tokenOf = (url) => /\/join\/j(\d+)$/.exec(url)[1];

async function boot(page, hubUrl) {
  await page.goto('/');
  await ready(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hubUrl);
  await page.reload();
  await ready(page);
}

async function kernel(page) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  await page.evaluate(async () => {
    globalThis.leadersClient = await globalThis.sliccKernelClient();
  });
}

const slicc = (page, url) =>
  page.evaluate(
    (command) =>
      globalThis.leadersClient
        .run(['bash', '-c', command], { cwd: '/' })
        .then(({ status, stdout, stderr }) => ({ status, out: `${stdout ?? ''}${stderr ?? ''}` })),
    `slicc '${url}' abort`
  );

const devices = async (page) =>
  (await model(page, (network) => network.status().links.devices)).filter(
    (item) => item.kind === 'cli' && item.mode === 'remote'
  );

const rows = (page) => model(page, (network) => network.status().leaders ?? []);

async function leaderIs(page, id, state, ms = STEP) {
  await page
    .within(
      ms,
      ([id, state]) =>
        document
          .querySelector('slicc-app')
          .dock.content('network')
          ?.shadowRoot?.querySelector(`li[data-leader="${id}"]`)?.dataset.state === state,
      [id, state]
    )
    .catch(async (error) => {
      throw new Error(
        `leader ${id.slice(0, 8)} never ${state}: ${error.message}\n${JSON.stringify(await rows(page))}`
      );
    });
}

async function press(page, id, action) {
  await page.evaluate(
    ([id, action]) =>
      document
        .querySelector('slicc-app')
        .dock.content('network')
        .shadowRoot.querySelector(`li[data-leader="${id}"] [data-action="${action}"]`)
        .click(),
    [id, action]
  );
}

async function confirmForget(page) {
  const confirm = () => {
    const deep = (root) => {
      const found = root.querySelector('slicc-confirm');
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && deep(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return deep(document);
  };
  await page.until(
    (find) => !!new Function(`return (${find})()`)()?.shadowRoot?.querySelector('dialog[open]'),
    confirm.toString()
  );
  await page.evaluate(
    (find) =>
      [...new Function(`return (${find})()`)().shadowRoot.querySelectorAll('swc-button')]
        .find((button) => button.textContent.trim() === 'Forget')
        .click(),
    confirm.toString()
  );
}

const traces = (page, needles) =>
  page.evaluate(async (needles) => {
    const found = [];
    const hit = (where, text) => {
      if (needles.some((needle) => text.includes(needle))) found.push(where);
    };
    const text = (value) => {
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return String(value);
      }
    };
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      hit(`localStorage ${key}`, `${key}\n${localStorage.getItem(key)}`);
    }
    const ask = (request) =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    let stores = 0;
    for (const { name } of await indexedDB.databases()) {
      const db = await ask(indexedDB.open(name));
      for (const store of db.objectStoreNames) {
        const items = db.transaction(store).objectStore(store);
        const [keys, values] = [await ask(items.getAllKeys()), await ask(items.getAll())];
        hit(`indexedDB ${name}/${store}`, `${text(keys)}\n${values.map(text).join('\n')}`);
        stores += 1;
      }
      db.close();
    }
    const latin = new TextDecoder('latin1');
    let files = 0;
    const unread = [];
    const walk = async (dir, path) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          await walk(handle, `${path}${name}/`);
          continue;
        }
        try {
          const bytes = await (await handle.getFile()).arrayBuffer();
          hit(`opfs ${path}${name}`, latin.decode(bytes));
          files += 1;
        } catch (error) {
          unread.push(`${path}${name}: ${error.name}`);
        }
      }
    };
    await walk(await navigator.storage.getDirectory(), '/');
    return { found, stores, files, unread };
  }, needles);

test('Leaders: Disconnect holds across a reload with no dial, Reconnect keeps the certificate, an expired tray fails with Retry, and Forget leaves no join URL behind', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const owner = await owners.page(t);
  await boot(owner, hub.url);
  const page = await followers.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page, hub.url);
  await page.within(5 * 60 * 1000, () =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'slicc' && item.state === 'available')
  );
  assert.equal(await actPackage(page, 'slicc'), 'ok');
  await kernel(page);

  const { joinUrl } = await model(owner, (network) => network.status().links);
  const real = keyOf(joinUrl);
  const first = await slicc(page, joinUrl);
  assert.equal(first.status, 3, first.out);
  assert.match(first.out, /doesn't allow remote control from this one/);
  let found = [];
  for (let i = 0; i < 240 && found.length !== 1; i += 1) {
    found = await devices(owner);
    if (found.length !== 1) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(found.length, 1, JSON.stringify(found));
  const [device] = found;
  await model(owner, (network, id) => network.setRemoteControl(id, true), device.id);
  const allowed = await slicc(page, joinUrl);
  assert.equal(allowed.status, 3, allowed.out);
  assert.match(allowed.out, /the agent is not running/);

  const fake = await owner.evaluate(leader, hub.url);
  const other = keyOf(fake);
  const followedFake = await slicc(page, fake);
  assert.equal(followedFake.status, 0, followedFake.out);
  assert.match(followedFake.out, /nothing was running/);
  assert.deepEqual(await owner.evaluate(() => globalThis.fakeLeader.fingerprints), [device.id]);

  await page.evaluate(() => document.querySelector('slicc-app').show('network'));
  await leaderIs(page, real, 'connected');
  await leaderIs(page, other, 'connected');
  const listed = await rows(page);
  assert.deepEqual(
    listed.map((item) => [item.id, item.name, item.hub, item.state]).sort(),
    [
      [real, `seven on ${new URL(owners.url).host}`, new URL(hub.url).host, 'connected'],
      [other, 'a fake leader', new URL(hub.url).host, 'connected'],
    ].sort()
  );
  for (const secret of [joinUrl, fake, new URL(joinUrl).pathname, new URL(fake).pathname])
    assert.ok(!JSON.stringify(listed).includes(secret), 'the status carries no join URL');
  await shoot(page, 'leaders-connected', { show: 'network', target: 'section[data-leaders]' });

  await press(page, real, 'disconnect-leader');
  await leaderIs(page, real, 'disconnected');
  await owner.within(
    60000,
    (id) =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links.devices.some((item) => item.id === id && item.state === 'offline'),
    device.id
  );
  const dials = hub.dials[tokenOf(joinUrl)];
  const refused = await slicc(page, joinUrl);
  assert.equal(refused.status, 3, refused.out);
  assert.match(refused.out, /disconnected from that one; reconnect it in Network/);
  const fakeDials = hub.dials[tokenOf(fake)];
  await page.reload();
  await ready(page);
  await kernel(page);
  await page.evaluate(() => document.querySelector('slicc-app').show('network'));
  await leaderIs(page, other, 'connected');
  assert.ok(hub.dials[tokenOf(fake)] > fakeDials, 'boot dials a kept leader again');
  await leaderIs(page, real, 'disconnected');
  assert.equal(hub.dials[tokenOf(joinUrl)], dials, 'a disconnected leader is never dialled');
  await shoot(page, 'leaders-disconnected', { show: 'network', target: 'section[data-leaders]' });

  await press(page, real, 'reconnect-leader');
  await leaderIs(page, real, 'connected');
  assert.ok(hub.dials[tokenOf(joinUrl)] > dials);
  const back = await devices(owner);
  assert.deepEqual(
    back.map((item) => [item.id, item.state, item.control.allowed]),
    [[device.id, 'connected', true]],
    'Reconnect brings back the same certificate, with its grant'
  );
  const resumed = await slicc(page, joinUrl);
  assert.match(resumed.out, /the agent is not running/);

  hub.expired.add(tokenOf(fake));
  await owner.evaluate(() => globalThis.fakeLeaderClose());
  await leaderIs(page, other, 'failed');
  assert.match(
    (await rows(page)).find((item) => item.id === other).error,
    /^That tray has expired; ask for a new join URL\.$/
  );
  assert.ok(
    await page.evaluate(
      (id) =>
        !!document
          .querySelector('slicc-app')
          .dock.content('network')
          .shadowRoot.querySelector(`li[data-leader="${id}"] [data-action="retry-leader"]`),
      other
    )
  );
  await shoot(page, 'leaders-failed', { show: 'network', target: 'section[data-leaders]' });
  hub.expired.delete(tokenOf(fake));
  await press(page, other, 'retry-leader');
  await leaderIs(page, other, 'connected');

  const needles = [fake, new URL(fake).pathname];
  const before = await traces(page, needles);
  assert.deepEqual(before.found, ['localStorage slicc-os.leaders'], JSON.stringify(before));
  assert.ok(before.files > 100 && before.stores > 0, JSON.stringify(before));
  await press(page, other, 'forget-leader');
  await confirmForget(page);
  await page.until(
    (id) =>
      !document
        .querySelector('slicc-app')
        .model.network.status()
        .leaders.some((item) => item.id === id),
    other
  );
  const afterForget = await traces(page, needles);
  assert.deepEqual(afterForget.found, [], JSON.stringify(afterForget));
  assert.ok(afterForget.unread.length < afterForget.files / 10, JSON.stringify(afterForget.unread));
  assert.deepEqual(
    (await devices(owner)).map((item) => [item.id, item.control.allowed]),
    [[device.id, true]],
    'the other leader on the hub keeps this seven and its grant'
  );
  const still = await slicc(page, joinUrl);
  assert.match(still.out, /the agent is not running/);

  const relinked = await slicc(page, fake);
  assert.equal(relinked.status, 0, relinked.out);
  const prints = await owner.evaluate(() => globalThis.fakeLeader.fingerprints);
  assert.notEqual(prints.at(-1), device.id, 'the next link to a forgotten leader is a new device');
  await leaderIs(page, other, 'connected');

  assert.deepEqual(page.errors, []);
  assert.deepEqual(owner.errors, []);
});
