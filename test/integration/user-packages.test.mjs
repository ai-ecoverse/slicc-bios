import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';
import { shoot } from './shots.mjs';

const INSTALL = 15 * 60 * 1000;
const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const TITLE = 'Greeter package from opt user';
const said = (text) =>
  Buffer.concat([
    eventFrame('messageStart', { role: 'assistant' }),
    eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text } }),
    eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
    eventFrame('messageStop', { stopReason: 'end_turn' }),
    eventFrame('metadata', {
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      metrics: { latencyMs: 1 },
    }),
  ]);

const chrome = await launch({ agent: true, timeout: 60000 });
const proxy = await fakeProxy({
  origin: new URL(chrome.url).origin,
  key: 'the-key',
  answer: async (request, body) => {
    if (request.url.startsWith(BEDROCK))
      return {
        status: 200,
        headers: [['content-type', 'application/vnd.amazon.eventstream']],
        body: said(body.includes('Give this chat a title') ? TITLE : 'Noted.'),
      };
    if (!request.url.startsWith('https://registry.npmjs.org/'))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
    return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
  },
});
after(async () => {
  await proxy.close();
  await chrome.close();
});

const own = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .filter((item) => item.origin === 'user')
      .map(({ id, pin, warnings }) => ({ id, project: pin.project, warnings: warnings ?? [] }))
  );

const commands = (page) =>
  page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return agent.commands(agent.active()).map((command) => command.name);
  });

const skill = (name, description) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSay hello.\n`;

const checkNow = (page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('Your packages live in /opt/user: an addition moves there, its bin runs, its skill reaches the agent without a restart, an edit inside it offers Restart agent, a shipped name is ignored', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  await page.within(INSTALL, () => {
    const { agent } = document.querySelector('slicc-app').model;
    return !!agent?.commands && agent.commands(agent.active()).some((c) => c.kind === 'skill');
  });
  await page.within(INSTALL, () =>
    document
      .querySelector('slicc-app')
      .model.settings?.accounts?.()
      .some((a) => a.id === 'amazon-bedrock')
  );
  await page.evaluate(
    (secret) =>
      document.querySelector('slicc-app').model.settings.connect('amazon-bedrock', secret),
    KEY
  );
  await page.until(async () => {
    const root = await navigator.storage.getDirectory();
    const opt = await root.getDirectoryHandle('opt');
    return opt.getDirectoryHandle('user').then(
      () => true,
      () => false
    );
  });

  await page.evaluate(
    async (files) => {
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
    },
    {
      'home/greeter/package.json': JSON.stringify({
        name: 'greeter',
        version: '1.0.0',
        description: 'Greets from /opt/user',
        bin: { greet: 'greet.sh' },
        pi: { skills: ['skills'] },
      }),
      'home/greeter/greet.sh': '#!/bin/sh\necho greetings-$((6 * 7))\n',
      'home/greeter/skills/greeter/SKILL.md': skill(
        'greeter',
        'Greets the user from a package in /opt/user.'
      ),
      'home/shadow/package.json': JSON.stringify({
        name: '@ai-ecoverse/slicc-kernel',
        version: '0.0.1',
        pi: { skills: ['skills'] },
      }),
      'home/shadow/skills/shadow-skill/SKILL.md': skill(
        'shadow-skill',
        'Must never load, since the agent ships this package name.'
      ),
    }
  );
  await run(
    page,
    'chmod +x /home/greeter/greet.sh; cd /opt/user && pnpm add file:../../home/shadow > /tmp/add-user.log 2>&1; echo "user-added-$((40 + 2))-$?"; cd /home'
  );
  await shows(page, 'user-added-42-', 5 * 60 * 1000);
  if (!/user-added-42-0/.test(await screen(page))) {
    await run(page, 'clear; tail -5 /tmp/add-user.log');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.fail(await screen(page));
  }
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let dir = root;
    for (const part of ['var', 'lib', 'slicc', 'agent']) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle('user.json', { create: true });
    let layer = { add: {}, pin: {} };
    try {
      layer = { ...layer, ...JSON.parse(await (await handle.getFile()).text()) };
    } catch {}
    layer.add = {
      ...layer.add,
      greeter: { spec: 'file:../../home/greeter', field: 'dependencies' },
    };
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(layer));
    await writable.close();
  });
  await checkNow(page);
  await page.within(5 * 60 * 1000, () =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'user:user:greeter')
  );
  const rows = await own(page);
  assert.deepEqual(
    rows.map(({ id, project, warnings }) => [id, project, warnings]),
    [
      [
        'user:user:@ai-ecoverse/slicc-kernel',
        '/opt/user',
        ["Seven's agent ships its own @ai-ecoverse/slicc-kernel and ignores this one."],
      ],
      ['user:user:greeter', '/opt/user', []],
    ]
  );

  await run(page, 'clear; greet; echo "on-path $(command -v greet)"');
  await shows(page, 'greetings-42');
  await shows(page, 'on-path /opt/user/node_modules/.bin/greet');

  const greeter = () =>
    page.evaluate(() => {
      const { agent } = document.querySelector('slicc-app').model;
      return agent.commands(agent.active()).find((command) => command.name === 'skill:greeter')
        ?.description;
    });
  await page.within(INSTALL, async () => {
    const { agent } = document.querySelector('slicc-app').model;
    return agent.commands(agent.active()).some((command) => command.name === 'skill:greeter');
  });
  assert.equal(await greeter(), 'Greets the user from a package in /opt/user.');
  const offered = () =>
    page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.updates.list()
        .some((item) => item.id === 'agent' && item.actions?.includes('restart-agent'))
    );
  await checkNow(page);
  await new Promise((resolve) => setTimeout(resolve, 10000));
  assert.equal(await offered(), false, 'an addition needs no restart');

  await run(
    page,
    'clear; sed -i \'s/Greets the user from a package in \\/opt\\/user\\./Waves at the user from \\/opt\\/user./\' /opt/user/node_modules/greeter/skills/greeter/SKILL.md; echo "edited-$((40 + 2))"'
  );
  await shows(page, 'edited-42');
  await checkNow(page);
  await page.within(5 * 60 * 1000, () =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .some((item) => item.id === 'agent' && item.actions?.includes('restart-agent'))
  );
  assert.equal(await greeter(), 'Greets the user from a package in /opt/user.');
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.updates.act('agent', 'restart-agent')
  );
  await page.within(INSTALL, async () => {
    const { agent } = document.querySelector('slicc-app').model;
    return agent
      .commands(agent.active())
      .some(
        (command) =>
          command.name === 'skill:greeter' &&
          command.description === 'Waves at the user from /opt/user.'
      );
  });
  await page.within(120000, () =>
    JSON.stringify(
      document
        .querySelector('slicc-app')
        .model.agent.messages(document.querySelector('slicc-app').model.agent.active())
    ).includes('/opt/user/node_modules/@ai-ecoverse/slicc-kernel')
  );
  const names = await commands(page);
  assert.ok(names.includes('skill:greeter'), names.join(', '));
  assert.ok(!names.includes('skill:shadow-skill'), names.join(', '));
  assert.deepEqual(
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      let dir = root;
      for (const part of ['opt', 'agent', 'node_modules', '@ai-ecoverse', 'slicc-kernel'])
        dir = await dir.getDirectoryHandle(part);
      return (
        JSON.parse(await (await (await dir.getFileHandle('package.json')).getFile()).text())
          .version !== '0.0.1'
      );
    }),
    true
  );

  await page.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
  });
  await shoot(page, 'your-packages-opt-user', {
    show: 'updates',
    before: () => {
      document
        .querySelector('slicc-app')
        .dock.content('updates')
        ?.shadowRoot?.querySelector('section[data-section="user-packages"]')
        ?.scrollIntoView({ block: 'start' });
    },
  });
  await page.evaluate(async () => {
    const { droppedNotice } = await import('/os/user.js');
    document.querySelector('slicc-app').model.notices.show(droppedNotice(true), () => {});
  });
  await shoot(page, 'pins-dropped-notice', { show: 'chat' });
  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Which packages did I add to /opt/user today?');
  });
  await page.within(
    120000,
    (title) => {
      const { agent } = document.querySelector('slicc-app').model;
      const messages = agent.messages(agent.active());
      const asked = messages.findIndex(
        (message) => message.role === 'user' && message.text.includes('Which packages')
      );
      return (
        asked >= 0 &&
        messages.slice(asked + 1).some((message) => message.role === 'assistant') &&
        agent
          .list()
          .some((cone) => cone.kind === 'cone' && cone.title === title && cone.status === 'idle')
      );
    },
    TITLE
  );
  await page.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
  });
  await shoot(page, 'agents-model-title', { show: 'agents' });
  assert.deepEqual(page.errors, []);
});
