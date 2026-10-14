import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const rootShell = ['slicc:/home# '];

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

async function bootIn(page, mode) {
  await page.goto(`/#users=${mode}`);
  await ready(page, rootShell);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.users), mode);
}

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

async function logged(page, path) {
  await page.until(async (path) => {
    let dir = await navigator.storage.getDirectory();
    try {
      for (const part of ['var', 'log', 'slicc']) dir = await dir.getDirectoryHandle(part);
      const text = await (await (await dir.getFileHandle('denials.log')).getFile()).text();
      return text.includes(`"path":"${path}"`);
    } catch {
      return false;
    }
  }, path);
  return (await read(page, 'var/log/slicc/denials.log'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((line) => line.path === path);
}

const shade = (page, value) =>
  page.evaluate((value) => {
    const app = document.querySelector('slicc-app');
    if (app.color !== value) app.toggleColor();
  }, value);

async function shoot(page, name) {
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await shade(page, 'light');
  await page.screenshot(new URL(`${name}-light.png`, page.dir));
  await shade(page, 'dark');
  await page.screenshot(new URL(`${name}-dark.png`, page.dir));
  await shade(page, 'light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.screenshot(new URL(`${name}-420.png`, page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
}

test('seven runs kernel users report by default, and the human’s terminal is root', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page, rootShell);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.users), 'report');
  await run(
    page,
    'clear; whoami; id -nG cone; printf "echo ran-\\$((40 + 2))\\n" > /tmp/nox; chmod 644 /tmp/nox; /tmp/nox'
  );
  await shows(page, 'ran-42');
  const text = await screen(page);
  assert.match(text, /^root\s/);
  assert.match(text, /\bsudo\b/);
  const [line] = await logged(page, '/tmp/nox');
  assert.equal(line.user, 'root');
  assert.equal(line.mode, 'report');
  assert.equal(JSON.parse(line.tag).kind, 'user');
  assert.match(JSON.parse(line.tag).where, /^terminal:/);

  await run(page, 'clear; slicc-denials; slicc-denials --json > /tmp/sum.json; echo summed-$?');
  await shows(page, 'summed-0');
  assert.match(await screen(page), /denials: \d+/);
  assert.match(await screen(page), /by kind:\s+\d+\s+user/);
  const summary = JSON.parse(await read(page, 'tmp/sum.json'));
  assert.ok(summary.total >= 1);
  assert.ok(summary.paths.some(({ key }) => key === '/tmp/nox'));
  assert.deepEqual(page.errors, []);
});

test('enforce: a cone writes its home, is refused in root’s, and sudo asks with once, always and deny', async (t) => {
  const page = await chrome.page(t);
  await bootIn(page, 'enforce');
  await run(
    page,
    "clear; sudo -u cone bash -c 'cd && touch mine; echo home=$?; touch /root/theirs; echo root=$?'; echo done-$((40 + 2))"
  );
  await shows(page, 'done-42');
  const text = await screen(page);
  assert.match(text, /home=0/);
  assert.match(text, /root=1/);
  assert.match(text, /Permission denied/);
  const [refused] = await logged(page, '/root/theirs');
  assert.equal(refused.user, 'cone');
  assert.equal(refused.errno, 'EACCES');
  assert.equal(refused.mode, 'enforce');
  assert.match(JSON.parse(refused.tag).where, /^terminal:/);

  await run(page, 'clear; cd /tmp; sudo -u cone sudo true; echo allowed=$?');
  const once = await decide(page, 'once');
  await shows(page, 'allowed=0');
  assert.equal(once.kind, 'sudo');
  assert.equal(once.command, '/usr/bin/true');
  assert.deepEqual(once.requester, { kind: 'user', name: 'cone', where: 'a terminal' });
  assert.equal(once.target, 'root');
  assert.equal(once.cwd, '/tmp');
  assert.equal(once.always, true);

  await run(page, 'clear; sudo -u cone sudo ls -la /root; echo denied=$?');
  await page.until(() => document.querySelector('slicc-app').model.approvals.list().length > 0);
  await shoot(page, 'approval');
  const listed = await decide(page, 'deny');
  assert.equal(listed.command, '/usr/bin/ls -la /root');
  await shows(page, 'denied=1');

  await run(page, 'clear; sudo -u cone sudo id -un; echo always=$?');
  await decide(page, 'always');
  await shows(page, 'always=0');
  await run(page, 'clear; sudo -u cone sudo id -un; echo again=$?');
  await shows(page, 'again=0');
  assert.deepEqual(
    await page.evaluate(() => document.querySelector('slicc-app').model.approvals.list()),
    []
  );

  await run(page, 'clear; echo x > /tmp/k4x; sudo -u cone sudo cat /tmp/k4x; echo tmp=$?');
  const [shown] = await page.until(() => {
    const list = document.querySelector('slicc-app').model.approvals.list();
    return list.length ? list : null;
  });
  assert.equal(shown.always, false);
  await page.evaluate(
    (id) => document.querySelector('slicc-app').model.approvals.decide(id, 'always'),
    shown.id
  );
  await shows(page, 'tmp=0');
  await page.until(() => {
    const find = (root) => {
      const found = root.querySelector('slicc-approvals');
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && find(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const dialog = find(document)?.shadowRoot?.querySelector('dialog');
    if (!dialog) return true;
    dialog.querySelector('[data-action="close"]')?.click();
    return false;
  });
  await run(page, 'clear; sudo -u cone sudo cat /tmp/k4x; echo tmp2=$?');
  await decide(page, 'deny');
  await shows(page, 'tmp2=1');
  assert.doesNotMatch(await read(page, 'etc/sudoers.d/cone'), /k4x/);
  assert.deepEqual(page.errors, []);
});

test('enforce: a cone’s Python finds what /opt/slicc/python lists, in a login shell and through sudo', async (t) => {
  const page = await chrome.page(t);
  await bootIn(page, 'enforce');
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
  assert.equal(await page.within(10 * 60 * 1000, () => window.result), 'ok');
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
  await run(
    page,
    `clear; sudo -u cone python3 -c "import sliccprobe; print('cone', sliccprobe.ok)"`
  );
  await shows(page, 'cone 42', 5 * 60 * 1000);
  await run(
    page,
    `clear; sudo -u cone bash -lc 'python3 -c "import sliccprobe; print(\\"login\\", sliccprobe.ok)"'`
  );
  await shows(page, 'login 42', 5 * 60 * 1000);
  await run(
    page,
    `clear; sudo -u cone sudo python3 -c "import sliccprobe; print('sudo', sliccprobe.ok)"`
  );
  await decide(page, 'once');
  await shows(page, 'sudo 42', 5 * 60 * 1000);
  assert.deepEqual(page.errors, []);
});

test('seven’s code paths are read-only to root and cones, installs still write them, and remembered mounts on them are dropped', async (t) => {
  const page = await chrome.page(t);
  await bootIn(page, 'enforce');
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
    'clear; touch /opt/agent/x; echo agent=$?; touch /os/x; echo os=$?; mount -t fsa none /opt; echo opt=$?; sudo -u cone touch /opt/agent/x; echo cone=$?; echo root-$((40 + 2))'
  );
  await shows(page, 'root-42');
  const text = await screen(page);
  assert.match(text, /Read-only file system/);
  assert.match(text, /agent=1/);
  assert.match(text, /os=1/);
  assert.match(text, /opt=[1-9]/);
  assert.match(text, /cone=1/);

  await page.evaluate(() => {
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
  await ready(page, rootShell);
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
  assert.equal(notice.title, 'Some remembered folders weren’t mounted');
  assert.equal(
    notice.body,
    'Seven keeps its own code in /opt, so it no longer mounts folders there. Not mounted: /opt, /opt/agent/deep. Mount them somewhere else, such as /mnt.'
  );
  await shoot(page, 'mount-notice');
});

test('report: a write to a protected tree goes through and is logged as a would-be protect hit', async (t) => {
  const page = await chrome.page(t);
  await bootIn(page, 'report');
  await run(page, 'clear; touch /opt/agent/x; echo agent=$?; echo wrote-$((40 + 2))');
  await shows(page, 'wrote-42');
  assert.match(await screen(page), /agent=0/);
  const [hit] = await logged(page, '/opt/agent/x');
  assert.equal(hit.op, 'protect');
  assert.equal(hit.errno, 'EROFS');
  assert.equal(hit.mode, 'report');
  await run(page, 'clear; slicc-denials | grep -A3 "by op:"; echo summed-$?');
  await shows(page, 'summed-0');
  assert.match(await screen(page), /by op:\s+\d+\s+\w+/);
  assert.match(await screen(page), /\d+\s+protect/);
  assert.deepEqual(page.errors, []);
});

test('enforce: the base set installs from /opt/slicc/base, whatever a root process puts at /', async (t) => {
  const page = await chrome.page(t);
  await bootIn(page, 'enforce');
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

test('an install from before users boots with them, its legacy files locked once, root still reading them', async (t) => {
  const page = await chrome.page(t);
  await bootIn(page, 'off');
  await run(
    page,
    "clear; mkdir -p /home/.pi/agent /scoops/old /home/sprinkles; echo '{\"servers\":{}}' > /home/.pi/agent/mcp.json; echo work > /scoops/old/notes.md; echo '<title>x</title>' > /home/sprinkles/x.shtml; echo mine > /home/notes.txt; chmod 644 /home/.pi/agent/mcp.json /scoops/old/notes.md; echo populated-$((40 + 2))"
  );
  await shows(page, 'populated-42');
  await page.goto('/#users=enforce');
  await ready(page, rootShell);
  const marker = await read(page, 'var/lib/slicc/legacy-locked');
  assert.match(marker, /^\d{4}-\d\d-\d\dT/);
  await run(
    page,
    "clear; sudo -u cone cat /home/.pi/agent/mcp.json; echo mcp=$?; sudo -u cone cat /scoops/old/notes.md; echo scoops=$?; cat /home/.pi/agent/mcp.json /scoops/old/notes.md /home/notes.txt; stat -c '%a %U' /home/.pi/agent/mcp.json /home/notes.txt; echo checked-$((40 + 2))"
  );
  await shows(page, 'checked-42');
  let text = await screen(page);
  assert.match(text, /mcp=1/);
  assert.match(text, /scoops=1/);
  assert.match(text, /Permission denied/);
  assert.match(text, /\{"servers":\{\}\}/);
  assert.match(text, /\swork\s/);
  assert.match(text, /\smine\s/);
  assert.match(text, /600 root/);
  assert.match(text, /644 root/);
  await page.reload();
  await ready(page, rootShell);
  assert.equal(await read(page, 'var/lib/slicc/legacy-locked'), marker);
  await run(page, 'clear; chmod 644 /home/.pi/agent/mcp.json; echo reopened-$((40 + 2))');
  await shows(page, 'reopened-42');
  await page.reload();
  await ready(page, rootShell);
  await run(page, "clear; stat -c '%a' /home/.pi/agent/mcp.json; echo again-$((40 + 2))");
  await shows(page, 'again-42');
  text = await screen(page);
  assert.match(text, /\b644\s/);
  assert.deepEqual(page.errors, []);
});
