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

  const lines = await denials(page);
  const refused = lines.find((line) => line.path === '/root/theirs' || line.path === '/root');
  assert.ok(refused, JSON.stringify(lines));
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
