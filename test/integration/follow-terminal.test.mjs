import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { model, startHub } from './fake-hub.mjs';
import { shoot } from './shots.mjs';

const owners = await launch({ tools: false });
const followers = await launch({ tools: false });
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

const opfsHas = (page, path) =>
  page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    try {
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      await dir.getFileHandle(parts.at(-1));
      return true;
    } catch {
      return false;
    }
  }, path);

async function openPort(page) {
  await page.evaluate(() => {
    const { terminals } = document.querySelector('slicc-app').model;
    const info = terminals.open({ cwd: '/home' });
    const kept = {
      id: info.id,
      output: '',
      exited: null,
      error: null,
      session: null,
      settled: false,
    };
    window.keptTerminal = kept;
    const sink = {
      output: (bytes) => {
        kept.output += typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
      },
      exit: (status) => {
        kept.exited = status;
      },
    };
    terminals
      .backend(info.id)
      .open(sink, { cols: 80, rows: 24 })
      .then(
        (session) => {
          kept.session = session;
        },
        (error) => {
          kept.error = error.code ?? error.message;
        }
      )
      .finally(() => {
        kept.settled = true;
      });
  });
  try {
    await page.within(90000, () => window.keptTerminal.settled);
  } catch (error) {
    const state = await page.evaluate(() =>
      JSON.stringify({ ...window.keptTerminal, session: !!window.keptTerminal.session })
    );
    throw new Error(`the follower's terminal port never settled: ${state}`, { cause: error });
  }
  return page.evaluate(() => ({
    error: window.keptTerminal.error,
    open: !!window.keptTerminal.session,
  }));
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
  await owner.evaluate(() => {
    const { network } = document.querySelector('slicc-app').model;
    globalThis.allowed = null;
    const off = network.on('network', (status) => {
      const asking = status.links?.devices.find((d) => d.asking);
      if (!asking || globalThis.allowed) return;
      const allowed = { id: asking.id, state: asking.state };
      globalThis.allowed = allowed;
      off();
      network.setAccess(asking.id, 'view', true).then(
        () => {
          allowed.done = true;
        },
        (error) => {
          allowed.error = error.message;
        }
      );
    });
  });
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
  const device = await owner.within(
    60000,
    () => (globalThis.allowed?.done || globalThis.allowed?.error) && globalThis.allowed
  );
  assert.deepEqual(device, { id: device.id, state: 'connected', done: true });
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

  const viewOnly = await openPort(page);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const unopened = await page.evaluate(() => {
    const kept = window.keptTerminal;
    if (kept.session) kept.session.write(new TextEncoder().encode('touch /home/view-only-wrote\r'));
    document.querySelector('slicc-app').model.terminals.close(kept.id);
    return { error: kept.error, exited: kept.exited, output: kept.output };
  });
  assert.equal(
    viewOnly.open,
    false,
    `a terminal opened without Terminal: ${JSON.stringify(unopened)}`
  );
  assert.match(String(unopened.error), /EACCES/);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(await opfsHas(owner, 'home/view-only-wrote'), false);
  assert.ok(
    (await model(owner, (network) => network.status().links.devices)).every((d) => !d.terminals)
  );

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
  await type(page, "bash -c 'exit 7'; echo exit-status-$?");
  await shows(page, 'exit-status-7');
  await type(
    page,
    `printf '{"kind":"open.url","url":"%s"}\\n' https://example.test/remote | cat > /dev/embedder; echo remote-$?`
  );
  await shows(page, 'no page answers requests for this session');
  await shows(page, 'remote-1');
  const { targetInfos } = await owners.cdp.send('Target.getTargets');
  assert.deepEqual(
    targetInfos.filter(({ url }) => url.startsWith('https://example.test')),
    []
  );
  assert.equal(await owner.evaluate(dialog), null);
  await shoot(page, 'follower-terminal', { show: 'terminal' });
  await owner.evaluate(() => document.querySelector('slicc-app').show('terminal'));
  await shows(owner, 'slicc:');
  await type(owner, 'ls -l /home/far');
  await shows(owner, 'from-the-follower');
  await shoot(owner, 'owner-terminal', { show: 'terminal' });

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

  assert.deepEqual(await openPort(page), { error: null, open: true });
  await page.until(() => window.keptTerminal.output.includes('slicc:'));
  await model(owner, (network, id) => network.setAccess(id, 'terminal', false), device.id);
  await owner.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links.devices.every((d) => !d.terminals)
  );
  await page.until(() => window.keptTerminal.exited !== null);
  await page.evaluate(() =>
    window.keptTerminal.session.write(new TextEncoder().encode('touch /home/after-revoke\r'))
  );
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(await opfsHas(owner, 'home/after-revoke'), false);
  assert.deepEqual(owner.errors, []);
  assert.deepEqual(page.errors, []);
  await owner.evaluate(() => localStorage.removeItem('slicc-os.tray-hub'));
});
