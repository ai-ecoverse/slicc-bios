import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { agentState, agentUp, connectAccount, connected, listsAccount, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { CLI, cliEnv } from './cli.mjs';
import { startHub } from './fake-hub.mjs';
import { eventFrame, fakeLlm } from './fake-llm.mjs';

const cli = CLI;
const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const SENTINEL = 'INVENTORY-PROMPT-SENTINEL-4Z';
const ANSWER = 'INVENTORY-ANSWER-SENTINEL-4Z';
const stream = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: ANSWER } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'end_turn' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    metrics: { latencyMs: 1 },
  }),
]);

const chrome = await launch({ tools: false, intercept: [], agent: true, timeout: 60000 });
const llm = await fakeLlm(chrome.cdp, {
  hosts: [BEDROCK, 'https://registry.npmjs.org/'],
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
    await new Promise((resolve) => setTimeout(resolve, 1500));
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
  await llm.close();
  await chrome.close();
});

const AGENT_KEYS = ['id', 'kind', 'parent', 'status', 'queued', 'provider', 'model', 'since'];
const SNAPSHOT_KEYS = [
  'schema',
  'event',
  'v',
  'instance',
  'seq',
  'changedAt',
  'reportedAt',
  'counts',
  'agents',
  'receivedAt',
];
const STATUSES = ['running', 'queued', 'waiting', 'error', 'idle'];

function slicc(page, args, env = cliEnv()) {
  const node = spawn(cli, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
  const events = [];
  const lines = [];
  const stderr = [];
  node.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  createInterface({ input: node.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.nonce) {
      page?.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {});
      return;
    }
    lines.push(line);
    events.push(message);
  });
  const exited = new Promise((resolve) => node.on('exit', (code) => resolve(code)));
  return { node, events, lines, stderr, exited };
}

function checkSnapshot(snapshot) {
  assert.deepEqual(
    Object.keys(snapshot).filter((key) => !SNAPSHOT_KEYS.includes(key)),
    [],
    JSON.stringify(snapshot)
  );
  assert.equal(snapshot.v, 1);
  assert.match(snapshot.instance.id, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(Object.keys(snapshot.instance).sort(), ['id', 'name']);
  assert.match(snapshot.instance.name, /^seven on /);
  assert.deepEqual(Object.keys(snapshot.counts), STATUSES);
  assert.equal(
    Object.values(snapshot.counts).reduce((sum, n) => sum + n, 0),
    snapshot.agents.length
  );
  for (const agent of snapshot.agents) {
    assert.deepEqual(
      Object.keys(agent).filter((key) => !AGENT_KEYS.includes(key)),
      [],
      JSON.stringify(agent)
    );
    assert.match(agent.id, /^[A-Za-z0-9_-]{22}$/);
    assert.ok(STATUSES.includes(agent.status));
  }
}

test('slicc agents lists the agents over a local link, once and as they run, with opaque ids and no prompt or answer in any line', {
  skip: !cli,
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  await agentUp(page);
  await listsAccount(page, 'amazon-bedrock');
  await connectAccount(page, 'amazon-bedrock', KEY);
  await connected(page, 'amazon-bedrock');
  let current = null;
  await page.expose('sliccLinkSend', (message) =>
    current?.node.stdin.write(`${JSON.stringify(message)}\n`)
  );

  const once = slicc(page, ['agents', '--signal', 'stdio']);
  current = once;
  const code = await once.exited;
  if (code !== 0)
    assert.fail(
      `slicc agents exited ${code}: ${once.stderr.join('')}\n${once.lines.join('\n')}\n${await agentState(page)}`
    );
  const [snapshot] = once.events.filter((event) => event.event === 'inventory');
  assert.ok(snapshot, once.lines.join('\n'));
  checkSnapshot(snapshot);
  assert.equal(snapshot.agents[0].kind, 'cone');
  assert.equal(snapshot.agents[0].provider, 'amazon-bedrock');
  assert.equal(snapshot.agents[0].status, 'idle');
  assert.notEqual(snapshot.agents[0].id, 'cone');

  const watcher = slicc(page, ['agents', '--signal', 'stdio', '--watch']);
  current = watcher;
  t.after(() => watcher.node.kill('SIGINT'));
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((d) => d.state === 'connected')
  );
  const seen = (status) =>
    watcher.events.some(
      (event) => event.event === 'inventory' && event.agents[0]?.status === status
    );
  for (let i = 0; i < 240 && !seen('idle'); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(seen('idle'), watcher.lines.join('\n'));
  const prompt = slicc(page, ['prompt', '--signal', 'stdio', SENTINEL]);
  current = prompt;
  assert.equal(await prompt.exited, 0, prompt.stderr.join(''));
  assert.ok(prompt.lines.join('\n').includes(ANSWER));
  current = watcher;
  const ran = () => {
    const at = watcher.events.findIndex(
      (event) => event.event === 'inventory' && event.agents[0]?.status === 'running'
    );
    return (
      at >= 0 &&
      watcher.events
        .slice(at)
        .some((event) => event.event === 'inventory' && event.agents[0]?.status === 'idle')
    );
  };
  for (let i = 0; i < 240 && !ran(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(ran(), watcher.lines.join('\n'));
  const devices = await page.evaluate(
    () => document.querySelector('slicc-app').model.network.status().links.devices
  );
  assert.ok(
    devices.every((d) => d.controlling !== 'watch'),
    JSON.stringify(devices)
  );
  watcher.node.kill('SIGINT');
  assert.equal(await watcher.exited, 0, watcher.stderr.join(''));
  const inventories = watcher.events.filter((event) => event.event === 'inventory');
  for (const each of inventories) checkSnapshot(each);
  const ids = new Set(inventories.map((each) => each.agents[0].id));
  assert.deepEqual([...ids], [snapshot.agents[0].id]);
  assert.equal(new Set(inventories.map((each) => each.instance.id)).size, 1);
  const all = [...once.lines, ...watcher.lines, ...once.stderr, ...watcher.stderr].join('\n');
  for (const secret of [SENTINEL, ANSWER, KEY, BEDROCK, '"id":"cone"', '"parent":"cone"', 'sliccy'])
    assert.equal(all.includes(secret), false, `${secret} reached slicc agents`);
});

test('slicc agents over the tray from a device without Control is refused, plain and with --watch, and the page itself resets a raw inventory OPEN with EACCES', {
  skip: !cli,
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page);
  await agentUp(page);
  const joinUrl = await page.within(
    60000,
    () => document.querySelector('slicc-app').model.network.status().links?.joinUrl
  );
  const home = await mkdtemp(join(tmpdir(), 'inventory-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...cliEnv(), HOME: home, XDG_CONFIG_HOME: join(home, 'config') };
  for (const extra of [[], ['--watch']]) {
    const run = slicc(null, [joinUrl, 'agents', '--json', ...extra], env);
    const timer = setTimeout(() => run.node.kill('SIGKILL'), 120000);
    const code = await run.exited;
    clearTimeout(timer);
    const said = run.stderr.join('');
    assert.equal(code, 3, `${extra}: ${said}\n${run.lines.join('\n')}`);
    assert.match(said, /doesn't allow remote control from this device/);
    assert.equal(
      run.events.some((event) => event.event === 'inventory'),
      false
    );
    assert.equal(said.includes(joinUrl), false);
  }
  const raw = await page.tab();
  await raw.goto('/manifest.json');
  const opened = await raw.evaluate(
    async (join, tray) => {
      localStorage.setItem('slicc-os.tray-hub', tray);
      const { createLeaders } = await import('/seed/leaders.js');
      const { hubClient } = await import('/seed/follow.js');
      const leaders = createLeaders({
        post: hubClient({ origin: null, fetch: (...args) => fetch(...args) }),
        name: 'raw inventory node',
      });
      const out = [];
      for (const meta of [
        { kind: 'agent', op: 'inventory' },
        { kind: 'agent', op: 'inventory', watch: true },
      ]) {
        try {
          const { stream } = await leaders.open(join, meta);
          const read = await Promise.race([
            stream.read(),
            new Promise((resolve) => setTimeout(() => resolve('nothing'), 2000)),
          ]);
          out.push({ opened: true, read: read && read !== 'nothing' ? [...read] : read });
        } catch (error) {
          out.push({ code: error.code, message: error.message });
        }
      }
      return out;
    },
    joinUrl,
    hub.url
  );
  assert.deepEqual(
    opened.map((each) => each.code),
    ['EACCES', 'EACCES'],
    JSON.stringify(opened)
  );
  for (const each of opened) assert.match(each.message, /doesn't allow remote control/);
  await page.evaluate(() => localStorage.removeItem('slicc-os.tray-hub'));
});
