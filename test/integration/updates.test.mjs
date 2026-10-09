import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const INSTALL = 5 * 60 * 1000;

function agent(version, integrity) {
  return {
    '/packages/agent/package.json': JSON.stringify({
      name: 'slicc-bios-agent',
      private: true,
      dependencies: { 'is-number': version },
    }),
    '/packages/agent/pnpm-lock.yaml': `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      is-number:
        specifier: ${version}
        version: ${version}

packages:

  is-number@${version}:
    resolution: {integrity: ${integrity}}
    engines: {node: '>=0.12.0'}

snapshots:

  is-number@${version}: {}
`,
  };
}

const good = agent(
  '7.0.0',
  'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng=='
);
const missing = (version) =>
  agent(version, `sha512-${Buffer.alloc(64, version).toString('base64')}`);

function deploy(files) {
  for (const [path, body] of Object.entries(files)) chrome.overrides.set(path, body);
}

const helpers = () => {
  window.app = () => document.querySelector('slicc-app');
  window.agentRow = () =>
    window
      .app()
      .model.updates.list()
      .find((item) => item.id === 'agent');
  window.updatesOpen = () => window.app().dock.api.panels.some((panel) => panel.id === 'updates');
  window.updatesButton = (id, action) =>
    window
      .app()
      .dock.content('updates')
      ?.shadowRoot?.querySelector(`article[data-id="${id}"] swc-button[data-action="${action}"]`);
};

test('Install / Update opens at boot until the agent is installed, and a failed tarball opens it again with Retry', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  deploy(missing('99.0.0'));
  await page.init(helpers);
  await page.goto('/');
  await ready(page, { settle: false });

  await t.test('a cold boot opens the panel while the agent installs', async () => {
    assert.equal(await page.evaluate(() => window.app().model.updates.ready()), false);
    await page.until(() => window.updatesOpen());
    await page.within(INSTALL, () => window.agentRow().state === 'failed');
    await page.until(() => !!window.updatesButton('agent', 'retry'));
    const row = await page.evaluate(() => window.agentRow());
    assert.deepEqual(row.actions, ['retry']);
    assert.match(
      row.error,
      /^Couldn't download the agent: the registry wasn't reachable .*Retry, or check the network\.$/
    );
    assert.match(row.log, /ERR_PNPM_/);
    const grammars = await page.evaluate(() =>
      window
        .app()
        .model.updates.list()
        .find((item) => item.id === 'grammars')
    );
    assert.notEqual(grammars.state, 'current');
    assert.equal(await page.evaluate(() => window.updatesOpen()), true);
    assert.equal(await page.evaluate(() => window.app().model.updates.ready()), false);
    await page.screenshot(new URL('failed.png', page.dir));
  });

  await t.test('Retry installs the agent and the panel closes', async () => {
    deploy(good);
    await page.evaluate(() => window.updatesButton('agent', 'retry').click());
    await page.within(INSTALL, () => window.app().model.updates.ready());
    await page.until(() => !window.updatesOpen());
    const row = await page.evaluate(() => window.agentRow());
    assert.deepEqual([row.state, row.error, row.actions], ['installed', null, []]);
    assert.match(
      await page.evaluate(() => window.agentRow().log),
      /resolved 1, reused 0, downloaded 1, added 1/
    );
  });

  await t.test('a later failed tarball opens it again with Retry', async () => {
    deploy(missing('98.0.0'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.within(INSTALL, () => window.agentRow().state === 'failed');
    await page.until(() => window.updatesOpen() && !!window.updatesButton('agent', 'retry'));
    const row = await page.evaluate(() => window.agentRow());
    assert.match(row.error, /^Couldn't download the agent: the registry wasn't reachable/);
    assert.match(
      await page.evaluate(() => window.app().shadowRoot.querySelector('#updates')?.textContent),
      /1 failed/
    );
    await page.screenshot(new URL('reopened.png', page.dir));
  });
});
