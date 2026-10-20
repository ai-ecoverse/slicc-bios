import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { agentUp, boot, ready, rowSettled, run, screen, shows } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';
import { fakeRegistry, fakeRelease } from './fake-npm.mjs';
import { shoot } from './shots.mjs';

const AGENT = '@ai-ecoverse/slicc-agent';
const PINNED = JSON.parse(
  await readFile(new URL('../../src/packages/agent/package.json', import.meta.url), 'utf8')
).dependencies[AGENT];
const BETA = '6.99.0';
const ELSEWHERE = 'Only the tab running SLICC can install a beta or leave one.';

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const release = await fakeRelease({
  name: AGENT,
  from: PINNED,
  version: BETA,
  repository: 'https://github.com/ai-ecoverse/slicc-agent',
});
const chrome = await launch({
  agent: true,
  timeout: 120000,
  intercept: [],
  args: [`--remote-debugging-port=${port}`],
});
after(() => chrome.close());
const clipboard = await fakeRelease({
  name: '@ai-ecoverse/slicc-clipboard',
  from: '1.0.2',
  version: '1.0.99',
  repository: 'https://github.com/ai-ecoverse/slicc-clipboard',
});
const tainted = await fakeRelease({
  name: AGENT,
  from: PINNED,
  version: '7.0.0',
  repository: 'https://github.com/ai-ecoverse/slicc-agent',
  dependencies: { '@ai-ecoverse/slicc-clipboard': '1.0.99' },
});
const mcpcat = await fakeRelease({
  name: '@ai-ecoverse/mcpcat',
  from: '0.17.2',
  version: '0.99.0',
  repository: 'https://github.com/ai-ecoverse/mcpcat',
});
const pinned = await fakeRelease({
  name: AGENT,
  from: PINNED,
  version: '7.0.1',
  repository: 'https://github.com/ai-ecoverse/slicc-agent',
  dependencies: { '@ai-ecoverse/mcpcat': '0.99.0' },
});
const releases = [release, clipboard, mcpcat];
const registry = await fakeRegistry(chrome.cdp, releases);
const fakeExtension = extensionOver(await debuggerUrl(port));

const agentRow = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'agent')
  );

const installedAgent = (page) =>
  page.evaluate(async (name) => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ['opt', 'agent', 'node_modules', ...name.split('/')])
      dir = await dir.getDirectoryHandle(part);
    const file = await (await dir.getFileHandle('package.json')).getFile();
    return JSON.parse(await file.text()).version;
  }, AGENT);

const notice = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.notices.list()
        .find((item) => item.id === id || item.id.startsWith(`${id}:`)) ?? null,
    id
  );

async function runsAgent(page, version, ms = 5 * 60 * 1000) {
  await page
    .within(
      ms,
      (version) => {
        const row = document
          .querySelector('slicc-app')
          .model.updates.list()
          .find((item) => item.id === 'agent');
        window.sliccRuns = JSON.stringify([row?.state, row?.from, row?.to]);
        return row?.state !== 'ready' && row?.from === version && row?.to === version;
      },
      version
    )
    .catch(async (error) => {
      const seen = await page.evaluate(() => window.sliccRuns).catch(() => 'unknown');
      throw new Error(`the agent never ran ${version}, last ${seen}: ${error.message}`);
    });
}

async function developer(page, on, ms = 10 * 60 * 1000) {
  await page.evaluate((on) => {
    window.sliccDeveloper = document
      .querySelector('slicc-app')
      .model.updates.setDeveloper(on)
      .then(
        () => 'done',
        (error) => error.message
      );
  }, on);
  await page
    .within(
      ms,
      (on) => {
        const { updates } = document.querySelector('slicc-app').model;
        const npm = updates.list().find((item) => item.id === 'agent')?.npm ?? null;
        window.sliccNpm = JSON.stringify(npm);
        if (updates.developer() !== on) return false;
        return on ? npm !== null && npm.state !== 'checking' : npm === null;
      },
      on
    )
    .catch(async (error) => {
      const seen = await page.evaluate(() => window.sliccNpm).catch(() => 'unknown');
      throw new Error(
        `developer mode never settled ${on ? 'on' : 'off'}, last ${seen}: ${error.message}`
      );
    });
}

async function npmSays(page, state, ms = 10 * 60 * 1000) {
  await page
    .within(
      ms,
      (state) => {
        const row = document
          .querySelector('slicc-app')
          .model.updates.list()
          .find((item) => item.id === 'agent');
        window.sliccNpm = JSON.stringify(row?.npm ?? null);
        return row?.npm?.state === state;
      },
      state
    )
    .catch(async (error) => {
      const seen = await page.evaluate(() => window.sliccNpm).catch(() => 'unknown');
      throw new Error(`npm never said ${state}, last ${seen}: ${error.message}`);
    });
}

async function confirmWith(page, label) {
  await page.until(() => {
    const app = document.querySelector('slicc-app');
    return !!app.shadowRoot
      .querySelector('slicc-confirm')
      ?.shadowRoot?.querySelector('dialog[open]');
  });
  const body = await page.evaluate(
    () =>
      document.querySelector('slicc-app').shadowRoot.querySelector('slicc-confirm').shadowRoot
        .textContent
  );
  await page.evaluate((label) => {
    const dialog = document.querySelector('slicc-app').shadowRoot.querySelector('slicc-confirm');
    [...dialog.shadowRoot.querySelectorAll('swc-button')]
      .find((button) => button.textContent.trim() === label)
      .click();
  }, label);
  return body;
}

const act = (page, action) =>
  page.evaluate(
    (action) => document.querySelector('slicc-app').model.updates.act('agent', action),
    action
  );

test('the owner turns on developer mode, npm’s newer agent is offered as a beta, Install beta installs it marked Beta, it survives the next check, and Back to certified returns to the certified pin', async (t) => {
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
    await act(page, 'back-to-certified');
    await rowSettled(page, 'agent');
    assert.equal(await installedAgent(page), PINNED);
    assert.equal(await notice(page, 'beta:agent'), null);
  });

  await t.test(
    'when seven’s certified agent lock changes under a beta, the beta goes and a notice says so',
    async () => {
      await npmSays(page, 'offered');
      const acting = act(page, 'install-beta');
      await confirmWith(page, 'Install beta');
      await acting;
      await rowSettled(page, 'agent');
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
      chrome.overrides.delete('/packages/agent/pnpm-lock.yaml');
      await act(page, 'retry');
      await rowSettled(page, 'agent');
      assert.equal(await installedAgent(page), PINNED);
    }
  );

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
    }
  );

  await t.test(
    'a release that brings an uncertified slicc-clipboard is listed but not offered',
    async () => {
      releases.unshift(tainted);
      t.after(() => releases.splice(releases.indexOf(tainted), 1));
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
      assert.deepEqual(page.errors, []);
    }
  );
});

test('nobody but the owner tab can turn developer mode on or install a beta: not another tab, not the kernel’s processes, not the agent’s CDP', async (t) => {
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

test('under report, a user’s pnpm pin in /opt/agent that brings an uncertified mcpcat is refused, and seven goes back to its own agent', async (t) => {
  releases.unshift(pinned);
  t.after(() => releases.splice(releases.indexOf(pinned), 1));
  const page = await chrome.page(t);
  await page.goto('/#users=report');
  await ready(page);
  await agentUp(page);
  await rowSettled(page, 'agent');
  await run(
    page,
    `cd /opt/agent && pnpm add ${AGENT}@7.0.1 --save-exact > /tmp/add.log 2>&1; echo "add-""done-$?"; cd /home`
  );
  await shows(page, 'add-done-', 5 * 60 * 1000);
  assert.match(await screen(page), /add-done-0/);
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
  assert.equal(
    own.error,
    "Needs @ai-ecoverse/mcpcat@0.99.0, which seven hasn't tested. Seven went back to its own versions."
  );
  assert.equal(await installedAgent(page), PINNED);
  assert.deepEqual(page.errors, []);
});
