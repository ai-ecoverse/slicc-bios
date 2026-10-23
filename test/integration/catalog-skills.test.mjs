import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, agentUp, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeCatalog } from './fake-catalog.mjs';

const MCPCAT = '@ai-ecoverse/mcpcat';
const ROOT_SHELL = ['slicc:/home# '];
const MOVE = 5 * 60 * 1000;

const chrome = await launch({ agent: true, timeout: 120000, intercept: [] });
const registry = await fakeCatalog(chrome.cdp);
after(() => chrome.close());

function offer(version) {
  registry.latest.set(MCPCAT, version);
  chrome.overrides.set(
    '/packages/optional/catalog.json',
    JSON.stringify({
      [MCPCAT]: {
        id: 'mcpcat',
        label: 'mcpcat',
        source: { repo: 'ai-ecoverse/mcpcat', workflow: '.github/workflows/release.yml' },
      },
    })
  );
}

async function command(page, line) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  return page.evaluate(async (line) => {
    globalThis.skillsClient ??= await globalThis.sliccKernelClient();
    const { stdout, stderr } = await globalThis.skillsClient.run(['bash', '-c', line], {
      cwd: '/',
    });
    return `${stdout ?? ''}${stderr ?? ''}`;
  }, line);
}

const row = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .find((item) => item.id === 'mcpcat')
  );

async function state(page, wanted) {
  await page
    .within(
      MOVE,
      (wanted) =>
        document
          .querySelector('slicc-app')
          .model.updates.packages()
          .find((item) => item.id === 'mcpcat')?.state === wanted,
      wanted
    )
    .catch(async (error) => {
      throw new Error(`${error.message}\nrow: ${JSON.stringify(await row(page))}`);
    });
}

const skill = (page) =>
  page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return (
      agent.commands(agent.active()).find((command) => command.name === 'skill:mcpcat') ?? null
    );
  });

async function listed(page, present) {
  await page
    .within(
      MOVE,
      (present) => {
        const { agent } = document.querySelector('slicc-app').model;
        const found = agent
          .commands(agent.active())
          .some((command) => command.name === 'skill:mcpcat');
        return found === present;
      },
      present
    )
    .catch(async (error) => {
      throw new Error(`${error.message}\nskill: ${JSON.stringify(await skill(page))}`);
    });
}

test('a certified catalog package’s pi.skills reach every cone’s agent through root-owned links in /usr/share/skills, and leave with the package', {
  timeout: 45 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  offer('0.16.3');
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto('/#users=enforce');
  await ready(page, ROOT_SHELL);
  await agentUp(page);

  await state(page, 'available');
  assert.equal(await actPackage(page, 'mcpcat', 'install'), 'ok', JSON.stringify(await row(page)));
  const before = await command(page, 'test -e /usr/share/skills/mcpcat; echo none=$?');
  assert.match(before, /none=1/);

  offer('0.17.0');
  await page.reload();
  await ready(page, ROOT_SHELL);
  await agentUp(page);
  await state(page, 'outdated');
  assert.equal(await actPackage(page, 'mcpcat', 'update'), 'ok', JSON.stringify(await row(page)));
  assert.equal((await row(page)).version, '0.17.0');

  await listed(page, true);
  const found = await skill(page);
  assert.equal(found.source, 'package', JSON.stringify(found));
  assert.deepEqual(found.package, { name: MCPCAT, version: '0.17.0' }, JSON.stringify(found));

  const linked = await command(
    page,
    "readlink /usr/share/skills/mcpcat; stat -c 'link %U' /usr/share/skills/mcpcat; stat -L -c 'file %U %a' /usr/share/skills/mcpcat/SKILL.md; sudo -u cone bash -c 'sed -n 2p /usr/share/skills/mcpcat/SKILL.md; echo x >> /usr/share/skills/mcpcat/SKILL.md; echo write=$?; ln -sfn /tmp /usr/share/skills/mcpcat; echo relink=$?'"
  );
  assert.match(
    linked,
    /^\/usr\/local\/share\/pnpm\/\S+\/@ai-ecoverse\/mcpcat\/dist\/skills\/mcpcat$/m
  );
  assert.match(linked, /^link root$/m);
  assert.match(linked, /^file root 644$/m);
  assert.match(linked, /^name: mcpcat$/m);
  assert.match(linked, /^write=[1-9]/m);
  assert.match(linked, /^relink=[1-9]/m);

  assert.equal(await actPackage(page, 'mcpcat', 'remove'), 'ok', JSON.stringify(await row(page)));
  const gone = await command(
    page,
    'test -e /usr/share/skills/mcpcat || test -L /usr/share/skills/mcpcat; echo gone=$?; test -e /var/lib/slicc/optional/mcpcat/skills; echo record=$?'
  );
  assert.match(gone, /gone=1/);
  assert.match(gone, /record=1/);
  await listed(page, false);
  assert.deepEqual(page.errors, []);
});
