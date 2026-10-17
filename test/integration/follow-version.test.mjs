import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import {
  agentState,
  agentUp,
  connectAccount,
  listsAccount,
  ready,
  run,
  screen,
  shows,
} from './bios.mjs';
import { launch } from './chrome.mjs';
import { model, startHub } from './fake-hub.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';
import { shoot } from './shots.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const OLD = new URL('fixtures/agent-5.0.3/', import.meta.url);
const OLD_AGENT = Object.fromEntries(
  ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map((file) => [
    `/packages/agent/${file}`,
    readFileSync(new URL(file, OLD), 'utf8'),
  ])
);
const NOTICE = 'follow:other-agent-version';
const SENTENCE = /That SLICC runs another version of the agent, so this tab can't follow it\./;

const usage = eventFrame('metadata', {
  usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
  metrics: { latencyMs: 1 },
});
const text = (said) =>
  Buffer.concat([
    eventFrame('messageStart', { role: 'assistant' }),
    eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: said } }),
    eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
    eventFrame('messageStop', { stopReason: 'end_turn' }),
    usage,
  ]);
const bash = (id, command) =>
  Buffer.concat([
    eventFrame('messageStart', { role: 'assistant' }),
    eventFrame('contentBlockStart', {
      contentBlockIndex: 0,
      start: { toolUse: { toolUseId: id, name: 'bash' } },
    }),
    eventFrame('contentBlockDelta', {
      contentBlockIndex: 0,
      delta: { toolUse: { input: JSON.stringify({ command }) } },
    }),
    eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
    eventFrame('messageStop', { stopReason: 'tool_use' }),
    usage,
  ]);

function answer(body) {
  let sent = {};
  try {
    sent = JSON.parse(body.toString());
  } catch {}
  const content = sent.messages?.at(-1)?.content ?? [];
  const said = content.map((item) => item.text ?? '').join(' ');
  if (content.some((item) => item.toolResult?.toolUseId === 'old-sudo'))
    return text('Seven said no, so I left /root alone.');
  if (sent.toolConfig?.tools?.length && said.includes('List root'))
    return bash('old-sudo', 'sudo ls -la /root');
  return text('Done.');
}

const owners = await launch({ agent: true, timeout: 60000 });
const followers = await launch({
  agent: true,
  timeout: 60000,
  args: ['--disable-features=IsolateSandboxedIframes'],
});
const proxy = await fakeProxy({
  origin: new URL(owners.url).origin,
  key: 'the-key',
  answer: async (request, body) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: answer(body),
    };
  },
});
after(async () => {
  await proxy.close();
  await Promise.all([owners.close(), followers.close()]);
});

const find = (selector) => {
  const walk = (root) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && walk(element.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  return walk(document);
};

const confirmDialog = () => {
  const deep = (root) => {
    const found = root.querySelector('slicc-confirm');
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && deep(element.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  return deep(document)?.shadowRoot?.querySelector('dialog[open]') ?? null;
};

const attempts = (page) => page.console.filter((line) => line.includes('following the agent:'));

async function agentVersion(page) {
  await run(
    page,
    `clear; v=$(grep -o '"version": "[^"]*"' /opt/agent/node_modules/@ai-ecoverse/slicc-agent/package.json); echo "agent $v at-$((6 * 7))"`
  );
  await shows(page, 'at-42');
  return (await screen(page)).match(/agent "version": "([^"]+)" at-42/)?.[1] ?? null;
}

test("a follower of a SLICC on another agent version shows the agent's sentence as bios's own warning and stops, the older agent's sudo still asks in bios's dialog, and the warning goes once the owner upgrades", {
  timeout: 60 * 60 * 1000,
}, async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const owner = await owners.page(t);
  const page = await followers.page(t);
  for (const [path, body] of Object.entries(OLD_AGENT)) owners.overrides.set(path, body);
  await owner.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(owner);
  await owner.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await owner.reload();
  await ready(owner);
  await page.goto('/');
  await ready(page);
  await Promise.all([
    agentUp(owner, { label: 'owner agent' }),
    agentUp(page, { label: 'follower agent' }),
  ]);
  assert.equal(await agentVersion(owner), '5.0.3');
  assert.notEqual(await agentVersion(page), '5.0.3');
  await listsAccount(owner, 'amazon-bedrock');
  await connectAccount(owner, 'amazon-bedrock', KEY);
  const { joinUrl } = await model(owner, (network) => network.status().links);

  await page.goto(`/#follow=${encodeURIComponent(joinUrl)}`);
  await page.until(new Function(`return !!(${confirmDialog})()`));
  await page.evaluate(
    new Function(
      `[...(${confirmDialog})().getRootNode().host.shadowRoot.querySelectorAll('swc-button')].find((b) => b.textContent.trim() === 'Follow').click()`
    )
  );
  await page.until(
    () => document.querySelector('slicc-app')?.model?.follow?.state().link === 'connected'
  );
  await owner.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links.devices.some((d) => d.kind === 'seven' && d.asking)
  );
  const [device] = await model(owner, (network) => network.status().links.devices);
  await model(owner, (network, id) => network.setAccess(id, 'view', true), device.id);

  const shown = await page
    .within(
      3 * 60 * 1000,
      (id) => {
        const notices = document.querySelector('slicc-app').model.notices.list();
        return notices.find((notice) => notice.id === id) ?? null;
      },
      NOTICE
    )
    .catch(async (error) => {
      throw new Error(
        `the follower never showed the other-version warning: ${error.message}\nfollower notices: ${JSON.stringify(await page.evaluate(() => document.querySelector('slicc-app').model.notices.list()))}\nfollower attempts: ${attempts(page).join('\n')}\nfollower console:\n${page.console.slice(-15).join('\n')}\nowner: ${await agentState(owner)}`
      );
    });
  assert.equal(shown.tone, 'warning');
  assert.equal(shown.dismissible, false);
  assert.match(shown.body, SENTENCE);
  const tried = attempts(page).length;
  await new Promise((resolve) => setTimeout(resolve, 10000));
  assert.equal(
    attempts(page).length,
    tried,
    `the follower tried again after EVERSION:\n${attempts(page).join('\n')}`
  );
  assert.ok(
    await page.evaluate(
      (id) =>
        document
          .querySelector('slicc-app')
          .model.notices.list()
          .some((notice) => notice.id === id),
      NOTICE
    )
  );
  await shoot(page, 'follower-other-agent-version', { show: 'chat' });

  await owner.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
    const { agent } = document.querySelector('slicc-app').model;
    document.querySelector('slicc-app').show('chat');
    void agent.send(agent.active(), 'List root’s home');
  });
  const [asked] = await owner.within(5 * 60 * 1000, () => {
    const list = document.querySelector('slicc-app').model.approvals.list();
    return list.length ? list : null;
  });
  assert.equal(asked.kind, 'sudo');
  assert.equal(asked.command, '/usr/bin/ls -la /root');
  assert.deepEqual(asked.requester, { kind: 'agent', name: 'cone', agentId: 'cone:cone' });
  await owner.until(
    new Function(
      'id',
      `const list = document.querySelector('slicc-app').model.approvals.list();
      if (!list.some((item) => item.id === id)) return true;
      (${find})('slicc-approvals')?.shadowRoot?.querySelector('dialog[data-approval="' + id + '"] [data-action="deny"]')?.click();
      return false;`
    ),
    asked.id
  );
  await owner.within(5 * 60 * 1000, () => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return !agent.busy(id) && JSON.stringify(agent.messages(id)).includes('left /root alone');
  });
  assert.match(
    await owner.evaluate(() => {
      const { agent } = document.querySelector('slicc-app').model;
      return JSON.stringify(agent.messages(agent.active()));
    }),
    /approval denied/
  );

  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    owners.overrides.set(
      `/packages/agent/${file}`,
      readFileSync(new URL(`../../src/packages/agent/${file}`, import.meta.url), 'utf8')
    );
  await owner.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await owner
    .within(
      20 * 60 * 1000,
      () => document.querySelector('slicc-app').model.updates.get('agent')?.state === 'ready'
    )
    .catch(async (error) => {
      throw new Error(
        `the owner never got the newer agent ready: ${error.message}\n${await agentState(owner)}`
      );
    });
  await owner.evaluate(() =>
    document.querySelector('slicc-app').model.updates.act('agent', 'restart-agent')
  );
  await owner.within(
    5 * 60 * 1000,
    () => document.querySelector('slicc-app').model.updates.get('agent')?.state === 'current'
  );
  await owner.reload();
  await ready(owner);
  await agentUp(owner, { label: 'owner agent after the upgrade' });
  assert.notEqual(await agentVersion(owner), '5.0.3');
  await page
    .within(
      5 * 60 * 1000,
      (id) => {
        const { model } = document.querySelector('slicc-app');
        return !model.notices.list().some((notice) => notice.id === id) && !!model.agent;
      },
      NOTICE
    )
    .catch(async (error) => {
      throw new Error(
        `the follower kept the other-version warning after the owner upgraded: ${error.message}\nfollower attempts: ${attempts(page).join('\n')}\nfollower console:\n${page.console.slice(-15).join('\n')}`
      );
    });
});
