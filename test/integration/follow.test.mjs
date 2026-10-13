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

async function join(t, joinUrl, hub) {
  const page = await followers.page(t);
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
