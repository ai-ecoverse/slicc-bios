import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const XXD = '@ai-ecoverse/wasm-xxd';
const DIG = '@ai-ecoverse/wasi-dig';
const integrity = {
  [`${XXD}@9.2.1192-1`]:
    'sha512-3yU7xVU/fCrryy91GOJDcYOrvToeYATUQ26XQfSL30URhohHUOAwUrlWCESNsPYhKU3FGIginKfWqSQpkOS54A==',
  [`${XXD}@9.2.1192-2`]:
    'sha512-LXSqT8z9jLCjvOKDsVQMZ5q42vhQcY1wwOwlw6cDcgzwAkx7d4oW13St8EJ2IHX5x4KRYJMu6co2BLTPC0rrBw==',
  [`${DIG}@0.1.0-4`]:
    'sha512-zWKTPKPoJ27Jndc1gpHSGmGovisg8mXD6hkPYm14ccVlqtVpNTDdGgdY+5QAqzqYdTzyiVAbkhqFMDo75vxVOg==',
};
const ROOT_SHELL = ['slicc:/home# '];
const WAIT = 5 * 60 * 1000;
const CONE_PNPM = '/home/cone/.local/share/pnpm';
const SYSTEM_PNPM = '/usr/local/share/pnpm';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

function offer(xxd) {
  const pins = { [XXD]: xxd, [DIG]: '0.1.0-4' };
  chrome.overrides.set(
    '/packages/optional/catalog.json',
    JSON.stringify({
      [XXD]: {
        id: 'xxd',
        label: 'xxd',
        description: 'Hex dumps of any file.',
        commands: ['xxd'],
        requires: ['dig'],
        size: 30000,
      },
      [DIG]: {
        id: 'dig',
        label: 'dig',
        description: 'Looks up DNS records.',
        commands: ['dig'],
        size: 214326,
      },
    })
  );
  chrome.overrides.set(
    '/packages/optional/package.json',
    JSON.stringify({ name: 'slicc-bios-optional', private: true, dependencies: pins })
  );
  const packages = Object.fromEntries(
    Object.entries(pins).map(([name, version]) => [
      `node_modules/${name}`,
      { version, integrity: integrity[`${name}@${version}`] },
    ])
  );
  chrome.overrides.set(
    '/packages/optional/package-lock.json',
    JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: pins }, ...packages } })
  );
}

async function sh(page, line, user = 'root') {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  return page.evaluate(
    async ([line, user]) => {
      globalThis.installsClient ??= await globalThis.sliccKernelClient();
      const options = user === 'root' ? { cwd: '/' } : { cwd: `/home/${user}`, user };
      const { status, stdout, stderr } = await globalThis.installsClient.run(
        ['bash', '-c', line],
        options
      );
      return `${stdout ?? ''}${stderr ?? ''}status=${status}`;
    },
    [line, user]
  );
}

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id) ?? null,
    id
  );

async function until(page, id, check) {
  const deadline = Date.now() + WAIT;
  for (;;) {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const found = await row(page, id);
    if (found && check(found)) return found;
    if (Date.now() > deadline) throw new Error(`${id} never matched: ${JSON.stringify(found)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const shape = ({ installs }) =>
  installs.map(({ manager, user, version, where }) => [manager, user ?? null, version, where]);

const systemCopy = (name) =>
  `ls -d ${SYSTEM_PNPM}/global/v11/*/node_modules/${name} 2>/dev/null | wc -l | sed 's/^ */system=/'`;

test('cone’s own pnpm add -g shows as installed for cone, satisfies a requirement, and updates as cone without a system copy', {
  timeout: 45 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  offer('9.2.1192-1');
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto('/#users=enforce');
  await ready(page, ROOT_SHELL);

  const added = await sh(page, `pnpm add -g ${DIG}@0.1.0-2 >/dev/null 2>&1; echo add=$?`, 'cone');
  assert.match(added, /add=0/, added);
  const dig = await until(page, 'dig', ({ version }) => version === '0.1.0-2');
  assert.equal(dig.state, 'outdated');
  assert.deepEqual(dig.actions, ['update']);
  assert.deepEqual(shape(dig), [['pnpm', 'cone', '0.1.0-2', CONE_PNPM]]);

  assert.equal(
    await actPackage(page, 'xxd', 'install'),
    'ok',
    JSON.stringify(await row(page, 'xxd'))
  );
  const xxd = await row(page, 'xxd');
  assert.equal(xxd.warnings, undefined, JSON.stringify(xxd));
  assert.deepEqual(shape(xxd), [['panel', null, '9.2.1192-1', SYSTEM_PNPM]]);
  assert.match(await sh(page, systemCopy(DIG)), /system=0/);

  assert.equal(
    await actPackage(page, 'dig', 'update'),
    'ok',
    JSON.stringify(await row(page, 'dig'))
  );
  const updated = await row(page, 'dig');
  assert.equal(updated.state, 'installed', JSON.stringify(updated));
  assert.deepEqual(updated.actions, []);
  assert.deepEqual(shape(updated), [['pnpm', 'cone', '0.1.0-4', CONE_PNPM]]);
  const files = await sh(
    page,
    `${systemCopy(DIG)}; find ${CONE_PNPM}/global/v11 -path '*/${DIG}/package.json' -exec stat -L -c 'owner %U' {} + | sort -u; grep -h '"version"' ${CONE_PNPM}/global/v11/*/node_modules/${DIG}/package.json`
  );
  assert.match(files, /system=0/, files);
  assert.match(files, /^owner cone$/m, files);
  assert.doesNotMatch(files, /^owner root$/m, files);
  assert.match(files, /"version": "0\.1\.0-4"/, files);
  const runs = await sh(page, 'dig -v >/dev/null 2>&1; echo ran=$?', 'cone');
  assert.match(runs, /ran=(?!127\b)\d+/, runs);
  assert.deepEqual(page.errors, []);
});

test('the panel installs, updates and removes only its own copy while cone has the same package, and the row then reads installed for cone with no Install', {
  timeout: 45 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  offer('9.2.1192-1');
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto('/#users=enforce');
  await ready(page, ROOT_SHELL);

  const added = await sh(
    page,
    `pnpm add -g ${XXD}@9.2.1192-2 ${DIG}@0.1.0-4 >/dev/null 2>&1; echo add=$?`,
    'cone'
  );
  assert.match(added, /add=0/, added);
  const theirs = await until(page, 'xxd', ({ version }) => version === '9.2.1192-2');
  assert.equal(theirs.state, 'installed');
  assert.deepEqual(theirs.actions, []);

  assert.equal(
    await actPackage(page, 'xxd', 'install'),
    'ok',
    JSON.stringify(await row(page, 'xxd'))
  );
  const both = await row(page, 'xxd');
  assert.deepEqual(shape(both), [
    ['panel', null, '9.2.1192-1', SYSTEM_PNPM],
    ['pnpm', 'cone', '9.2.1192-2', CONE_PNPM],
  ]);
  assert.equal(both.version, '9.2.1192-1');
  assert.deepEqual(both.actions, ['remove']);
  assert.match(await sh(page, systemCopy(XXD)), /system=[1-9]/);

  offer('9.2.1192-2');
  await page.reload();
  await ready(page, ROOT_SHELL);
  const outdated = await until(page, 'xxd', ({ state }) => state === 'outdated');
  assert.deepEqual(outdated.actions, ['update', 'remove']);
  assert.equal(
    await actPackage(page, 'xxd', 'update'),
    'ok',
    JSON.stringify(await row(page, 'xxd'))
  );
  assert.deepEqual(shape(await row(page, 'xxd')), [
    ['panel', null, '9.2.1192-2', SYSTEM_PNPM],
    ['pnpm', 'cone', '9.2.1192-2', CONE_PNPM],
  ]);
  const owners = await sh(
    page,
    `stat -L -c 'system %U' ${SYSTEM_PNPM}/global/v11/*/node_modules/${XXD}/package.json; stat -L -c 'cone %U' ${CONE_PNPM}/global/v11/*/node_modules/${XXD}/package.json`
  );
  assert.match(owners, /^system root$/m, owners);
  assert.match(owners, /^cone cone$/m, owners);

  assert.equal(
    await actPackage(page, 'xxd', 'remove'),
    'ok',
    JSON.stringify(await row(page, 'xxd'))
  );
  const left = await row(page, 'xxd');
  assert.deepEqual(shape(left), [['pnpm', 'cone', '9.2.1192-2', CONE_PNPM]]);
  assert.equal(left.state, 'installed');
  assert.deepEqual(left.actions, []);
  assert.match(await sh(page, systemCopy(XXD)), /system=0/);
  const still = await sh(page, 'echo hi | xxd; echo ran=$?', 'cone');
  assert.match(still, /00000000: 6869 0a/, still);
  assert.deepEqual(page.errors, []);
});
