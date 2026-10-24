import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { ready, rowSettled, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const KERNEL = 'node_modules/@ai-ecoverse/slicc-kernel';
const OLD = {
  version: '1.67.1',
  resolved: 'https://registry.npmjs.org/@ai-ecoverse/slicc-kernel/-/slicc-kernel-1.67.1.tgz',
  integrity:
    'sha512-Z7ylHfrgkjf1pR7GSMLeg00QuohB8RBASTQYX9c5mhIprFuKRn473l+1epiwO+rLUMI7ON/gq2kQiSDaTPrrgQ==',
};

const chrome = await launch({ timeout: 120000, agent: true });
after(() => chrome.close());

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

const BINS = 5 * 60 * 1000;
const FIXTURE = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

function olderLock(shipped) {
  const lock = structuredClone(shipped);
  lock.packages[KERNEL] = { ...lock.packages[KERNEL], ...OLD };
  return lock;
}

const agentRow = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'agent')
  );

async function said(page, command, mark) {
  await run(page, `printf '\\033[H\\033[2J\\033[3J'; ${command}; echo ${mark}-$((40 + 2))`);
  await shows(page, `${mark}-42`, BINS);
  return (await screen(page)).replace(/\s+/g, ' ');
}

test('a profile whose /opt/agent was installed on kernel 1.67.1 keeps its bin scripts runnable under enforce on a /meta kernel', async (t) => {
  const shipped = JSON.parse(
    readFileSync(new URL('../../src/packages/package-lock.json', import.meta.url), 'utf8')
  );
  const page = await chrome.page(t);
  for (const name of FIXTURE)
    chrome.overrides.set(
      `/packages/agent/${name}`,
      readFileSync(new URL(`fixtures/agent-bins/${name}`, import.meta.url), 'utf8')
    );
  chrome.overrides.set('/packages/package-lock.json', JSON.stringify(olderLock(shipped)));
  await page.goto('/#users=off');
  await ready(page, ['slicc:/home# ']);
  await rowSettled(page, 'agent', BINS);
  const installed = await agentRow(page);
  assert.equal(installed.state, 'installed', installed.log);
  assert.match(installed.log, /\+ n 10\.2\.0/);
  const old = await said(
    page,
    'chmod 644 /opt/agent/node_modules/semver/bin/semver.js; stat -L -c \'old %a %n\' /opt/agent/node_modules/.bin/n /opt/agent/node_modules/.bin/semver; k=$(< /node_modules/@ai-ecoverse/slicc-kernel/package.json); [[ $k =~ \\"version\\":\\ *\\"([^\\"]+)\\" ]] && echo "kernel ${BASH_REMATCH[1]} "; md5sum /opt/agent/node_modules/.modules.yaml',
    'old'
  );
  assert.match(old, /kernel 1\.67\.1 /);
  assert.match(old, /old 755 \/opt\/agent\/node_modules\/\.bin\/n /);
  assert.match(old, /old 644 \/opt\/agent\/node_modules\/\.bin\/semver /);
  const [modules] = old.match(/[0-9a-f]{32}(?=\s+\/opt\/agent\/node_modules\/\.modules\.yaml)/);

  chrome.overrides.set('/packages/package-lock.json', JSON.stringify(shipped));
  chrome.cdn.requests.length = 0;
  await page.goto('/#users=enforce');
  await ready(page, ['slicc:/home# ']);
  const kernel = JSON.parse(await read(page, `${KERNEL}/package.json`));
  if (!kernel.exports?.['./meta']) {
    t.skip(`slicc-kernel ${kernel.version} has no /meta`);
    return;
  }
  const fetched = chrome.cdn.requests.filter((url) => url.endsWith('.tgz'));
  t.diagnostic(`the repair fetched ${fetched.length} tarballs: ${fetched.join(' ')}`);
  await rowSettled(page, 'agent', BINS);
  assert.equal((await agentRow(page)).state, 'current');
  const now = await said(
    page,
    'for b in /opt/agent/node_modules/.bin/*; do [ -x "$b" ] || echo "noexec $b"; done; stat -L -c \'now %a %n\' /opt/agent/node_modules/.bin/n /opt/agent/node_modules/.bin/semver; sudo -u cone bash -c "/opt/agent/node_modules/.bin/n --version"; echo n=$?; sudo -u cone bash -c "/opt/agent/node_modules/.bin/semver 1.2.3"; echo semver=$?; i --help > /dev/null 2>&1; echo i=$?; md5sum /opt/agent/node_modules/.modules.yaml',
    'bins'
  );
  t.diagnostic(now.slice(0, 600));
  assert.ok(now.includes(`${modules} `), 'the current kernel ran no pnpm in /opt/agent');
  assert.match(now, /now 755 \/opt\/agent\/node_modules\/\.bin\/n /);
  assert.match(now, /10\.2\.0 n=0/);
  assert.doesNotMatch(now, /noexec \/opt\/agent\/node_modules\/\.bin\/n /);
  assert.match(now, /now 644 \/opt\/agent\/node_modules\/\.bin\/semver /);
  assert.match(now, /noexec \/opt\/agent\/node_modules\/\.bin\/semver /);
  assert.match(now, /semver=126/);
  assert.match(now, /i=0/);
  assert.deepEqual(page.errors, []);
});
