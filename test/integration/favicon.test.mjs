import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { agentUp, connectAccount, listsAccount, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';
import { shoot } from './shots.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';

function png(size, paint) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.from([0]));
    for (let x = 0; x < size; x += 1) rows.push(Buffer.from(paint(x, y)));
  }
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
const wave = (x, y) => {
  const inside = (x - 7.5) ** 2 + (y - 7.5) ** 2 <= 56;
  const crest = Math.abs(y - (8 + 2.5 * Math.sin((x / 15) * 2 * Math.PI))) < 1.3;
  if (!inside) return [0, 0, 0, 0];
  return crest ? [255, 255, 255, 255] : [11, 91, 122, 255];
};
const HARBOR_ICON = png(16, wave);
const BIG_ICON = png(64, () => [200, 40, 40, 255]);
const EDGE_ICON = png(32, () => [40, 120, 60, 255]);
const SVG_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#7a4b0b"/></svg>')}`;

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const hits = [];
const pages = {
  '/harbor/forecast.html': `<!doctype html><title>Harbor forecast</title><link rel="icon" href="${HARBOR_ICON}"><h1>Harbor forecast</h1><p>High tide 16:40, 3.2 m.</p>`,
  '/lighthouse/log.html':
    '<!doctype html><title>Lighthouse log</title><link rel="icon" href="/lighthouse/icon.png"><h1>Keeper’s log</h1><p>18:30 Lamp on.</p>',
  '/buoys/list.html': `<!doctype html><title>Buoys</title><link rel="icon" href="${BIG_ICON}"><h1>Buoys</h1>`,
  '/pier/notes.html': `<!doctype html><title>Pier</title><link rel="icon" href="${BIG_ICON}"><link rel="icon" href="${EDGE_ICON}"><h1>Pier</h1>`,
  '/beacon/notes.html': `<!doctype html><title>Beacon</title><link rel="icon" href="/beacon/icon.png"><link rel="icon" href="${SVG_ICON}"><h1>Beacon</h1>`,
  '/vault': `<!doctype html><title>VAULT-MARK</title><link rel="icon" href="${HARBOR_ICON}"><h1>Vault</h1>`,
};
const stand = createHttp((req, res) => {
  hits.push(`${req.headers.host?.split(':')[0]}${req.url}`);
  const body = pages[req.url];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
  res.end(body ?? 'missing');
});
await new Promise((resolve) => stand.listen(0, '127.0.0.1', resolve));
const at = (host, path) => `http://${host}:${stand.address().port}${path}`;
const HARBOR = at('harbor.example.test', '/harbor/forecast.html');
const LIGHTHOUSE = at('lighthouse.example.test', '/lighthouse/log.html');
const BUOYS = at('buoys.example.test', '/buoys/list.html');
const VAULT = at('vault.sliccy.ai', '/vault');
const PIER = at('pier.example.test', '/pier/notes.html');
const BEACON = at('beacon.example.test', '/beacon/notes.html');

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
const STEPS = [
  ['harbor', HARBOR],
  ['lighthouse', LIGHTHOUSE],
  ['buoys', BUOYS],
  ['vault', VAULT],
  ['pier', PIER],
  ['beacon', BEACON],
];
const FIRST = 4;
const open = (index) => {
  const [name, url] = STEPS[index];
  return bash(
    `tab-${index}`,
    `mkdir -p /tmp/${name} && cd /tmp/${name} && playwright-cli open ${url}`
  );
};

function answer(body) {
  let sent;
  try {
    sent = JSON.parse(body.toString());
  } catch {
    return text('Done.');
  }
  const tools = !!sent.toolConfig?.tools?.length;
  const content = sent.messages?.at(-1)?.content ?? [];
  const said = content.map((item) => item.text ?? '').join(' ');
  const result = content.find((item) => item.toolResult)?.toolResult?.toolUseId;
  const index = result ? Number(result.slice(4)) + 1 : -1;
  if (index === FIRST) return text('The harbor, the lighthouse and the buoys are open.');
  if (index === STEPS.length) return text('The pier and the beacon are open.');
  if (index > 0) return open(index);
  if (tools && said.includes('Open the harbor')) return open(0);
  if (tools && said.includes('Open the pier')) return open(FIRST);
  return text('Done.');
}

const chrome = await launch({
  agent: true,
  timeout: 60000,
  args: [
    `--remote-debugging-port=${port}`,
    '--host-resolver-rules=MAP *.example.test 127.0.0.1, MAP vault.sliccy.ai 127.0.0.1',
  ],
});
const proxy = await fakeProxy({
  origin: new URL(chrome.url).origin,
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
const browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
  .webSocketDebuggerUrl;
const fakeExtension = extensionOver(browser);
after(async () => {
  await proxy.close();
  await chrome.close();
  stand.close();
});

const chips = `() => {
  const found = [];
  const walk = (root) => {
    for (const chip of root.querySelectorAll('.chip[data-icon]'))
      found.push({ icon: chip.dataset.icon, src: chip.querySelector('img.favicon')?.getAttribute('src') ?? null });
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) walk(element.shadowRoot);
  };
  walk(document);
  return found;
}`;

test('a tab’s favicon comes from the data: icon its page already loaded: a tool-run strip shows it, a too-big or linked icon leaves the globe, a protected tab never gets one, and nothing is fetched for it', {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  await agentUp(page);
  await listsAccount(page, 'amazon-bedrock');
  await connectAccount(page, 'amazon-bedrock', KEY);
  await page.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
  });
  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Open the harbor, the lighthouse, the buoys and the vault');
  });
  await page.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return !agent.busy(id) && JSON.stringify(agent.messages(id)).includes('the buoys are open');
  });
  const tabs = () =>
    document
      .querySelector('slicc-app')
      .model.browser.list()
      .map(({ url, favicon }) => ({ host: new URL(url).hostname, favicon: favicon ?? null }));
  await page.within(
    60000,
    (wanted) =>
      document
        .querySelector('slicc-app')
        .model.browser.list()
        .find(({ url }) => url.includes('harbor.example.test'))?.favicon === wanted,
    HARBOR_ICON
  );
  const listed = await page.evaluate(tabs);
  const by = Object.fromEntries(listed.map(({ host, favicon }) => [host, favicon]));
  assert.equal(by['harbor.example.test'], HARBOR_ICON, JSON.stringify(listed));
  assert.equal(by['lighthouse.example.test'], null, JSON.stringify(listed));
  assert.equal(by['buoys.example.test'], null, JSON.stringify(listed));
  assert.ok(
    listed.every(({ host, favicon }) => !host.endsWith('sliccy.ai') || favicon === null),
    JSON.stringify(listed)
  );
  assert.ok(!hits.some((hit) => hit.startsWith('vault.sliccy.ai')), hits.join(' '));
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  const strip = await page.within(
    60000,
    new Function(`return (${chips})().some((chip) => chip.icon === 'favicon') && (${chips})()`)
  );
  assert.deepEqual(
    strip.map(({ icon, src }) => [icon, src === HARBOR_ICON]),
    [
      ['favicon', true],
      ['site', false],
      ['site', false],
      ['site', false],
    ],
    JSON.stringify(strip)
  );
  const linked = hits.filter((hit) => hit === 'lighthouse.example.test/lighthouse/icon.png');
  assert.ok(
    linked.length <= 1,
    `the linked icon was fetched ${linked.length} times: ${hits.join(' ')}`
  );
  assert.deepEqual(
    hits.filter((hit) => !linked.includes(hit)),
    [
      'harbor.example.test/harbor/forecast.html',
      'lighthouse.example.test/lighthouse/log.html',
      'buoys.example.test/buoys/list.html',
    ]
  );
  const quiet = () => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
  };
  await page.evaluate(quiet);
  await shoot(page, 'favicon-strip', { show: 'chat', before: quiet });

  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Open the pier and the beacon');
  });
  await page.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return !agent.busy(id) && JSON.stringify(agent.messages(id)).includes('the beacon are open');
  });
  const icon = (host) =>
    document
      .querySelector('slicc-app')
      .model.browser.list()
      .find(({ url }) => new URL(url).hostname === host)?.favicon ?? null;
  await page.within(
    60000,
    new Function(
      'wanted',
      `const icon = ${icon}; return icon('pier.example.test') === wanted[0] && icon('beacon.example.test') === wanted[1];`
    ),
    [EDGE_ICON, SVG_ICON]
  );
  const controls = await page.evaluate(tabs);
  const after = Object.fromEntries(controls.map(({ host, favicon }) => [host, favicon]));
  assert.equal(
    after['pier.example.test'],
    EDGE_ICON,
    'the 64×64 icon is passed over for the 32×32 one'
  );
  assert.equal(
    after['beacon.example.test'],
    SVG_ICON,
    'the http icon link is passed over for the data: one'
  );
  assert.equal(after['lighthouse.example.test'], null, JSON.stringify(controls));
  assert.equal(after['buoys.example.test'], null, JSON.stringify(controls));
  const fetched = hits.filter((hit) => /\/(lighthouse|beacon)\/icon\.png$/.test(hit));
  assert.ok(
    fetched.length <= 2,
    `linked icons were fetched ${fetched.length} times: ${hits.join(' ')}`
  );
  assert.deepEqual(hits.filter((hit) => !fetched.includes(hit)).slice(3), [
    'pier.example.test/pier/notes.html',
    'beacon.example.test/beacon/notes.html',
  ]);
});
