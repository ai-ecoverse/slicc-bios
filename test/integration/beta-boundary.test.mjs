import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  AGENT,
  act,
  agentRow,
  BETA,
  chrome,
  DEPRECATED,
  ELSEWHERE,
  fakeExtension,
  installedAgent,
  PINNED,
  pinned,
  registry,
  releases,
} from './beta-fixture.mjs';
import { agentUp, boot, ready, rowSettled, run, screen, shows } from './bios.mjs';

test('nobody but the owner tab can turn developer mode on or install a beta: not another tab, not the kernel’s processes, not the agent’s CDP', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  registry.asked.length = 0;
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  await agentUp(page);
  await rowSettled(page, 'agent');

  await t.test('another tab has no switch, and its Install beta is refused', async () => {
    const other = await page.tab();
    await other.goto('/');
    await ready(other);
    await other.until(
      () => document.querySelector('slicc-app').model.tabs?.state().role === 'follower'
    );
    const seen = await other.evaluate(async () => {
      const { updates } = document.querySelector('slicc-app').model;
      const tries = [];
      for (const action of ['install-beta', 'back-to-certified'])
        tries.push(
          await updates.act('agent', action).then(
            () => 'done',
            (error) => error.message
          )
        );
      return {
        developer: typeof updates.developer,
        setDeveloper: typeof updates.setDeveloper,
        tries,
      };
    });
    assert.deepEqual(seen, {
      developer: 'undefined',
      setDeveloper: 'undefined',
      tries: [ELSEWHERE, ELSEWHERE],
    });
    assert.deepEqual(other.errors, []);
    await other.close();
  });

  await t.test('the kernel’s root processes can’t turn it on or pin a beta', async () => {
    await run(
      page,
      `for f in /var/lib/slicc/beta.json /etc/slicc/developer /opt/slicc/beta/agent/package.json; do mkdir -p "$(dirname $f)" 2>/dev/null; echo '{"agent":{"name":"${AGENT}","version":"${BETA}"},"developer":"on"}' > $f 2>/dev/null; done; jq '.dependencies["${AGENT}"] = "${BETA}"' /opt/agent/package.json > /tmp/p 2>/dev/null && cp /tmp/p /opt/agent/package.json 2>/dev/null; echo lock > /opt/slicc/beta/agent/pnpm-lock.yaml 2>/dev/null; echo "scratch-$?"; echo "wrote-""done"`
    );
    await shows(page, 'wrote-done');
    assert.match(await screen(page), /scratch-[1-9]/);
    await act(page, 'retry');
    await rowSettled(page, 'agent');
    const row = await agentRow(page);
    assert.equal(row.npm, null);
    assert.equal(row.beta, null);
    assert.equal(await installedAgent(page), PINNED);
    assert.equal(
      await page
        .evaluate(() => [
          document.querySelector('slicc-app').model.updates.developer(),
          localStorage.getItem('slicc-os.developer'),
          localStorage.getItem('slicc-os.beta'),
        ])
        .then(JSON.stringify),
      JSON.stringify([false, null, null])
    );
  });

  await t.test('the agent’s CDP can’t reach seven’s tab to flip the setting', async () => {
    const seven = new URL('/os/', chrome.url).href;
    await run(
      page,
      `curl -sf http://127.0.0.1:9222/json/list | jq -r '[.[] | select(.url | startswith("${new URL(chrome.url).origin}"))] | "seven listed " + (length | tostring)'`
    );
    await shows(page, 'seven listed 0');
    await run(
      page,
      `playwright-cli open ${seven} > /tmp/pw 2>&1; playwright-cli eval "localStorage.setItem('slicc-os.developer', 'on')" >> /tmp/pw 2>&1; echo "pw-$?"; echo "cdp-""done"`
    );
    await shows(page, 'cdp-done', 120000);
    assert.match(await screen(page), /pw-[1-9]/);
    await act(page, 'retry');
    await rowSettled(page, 'agent');
    assert.equal(
      await page
        .evaluate(() => [
          document.querySelector('slicc-app').model.updates.developer(),
          localStorage.getItem('slicc-os.developer'),
        ])
        .then(JSON.stringify),
      JSON.stringify([false, null])
    );
    assert.equal((await agentRow(page)).npm, null);
    assert.equal(await installedAgent(page), PINNED);
    assert.ok(!registry.asked.some((url) => url.endsWith(`/${AGENT}/latest`)));
  });
  assert.deepEqual(page.errors, []);
});

test('under report, a user’s pnpm pin in /opt/agent that brings an uncertified mcpcat and a certs.json py-six npm deprecates is refused at seven’s next agent update, and seven goes back to its own agent', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  releases.unshift(pinned, DEPRECATED);
  t.after(() => {
    for (const one of [pinned, DEPRECATED])
      if (releases.includes(one)) releases.splice(releases.indexOf(one), 1);
  });
  const page = await chrome.page(t);
  await page.goto('/#users=report');
  await ready(page);
  await agentUp(page);
  await rowSettled(page, 'agent');
  await run(
    page,
    `jq '.dependencies["${AGENT}"] = "6.97.0"' /opt/agent/package.json > /tmp/p && cp /tmp/p /opt/agent/package.json; echo "pin-""done-$?"`
  );
  await shows(page, 'pin-done-');
  assert.match(await screen(page), /pin-done-0/);
  const lock = await readFile(
    new URL('../../src/packages/agent/pnpm-lock.yaml', import.meta.url),
    'utf8'
  );
  chrome.overrides.set('/packages/agent/pnpm-lock.yaml', `${lock}\n`);
  t.after(() => chrome.overrides.delete('/packages/agent/pnpm-lock.yaml'));
  await act(page, 'retry');
  await rowSettled(page, 'agent');
  const id = `user:agent:${AGENT}`;
  const own = await page
    .within(
      5 * 60 * 1000,
      (id) =>
        document
          .querySelector('slicc-app')
          .model.updates.userPackages()
          .find((row) => row.id === id && row.error) ?? null,
      id
    )
    .catch(async (error) => {
      const rows = await page.evaluate(() =>
        JSON.stringify(document.querySelector('slicc-app').model.updates.userPackages())
      );
      throw new Error(`the pin was never refused, rows ${rows}: ${error.message}`);
    });
  const certs = JSON.parse(
    await readFile(new URL('../../src/packages/certs.json', import.meta.url), 'utf8')
  );
  assert.ok(
    certs[`${DEPRECATED.name}@${DEPRECATED.version}`],
    'certs.json has the py-six npm now deprecates'
  );
  assert.equal(
    own.error,
    `Needs @ai-ecoverse/mcpcat@0.99.0, ${DEPRECATED.name}@${DEPRECATED.version}, which seven hasn't tested. Seven went back to its own versions.`
  );
  assert.equal(await installedAgent(page), PINNED);
  assert.deepEqual(page.errors, []);
});
