import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const coneShell = ['slicc:/home$ ', 'slicc:~$ '];

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    try {
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return '';
    }
  }, path);
}

async function bootAs(page, mode) {
  await page.goto(`/#users=${mode}`);
  await ready(page);
  await page.evaluate(() => localStorage.setItem('slicc-os.terminal-user', 'cone'));
  await page.reload();
  await ready(page, coneShell);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.users), mode);
}

const pending = () => document.querySelector('slicc-app').model.approvals.list();

async function decide(page, decision) {
  const [approval] = await page.until(() => {
    const list = document.querySelector('slicc-app').model.approvals.list();
    return list.length ? list : null;
  });
  await page.until(
    (id, decision) => {
      const find = (root) => {
        const found = root.querySelector('slicc-approvals');
        if (found) return found;
        for (const element of root.querySelectorAll('*')) {
          const inner = element.shadowRoot && find(element.shadowRoot);
          if (inner) return inner;
        }
        return null;
      };
      const list = document.querySelector('slicc-app').model.approvals.list();
      if (!list.some((item) => item.id === id)) return true;
      find(document)
        ?.shadowRoot?.querySelector(`dialog[data-approval="${id}"] [data-action="${decision}"]`)
        ?.click();
      return false;
    },
    approval.id,
    decision
  );
  return approval;
}

async function denials(page) {
  return (await read(page, 'var/log/slicc/denials.log'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const shade = (page, value) =>
  page.evaluate((value) => {
    const app = document.querySelector('slicc-app');
    if (app.color !== value) app.toggleColor();
  }, value);

test('enforce: a cone writes its home, is refused in root’s, and sudo asks first', async (t) => {
  const page = await chrome.page(t);
  await bootAs(page, 'enforce');
  await run(
    page,
    'clear; whoami; touch ~/mine; echo home=$?; touch /root/theirs; echo root=$?; echo done-$((40 + 2))'
  );
  await shows(page, 'done-42');
  const text = await screen(page);
  assert.match(text, /^cone\s/);
  assert.match(text, /home=0/);
  assert.match(text, /root=1/);
  assert.match(text, /Permission denied/);

  await run(page, 'sudo true; echo allowed=$?');
  const asked = await decide(page, 'once');
  await shows(page, 'allowed=0');
  assert.equal(asked.kind, 'sudo');
  assert.equal(asked.command, '/usr/bin/true');
  assert.equal(asked.requester.name, 'cone');
  assert.equal(asked.requester.kind, 'user');
  assert.equal(asked.requester.where, 'a terminal');
  assert.equal(asked.target, 'root');
  assert.equal(asked.always, true);
  assert.deepEqual(await page.evaluate(pending), []);

  await run(page, 'sudo ls -la /root; echo denied=$?');
  await page.until(() => document.querySelector('slicc-app').model.approvals.list().length > 0);
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await shade(page, 'light');
  await page.screenshot(new URL('approval-light.png', page.dir));
  await shade(page, 'dark');
  await page.screenshot(new URL('approval-dark.png', page.dir));
  await shade(page, 'light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.screenshot(new URL('approval-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  const listed = await decide(page, 'deny');
  assert.equal(listed.command, '/usr/bin/ls -la /root');
  await shows(page, 'denied=1');

  await page.until(async () => {
    let dir = await navigator.storage.getDirectory();
    try {
      for (const part of ['var', 'log', 'slicc']) dir = await dir.getDirectoryHandle(part);
      const text = await (await (await dir.getFileHandle('denials.log')).getFile()).text();
      return text.includes('/root/theirs');
    } catch {
      return false;
    }
  });
  const lines = await denials(page);
  const refused = lines.find((line) => line.path === '/root/theirs');
  assert.ok(refused, JSON.stringify(lines));
  assert.ok(refused.count >= 1);
  assert.equal(refused.user, 'cone');
  assert.equal(refused.errno, 'EACCES');
  assert.equal(refused.mode, 'enforce');
  assert.match(refused.time, /^\d{4}-\d\d-\d\dT/);
  assert.ok('tag' in refused && 'op' in refused);
  assert.deepEqual(page.errors, []);
});

test('report: the same refusal is logged but allowed', async (t) => {
  const page = await chrome.page(t);
  await bootAs(page, 'report');
  await run(page, 'clear; whoami; touch /root/theirs; echo root=$?; echo done-$((40 + 2))');
  await shows(page, 'done-42');
  assert.match(await screen(page), /root=0/);
  const lines = await page.until(async () => {
    const text = await (async () => {
      let dir = await navigator.storage.getDirectory();
      try {
        for (const part of ['var', 'log', 'slicc']) dir = await dir.getDirectoryHandle(part);
        return await (await (await dir.getFileHandle('denials.log')).getFile()).text();
      } catch {
        return '';
      }
    })();
    const found = text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((line) => line.user === 'cone');
    return found.length ? found : null;
  });
  assert.ok(lines.every((line) => line.mode === 'report'));
  assert.ok(lines.some((line) => line.path.startsWith('/root')));
  assert.deepEqual(page.errors, []);
});

test('enforce: a cone’s terminal starts in its home, and its Python finds what /opt/slicc/python lists', async (t) => {
  const page = await chrome.page(t);
  await bootAs(page, 'enforce');
  await run(page, 'clear; pwd; echo hi > f && echo wrote=$?; echo home-$((40 + 2))');
  await shows(page, 'home-42');
  assert.match(await screen(page), /^\/home\/cone\s/);
  assert.match(await screen(page), /wrote=0/);
  await page.evaluate(() => {
    window.installed = document
      .querySelector('slicc-app')
      .model.updates.actPackage('python', 'install')
      .then(
        () => 'ok',
        (error) => error.message
      );
    window.installed.then((result) => {
      window.result = result;
    });
  });
  const installed = await page.within(10 * 60 * 1000, () => window.result);
  assert.equal(installed, 'ok');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const put = async (path, data) => {
      const names = path.split('/');
      const name = names.pop();
      let dir = root;
      for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(data);
      await writable.close();
    };
    await put('opt/slicc/probe/sliccprobe.py', 'ok = 42\n');
    await put('opt/slicc/python/slicc-probe.pth', '/opt/slicc/probe\n');
    await put(
      'opt/slicc/python/sitecustomize.py',
      "import site\n\nsite.addsitedir('/opt/slicc/python')\n"
    );
  });
  await run(page, 'clear; whoami; python3 -c "import sliccprobe; print(\'probe\', sliccprobe.ok)"');
  await page.within(10 * 60 * 1000, () =>
    document
      .querySelector('slicc-app')
      .dock.content(
        document
          .querySelector('slicc-app')
          .dock.api.panels.map((panel) => panel.id)
          .findLast((id) => id.startsWith('terminal:'))
      )
      .screen.textContent.includes('probe 42')
  );
  assert.match(await screen(page), /^cone\s/);

  await run(
    page,
    `clear; bash -lc 'python3 -c "import sliccprobe; print(\\"login\\", sliccprobe.ok)"'`
  );
  await shows(page, 'login 42', 5 * 60 * 1000);
  await run(page, `clear; sudo python3 -c "import sliccprobe; print('sudo', sliccprobe.ok)"`);
  await decide(page, 'once');
  await shows(page, 'sudo 42', 5 * 60 * 1000);
  assert.deepEqual(page.errors, []);
});

test('enforce: seven’s code paths are read-only to root and cones, and installs still write them', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/#users=enforce');
  await ready(page, ['slicc:/home# ']);
  await page.within(5 * 60 * 1000, async () => {
    let dir = await navigator.storage.getDirectory();
    try {
      for (const part of ['var', 'lib', 'slicc', 'agent']) dir = await dir.getDirectoryHandle(part);
      await dir.getFileHandle('pnpm-lock.yaml');
      return true;
    } catch {
      return false;
    }
  });
  const agentRow = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'agent')
  );
  assert.notEqual(agentRow.state, 'failed', agentRow.error);
  assert.ok(await read(page, 'opt/agent/node_modules/.modules.yaml'));

  await run(
    page,
    'clear; touch /opt/agent/x; echo agent=$?; touch /os/x; echo os=$?; mkdir -p /mnt/free; mount -t fsa none /opt; echo opt=$?; echo root-$((40 + 2))'
  );
  await shows(page, 'root-42');
  let text = await screen(page);
  assert.match(text, /Read-only file system/);
  assert.match(text, /agent=1/);
  assert.match(text, /os=1/);
  assert.match(text, /opt=[1-9]/);

  await page.evaluate(() => {
    localStorage.setItem('slicc-os.terminal-user', 'cone');
    localStorage.setItem(
      'slicc-os.mounts',
      JSON.stringify([
        { type: 'hostfs', source: 'one', target: '/opt' },
        { type: 'hostfs', source: 'two', target: '/opt/agent/deep' },
        { type: 'hostfs', source: 'three', target: '/mnt/kept' },
      ])
    );
  });
  await page.reload();
  await ready(page, coneShell);
  await run(page, 'clear; touch /opt/agent/x; echo cone=$?; echo cone-$((40 + 2))');
  await shows(page, 'cone-42');
  text = await screen(page);
  assert.match(text, /Permission denied|Read-only file system/);
  assert.match(text, /cone=1/);
  const kept = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('slicc-os.mounts')).map(({ target }) => target)
  );
  assert.deepEqual(kept, ['/mnt/kept']);
  const notice = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .find(({ id }) => id.startsWith('mounts-protected:'))
  );
  assert.equal(notice.title, 'A remembered folder wasn’t mounted');
  assert.match(notice.body, /\/opt, \/opt\/agent\/deep/);
});

test('enforce: the base set installs from /opt/slicc/base, whatever a root process puts at /', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/#users=enforce');
  await ready(page, ['slicc:/home# ']);
  assert.match(await read(page, 'opt/slicc/base/pnpm-lock.yaml'), /lockfileVersion/);
  assert.ok(await read(page, 'opt/slicc/base/pnpm-workspace.yaml'));
  assert.equal(await read(page, 'package.json'), '');
  assert.equal(await read(page, 'pnpm-lock.yaml'), '');
  const bash = async () =>
    JSON.parse(await read(page, 'node_modules/@ai-ecoverse/wasm-bash/package.json')).version;
  const before = await bash();
  await run(
    page,
    'clear; echo \'lockfileVersion: 9.0\\nimporters:\\n  .:\\n    dependencies:\\n      evil: {specifier: 1.0.0, version: 1.0.0}\' > /pnpm-lock.yaml; echo \'{"dependencies":{"evil":"1.0.0"}}\' > /package.json; echo \'registry=https://evil.invalid/\' > /.npmrc; printf \'overrides:\\n  "@ai-ecoverse/wasm-bash": "0.0.1"\\n\' > /pnpm-workspace.yaml; touch /opt/slicc/base/pnpm-lock.yaml; echo base=$?; rm /var/lib/slicc/pnpm-lock.yaml; echo planted-$((40 + 2))'
  );
  await shows(page, 'planted-42');
  assert.match(await screen(page), /base=1/);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.within(5 * 60 * 1000, async () => {
    let dir = await navigator.storage.getDirectory();
    try {
      for (const part of ['var', 'lib', 'slicc']) dir = await dir.getDirectoryHandle(part);
      await dir.getFileHandle('pnpm-lock.yaml');
      return true;
    } catch {
      return false;
    }
  });
  const bios = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'bios')
  );
  assert.notEqual(bios.state, 'failed', bios.error);
  assert.equal(await bash(), before);
  assert.equal(await read(page, 'node_modules/evil/package.json'), '');
  for (const name of ['package.json', 'pnpm-lock.yaml', '.npmrc', 'pnpm-workspace.yaml']) {
    assert.equal(await read(page, name), '', name);
  }
});
