import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import {
  agentState,
  agentUp,
  connectAccount,
  connected,
  listsAccount,
  ready,
  run,
  shows,
} from './bios.mjs';
import { launch } from './chrome.mjs';
import { startHub } from './fake-hub.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';

const cli = process.env.SLICC_CLI;
const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const stream = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello from ' } }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'the remote prompt.' } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'end_turn' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    metrics: { latencyMs: 1 },
  }),
]);

const chrome = await launch({ agent: true, timeout: 60000 });
const proxy = await fakeProxy({
  origin: new URL(chrome.url).origin,
  key: 'the-key',
  answer: async (request) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return {
        status: 200,
        headers: [['content-type', type]],
        body: await download(request.url),
      };
    }
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: stream,
    };
  },
});
const hub = await startHub();
after(async () => {
  hub.close();
  await proxy.close();
  await chrome.close();
});

function slicc(page, args) {
  const node = spawn(cli, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  const stderr = [];
  node.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  createInterface({ input: node.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.nonce)
      page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {});
    else events.push(message);
  });
  const exited = new Promise((resolve) => node.on('exit', (code) => resolve(code)));
  return { node, events, stderr, exited };
}

test('a linked slicc CLI prompts the agent, watches it, and aborts, over the link', {
  skip: !cli,
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  await agentUp(page);
  await listsAccount(page, 'amazon-bedrock');
  await connectAccount(page, 'amazon-bedrock', KEY);
  await connected(page, 'amazon-bedrock');
  let current = null;
  await page.expose('sliccLinkSend', (message) =>
    current?.node.stdin.write(`${JSON.stringify(message)}\n`)
  );

  const watcher = slicc(page, ['watch', '--signal', 'stdio']);
  current = watcher;
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((d) => d.controlling === 'watch')
  );
  t.after(() => watcher.node.kill('SIGINT'));
  const prompt = slicc(page, ['prompt', '--signal', 'stdio', 'Say hello']);
  current = prompt;
  const code = await prompt.exited;
  if (code !== 0) {
    const devices = await page.evaluate(
      () => document.querySelector('slicc-app').model.network.status().links?.devices
    );
    assert.fail(
      `slicc prompt exited ${code}: ${prompt.stderr.join('')}\nits events: ${JSON.stringify(prompt.events)}\nthe watcher's events: ${JSON.stringify(watcher.events)}\nlinked devices: ${JSON.stringify(devices)}\n${await agentState(page)}`
    );
  }
  const kinds = prompt.events.map((e) => e.t);
  assert.equal(kinds[0], 'user');
  assert.equal(prompt.events[0].text, 'Say hello');
  assert.ok(kinds.includes('text'));
  assert.equal(
    prompt.events
      .filter((e) => e.t === 'text')
      .map((e) => e.delta)
      .join(''),
    'Hello from the remote prompt.'
  );
  assert.deepEqual(prompt.events.at(-1), { t: 'end', reason: 'stop' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(
    watcher.events.some((e) => e.t === 'user' && e.text === 'Say hello'),
    JSON.stringify(watcher.events)
  );
  assert.ok(watcher.events.some((e) => e.t === 'text'));
  const abort = slicc(page, ['abort', '--signal', 'stdio']);
  current = abort;
  assert.equal(await abort.exited, 0, abort.stderr.join(''));
  assert.match(abort.stderr.join(''), /nothing was running/);
  const devices = await page.evaluate(
    () => document.querySelector('slicc-app').model.network.status().links.devices
  );
  assert.ok(devices.every((d) => d.control?.fixed === true));
});

test('a webhook from the tray hub reaches the agent as a lick, without secret headers', {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page);
  await agentUp(page);
  await listsAccount(page, 'amazon-bedrock');
  await connectAccount(page, 'amazon-bedrock', KEY);
  await connected(page, 'amazon-bedrock');
  await page.until(
    () => document.querySelector('slicc-app').model.network.status().links?.webhookUrl
  );
  assert.equal(
    await page.evaluate(
      () => document.querySelector('slicc-app').model.network.status().links.webhookUrl
    ),
    `${hub.url}/webhook/w1`
  );
  await run(
    page,
    `mkdir -p /root/.slicc/webhooks && echo '{ "target": "cone", "message": "Deploy finished" }' > /root/.slicc/webhooks/deploy.json && echo hook-ready`
  );
  await shows(page, 'hook-ready');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  hub.send({
    type: 'webhook.event',
    webhookId: 'deploy',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer hush-hush',
      'x-github-delivery': 'd-1',
    },
    body: { ref: 'refs/heads/main', marker: 'webhook-marker-42' },
    timestamp: new Date().toISOString(),
  });
  const asked = () =>
    proxy.requests.filter((r) => r.url.startsWith(BEDROCK) && r.body.includes('webhook-marker-42'));
  for (let i = 0; i < 240 && !asked().length; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 250));
  const [request] = asked();
  assert.ok(request, 'the agent ran on the webhook');
  assert.match(request.body, /Deploy finished/);
  assert.match(request.body, /channel=\\"webhook\\"/);
  assert.doesNotMatch(request.body, /hush-hush/);
});
