import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, eventually, prompt } from './bios.mjs';
import { offered } from './catalog.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const source = (file) => readFile(new URL(`../../src/packages/${file}`, import.meta.url), 'utf8');
const KERNEL = '@ai-ecoverse/slicc-kernel';
const lock = JSON.parse(await source('package-lock.json'));
const SHIPPED = lock.packages[`node_modules/${KERNEL}`].version;
const shippedIntegrity = lock.packages[`node_modules/${KERNEL}`].integrity;
const parts = (version) => version.split('.').map(Number);
const older = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};
const floor = [...(await source('pnpm-lock.yaml')).matchAll(/slicc-kernel: '>=(\d+\.\d+\.\d+)'/g)]
  .map(([, version]) => version)
  .reduce((high, version) => (older(high, version) ? version : high), '0.0.0');
async function registry(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (response.ok) return response.json();
      if (attempt >= 3) throw new Error(`${response.status} ${url}`);
    } catch (error) {
      if (attempt >= 3) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
}
const packument = await registry(`https://registry.npmjs.org/${KERNEL.replace('/', '%2F')}`);
const PREVIOUS = Object.keys(packument.versions)
  .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
  .filter((version) => older(version, SHIPPED) && !older(version, floor))
  .sort((a, b) => (older(a, b) ? 1 : -1))[0];
assert.ok(PREVIOUS, `no published kernel between ${floor} and ${SHIPPED}`);
const previousIntegrity = packument.versions[PREVIOUS].dist.integrity;
const files = ['package.json', 'package-lock.json', 'pnpm-lock.yaml'];
const VERIFY = '<!-- cert-verify -->\ncertified @ai-ecoverse/slicc-kernel\n<!-- /cert-verify -->\n';
const MAX_NOTES = 64 * 1024;

async function downgrade() {
  for (const file of files) {
    const text = await source(file);
    const pinned = text
      .replaceAll(`slicc-kernel@${SHIPPED}`, `slicc-kernel@${PREVIOUS}`)
      .replaceAll(`slicc-kernel-${SHIPPED}.tgz`, `slicc-kernel-${PREVIOUS}.tgz`)
      .replaceAll(`"${KERNEL}": "${SHIPPED}"`, `"${KERNEL}": "${PREVIOUS}"`)
      .replaceAll(
        `'${KERNEL}':\n        specifier: ${SHIPPED}\n        version: ${SHIPPED}`,
        `'${KERNEL}':\n        specifier: ${PREVIOUS}\n        version: ${PREVIOUS}`
      )
      .replaceAll(shippedIntegrity, previousIntegrity);
    chrome.overrides.set(`/packages/${file}`, pinned);
  }
  const pinned = structuredClone(lock);
  pinned.packages[`node_modules/${KERNEL}`] = {
    ...pinned.packages[`node_modules/${KERNEL}`],
    version: PREVIOUS,
    resolved: `https://registry.npmjs.org/${KERNEL}/-/slicc-kernel-${PREVIOUS}.tgz`,
    integrity: previousIntegrity,
  };
  pinned.packages[''].dependencies[KERNEL] = PREVIOUS;
  chrome.overrides.set('/packages/package-lock.json', `${JSON.stringify(pinned, null, 2)}\n`);
}

const release = (tag, body) => ({
  tag_name: tag,
  html_url: `https://github.com/ai-ecoverse/slicc-kernel/releases/tag/${tag}`,
  body,
});

function row(page, id) {
  return page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === id),
    id
  );
}

function packageRow(page, id) {
  return page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id),
    id
  );
}

const kernelCalls = () =>
  chrome.github.state.requests.filter(
    ({ path }) => path === '/repos/ai-ecoverse/slicc-kernel/releases'
  );

test("a check gives each row its GitHub releases: the installed one and the newer ones up to the offered version, at most 30 and 64 KB of notes each, revalidated with the cache's ETag, never with a cookie or a token", {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await downgrade();
  const huge = `${VERIFY}${'x'.repeat(MAX_NOTES * 2)}`;
  const between = Array.from({ length: 40 }, (_, i) =>
    release(`v${SHIPPED}-rc.${40 - i}`, i === 0 ? `${VERIFY}rc notes` : `notes ${40 - i}`)
  );
  chrome.github.releases('ai-ecoverse/slicc-kernel', [
    release('v99.0.0', 'too new'),
    release(`v${SHIPPED}`, huge),
    ...between,
    release(`v${PREVIOUS}`, 'the installed one'),
    release('v1.0.0', 'too old'),
  ]);
  const mcpcat = await offered('@ai-ecoverse/mcpcat');
  chrome.github.releases('ai-ecoverse/mcpcat', [
    {
      tag_name: `v${mcpcat}`,
      html_url: `https://github.com/ai-ecoverse/mcpcat/releases/tag/v${mcpcat}`,
      body: 'mcpcat notes',
    },
  ]);
  const catalog = JSON.parse(await source('optional/catalog.json'));
  catalog['@gitlab/ui'] = {
    id: 'gitlab-ui',
    label: 'GitLab UI',
    notes: ['A package whose repository is on GitLab.'],
  };
  const certs = JSON.parse(await source('certs.json'));
  const gitlab = await registry('https://registry.npmjs.org/@gitlab%2Fui/latest');
  const gitlabVersion = gitlab.version;
  const pinnedDeps = Object.entries(gitlab.dependencies ?? {}).filter(([, spec]) =>
    /^\d+\.\d+\.\d+$/.test(spec)
  );
  for (const [dep, version] of [['@gitlab/ui', gitlab.version], ...pinnedDeps]) {
    const doc = await registry(`https://registry.npmjs.org/${dep.replace('/', '%2F')}/${version}`);
    certs[`${dep}@${version}`] = { integrity: doc.dist.integrity };
  }
  chrome.overrides.set('/packages/optional/catalog.json', JSON.stringify(catalog));
  chrome.overrides.set('/packages/certs.json', JSON.stringify(certs));
  await boot(page, [prompt, 'slicc:/home$ ']);

  await t.test('an up-to-date kernel row links its installed release', async () => {
    await page.until(
      () =>
        !!document
          .querySelector('slicc-app')
          .model.updates.list()
          .find((item) => item.id === 'kernel')?.releases
    );
    const kernel = await row(page, 'kernel');
    assert.equal(kernel.from, PREVIOUS);
    assert.deepEqual(kernel.releases, [
      {
        version: PREVIOUS,
        url: `https://github.com/ai-ecoverse/slicc-kernel/releases/tag/v${PREVIOUS}`,
        notes: 'the installed one',
      },
    ]);
  });

  await t.test(
    'an optional package from GitHub gets its release, and one from elsewhere gets none',
    async () => {
      await page.within(
        10 * 60 * 1000,
        () =>
          !!document
            .querySelector('slicc-app')
            .model.updates.packages()
            .find((item) => item.id === 'mcpcat')?.releases
      );
      assert.deepEqual((await packageRow(page, 'mcpcat')).releases, [
        {
          version: mcpcat,
          url: `https://github.com/ai-ecoverse/mcpcat/releases/tag/v${mcpcat}`,
          notes: 'mcpcat notes',
        },
      ]);
      const gitlab = await packageRow(page, 'gitlab-ui');
      assert.equal(gitlab.offered, gitlabVersion);
      assert.equal('releases' in gitlab, false);
    }
  );

  await t.test(
    'an update ready from the installed kernel to the offered one lists the newest 30 releases between them, revalidated with If-None-Match',
    async () => {
      for (const file of files) chrome.overrides.delete(`/packages/${file}`);
      const first = kernelCalls();
      assert.ok(first.length >= 1);
      const etag = first.at(-1).etag;
      chrome.github.state.requests.length = 0;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.within(
        10 * 60 * 1000,
        () =>
          document
            .querySelector('slicc-app')
            .model.updates.list()
            .find((item) => item.id === 'kernel')?.releases?.length === 30
      );
      const kernel = await row(page, 'kernel');
      assert.equal(kernel.state, 'ready');
      assert.deepEqual([kernel.from, kernel.to], [PREVIOUS, SHIPPED]);
      assert.deepEqual(
        kernel.releases.map(({ version }) => version),
        [SHIPPED, ...Array.from({ length: 29 }, (_, i) => `${SHIPPED}-rc.${40 - i}`)]
      );
      assert.equal(kernel.releases[0].notes.length, MAX_NOTES);
      assert.ok(kernel.releases[0].notes.startsWith(VERIFY));
      assert.equal(kernel.releases[1].notes, `${VERIFY}rc notes`);
      const again = kernelCalls();
      assert.ok(again.length >= 1);
      assert.equal(again[0].headers['if-none-match'], etag);
      assert.equal(again[0].status, 304);
    }
  );

  await t.test('no request to GitHub carries a cookie, a token or a user header', () => {
    for (const { headers } of chrome.github.state.requests) {
      assert.equal(headers.cookie, undefined);
      assert.equal(headers.authorization, undefined);
      assert.equal(headers['x-github-token'], undefined);
    }
  });
});

test('a rate-limited GitHub leaves releases out, shows no error, and is not asked again during the back-off', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  chrome.github.releases('ai-ecoverse/slicc-kernel', [release(`v${SHIPPED}`, 'notes')]);
  chrome.github.state.status = 403;
  await boot(page);
  await page.until(() => {
    const kernel = document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'kernel');
    return kernel?.checkedAt !== null && kernel?.checkedAt !== undefined;
  });
  await eventually(() => assert.ok(chrome.github.state.requests.length >= 1));
  const kernel = await row(page, 'kernel');
  assert.equal('releases' in kernel, false);
  assert.equal(kernel.error, null);
  assert.notEqual(kernel.state, 'failed');
  const asked = chrome.github.state.requests.length;
  chrome.github.state.status = 0;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.until(() => {
    const items = document.querySelector('slicc-app').model.updates.list();
    return items.every((item) => !/checking|downloading|linking/.test(item.state));
  });
  await new Promise((resolve) => setTimeout(resolve, 5000));
  assert.equal(chrome.github.state.requests.length, asked);
  assert.equal('releases' in (await row(page, 'kernel')), false);
});

test('a GitHub that answers slowly does not hold the update check up, and its releases reach the row once they arrive', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  chrome.github.releases('ai-ecoverse/slicc-kernel', [release(`v${SHIPPED}`, 'late notes')]);
  chrome.github.state.delay = 6000;
  await boot(page, undefined, { tools: false });
  await page.until(() => {
    const kernel = document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'kernel');
    return kernel?.checkedAt !== null && kernel?.checkedAt !== undefined;
  });
  const early = await row(page, 'kernel');
  assert.equal('releases' in early, false);
  assert.ok(kernelCalls().some(({ status }) => status === 0));
  await page.within(
    2 * 60 * 1000,
    () =>
      !!document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === 'kernel')?.releases
  );
  const late = await row(page, 'kernel');
  assert.equal(late.checkedAt, early.checkedAt);
  assert.deepEqual(late.releases, [
    {
      version: SHIPPED,
      url: `https://github.com/ai-ecoverse/slicc-kernel/releases/tag/v${SHIPPED}`,
      notes: 'late notes',
    },
  ]);
});
