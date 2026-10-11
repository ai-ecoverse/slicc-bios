import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';

const cli = process.env.SLICC_CLI;
const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const INSTALL = 15 * 60 * 1000;
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

const chrome = cli ? await launch({ agent: true, timeout: 60000 }) : null;
const proxy = cli
  ? await fakeProxy({
      origin: new URL(chrome.url).origin,
      key: 'the-key',
      answer: async (request) => {
        if (request.url.startsWith('https://registry.npmjs.org/')) {
          const type = request.url.endsWith('.tgz')
            ? 'application/octet-stream'
            : 'application/json';
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
    })
  : null;
after(async () => {
  await proxy?.close();
  await chrome?.close();
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
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
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
  await page.until(
    () =>
      document
        .querySelector('slicc-app')
        .model.settings.accounts()
        .find((a) => a.id === 'amazon-bedrock').status === 'connected'
  );
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
  assert.equal(code, 0, prompt.stderr.join(''));
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
