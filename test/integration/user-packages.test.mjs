import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, agentUp, opfs, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const chrome = await launch({ agent: true, timeout: 120000 });
after(() => chrome.close());

const ROOT_SHELL = ['slicc:/home# '];
const DROPPED =
  'Seven now uses the versions it ships for the agent and its tools. To add your own packages, use /opt/user (Install / Update › Your packages).';
const MOVE = 5 * 60 * 1000;

const skill = (name, description) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSay hello.\n`;

const PACKAGES = {
  'srv/pkgs/greeter/package.json': JSON.stringify({
    name: 'greeter',
    version: '1.0.0',
    description: 'Greets from /opt/user',
    bin: { greet: 'greet.sh' },
    pi: { skills: ['skills'] },
  }),
  'srv/pkgs/greeter/greet.sh': '#!/bin/sh\necho greetings-$((6 * 7))\n',
  'srv/pkgs/greeter/skills/greeter/SKILL.md': skill(
    'greeter',
    'Greets the user from a package in /opt/user.'
  ),
  'srv/pkgs/waver/package.json': JSON.stringify({
    name: 'waver',
    version: '2.0.0',
    description: 'Waves from /opt/user',
    pi: { skills: ['skills'] },
  }),
  'srv/pkgs/waver/skills/waver/SKILL.md': skill('waver', 'Waves at the user from /opt/user.'),
  'srv/pkgs/shadow/package.json': JSON.stringify({
    name: '@ai-ecoverse/slicc-kernel',
    version: '0.0.1',
    pi: { skills: ['skills'] },
  }),
  'srv/pkgs/shadow/skills/shadow-skill/SKILL.md': skill(
    'shadow-skill',
    'Never loads, since seven ships this package name.'
  ),
};

const writeFiles = (page, files) =>
  page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for (const [path, text] of Object.entries(files)) {
      const names = path.split('/');
      const name = names.pop();
      let dir = root;
      for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    }
  }, files);

const read = (page, path) =>
  page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    try {
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return null;
    }
  }, path);

const own = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .filter((item) => item.origin === 'user')
      .map(({ id, state, version, pin, warnings, actions, error }) => ({
        id,
        state,
        version,
        project: pin.project,
        warnings: warnings ?? [],
        actions,
        error,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  );

const skills = (page) =>
  page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return agent
      .commands(agent.active())
      .filter((command) => command.kind === 'skill')
      .map((command) => command.name)
      .sort();
  });

async function hasSkills(page, wanted, missing = []) {
  await page
    .within(
      MOVE,
      ([wanted, missing]) => {
        const { agent } = document.querySelector('slicc-app').model;
        const names = agent.commands(agent.active()).map((command) => command.name);
        return (
          wanted.every((name) => names.includes(name)) &&
          !missing.some((name) => names.includes(name))
        );
      },
      [wanted, missing]
    )
    .catch(async (error) => {
      throw new Error(
        `the agent's skills are ${(await skills(page)).join(', ')}, wanted ${wanted.join(', ')} without ${missing.join(', ')}: ${error.message}`
      );
    });
}

async function listed(page, id, state = 'installed') {
  await page
    .within(
      MOVE,
      ([id, state]) =>
        document
          .querySelector('slicc-app')
          .model.updates.packages()
          .some((item) => item.id === id && item.state === state),
      [id, state]
    )
    .catch(async (error) => {
      throw new Error(
        `${id} is not ${state} in Your packages: ${error.message}\n${JSON.stringify(await own(page), null, 2)}`
      );
    });
}

async function checked(page) {
  await page.within(MOVE, () =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .some((item) => item.id === 'grammars' && item.checkedAt !== null)
  );
}

async function command(page, line, done) {
  await run(page, `clear; ${line}; echo ${done}-$((40 + 2))`);
  await shows(page, `${done}-42`, MOVE);
  return screen(page);
}

async function decide(page, decision) {
  const [approval] = await page.within(MOVE, () => {
    const list = document.querySelector('slicc-app').model.approvals.list();
    return list.length ? list : null;
  });
  await page.until(
    (id, decision) => {
      const find = (root) => {
        const found = root.querySelector('slicc-approvals');
        if (found) return found;
        for (const element of root.querySelectorAll('*')) {
          const inner = element.shadowRoot && find(element.shadowRoot);
          if (inner) return inner;
        }
        return null;
      };
      const list = document.querySelector('slicc-app').model.approvals.list();
      if (!list.some((item) => item.id === id)) return true;
      const dialog = find(document)?.shadowRoot?.querySelector(`dialog[data-approval="${id}"]`);
      dialog?.querySelector('[data-action="full-command"][aria-expanded="false"]')?.click();
      dialog?.querySelector('[data-command], [data-summary]')?.scrollIntoView({ block: 'end' });
      dialog?.querySelector(`[data-action="${decision}"]`)?.click();
      return false;
    },
    approval.id,
    decision
  );
  return approval;
}

const scrollToYours = () => {
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  focused?.blur();
  document
    .querySelector('slicc-app')
    .dock.content('updates')
    ?.shadowRoot?.querySelector('section[data-section="user-packages"]')
    ?.scrollIntoView({ block: 'start' });
};

test('enforce: Your packages live in /opt/user, a root project that cones read and only sudo writes, and the agent and every shell use them', {
  timeout: 45 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/#users=enforce');
  await ready(page, ROOT_SHELL);
  await agentUp(page);
  await writeFiles(page, PACKAGES);

  await t.test('/opt/user is root’s, and a cone reads it but can’t write it', async () => {
    const text = await command(
      page,
      "stat -c '%U:%G %a %n' /opt/user /opt/user/package.json; sudo -u cone bash -c 'cd /opt/user && cat package.json > /dev/null; echo read=$?; touch /opt/user/mine; echo touch=$?; rm -f /opt/user/package.json; echo rm=$?'",
      'cone'
    );
    assert.match(text, /root:root 755 \/opt\/user\b/);
    assert.match(text, /root:root 644 \/opt\/user\/package\.json/);
    assert.match(text, /read=0/);
    assert.match(text, /touch=1/);
    assert.match(text, /rm=1/);
    assert.match(text, /Permission denied/);
    assert.notEqual(await read(page, 'opt/user/package.json'), null);
    assert.equal(await read(page, 'opt/user/mine'), null);
  });

  await t.test(
    'an addition an older seven left in /opt/agent moves to /opt/user once, and its pin goes with one notice',
    async () => {
      await writeFiles(page, {
        'var/lib/slicc/agent/user.json': JSON.stringify({
          add: { greeter: { spec: 'file:../../srv/pkgs/greeter', field: 'dependencies' } },
          pin: {
            '@ai-ecoverse/slicc-agent': { spec: '5.0.2', field: 'dependencies', base: '5.0.3' },
          },
        }),
      });
      await page.goto('/#users=enforce');
      await ready(page, ROOT_SHELL);
      await listed(page, 'user:user:greeter');
      await checked(page);
      assert.deepEqual(JSON.parse(await read(page, 'opt/user/package.json')).dependencies, {
        greeter: 'file:../../srv/pkgs/greeter',
      });
      const layer = JSON.parse(await read(page, 'var/lib/slicc/agent/user.json'));
      assert.deepEqual([layer.add, layer.pin], [{}, {}]);
      assert.deepEqual(
        await page.evaluate(() =>
          document
            .querySelector('slicc-app')
            .model.notices.list()
            .filter((notice) => notice.id === 'pins-dropped')
            .map(({ title, body }) => [title, body])
        ),
        [['Your pinned versions were removed', DROPPED]]
      );
      await agentUp(page);
      await hasSkills(page, ['skill:greeter']);
      const text = await command(
        page,
        "greet; sudo -u cone bash -c 'echo cone-$(greet)'; stat -c '%U %a %n' /opt/user/node_modules/greeter/greet.sh",
        'greeted'
      );
      assert.match(text, /^greetings-42/m);
      assert.match(text, /cone-greetings-42/);
      assert.match(text, /root 755 \/opt\/user\/node_modules\/greeter\/greet\.sh/);
      await shoot(page, 'pins-dropped-notice', { show: 'chat' });

      await page.goto('/#users=enforce');
      await ready(page, ROOT_SHELL);
      await listed(page, 'user:user:greeter');
      await checked(page);
      assert.deepEqual(JSON.parse(await read(page, 'opt/user/package.json')).dependencies, {
        greeter: 'file:../../srv/pkgs/greeter',
      });
      assert.deepEqual(
        await page.evaluate(() =>
          document
            .querySelector('slicc-app')
            .model.notices.list()
            .filter((notice) => notice.id === 'pins-dropped')
        ),
        []
      );
    }
  );

  await t.test(
    'a cone adds with sudo pnpm add, which offers Allow once only, and the agent sees it',
    async () => {
      await agentUp(page);
      await run(
        page,
        "clear; sudo -u cone bash -c 'cd /opt/user && sudo pnpm add file:../../srv/pkgs/waver file:../../srv/pkgs/shadow > /tmp/cone-add.log 2>&1; echo cone-added=$?'"
      );
      const approval = await decide(page, 'once');
      assert.match(approval.command, /^\/usr\/bin\/pnpm add file:/);
      assert.equal(approval.requester.name, 'cone');
      assert.equal(approval.cwd, '/opt/user');
      assert.equal(approval.always, false);
      await shows(page, 'cone-added=', MOVE);
      if (!/cone-added=0/.test(await screen(page))) {
        const log = await read(page, 'tmp/cone-add.log');
        assert.fail(`${await screen(page)}\n${log}`);
      }
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await listed(page, 'user:user:waver');
      await listed(page, 'user:user:@ai-ecoverse/slicc-kernel');
      assert.deepEqual(await own(page), [
        {
          id: 'user:user:@ai-ecoverse/slicc-kernel',
          state: 'installed',
          version: '0.0.1',
          project: '/opt/user',
          warnings: ['Seven ships its own @ai-ecoverse/slicc-kernel and ignores this one.'],
          actions: ['remove'],
          error: null,
        },
        {
          id: 'user:user:greeter',
          state: 'installed',
          version: '1.0.0',
          project: '/opt/user',
          warnings: [],
          actions: ['remove'],
          error: null,
        },
        {
          id: 'user:user:waver',
          state: 'installed',
          version: '2.0.0',
          project: '/opt/user',
          warnings: [],
          actions: ['remove'],
          error: null,
        },
      ]);
      await hasSkills(page, ['skill:greeter', 'skill:waver'], ['skill:shadow-skill']);
      const text = await command(page, "stat -c '%U %a %n' /opt/user/node_modules", 'owned');
      assert.match(text, /root 755 \/opt\/user\/node_modules/);
      await page.evaluate(() => {
        const { notices } = document.querySelector('slicc-app').model;
        for (const notice of notices.list()) notices.dismiss(notice.id);
      });
      await shoot(page, 'your-packages-opt-user', { show: 'updates', before: scrollToYours });
    }
  );

  await t.test(
    'Remove in Your packages takes a package out of /opt/user, its command and its skill, and it stays out',
    async () => {
      assert.equal(await actPackage(page, 'user:user:greeter', 'remove'), 'ok');
      assert.deepEqual(
        (await own(page)).map(({ id }) => id),
        ['user:user:@ai-ecoverse/slicc-kernel', 'user:user:waver']
      );
      assert.deepEqual(
        Object.keys(JSON.parse(await read(page, 'opt/user/package.json')).dependencies).sort(),
        ['@ai-ecoverse/slicc-kernel', 'waver']
      );
      const left = (await opfs(page)).filter((path) => path.startsWith('opt/user/node_modules/'));
      assert.ok(!left.some((path) => path.includes('/greeter/')), left.join('\n'));
      await hasSkills(page, ['skill:waver'], ['skill:greeter']);
      const text = await command(
        page,
        "command -v greet || echo root-no-greet; sudo -u cone bash -c 'command -v greet || echo cone-no-greet'",
        'gone'
      );
      assert.match(text, /root-no-greet/);
      assert.match(text, /cone-no-greet/);

      await page.goto('/#users=enforce');
      await ready(page, ROOT_SHELL);
      await listed(page, 'user:user:waver');
      await checked(page);
      assert.deepEqual(
        (await own(page)).map(({ id }) => id),
        ['user:user:@ai-ecoverse/slicc-kernel', 'user:user:waver']
      );
      assert.equal(
        JSON.parse(await read(page, 'opt/user/package.json')).dependencies.greeter,
        undefined
      );
      assert.deepEqual(page.errors, []);
    }
  );
});
