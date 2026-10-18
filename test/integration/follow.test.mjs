import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { model, startHub } from './fake-hub.mjs';
import { shoot } from './shots.mjs';

const owners = await launch();
const followers = await launch();
after(() => Promise.all([owners.close(), followers.close()]));

const follow = (page) =>
  page.evaluate(() => document.querySelector('slicc-app').model.follow?.state() ?? null);

const devices = (page) => model(page, (network) => network.status().links.devices);

async function lead(t, hub) {
  const owner = await owners.page(t);
  await boot(owner);
  await owner.evaluate((url) => {
    localStorage.setItem('slicc-os.tray-hub', url);
  }, hub.url);
  await owner.reload();
  await ready(owner);
  await owner.until(
    () => document.querySelector('slicc-app').model.network.status().links?.joinUrl
  );
  return owner;
}

const dialog = () => {
  const deep = (root) => {
    const found = root.querySelector('slicc-confirm');
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && deep(element.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  return deep(document)?.shadowRoot?.querySelector('dialog[open]') ?? null;
};

async function join(t, joinUrl, hub, init) {
  const page = await followers.page(t);
  if (init) await page.init(init);
  await page.goto(`/#follow=${encodeURIComponent(joinUrl)}`);
  await page.until(
    () => location.pathname === '/os/' && document.documentElement.dataset.follow === 'on'
  );
  await page.until(new Function(`return !!(${dialog})()`));
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.follow')), null);
  assert.equal(hub.attaches.length, 0);
  page.asked = await page.evaluate(new Function(`return (${dialog})().textContent`));
  await shoot(page, 'follower-asks-first');
  await page.evaluate(
    new Function(
      `[...(${dialog})().getRootNode().host.shadowRoot.querySelectorAll('swc-button')].find((b) => b.textContent.trim() === 'Follow').click()`
    )
  );
  return page;
}

const CHROME_DROPS = `() => {
  const announced = new WeakSet();
  const opened = new WeakSet();
  globalThis.droppedBeforeOpen = [];
  const listen = RTCPeerConnection.prototype.addEventListener;
  RTCPeerConnection.prototype.addEventListener = function (type, listener, options) {
    if (type !== 'datachannel') return listen.call(this, type, listener, options);
    const pc = this;
    return listen.call(pc, type, (event) => {
      announced.add(event.channel);
      event.channel.addEventListener('open', () => opened.add(event.channel));
      return listener.call(pc, event);
    }, options);
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    if (announced.has(this) && !opened.has(this)) {
      globalThis.droppedBeforeOpen.push(typeof data === 'string' ? data.slice(0, 60) : 'binary');
      return;
    }
    return send.call(this, data);
  };
}`;

test('a follower says HELLO only once its announced control channel opens, since Chrome can drop a send before that, so the owner hears it at once', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const owner = await lead(t, hub);
  const { joinUrl } = await model(owner, (network) => network.status().links);
  const page = await join(t, joinUrl, hub, CHROME_DROPS);
  await page.until(
    () => document.querySelector('slicc-app').model.follow.state().link === 'connected'
  );
  const dropped = () => page.evaluate(() => globalThis.droppedBeforeOpen);
  await owner
    .within(5000, () =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links.devices.some((d) => d.kind === 'seven' && d.state === 'connected')
    )
    .catch(async (error) => {
      throw new Error(
        `${error.message}\nsent before the channel opened: ${JSON.stringify(await dropped())}`
      );
    });
  assert.deepEqual(await dropped(), []);
  await owner.evaluate(() => {
    localStorage.removeItem('slicc-os.tray-hub');
  });
});

test('a seven follows another: it asks first, follows once allowed, keeps its certificate across reloads, and unlink ends it', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const owner = await lead(t, hub);
  const { joinUrl, followUrl } = await model(owner, (network) => network.status().links);
  assert.equal(followUrl, `${new URL(owners.url).origin}/#follow=${encodeURIComponent(joinUrl)}`);
  assert.equal(await owner.evaluate(() => localStorage.getItem('slicc-os.followers')), null);
  await shoot(owner, 'owner-tray', { show: 'network', target: '#sync' });
  await shoot(owner, 'owner-open-on-another-device', { show: 'network', target: '#follow-link' });

  const page = await join(t, joinUrl, hub);
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.match(page.asked, /Follow a SLICC on another computer\?/);
  await page.until(() => localStorage.getItem('slicc-os.follow'));
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('slicc-os.follow'))), {
    hub: hub.url,
    url: joinUrl,
  });
  await page.until(
    () => document.querySelector('slicc-app').model.follow.state().link === 'connected'
  );
  const waiting = await follow(page);
  assert.match(waiting.owner, /^SLICC on /);
  assert.match(waiting.name, /^SLICC on /);
  assert.deepEqual(waiting.access, { view: false, control: false, terminal: false });
  assert.equal(hub.attaches.at(-1).runtime, 'slicc-seven/1');
  await shoot(page, 'follower-waiting');

  await owner.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links.devices.some((d) => d.kind === 'seven' && d.state === 'connected')
  );
  const [device] = await devices(owner);
  assert.match(device.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    [
      device.kind,
      device.mode,
      device.asking,
      device.access,
      device.exit,
      device.host,
      device.address,
    ],
    ['seven', 'remote', true, { view: false, control: false, terminal: false }, false, '', '']
  );
  await shoot(owner, 'owner-asks-to-follow', {
    show: 'network',
    target: '[aria-labelledby="links"]',
  });

  await model(owner, (network, id) => network.setAccess(id, 'control', true), device.id);
  await page.until(() => document.querySelector('slicc-app').model.follow.state().access.view);
  assert.deepEqual((await follow(page)).access, {
    view: true,
    control: true,
    terminal: false,
  });
  const [allowed] = await devices(owner);
  assert.equal(allowed.asking, undefined);
  await model(owner, (network, id) => network.setAccess(id, 'terminal', true), device.id);
  await page.until(() => document.querySelector('slicc-app').model.follow.state().access.terminal);
  await shoot(owner, 'owner-view-control-terminal', {
    show: 'network',
    target: '[aria-labelledby="links"]',
  });
  await shoot(page, 'follower-following');
  await model(owner, (network, id) => network.setAccess(id, 'view', false), device.id);
  await page.until(() => !document.querySelector('slicc-app').model.follow.state().access.view);
  assert.deepEqual((await follow(page)).access, { view: false, control: false, terminal: false });
  assert.equal((await devices(owner))[0].asking, true);
  await model(owner, (network, id) => network.setAccess(id, 'control', true), device.id);

  await page.reload();
  await page.until(() => {
    const state = document.querySelector('slicc-app')?.model?.follow?.state();
    return state?.link === 'connected' && state.access.control;
  });
  await owner.until(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links.devices.filter((d) => d.id === id && d.state === 'connected').length === 1,
    device.id
  );
  assert.deepEqual(
    (await devices(owner)).map((d) => d.id),
    [device.id]
  );

  await model(owner, (network, id) => network.unlink(id), device.id);
  await page.until(
    () => document.querySelector('slicc-app').model.follow.state().link === 'unlinked'
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.follow')), null);
  assert.deepEqual(await devices(owner), []);
  assert.deepEqual(owner.errors, []);
  assert.deepEqual(page.errors, []);
  await owner.evaluate(() => {
    localStorage.removeItem('slicc-os.tray-hub');
  });
});

test('a follower that seven reloads to put back one of its changed files keeps following, also after the owner moved its link, and doesn’t ask again', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const owner = await lead(t, hub);
  const { joinUrl } = await model(owner, (network) => network.status().links);
  const page = await join(t, joinUrl, hub);
  await page.until(
    () => document.querySelector('slicc-app').model.follow.state().link === 'connected'
  );
  assert.match((await follow(page)).owner, /^SLICC on /);
  assert.equal(await page.evaluate(() => location.hash), '');
  await model(owner, (network) => network.rotateJoinUrl());
  const moved = await page.until((url) => {
    const kept = JSON.parse(localStorage.getItem('slicc-os.follow'));
    return kept?.url !== url && kept?.url;
  }, joinUrl);

  await page.evaluate(async () => {
    window.__before = true;
    const os = await (await navigator.storage.getDirectory()).getDirectoryHandle('os');
    const handle = await os.getFileHandle('callback.js');
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek((await handle.getFile()).size);
    await writable.write('\nglobalThis.__changed = 1;\n');
    await writable.close();
    void fetch('/os/callback.js');
  });
  await page.until(
    () =>
      !window.__before &&
      location.pathname === '/os/' &&
      document.documentElement.dataset.follow === 'on' &&
      !!document.querySelector('slicc-app')?.model?.follow
  );
  const settled = await page
    .within(
      60000,
      new Function(`
        if ((${dialog})()) return { asked: (${dialog})().textContent.replace(/\\s+/g, ' ').trim() };
        const state = document.querySelector('slicc-app').model.follow.state();
        return state.link === 'connected' ? { state } : null;
      `)
    )
    .catch(async (error) => {
      throw new Error(
        `the follower neither followed nor asked after seven put its file back: ${error.message}\n${JSON.stringify(await follow(page))}`
      );
    });
  assert.equal(settled.asked, undefined, `the follower asked again: ${settled.asked}`);
  assert.match(settled.state.owner, /^SLICC on /);
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('slicc-os.follow'))), {
    hub: hub.url,
    url: moved,
    from: joinUrl,
  });
  assert.doesNotMatch(
    await page.evaluate(async () => (await fetch('/os/callback.js')).text()),
    /__changed/
  );
  await owner.evaluate(() => {
    localStorage.removeItem('slicc-os.tray-hub');
  });
});
