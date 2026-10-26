import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { agentUp, connectAccount, listsAccount, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { eventFrame, fakeLlm } from './fake-llm.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';

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

const bodies = [];

function answer(body) {
  bodies.push(body.toString());
  let sent = {};
  try {
    sent = JSON.parse(body.toString());
  } catch {}
  const content = sent.messages?.at(-1)?.content ?? [];
  const said = content.map((item) => item.text ?? '').join(' ');
  const result = content.find((item) => item.toolResult)?.toolResult?.toolUseId;
  if (result === 'grant-1') return text('The harbor token reached the command.');
  if (sent.toolConfig?.tools?.length && said.includes('Use the harbor token'))
    return bash('grant-1', 'printenv HARBOR_TOKEN; printf "%s" "$HARBOR_TOKEN" | wc -c');
  if (result === 'bytes-1') return text('The output came through.');
  if (sent.toolConfig?.tools?.length && said.includes('Show the bytes'))
    return bash(
      'bytes-1',
      `jq --version; echo '{"a":1}' | jq -c .; printf 'cat-said-hi\\n' > /tmp/c && cat /tmp/c; echo bytes-$((40 + 2))`
    );
  if (result === 'sudo-1') return text('Seven said no, so I left /root alone.');
  if (result === 'rules-1') return text('Seven said no, so the secret rules are unchanged.');
  if (sent.toolConfig?.tools?.length && said.includes('Change the rules'))
    return bash('rules-1', 'echo allow = true | sudo tee /etc/fnox/config.toml');
  if (sent.toolConfig?.tools?.length && said.includes('List root'))
    return bash('sudo-1', 'whoami; sudo ls -la /root');
  return text('Done.');
}

const KIMI = 'https://auth.kimi.com/api/oauth/';
const DEVICE = {
  device: 'dev-code-4f1c2b9e7a',
  user: 'HRBR-7K2Q',
  access: 'kimi-access-token-9c3e1d5f',
  refresh: 'kimi-refresh-token-2a8b6e0d',
  approved: false,
};
const asked = [];
const json = (status, value) => ({
  status,
  headers: [['content-type', 'application/json']],
  body: Buffer.from(JSON.stringify(value)),
});

function kimi(url, body) {
  const form = new URLSearchParams(body);
  if (url === `${KIMI}device_authorization`)
    return json(200, {
      device_code: DEVICE.device,
      user_code: DEVICE.user,
      verification_uri: 'https://auth.kimi.example/device',
      verification_uri_complete: 'https://auth.kimi.example/device',
      interval: 1,
      expires_in: 600,
    });
  if (url !== `${KIMI}token` || form.get('device_code') !== DEVICE.device)
    return json(400, { error: 'invalid_request' });
  if (!DEVICE.approved) return json(400, { error: 'authorization_pending' });
  return json(200, {
    access_token: DEVICE.access,
    refresh_token: DEVICE.refresh,
    token_type: 'Bearer',
    expires_in: 3600,
  });
}

const chrome = await launch({ intercept: [], agent: true, timeout: 60000 });
const llm = await fakeLlm(chrome.cdp, {
  hosts: [BEDROCK, KIMI, 'https://registry.npmjs.org/'],
  answer: async (request, body) => {
    asked.push({ url: request.url, body: body.toString() });
    if (request.url.startsWith(KIMI)) return kimi(request.url, body.toString());
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
  await llm.close();
  await chrome.close();
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

async function click(page, id, decision) {
  await page.until(
    new Function(
      'id',
      'decision',
      `const list = document.querySelector('slicc-app').model.approvals.list();
      if (!list.some((item) => item.id === id)) return true;
      const dialog = (${find})('slicc-approvals')?.shadowRoot?.querySelector('dialog[data-approval="' + id + '"]');
      dialog?.querySelector('[data-action="full-command"][aria-expanded="false"]')?.click();
      dialog?.querySelector('[data-command], [data-summary]')?.scrollIntoView({ block: 'end' });
      dialog?.querySelector('[data-action="' + decision + '"]')?.click();
      return false;`
    ),
    id,
    decision
  );
}

async function shots(page, name) {
  await page.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await shade(page, 'light');
  await page.screenshot(new URL(`${name}-light.png`, page.dir));
  await shade(page, 'dark');
  await page.screenshot(new URL(`${name}-dark.png`, page.dir));
  await shade(page, 'light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await new Promise((resolve) => setTimeout(resolve, 800));
  await page.screenshot(new URL(`${name}-420.png`, page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
}

const shade = (page, value) =>
  page.evaluate((value) => {
    const app = document.querySelector('slicc-app');
    if (app.color !== value) app.toggleColor();
  }, value);

test('enforce: a cone agent’s sudo asks the human through the agent’s approvals, naming the agent, Deny refuses it, and Always is refused where bios didn’t offer it', {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page, ['slicc:/home# ']);
  await agentUp(page);
  await listsAccount(page, 'amazon-bedrock');
  await connectAccount(page, 'amazon-bedrock', KEY);
  await page.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
    const { agent } = document.querySelector('slicc-app').model;
    document.querySelector('slicc-app').show('chat');
    void agent.send(agent.active(), 'List root’s home');
  });
  const [asked] = await page.within(5 * 60 * 1000, () => {
    const list = document.querySelector('slicc-app').model.approvals.list();
    return list.length ? list : null;
  });
  assert.equal(asked.kind, 'sudo');
  assert.equal(asked.command, '/usr/bin/ls -la /root');
  assert.deepEqual([asked.requester.kind, asked.requester.agentId], ['agent', 'cone']);
  assert.equal(asked.target, 'root');
  assert.equal(asked.cwd, '/home/cone');
  await page.until(
    new Function(
      'id',
      `return !!(${find})('slicc-approvals')?.shadowRoot?.querySelector('dialog[data-approval="' + id + '"]')`
    ),
    asked.id
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await shots(page, 'agent-sudo');
  await click(page, asked.id, 'deny');
  await page.within(5 * 60 * 1000, () => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return !agent.busy(id) && JSON.stringify(agent.messages(id)).includes('left /root alone');
  });
  const output = await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify(agent.messages(agent.active()));
  });
  assert.match(output, /approval denied/);
  assert.match(output, /\bcone\b/);

  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Change the rules');
  });
  const [rules] = await page.within(5 * 60 * 1000, () => {
    const list = document.querySelector('slicc-app').model.approvals.list();
    return list.length ? list : null;
  });
  assert.equal(rules.command, '/usr/bin/tee /etc/fnox/config.toml');
  assert.equal(rules.always, false);
  const buttons = await page.until(
    new Function(
      'id',
      `const dialog = (${find})('slicc-approvals')?.shadowRoot?.querySelector('dialog[data-approval="' + id + '"]');
      return dialog?.querySelector('[data-secret-rules]') && [...dialog.querySelectorAll('[data-action]')].map((b) => b.dataset.action);`
    ),
    rules.id
  );
  assert.deepEqual(buttons.sort(), ['deny', 'once']);
  await shots(page, 'agent-secret-rules');
  const forced = await page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.approvals.decide(id, 'always')
        .then(
          () => 'decided',
          (error) => error.message
        ),
    rules.id
  );
  assert.match(forced, /Always isn.t offered/);
  await click(page, rules.id, 'deny');
  await page.within(5 * 60 * 1000, () => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return !agent.busy(id);
  });
  assert.doesNotMatch(
    await page.evaluate(async () => {
      let dir = await navigator.storage.getDirectory();
      try {
        for (const part of ['etc', 'sudoers.d']) dir = await dir.getDirectoryHandle(part);
        return await (await (await dir.getFileHandle('cone')).getFile()).text();
      } catch {
        return '';
      }
    }),
    /fnox/
  );
  assert.deepEqual(page.errors, []);
});

test('kernel#1099: with a secret in the vault, the agent’s bash shows jq’s and cat’s output intact, as the vault scrubs it, and whatever endpoints the agent’s worker sets go only to its own agent port', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  chrome.vault.set({ secrets: ['API_TOKEN'] });
  t.after(() => chrome.vault.set({ secrets: [] }));
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page, ['slicc:/home# ']);
  await agentUp(page);
  await listsAccount(page, 'amazon-bedrock');
  await connectAccount(page, 'amazon-bedrock', KEY);
  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    document.querySelector('slicc-app').show('chat');
    void agent.send(agent.active(), 'Show the bytes');
  });
  await page.within(5 * 60 * 1000, () => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return (
      !agent.busy(id) && JSON.stringify(agent.messages(id)).includes('The output came through')
    );
  });
  const output = await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify(agent.messages(agent.active()));
  });
  assert.doesNotMatch(output, /must be bytes/);
  assert.match(output, /jq-1\.8/);
  assert.match(output, /\{\\"a\\":1\}/);
  assert.match(output, /cat-said-hi/);
  assert.match(output, /bytes-42/);
  assert.ok(chrome.vault.log.some((entry) => entry.role === 'agent' && entry.op === 'push'));
  const sent = chrome.vault.log.filter((entry) => /^endpoints/.test(entry.op));
  assert.deepEqual(
    sent.filter((entry) => entry.role !== 'agent'),
    [],
    'endpoints reached the vault on a port other than the agent’s'
  );
  assert.deepEqual(page.errors, []);
});

const HARBOR = 'dummy-harbor-value-0123456789';
const HARBOR_SEALED = 'fnox_proxy_00000000000000000000beef';
const fnoxConfig = (extra = '') =>
  `default_provider = "seven"\n\n[providers.seven]\ntype = "sealed"\n\n[providers.plain]\ntype = "plain"\n\n[secrets]\nHARBOR_TOKEN = { provider = "seven", value = "${HARBOR_SEALED}" }\n${extra}`;

async function secretsListed(page, needle) {
  return page
    .within(
      5 * 60 * 1000,
      (needle) => {
        const { agent } = document.querySelector('slicc-app').model;
        const id = agent.active();
        const text = JSON.stringify(agent.messages(id));
        return !agent.busy(id) && text.includes(needle) && text;
      },
      needle
    )
    .catch(async (error) => {
      const seen = await page.evaluate(() => {
        const { agent } = document.querySelector('slicc-app').model;
        return JSON.stringify(agent.messages(agent.active())).slice(-3000);
      });
      throw new Error(
        `${error.message}\nno ${needle} in: ${seen}\nconsole: ${page.console.join('\n').slice(-2000)}`
      );
    });
}

test('slicc-agent#459: on a fresh profile the agent lists a sealed fnox secret with its placeholder, a shell-granted one reaches a command, no value reaches the prompt or the output, and an unsealed env secret turns shell grants off by name', {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  chrome.vault.set({
    records: [
      {
        kind: 'secret',
        name: 'HARBOR_TOKEN',
        value: HARBOR,
        source: 'settings',
        placeholder: HARBOR_SEALED,
        exec: 'shell',
      },
    ],
    version: 1,
  });
  t.after(() => chrome.vault.set({ secrets: [] }));
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page, ['slicc:/home# ']);
  const write = (config) =>
    page.evaluate(async (config) => {
      const client = await globalThis.sliccKernelClient();
      const { status, stderr } = await client.run(
        ['bash', '-c', 'printf "%s" "$1" > /etc/fnox/config.toml', 'fnox', config],
        { cwd: '/' }
      );
      return status === 0 ? 'ok' : stderr;
    }, config);
  assert.equal(await write(fnoxConfig()), 'ok');
  await agentUp(page);
  await listsAccount(page, 'amazon-bedrock');
  await connectAccount(page, 'amazon-bedrock', KEY);
  const asked = bodies.length;
  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    document.querySelector('slicc-app').show('chat');
    void agent.send(agent.active(), '/secrets');
  });
  const listed = await secretsListed(page, 'The user listed secrets: HARBOR_TOKEN.');
  assert.doesNotMatch(listed, /Secrets are unavailable/);

  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Use the harbor token');
  });
  const used = await secretsListed(page, 'The harbor token reached the command');
  assert.match(
    used,
    new RegExp(`${HARBOR_SEALED}\\\\n${HARBOR.length}\\\\n`),
    `${used.slice(-1500)}\nvault: ${JSON.stringify(chrome.vault.log.filter((entry) => /materiali|consum|sealed|stamp/.test(entry.op)).slice(-12))}`
  );
  const prompts = bodies.slice(asked).join('\n');
  assert.ok(prompts.includes(HARBOR_SEALED), 'the prompt never named the placeholder');
  assert.doesNotMatch(prompts, /Secrets are unavailable/);
  assert.ok(!prompts.includes(HARBOR), 'an unsealed value reached the prompt');
  assert.ok(!used.includes(HARBOR), 'an unsealed value reached a command’s output');

  assert.equal(
    await write(fnoxConfig('LOOSE_TOKEN = { provider = "plain", value = "loose-value" }\n')),
    'ok'
  );
  await page.reload();
  await ready(page, ['slicc:/home# ']);
  await agentUp(page);
  const before = bodies.length;
  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), '/secrets');
  });
  const off = await secretsListed(page, 'LOOSE_TOKEN');
  assert.match(
    off,
    /Shell grants are off: fnox exec would also give every command the unsealed fnox secrets LOOSE_TOKEN/
  );
  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Use the harbor token');
  });
  const outputs = await page
    .within(
      5 * 60 * 1000,
      (count) => {
        const { agent } = document.querySelector('slicc-app').model;
        const messages = agent.messages(agent.active());
        const runs = messages
          .flatMap((message) => message.parts ?? [])
          .filter((part) => part.type === 'tool' && part.tool?.id === 'grant-1')
          .map((part) => part.tool.output);
        const done =
          JSON.stringify(messages).split('The harbor token reached the command').length > count;
        return !agent.busy(agent.active()) && done && runs;
      },
      2
    )
    .catch(async (error) => {
      const seen = await page.evaluate(() => {
        const { agent } = document.querySelector('slicc-app').model;
        return JSON.stringify(agent.messages(agent.active())).slice(-3000);
      });
      throw new Error(
        `${error.message}\nwaited for a second "The harbor token reached the command" from an idle agent, in: ${seen}`
      );
    });
  const ungranted = outputs.at(-1);
  assert.doesNotMatch(ungranted, new RegExp(`${HARBOR_SEALED}|\\b${HARBOR.length}\\b`), ungranted);
  assert.match(ungranted, /^\s*0\s*$/, ungranted);
  const later = bodies.slice(before).join('\n');
  assert.match(later, /Shell grants are off[^"]*LOOSE_TOKEN/);
  assert.ok(!later.includes(HARBOR), 'an unsealed value reached the prompt');
  assert.deepEqual(page.errors, []);
});

test('slicc-agent 6.12+: without a CORS-free route, a provider that needs one shows as blocked, neither missing nor failing, and one that doesn’t stays open', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page, ['slicc:/home# ']);
  await agentUp(page);
  const offered = await page.within(5 * 60 * 1000, () => {
    const providers = document.querySelector('slicc-app').model.settings.providers?.() ?? [];
    return (
      providers.length > 10 &&
      providers.map(({ id, blocked }) => ({ id, blocked: blocked ?? null }))
    );
  });
  const by = Object.fromEntries(offered.map(({ id, blocked }) => [id, blocked]));
  assert.equal(by.cerebras, 'cors-free-transport', JSON.stringify(offered));
  assert.equal(by.anthropic, null, JSON.stringify(offered));
  assert.equal(by['amazon-bedrock'], null, JSON.stringify(offered));
  assert.deepEqual(page.errors, []);
});

test('slicc-agent 6.16+: a Kimi device-code sign-in shows its user code, ends with the token sealed in the vault by the agent’s grant, and no device code or token reaches a URL, the page, its console or the vault log', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  t.after(() => {
    DEVICE.approved = false;
  });
  const page = await chrome.page(t);
  await page.init('() => { window.open = () => null; }');
  await page.init(() => {
    Object.defineProperty(globalThis, 'sliccExtension', {
      value: Object.freeze({ fetch: (input, init) => fetch(input, init) }),
    });
  });
  await page.goto('/');
  await ready(page, ['slicc:/home# ']);
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.transport),
    'extension',
    'Kimi needs a CORS-free transport, which slicc-extension’s fetch gives seven'
  );
  await agentUp(page);
  await page.within(5 * 60 * 1000, () =>
    (document.querySelector('slicc-app').model.settings.providers?.() ?? []).some(
      (provider) => provider.id === 'kimi-coding' && !provider.blocked
    )
  );
  const before = asked.length;
  const logged = chrome.vault.log.length;
  await page.evaluate(() => {
    window.signedIn = document
      .querySelector('slicc-app')
      .model.settings.connect('kimi-coding')
      .then(
        () => 'ok',
        (error) => error.message
      );
  });
  const prompt = await page.within(5 * 60 * 1000, () => {
    const account = document
      .querySelector('slicc-app')
      .model.settings.accounts()
      .find((item) => item.id === 'kimi-coding');
    return account?.status === 'signing-in' && account.signIn?.code && account.signIn;
  });
  assert.deepEqual(prompt, { url: 'https://auth.kimi.example/device', code: DEVICE.user });
  for (
    let tries = 0;
    tries < 120 && !asked.slice(before).some((item) => item.url === `${KIMI}token`);
    tries += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 500));
  DEVICE.approved = true;
  assert.equal(await page.within(5 * 60 * 1000, () => window.signedIn), 'ok');
  const account = await page.within(60000, () =>
    document
      .querySelector('slicc-app')
      .model.settings.accounts()
      .find((item) => item.id === 'kimi-coding' && item.status === 'connected')
  );
  assert.equal(account.identity, 'Signed in');

  const grants = chrome.vault.log.slice(logged).filter((entry) => entry.op === 'grant-fields');
  assert.equal(grants.length, 1, JSON.stringify(grants));
  assert.equal(grants[0].role, 'agent');
  assert.equal(grants[0].provider, 'kimi-coding');
  const record = chrome.vault.state.records?.find((item) => item.name === grants[0].name);
  assert.equal(record?.value, DEVICE.access);
  assert.equal(record.kind, 'model');
  const listed = await page.evaluate(
    (name) =>
      document
        .querySelector('slicc-app')
        .model.vault.list()
        ?.secrets.find((item) => item.name === name),
    grants[0].name
  );
  assert.match(listed?.placeholder ?? '', /^fnox_proxy_/);

  const calls = asked.slice(before).filter((item) => item.url.startsWith(KIMI));
  assert.ok(
    calls.some((item) => item.url === `${KIMI}token`),
    JSON.stringify(calls)
  );
  const urls = asked.slice(before).map((item) => item.url);
  const page_ = JSON.stringify(
    await page.evaluate(() => ({
      href: location.href,
      accounts: document.querySelector('slicc-app').model.settings.accounts(),
      vault: document.querySelector('slicc-app').model.vault.list(),
      storage: { ...localStorage },
    }))
  );
  for (const secret of [DEVICE.device, DEVICE.access, DEVICE.refresh]) {
    assert.ok(!urls.some((url) => url.includes(secret)), `${secret} reached a URL`);
    assert.ok(!page.console.join('\n').includes(secret), `${secret} reached the console`);
    assert.ok(
      !JSON.stringify(chrome.vault.log).includes(secret),
      `${secret} reached the vault log`
    );
    assert.ok(!page_.includes(secret), `${secret} reached the page`);
  }
  assert.ok(!urls.some((url) => url.includes(DEVICE.user)), 'the user code reached a URL');
  assert.deepEqual(page.errors, []);
});
