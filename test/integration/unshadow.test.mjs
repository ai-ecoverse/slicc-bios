import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const MCPCAT = '@ai-ecoverse/mcpcat';
const SEMVER = 'semver';
const pins = { [MCPCAT]: '0.16.3', [SEMVER]: '7.7.3' };
const integrity = {
  [MCPCAT]:
    'sha512-Sah/qC/1x31WKsVK+tyHYSdV8StFLpZEmuNyWqu2inbK19IL7ZyZyOb+85CGVAG1+ZRdXfE1y0eUAQuu0jnm3w==',
  [SEMVER]:
    'sha512-SdsKMrI9TdgjdweUSR9MweHA4EJ8YxHn8DFaDisvhVlUOe4BF1tLD7GAj0lIqWVl+dPb/rExr0Btby5loQm20Q==',
};
const BIN = '/usr/local/share/pnpm/bin';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

function offer() {
  const catalog = {
    [MCPCAT]: {
      id: 'mcpcat',
      label: 'mcpcat',
      description: 'An MCP client.',
      commands: ['mcpcat'],
      size: 589050,
    },
    [SEMVER]: {
      id: 'semver',
      label: 'semver',
      description: 'A package with only a Node bin.',
      commands: ['semver'],
      size: 28442,
    },
  };
  chrome.overrides.set('/packages/optional/catalog.json', JSON.stringify(catalog));
  chrome.overrides.set(
    '/packages/optional/package.json',
    JSON.stringify({ name: 'slicc-bios-optional', private: true, dependencies: pins })
  );
  chrome.overrides.set(
    '/packages/optional/package-lock.json',
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: pins },
        ...Object.fromEntries(
          Object.entries(pins).map(([name, version]) => [
            `node_modules/${name}`,
            { version, integrity: integrity[name] },
          ])
        ),
      },
    })
  );
}

async function sh(page, command) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  return page.evaluate(async (command) => {
    globalThis.unshadowClient ??= await globalThis.sliccKernelClient();
    return globalThis.unshadowClient.run(['bash', '-c', command], { cwd: '/' }).then(
      ({ status, stdout, stderr }) => ({
        code: String(status),
        out: `${stdout ?? ''}${stderr ?? ''}`.trim(),
      }),
      (error) => ({ code: 'error', out: error.message })
    );
  }, command);
}

async function install(page, id) {
  await page.until(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === id && item.state === 'available'),
    id
  );
  assert.equal(await actPackage(page, id, 'install'), 'ok', id);
}

test('a catalog package’s kernel command wins over the same package’s Node bin, and a package with only a bin keeps it', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  t.after(() => {
    for (const path of ['catalog.json', 'package.json', 'package-lock.json'])
      chrome.overrides.delete(`/packages/optional/${path}`);
  });
  offer();
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);

  await install(page, 'mcpcat');
  const found = await sh(page, 'command -v mcpcat');
  assert.deepEqual(found, { code: '0', out: '/usr/bin/mcpcat' });
  const version = await sh(page, 'mcpcat --version');
  assert.equal(version.code, '0', version.out);
  assert.match(version.out, /0\.16\.3/);
  const gone = await sh(page, `test -e ${BIN}/mcpcat || test -L ${BIN}/mcpcat; echo $?`);
  assert.equal(gone.out, '1');

  await install(page, 'semver');
  const kept = await sh(page, `test -e ${BIN}/semver || test -L ${BIN}/semver; echo $?`);
  assert.equal(kept.out, '0');
  assert.deepEqual(await sh(page, 'command -v semver'), { code: '0', out: `${BIN}/semver` });

  const listed = await sh(page, `ls ${BIN}`);
  assert.doesNotMatch(listed.out, /^mcpcat$/m);
  assert.match(listed.out, /^semver$/m);
  assert.deepEqual(page.errors, []);
});
