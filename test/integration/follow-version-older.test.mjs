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
import { eventFrame, fakeLlm } from './fake-llm.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const OLD_VERSION = '7.34.0';
const agentFiles = (base) =>
  Object.fromEntries(
    ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map((file) => [
      `/packages/agent/${file}`,
      readFileSync(new URL(file, base), 'utf8'),
    ])
  );
const OLD_AGENT = agentFiles(new URL(`fixtures/agent-${OLD_VERSION}/`, import.meta.url));
const PINNED_AGENT = agentFiles(new URL('../../src/packages/agent/', import.meta.url));
const NOTICE = 'follow:other-agent-version';

const reply = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Owner still here.' } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'end_turn' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    metrics: { latencyMs: 1 },
  }),
]);

const owners = await launch({ intercept: [], agent: true, timeout: 60000 });
const followers = await launch({
  agent: true,
  timeout: 60000,
  args: ['--disable-features=IsolateSandboxedIframes'],
});
const llm = await fakeLlm(owners.cdp, {
  hosts: [BEDROCK, 'https://registry.npmjs.org/'],
  answer: async (request) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: reply,
    };
  },
});
after(async () => {
  await llm.close();
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

const followed = (page) =>
  page.evaluate(
    new Function(
      'id',
      `const { model } = document.querySelector('slicc-app');
      const state = model.follow.state();
      const light = (${find})('[data-follow="connected"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null;
      return {
        link: state.link,
        owner: state.owner,
        refused: state.refused ?? null,
        notice: model.notices.list().some((notice) => notice.id === id),
        light,
      };`
    ),
    NOTICE
  );

test('a 7.x follower of an 8.x owner only sees its link close: no chat, no other-version warning, it keeps trying while the owner answers, and it follows once it takes the pin', {
  timeout: 60 * 60 * 1000,
}, async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const owner = await owners.page(t);
  const page = await followers.page(t);
  for (const [path, body] of Object.entries(OLD_AGENT)) followers.overrides.set(path, body);
  await owner.goto('/');
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
  assert.match(await agentVersion(owner), /^8\./);
  assert.equal(await agentVersion(page), OLD_VERSION);
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

  await page
    .within(
      3 * 60 * 1000,
      () => document.querySelector('slicc-app').model.follow.state().link === 'connected'
    )
    .catch(async (error) => {
      throw new Error(
        `the follower lost its link: ${error.message}\n${JSON.stringify(await followed(page))}`
      );
    });
  for (let i = 0; i < 120 && attempts(page).length < 3; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(
    attempts(page).length >= 3,
    `the 7.x follower stopped trying after ${attempts(page).length} attempts:\n${attempts(page).join('\n')}\nowner: ${await agentState(owner)}`
  );
  const before = attempts(page).length;
  await new Promise((resolve) => setTimeout(resolve, 10000));
  assert.ok(
    attempts(page).length > before,
    `the 7.x follower stopped trying, so it joined the 8.x owner or gave up:\n${attempts(page).join('\n')}`
  );
  const tried = await followed(page);
  assert.equal(tried.link, 'connected', JSON.stringify(tried));
  assert.equal(tried.refused, null, JSON.stringify(tried));
  assert.equal(tried.notice, false, JSON.stringify(tried));

  await owner.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
    const { agent } = document.querySelector('slicc-app').model;
    document.querySelector('slicc-app').show('chat');
    void agent.send(agent.active(), 'Are you there?');
  });
  await owner.within(5 * 60 * 1000, () => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return !agent.busy(id) && JSON.stringify(agent.messages(id)).includes('Owner still here.');
  });
  assert.deepEqual(owner.errors, []);

  for (const [path, body] of Object.entries(PINNED_AGENT)) followers.overrides.set(path, body);
  await page.reload();
  const following = await page
    .within(
      20 * 60 * 1000,
      new Function(
        'id',
        `const { model } = document.querySelector('slicc-app');
        const state = model.follow?.state();
        if (!state || state.link !== 'connected' || state.refused) return null;
        if (model.notices.list().some((notice) => notice.id === id)) return null;
        const light = (${find})('[data-follow="connected"]')?.textContent.replace(/\\s+/g, ' ').trim();
        return light?.includes('Following ' + state.owner) ? { owner: state.owner, light } : null;`
      ),
      NOTICE
    )
    .catch(async (error) => {
      throw new Error(
        `the follower didn't follow once it took the pinned agent: ${error.message}\nfollower: ${JSON.stringify(await followed(page).catch(() => null))}\nfollower attempts: ${attempts(page).join('\n')}\nfollower console:\n${page.console.slice(-15).join('\n')}`
      );
    });
  assert.match(following.owner, /^SLICC on /);
});
