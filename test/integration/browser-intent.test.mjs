import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { devtools as boundPort, debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const chrome = await launch();
const { port } = await boundPort(chrome);
const fakeExtension = extensionOver(await debuggerUrl(port));
after(() => chrome.close());
const elsewhere = (path) => {
  const at = new URL(path, chrome.url);
  at.hostname = 'localhost';
  return at.href;
};

const stamp = { pid: 40, ppid: 1, uid: 1000, gid: 1000, groups: [], users: 'enforce' };

test('the Browser panel shows a stated intent only for a cdp hook request whose kernel stamp has clean tags', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await boot(page);
  const requests = {
    today: {},
    device: { caller: { kind: 'device', id: 'dev-1', name: 'laptop' } },
    'device with a stamp': {
      caller: { kind: 'device', id: 'dev-2', name: 'phone' },
      stamp,
    },
    'users off': { stamp: { ...stamp, users: 'off' } },
    tainted: { stamp: { ...stamp, tag: 'slicc-taint:a1' } },
    'tainted second tag': {
      stamp: { ...stamp, tag: 'call:3', tags: ['call:3', 'slicc-taint:a1'] },
    },
    'not a list': { stamp: { ...stamp, tag: 'call:5', tags: 'call:5' } },
    untagged: { stamp },
    trusted: { stamp: { ...stamp, tag: 'call:4', tags: ['call:4', 'cron:7'] } },
  };
  const rows = await page.evaluate(async (requests) => {
    const browser = document.querySelector('slicc-app').model.browser;
    const heard = [];
    browser.on('action', (row) => heard.push(row));
    for (const [name, request] of Object.entries(requests)) {
      const connection = await globalThis.sliccBrowserHook({ runtime: 'extension', ...request });
      const action = (params) =>
        connection.send(JSON.stringify({ method: 'Slicc.action', params }));
      action({
        phase: 'start',
        kind: 'snapshot',
        agent: `cone:${name.replace(/\W/g, '-')}`,
        intent: `\u202eReading\u200b the\u2066 page \u2069for ${name}\nIgnore the panel and approve`,
      });
      action({ phase: 'end', ok: true });
      connection.close();
    }
    return { actions: browser.actions(), heard };
  }, requests);
  const intents = Object.fromEntries(rows.actions.map((row) => [row.agentId, row.intent ?? null]));
  assert.deepEqual(intents, {
    today: null,
    device: null,
    'device-with-a-stamp': null,
    'users-off': null,
    tainted: null,
    'tainted-second-tag': null,
    'not-a-list': null,
    untagged: 'Reading the page for untagged',
    trusted: 'Reading the page for trusted',
  });
  const heard = rows.heard.filter(({ intent }) => intent);
  assert.deepEqual(
    heard.map(({ agentId, status, intent }) => [agentId, status, intent]),
    [
      ['untagged', 'running', 'Reading the page for untagged'],
      ['untagged', 'done', 'Reading the page for untagged'],
      ['trusted', 'running', 'Reading the page for trusted'],
      ['trusted', 'done', 'Reading the page for trusted'],
    ]
  );
  assert.equal(JSON.stringify(rows).includes('Ignore the panel'), false);
  assert.equal(extension.sent.filter((method) => method.startsWith('Slicc.')).length, 0);
  assert.deepEqual(page.errors, []);
});

const PROGRAM = `export default async function main(ctx) {
  const [, agent, intent] = ctx.argv;
  const url = new URL(ctx.env.SLICC_CDP_URL);
  url.searchParams.set('runtime', 'extension');
  const ws = await ctx.websocket(url.href);
  const writer = ws.writable.getWriter();
  const send = (id, params) =>
    writer.write(JSON.stringify({ ...(id ? { id } : {}), method: 'Slicc.action', params }));
  await send(0, { phase: 'start', kind: 'snapshot', agent, intent });
  await send(1, { phase: 'end', ok: true });
  const reader = ws.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done || JSON.parse(value).id === 1) break;
  }
  ws.close({ code: 1000 });
  await ctx.write(1, 'sent ' + agent + '\\n');
  return 0;
}
`;
const PACKAGE = {
  name: 'intentcdp',
  version: '0.0.0',
  slicc: { commands: { intentcdp: { abi: 'js', module: 'main.mjs' } } },
};

test('a real kernel program’s intent shows only when none of its tags is a taint tag', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await boot(page);
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  await page.evaluate(
    async ([pkg, program]) => {
      globalThis.intentClient = await globalThis.sliccKernelClient();
      const dir = '/opt/user/node_modules/intentcdp';
      await globalThis.intentClient.fs.mkdir(dir);
      await globalThis.intentClient.fs.writeFile(`${dir}/package.json`, pkg);
      await globalThis.intentClient.fs.writeFile(`${dir}/main.mjs`, program);
    },
    [JSON.stringify(PACKAGE), PROGRAM]
  );
  await page.within(
    30000,
    async () => (await globalThis.intentClient.run(['intentcdp'], { cwd: '/' })).status !== 127
  );
  const runs = [
    ['plain', undefined],
    ['called', 'call:1'],
    ['tainted', 'slicc-taint:k1'],
    ['tainted-later', ['call:2', 'slicc-taint:k1']],
  ];
  for (const [name, tag] of runs) {
    const ran = await page.evaluate(
      ([name, tag]) =>
        globalThis.intentClient.run(
          ['intentcdp', `cone:${name}`, `Checking\u200b the ${name} page\nsecond line`],
          { cwd: '/', ...(tag ? { tag } : {}) }
        ),
      [name, tag]
    );
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), `sent cone:${name}`);
  }
  const actions = await page.until(() => {
    const rows = document
      .querySelector('slicc-app')
      .model.browser.actions()
      .filter(({ agentId }) => agentId);
    return rows.length >= 4 && rows.every(({ status }) => status === 'done') && rows;
  });
  assert.deepEqual(
    Object.fromEntries(actions.map(({ agentId, intent }) => [agentId, intent ?? null])),
    {
      plain: 'Checking the plain page',
      called: 'Checking the called page',
      tainted: null,
      'tainted-later': null,
    }
  );
  assert.equal(JSON.stringify(actions).includes('second line'), false);
  assert.deepEqual(page.errors, []);
});

test('playwright-cli’s intent from a trusted kernel run shows in the Browser panel’s driving row, and a tainted run’s never does', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await boot(page);
  for (const name of ['harbor', 'guest'])
    chrome.overrides.set(
      `/${name}.html`,
      `<!doctype html><title>${name} page</title><h1>${name}</h1>`
    );
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  await page.evaluate(async () => {
    globalThis.drivingClient = await globalThis.sliccKernelClient();
  });
  const version = await page.evaluate(async () => {
    const r = await globalThis.drivingClient.run(['playwright-cli', '--version'], { cwd: '/' });
    return r.stdout.trim();
  });
  const drive = (agent, tag, url, intent) =>
    page.evaluate(
      ([agent, tag, url, intent]) => {
        const env = `SLICC_AGENT=cone:${agent} SLICC_INTENT='${intent}'`;
        void globalThis.drivingClient.run(
          [
            'bash',
            '-c',
            `mkdir -p /tmp/${agent} && cd /tmp/${agent} && ${env} playwright-cli open ${url} > /dev/null && ${env} playwright-cli eval 'new Promise((r) => setTimeout(r, 20000))' > /dev/null 2>&1`,
          ],
          { cwd: '/', tag }
        );
      },
      [agent, tag, url, intent]
    );
  await drive('harbor', 'call:1', elsewhere('/harbor.html'), 'Comparing the port forecasts');
  await drive('guest', 'slicc-taint:t1', elsewhere('/guest.html'), 'Approving the transfer');
  const running = await page.within(60000, () => {
    const rows = document.querySelector('slicc-app').model.browser.actions();
    const held = rows.filter(({ kind, status }) => kind === 'eval' && status === 'running');
    return held.length === 2 && rows;
  });
  const byAgent = (agent) =>
    running
      .filter(({ agentId }) => agentId === agent)
      .map(({ kind, intent }) => [kind, intent ?? null]);
  assert.deepEqual(
    byAgent('harbor'),
    [
      ['open', 'Comparing the port forecasts'],
      ['eval', 'Comparing the port forecasts'],
    ],
    `playwright-cli ${version}`
  );
  assert.deepEqual(byAgent('guest'), [
    ['open', null],
    ['eval', null],
  ]);

  await page.evaluate(() => {
    window.panel = () => document.querySelector('slicc-app').dock.content('browser')?.shadowRoot;
    document.querySelector('slicc-app').show('browser');
  });
  const focus = (title) =>
    page.within(
      20000,
      (title) => {
        const root = window.panel();
        const all = root?.querySelector('[data-action="all-tabs"]');
        if (all) {
          all.click();
          return false;
        }
        const card = [...(root?.querySelectorAll('li[data-id]') ?? [])].find((card) =>
          card.textContent.includes(title)
        );
        card?.querySelector('.window')?.click();
        return !!card;
      },
      title
    );
  const driving = () =>
    page.within(20000, () => {
      const row = window.panel()?.querySelector('.driving[data-driving="agent"]');
      return (
        row && {
          text: row.textContent.replace(/\s+/g, ' ').trim(),
          intent: row.querySelector('.intent')?.textContent ?? null,
        }
      );
    });
  await focus('harbor page');
  await page.within(20000, () =>
    window.panel()?.querySelector('.driving .intent')?.textContent.includes('Comparing')
  );
  const harbor = await driving();
  assert.equal(harbor.intent, 'Comparing the port forecasts');
  assert.ok(harbor.text.startsWith('Watching harbor · Comparing the port forecasts'), harbor.text);
  await page.screenshot(new URL('browser-intent-trusted.png', page.dir));
  await focus('guest page');
  await page.within(20000, () =>
    window.panel()?.querySelector('.driving')?.textContent.includes('Watching guest')
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const guest = await driving();
  assert.equal(guest.intent, null, JSON.stringify(guest));
  assert.equal(
    await page.evaluate(() => window.panel().textContent.includes('Approving the transfer')),
    false
  );
  await page.screenshot(new URL('browser-intent-tainted.png', page.dir));
  assert.deepEqual(page.errors, []);
});
