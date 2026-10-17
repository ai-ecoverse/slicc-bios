import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import {
  actPackage,
  agentUp,
  connectAccount,
  connected,
  listsAccount,
  ready,
  run,
  screen,
} from './bios.mjs';
import { launch } from './chrome.mjs';
import { model, startHub } from './fake-hub.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const STEP = 3 * 60 * 1000;
const answer = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello from ' } }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'the leader.' } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'end_turn' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    metrics: { latencyMs: 1 },
  }),
]);

const sleeping = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockStart', {
    contentBlockIndex: 0,
    start: { toolUse: { toolUseId: 'sleep-1', name: 'bash' } },
  }),
  eventFrame('contentBlockDelta', {
    contentBlockIndex: 0,
    delta: { toolUse: { input: JSON.stringify({ command: 'sleep 600' }) } },
  }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'tool_use' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 9, totalTokens: 12 },
    metrics: { latencyMs: 1 },
  }),
]);

const lastTurn = (body) => {
  try {
    const sent = JSON.parse(body.toString());
    return {
      tools: !!sent.toolConfig?.tools?.length,
      content: sent.messages?.at(-1)?.content ?? [],
    };
  } catch {
    return { tools: false, content: [] };
  }
};

let sleeps = 0;

const leaders = await launch({ agent: true, timeout: 60000 });
const followers = await launch({ timeout: 60000 });
const asked = [];
const proxy = await fakeProxy({
  origin: new URL(leaders.url).origin,
  key: 'the-key',
  answer: async (request, body) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    asked.push(body.toString());
    const turn = lastTurn(body);
    const hold = turn.tools && turn.content.some((item) => item.text?.includes('Hold on'));
    if (hold) sleeps += 1;
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: hold ? sleeping : answer,
    };
  },
});
const hub = await startHub();
after(async () => {
  hub.close();
  await proxy.close();
  await Promise.all([leaders.close(), followers.close()]);
});

async function typed(page, command, label, ms = STEP) {
  await run(page, `clear; ${command}; echo "${label}-$((40 + 2)) $?"`);
  const pattern = `${label}-42 (\\d+)`;
  const code = await page
    .within(
      ms,
      (pattern) => {
        const { dock } = document.querySelector('slicc-app');
        const id = dock.api.panels
          .map((panel) => panel.id)
          .findLast((id) => id.startsWith('terminal:'));
        return new RegExp(pattern).exec(dock.content(id).screen.textContent)?.[1];
      },
      pattern
    )
    .catch(async (error) => {
      throw new Error(
        `${label}: ${error.message}\nscreen:\n${await screen(page)}\nconsole:\n${page.console.slice(-15).join('\n')}`
      );
    });
  return { code: Number(code), text: await screen(page) };
}

const GRAB = `() => {
  const close = RTCPeerConnection.prototype.close;
  globalThis.zzCloses = [];
  RTCPeerConnection.prototype.close = function () {
    globalThis.zzCloses.push(new Error('close').stack.split('\\n').slice(1, 9).map((line) => line.trim().replace(/https?:\\/\\/[^/]+/, '')).join(' < '));
    return close.call(this);
  };
}`;

test('diagnostic: first contacts to a busy leader refuse with the hint, never a closed control channel', {
  timeout: 40 * 60 * 1000,
}, async (t) => {
  const owner = await leaders.page(t);
  await owner.init(GRAB);
  await owner.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(owner);
  await owner.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await owner.reload();
  await ready(owner);
  const page = await followers.page(t);
  await page.init(GRAB);
  await page.goto('/');
  await ready(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page);
  const install = async () => {
    await page.within(5 * 60 * 1000, () =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === 'slicc' && item.state === 'available')
    );
    return actPackage(page, 'slicc');
  };
  const [installed] = await Promise.all([install(), agentUp(owner, { label: 'leader agent' })]);
  assert.equal(installed, 'ok');
  await listsAccount(owner, 'amazon-bedrock');
  await connectAccount(owner, 'amazon-bedrock', KEY);
  await connected(owner, 'amazon-bedrock');
  const { joinUrl } = await model(owner, (network) => network.status().links);
  const bad = [];
  const N = 20;
  for (let i = 0; i < N; i += 1) {
    const at = [
      await owner.evaluate(() => globalThis.zzCloses.length),
      await page.evaluate(() => globalThis.zzCloses.length),
      owner.console.length,
      page.console.length,
    ];
    const started = Date.now();
    const r = await typed(page, `sudo -u cone slicc '${joinUrl}' prompt "Say hello"`, `try${i}`);
    const ok = r.code === 3 && /doesn't allow remote control/.test(r.text);
    console.log(`diag ${i} code=${r.code} ok=${ok} ms=${Date.now() - started}`);
    if (!ok) {
      bad.push({
        i,
        code: r.code,
        text: r.text.replace(/\s+/g, ' ').slice(0, 200),
        ownerCloses: (await owner.evaluate(() => globalThis.zzCloses)).slice(at[0]),
        pageCloses: (await page.evaluate(() => globalThis.zzCloses)).slice(at[1]),
        ownerConsole: owner.console.slice(at[2]),
        pageConsole: page.console.slice(at[3]),
      });
      console.log(`diag BAD ${JSON.stringify(bad.at(-1), null, 1)}`);
    }
    const shown = await model(page, (network) => network.status().leaders);
    for (const item of shown) await model(page, (network, id) => network.forgetLeader(id), item.id);
  }
  assert.deepEqual(bad, [], JSON.stringify(bad, null, 1));
});
