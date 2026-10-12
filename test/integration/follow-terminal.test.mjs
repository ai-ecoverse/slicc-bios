import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { model, startHub } from './fake-hub.mjs';

const owners = await launch();
const followers = await launch();
after(() => Promise.all([owners.close(), followers.close()]));

const last = () => {
  const { dock } = document.querySelector('slicc-app');
  const id = dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'));
  return id ? dock.content(id) : null;
};

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

async function type(page, text) {
  await page.evaluate(
    (last) => new Function(`return (${last})()`)().screen.focus(),
    last.toString()
  );
  await page.insert(text);
  await page.enter();
}

const shows = (page, needle) =>
  page.until(
    ([last, needle]) => new Function(`return (${last})()`)()?.screen?.textContent.includes(needle),
    [last.toString(), needle]
  );

test('a follower with Terminal gets a shell in the owner kernel: ls, ^C, resize to stty size; without Terminal a stream gets EACCES', {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const owner = await owners.page(t);
  await boot(owner);
  await owner.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await owner.reload();
  await ready(owner);
  await owner.until(
    () => document.querySelector('slicc-app').model.network.status().links?.joinUrl
  );
  const { joinUrl } = await model(owner, (network) => network.status().links);
  const page = await followers.page(t);
  await page.goto(`/#follow=${encodeURIComponent(joinUrl)}`);
  await page.until(new Function(`return !!(${dialog})()`));
  await page.evaluate(
    new Function(
      `[...(${dialog})().getRootNode().host.shadowRoot.querySelectorAll('swc-button')].find((b) => b.textContent.trim() === 'Follow').click()`
    )
  );
  await page.until(
    () => document.querySelector('slicc-app')?.model?.follow?.state().link === 'connected'
  );
  await owner.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links.devices.some((d) => d.asking)
  );
  const [device] = await model(owner, (network) => network.status().links.devices);
  await model(owner, (network, id) => network.setAccess(id, 'view', true), device.id);
  await page.until(() => document.querySelector('slicc-app').model.follow.state().access.view);

  const refused = await page.evaluate(async (url) => {
    const { createFollow, hubClient, certificate, hubOrigin } = await import('/os/follow.js');
    const hub = hubOrigin(url);
    const probe = createFollow({
      kept: { hub, url },
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      post: hubClient({ origin: null, fetch: (...args) => fetch(...args) }),
      makePeer: (config) => new RTCPeerConnection(config),
      cert: () => certificate(hub),
      forget: async () => undefined,
      hello: () => ({
        name: 'probe',
        mode: 'remote',
        kind: 'seven',
        caps: ['join', 'permissions'],
        node: 'probe',
      }),
    });
    probe.start();
    for (let i = 0; i < 400 && !probe.session(); i += 1)
      await new Promise((r) => setTimeout(r, 50));
    const result = await probe.open({ kind: 'terminal', cols: 80, rows: 24 }).then(
      () => 'opened',
      (error) => error.code
    );
    await probe.leave();
    return result;
  }, joinUrl);
  assert.equal(refused, 'EACCES');

  await model(owner, (network, id) => network.setAccess(id, 'terminal', true), device.id);
  await page.until(() => document.querySelector('slicc-app').model.follow.state().access.terminal);
  await page.evaluate(() => document.querySelector('slicc-app').show('terminal'));
  await shows(page, 'slicc:/home# ');
  await owner.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links.devices.some((d) => d.terminals === 1)
  );

  await type(page, 'mkdir -p far && touch far/from-the-follower && ls far');
  await shows(page, 'from-the-follower');
  await owner.until(async () => {
    try {
      const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
      await (await home.getDirectoryHandle('far')).getFileHandle('from-the-follower');
      return true;
    } catch {
      return false;
    }
  });

  await type(page, 'sleep 60');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await page.press('c', 'ctrl');
  await type(page, 'echo sleep-ended-$?');
  await shows(page, 'sleep-ended-130');

  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const size = await page.evaluate((last) => {
    const term = new Function(`return (${last})()`)();
    return `${term.screen.rows} ${term.screen.cols}`;
  }, last.toString());
  await type(page, 'echo size-$(stty size | tr " " x)');
  await shows(page, `size-${size.replace(' ', 'x')}`);
  await page.send('Emulation.clearDeviceMetricsOverride');

  await model(owner, (network, id) => network.setAccess(id, 'terminal', false), device.id);
  await owner.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links.devices.every((d) => !d.terminals)
  );
  assert.deepEqual(owner.errors, []);
  assert.deepEqual(page.errors, []);
  await owner.evaluate(() => localStorage.removeItem('slicc-os.tray-hub'));
});
