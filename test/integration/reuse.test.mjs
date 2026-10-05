import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, booted, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const bash = 'node_modules/@ai-ecoverse/wasm-bash';
const lit = {
  '': {
    name: 'lit-fixture',
  },
  'node_modules/@lit-labs/ssr-dom-shim': {
    version: '1.6.0',
    resolved: 'https://registry.npmjs.org/@lit-labs/ssr-dom-shim/-/ssr-dom-shim-1.6.0.tgz',
    integrity:
      'sha512-VHb0ALPMTlgKjM6yIxxoQNnpKyUKLD04VzeQdsiXkMqkvYlAHxq9glGLmgbb889/1GsohSOAjvQYoiBppXFqrQ==',
  },
  'node_modules/@lit/reactive-element': {
    version: '2.1.2',
    resolved: 'https://registry.npmjs.org/@lit/reactive-element/-/reactive-element-2.1.2.tgz',
    integrity:
      'sha512-pbCDiVMnne1lYUIaYNN5wrwQXDtHaYtg7YEFPeW+hws6U47WeFvISGUWekPGKWOP1ygrs0ef0o1VJMk1exos5A==',
  },
  'node_modules/@types/trusted-types': {
    version: '2.0.7',
    resolved: 'https://registry.npmjs.org/@types/trusted-types/-/trusted-types-2.0.7.tgz',
    integrity:
      'sha512-ScaPdn1dQczgbl0QFTeTOmVHFULt394XJgOQNoyVhZ6r2vLnMLJfBPd53SB52T/3G36VI1/g2MZaX0cwDuXsfw==',
  },
  'node_modules/lit': {
    version: '3.3.1',
    resolved: 'https://registry.npmjs.org/lit/-/lit-3.3.1.tgz',
    integrity:
      'sha512-Ksr/8L3PTapbdXJCk+EJVB78jDodUMaP54gD24W186zGRARvwrsPfS60wae/SSCTCNZVPd1chXqio1qHQmu4NA==',
  },
  'node_modules/lit-element': {
    version: '4.2.2',
    resolved: 'https://registry.npmjs.org/lit-element/-/lit-element-4.2.2.tgz',
    integrity:
      'sha512-aFKhNToWxoyhkNDmWZwEva2SlQia+jfG0fjIWV//YeTaWrVnOxD89dPKfigCUspXFmjzOEUQpOkejH5Ly6sG0w==',
  },
  'node_modules/lit-html': {
    version: '3.3.3',
    resolved: 'https://registry.npmjs.org/lit-html/-/lit-html-3.3.3.tgz',
    integrity:
      'sha512-el8M6jK2o3RXBnrSHX3ZKrsN8zEV63pSExTO1wYJz7QndGYZ8353e2a5PPX+qHe2aGayfnchQmkAojaWAREOIA==',
  },
};

async function reboot(page) {
  chrome.cdn.requests.length = 0;
  const bios = await watch(page);
  await boot(page);
  assert.deepEqual(bios.states(), booted);
  return bios.texts('packages').at(-1);
}

function downloads() {
  return chrome.cdn.requests.filter((url) => url.startsWith('https://registry.npmjs.org/'));
}

function lockfile(packages) {
  return JSON.stringify({ name: 'slicc-bios-packages', lockfileVersion: 3, packages });
}

async function opfs(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, path);
}

test('reuses packages already in OPFS on reboot', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  assert.equal(downloads().length, 1);

  assert.equal(await reboot(page), '0/1 downloaded from npm, 0B');
  assert.deepEqual(downloads(), []);
});

test('installs a package again when its directory is gone', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate(async () => {
    const modules = await (await navigator.storage.getDirectory()).getDirectoryHandle(
      'node_modules'
    );
    await modules.removeEntry('@ai-ecoverse', { recursive: true });
  });

  assert.match(await reboot(page), /^1\/1 downloaded from npm, [\d.]+MB$/);
  assert.deepEqual(downloads(), [
    'https://registry.npmjs.org/@ai-ecoverse/wasm-bash/-/wasm-bash-5.3.0-7.tgz',
  ]);
});

test('replaces a package when the lockfile pins another version', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  chrome.overrides.set(
    '/packages/package-lock.json',
    lockfile({
      '': { name: 'slicc-bios-packages' },
      [bash]: {
        version: '5.3.0-6',
        resolved: 'https://registry.npmjs.org/@ai-ecoverse/wasm-bash/-/wasm-bash-5.3.0-6.tgz',
        integrity:
          'sha512-4mwVr9PT6JHJygxiJT9uWJFnf5PRo3n6TvoHVQ5sYm0V0mi1nQB6j/4r9VXSsQsXhgwcbEkeXu2L1FwHqWbWWw==',
      },
    })
  );

  assert.match(await reboot(page), /^1\/1 downloaded from npm, [\d.]+MB$/);
  assert.equal(JSON.parse(await opfs(page, `${bash}/package.json`)).version, '5.3.0-6');
  const receipt = JSON.parse(await opfs(page, `var/lib/bios/${bash}.json`));
  assert.equal(
    receipt.integrity,
    'sha512-4mwVr9PT6JHJygxiJT9uWJFnf5PRo3n6TvoHVQ5sYm0V0mi1nQB6j/4r9VXSsQsXhgwcbEkeXu2L1FwHqWbWWw=='
  );
});

test('follows a lockfile through every dependency it lists', async (t) => {
  const page = await chrome.page(t);
  chrome.overrides.set('/packages/package-lock.json', lockfile(lit));
  const bios = await watch(page);
  await page.goto('/');
  await page.until(() => location.pathname === '/os/');

  assert.match(bios.texts('packages').at(-1), /^6\/6 downloaded from npm, [\d.]+kB$/);
  for (const [path, { version }] of Object.entries(lit).filter(([path]) => path)) {
    assert.equal(JSON.parse(await opfs(page, `${path}/package.json`)).version, version);
  }
  const element = await opfs(page, 'node_modules/lit-element/lit-element.js');
  assert.match(element, /lit-html/);
});
