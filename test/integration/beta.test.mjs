import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  AGENT,
  act,
  agentRow,
  BETA,
  chrome,
  confirmWith,
  developer,
  installedAgent,
  notice,
  npmSays,
  PINNED,
  registry,
  release,
  releases,
  runsAgent,
  tainted,
} from './beta-fixture.mjs';
import { agentUp, boot, ready, rowSettled } from './bios.mjs';
import { shoot } from './shots.mjs';

test('the owner turns on developer mode, npm’s newer agent is offered as a beta, Install beta installs it marked Beta, it survives the next check and a reload, and a changed certified lock drops it', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await agentUp(page);
  await rowSettled(page, 'agent');

  await t.test('with developer mode off, npm is never asked and nothing is offered', async () => {
    const row = await agentRow(page);
    assert.equal(row.npm, null);
    assert.equal(row.beta, null);
    assert.ok(!row.actions.includes('install-beta'));
    assert.equal(
      await page.evaluate(() => document.querySelector('slicc-app').model.updates.developer()),
      false
    );
    assert.ok(!registry.asked.some((url) => url.endsWith(`/${AGENT}/latest`)));
  });

  await t.test('turning it on offers the newer release, with what it changes', async () => {
    await developer(page, true);
    await npmSays(page, 'offered');
    const row = await agentRow(page);
    assert.equal(row.npm.latest, BETA);
    assert.ok(row.npm.changes.count >= 1, JSON.stringify(row.npm));
    assert.deepEqual(row.npm.changes.gated, []);
    assert.ok(row.actions.includes('install-beta'), row.actions.join());
    assert.equal(row.beta, null);
    assert.equal(await installedAgent(page), PINNED);
    await shoot(page, 'beta-settings', { show: 'settings', target: '[data-setting="developer"]' });
    await shoot(page, 'beta-offered', { show: 'updates', target: '[data-npm]' });
  });

  await t.test('Install beta asks first; Cancel installs nothing', async () => {
    const acting = act(page, 'install-beta');
    await page.until(
      () =>
        !!document
          .querySelector('slicc-app')
          .shadowRoot.querySelector('slicc-confirm')
          ?.shadowRoot?.querySelector('dialog[open]')
    );
    await shoot(page, 'beta-confirm', {});
    const body = await confirmWith(page, 'Cancel');
    await acting;
    assert.match(body, new RegExp(`slicc-agent ${BETA.replaceAll('.', '\\.')} isn’t certified`));
    assert.match(
      body,
      /packages? changes? in \/opt\/agent’s lockfile\. No certified packages change\./
    );
    assert.equal((await agentRow(page)).beta, null);
    assert.equal(await installedAgent(page), PINNED);
  });

  await t.test('Install beta installs it into /opt/agent and marks it as a beta', async () => {
    const acting = act(page, 'install-beta');
    await confirmWith(page, 'Install beta');
    await acting;
    await rowSettled(page, 'agent');
    const row = await agentRow(page);
    assert.deepEqual(row.beta, { version: BETA, certified: PINNED });
    assert.notEqual(row.state, 'failed', row.error);
    assert.ok(row.actions.includes('back-to-certified'), row.actions.join());
    assert.equal(await installedAgent(page), BETA);
    assert.ok(registry.asked.some((url) => url.endsWith(`slicc-agent-${BETA}.tgz`)));
    const shown = await notice(page, 'beta:agent');
    assert.equal(shown?.tone, 'warning');
    await shoot(page, 'beta-ready', { show: 'updates', target: '[data-beta]' });
    if ((await agentRow(page)).actions.includes('restart-agent')) {
      await act(page, 'restart-agent');
      await runsAgent(page, BETA);
    }
    await shoot(page, 'beta-installed', { show: 'updates', target: '[data-beta]' });
    await shoot(page, 'beta-notice', { show: 'chat' });
    assert.match(
      shown.body,
      new RegExp(`slicc-agent ${BETA.replaceAll('.', '\\.')} isn’t certified`)
    );
  });

  await t.test('the next update check keeps the beta instead of repairing it', async () => {
    await act(page, 'retry');
    await rowSettled(page, 'agent');
    assert.equal(await installedAgent(page), BETA);
    assert.deepEqual((await agentRow(page)).beta, { version: BETA, certified: PINNED });
  });

  await t.test('dismissing the beta notice hides it for this session only', async () => {
    await page.evaluate(
      (id) => document.querySelector('slicc-app').model.notices.dismiss(id),
      `beta:agent:${BETA}`
    );
    assert.equal(await notice(page, 'beta:agent'), null);
    await act(page, 'retry');
    await rowSettled(page, 'agent');
    assert.equal(await notice(page, 'beta:agent'), null);
    await page.goto('/');
    await ready(page);
    await page.until(
      () =>
        !!document
          .querySelector('slicc-app')
          .model.notices?.list()
          .some((item) => item.id.startsWith('beta:agent:'))
    );
    await rowSettled(page, 'agent');
    assert.equal(await installedAgent(page), BETA);
  });

  await t.test(
    'when seven’s certified agent lock changes under a beta, the beta goes and a notice says so',
    async () => {
      assert.equal(await installedAgent(page), BETA);
      const lock = await readFile(
        new URL('../../src/packages/agent/pnpm-lock.yaml', import.meta.url),
        'utf8'
      );
      chrome.overrides.set('/packages/agent/pnpm-lock.yaml', `${lock}\n`);
      t.after(() => chrome.overrides.delete('/packages/agent/pnpm-lock.yaml'));
      await act(page, 'retry');
      await rowSettled(page, 'agent');
      assert.equal(await installedAgent(page), PINNED);
      assert.equal((await agentRow(page)).beta, null);
      assert.equal(await notice(page, 'beta:agent'), null);
      const replaced = await notice(page, 'beta:replaced');
      assert.equal(replaced?.title, 'The agent went back to certified');
      assert.match(replaced.body, new RegExp(`removed the beta ${BETA.replaceAll('.', '\\.')}`));
    }
  );
  assert.deepEqual(page.errors, []);
});

test('a release without provenance or with an uncertified gated dependency isn’t offered, and after Back to certified the next beta shows its notice again', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await agentUp(page);
  await rowSettled(page, 'agent');

  await t.test('turning it on offers the newer release', async () => {
    await developer(page, true);
    await npmSays(page, 'offered');
  });

  await t.test(
    'a release without provenance, or built outside the release workflow, is listed but not offered',
    async () => {
      release.provenance = false;
      t.after(() => {
        release.provenance = true;
      });
      await developer(page, false);
      assert.equal((await agentRow(page)).npm, null);
      await developer(page, true);
      await npmSays(page, 'not-offered');
      const row = await agentRow(page);
      assert.equal(row.npm.reason, 'no provenance');
      assert.ok(!row.actions.includes('install-beta'));
      await shoot(page, 'beta-not-offered', { show: 'updates', target: '[data-npm]' });
      release.provenance = true;
      release.workflow = { ref: 'refs/heads/main', path: '.github/workflows/ci.yml' };
      t.after(() => {
        release.workflow = { ref: 'refs/heads/main', path: '.github/workflows/release.yml' };
      });
      await developer(page, false);
      await developer(page, true);
      await npmSays(page, 'not-offered');
      const outside = await agentRow(page);
      assert.equal(outside.npm.reason, 'built outside the release workflow');
      assert.ok(!outside.actions.includes('install-beta'));
      release.workflow = { ref: 'refs/heads/main', path: '.github/workflows/release.yml' };
    }
  );

  await t.test(
    'a release that brings an uncertified slicc-clipboard is listed but not offered',
    async () => {
      releases.unshift(tainted);
      t.after(() => {
        if (releases.includes(tainted)) releases.splice(releases.indexOf(tainted), 1);
      });
      await developer(page, false);
      await developer(page, true);
      await npmSays(page, 'not-offered');
      const row = await agentRow(page);
      assert.equal(row.npm.latest, '7.0.0');
      assert.equal(
        row.npm.reason,
        'needs @ai-ecoverse/slicc-clipboard@1.0.99, which isn’t certified'
      );
      assert.ok(!row.actions.includes('install-beta'));
      assert.equal(await installedAgent(page), PINNED);
      releases.splice(releases.indexOf(tainted), 1);
      await developer(page, false);
      await developer(page, true);
    }
  );

  await t.test('Install beta installs the beta', async () => {
    await npmSays(page, 'offered');
    const acting = act(page, 'install-beta');
    await confirmWith(page, 'Install beta');
    await acting;
    await rowSettled(page, 'agent');
    assert.equal(await installedAgent(page), BETA);
    assert.deepEqual((await agentRow(page)).beta, { version: BETA, certified: PINNED });
  });

  await t.test('Back to certified returns /opt/agent to the certified pin', async () => {
    await page.evaluate(
      (id) => document.querySelector('slicc-app').model.notices.dismiss(id),
      `beta:agent:${BETA}`
    );
    await act(page, 'back-to-certified');
    await rowSettled(page, 'agent');
    const row = await agentRow(page);
    assert.equal(row.beta, null);
    assert.equal(await installedAgent(page), PINNED);
    assert.equal(await notice(page, 'beta:agent'), null);
    await runsAgent(page, PINNED);
    await npmSays(page, 'offered');
  });

  await t.test('the next Install beta in the same session shows the notice again', async () => {
    const acting = act(page, 'install-beta');
    await confirmWith(page, 'Install beta');
    await acting;
    await rowSettled(page, 'agent');
    assert.equal(await installedAgent(page), BETA);
    assert.equal((await notice(page, 'beta:agent'))?.id, `beta:agent:${BETA}`);
  });
  assert.deepEqual(page.errors, []);
});
