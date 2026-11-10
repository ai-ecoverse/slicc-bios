import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { agentUp, connectAccount, listsAccount, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { clearForcedForbidden, forceForbidden, judgeAnswers, judgeTrace } from './fake-judge.mjs';
import { eventFrame, fakeLlm } from './fake-llm.mjs';

const KEY = 'dummy-bedrock-key-0000';
const ADOBE_TOKEN = 'dummy-adobe-token-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const ADOBE = 'https://adobe-llm-proxy.paolo-moz.workers.dev/';
const JQ = /\/jq \.rules \/etc\/slicc\/secrets-policy\.toml$/;

const said = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', {
    contentBlockIndex: 0,
    delta: { text: 'It reads a file and changes nothing.' },
  }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'end_turn' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    metrics: { latencyMs: 1 },
  }),
]);

const judged = [];
const verdict = (body) => judgeAnswers(body, (input) => judged.push(input));

const json = (value) => ({
  status: 200,
  headers: [['content-type', 'application/json']],
  body: Buffer.from(JSON.stringify(value)),
});

const chrome = await launch({ intercept: [], agent: true, timeout: 60000 });
const llm = await fakeLlm(chrome.cdp, {
  hosts: [BEDROCK, ADOBE, 'https://registry.npmjs.org/'],
  answer: async (request, body) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    if (request.url.startsWith(`${ADOBE}v1/ai/run`)) return json(verdict(body));
    if (request.url.startsWith(`${ADOBE}v1/config`))
      return json({
        clientId: 'test-client',
        scopes: 'openid,AdobeID',
        imsEnvironment: 'prod',
        models: [],
      });
    if (request.url.startsWith(ADOBE))
      return json({
        usage: { weekly: { status: 'ok', percent: 42, resetsAt: '2026-10-15T00:00:00Z' } },
      });
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: said,
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

const buttons = (page, id) =>
  page.until(
    new Function(
      'id',
      `const dialog = (${find})('slicc-approvals')?.shadowRoot?.querySelector('dialog[data-approval="' + id + '"]');
      const actions = dialog && [...dialog.querySelectorAll('[data-action]')].map((b) => b.dataset.action);
      return actions?.includes('once') ? actions.filter((a) => ['always', 'once', 'deny', 'stop'].includes(a)).sort() : null;`
    ),
    id
  );

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

const decide = (page, id, decision) =>
  page.evaluate(
    ([id, decision]) =>
      document
        .querySelector('slicc-app')
        .model.approvals.decide(id, decision)
        .then(
          () => 'decided',
          (error) => error.message
        ),
    [id, decision]
  );

const closed = (page) =>
  page.until(
    new Function(
      `const dialog = (${find})('slicc-approvals')?.shadowRoot?.querySelector('dialog');
      if (!dialog) return true;
      dialog.querySelector('[data-action="close"]')?.click();
      return false;`
    )
  );

const sudoers = (page) =>
  page.evaluate(async () => {
    let dir = await navigator.storage.getDirectory();
    try {
      for (const part of ['etc', 'sudoers.d']) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle('cone')).getFile()).text();
    } catch {
      return '';
    }
  });

const dumpApprovals = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.approvals.list()
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        command: item.command,
        always: item.always,
        requester: item.requester,
        verdict: item.verdict ?? null,
        verdictError: item.verdictError ?? null,
        judging: item.judging ?? false,
      }))
  );

async function asked(page, pattern, until = () => true) {
  const source = pattern.source;
  return page
    .within(
      5 * 60 * 1000,
      new Function(
        'source',
        `const item = document.querySelector('slicc-app').model.approvals.list().find((entry) => entry.kind === 'sudo' && new RegExp(source).test(entry.command));
        return item && (${until})(item) ? item : null;`
      ),
      source
    )
    .catch(async (error) => {
      const terminal = await screen(page).catch(() => '');
      throw new Error(
        `${error.message}\napprovals: ${JSON.stringify(await dumpApprovals(page))}\ntrace: ${JSON.stringify(judgeTrace())}\nterminal: ${JSON.stringify(terminal).slice(-2000)}\njudged: ${JSON.stringify(judged).slice(-3000)}`
      );
    });
}

const approver = (page, value) =>
  page.evaluate(async (value) => {
    const { joinSwitchboard } = await import('/os/tabs.js');
    const { connectAgent } = await import(
      '/opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist/page.js'
    );
    window.policyBoard ??= await joinSwitchboard({ visible: false });
    const { agent } = await window.policyBoard.ports(['agent']);
    const connection = await connectAgent(agent);
    try {
      const { policy, error } = await connection.control.approvalPolicySet({
        sudo: { approver: value },
      });
      return error ?? policy.sudo.approver;
    } finally {
      connection.close();
    }
  }, value);

const judgedFor = (pattern) =>
  judged.find((input) =>
    pattern.test(String(input.state?.request?.untrusted ?? '').split('\n')[1] ?? '')
  );

test('with the agent up, bios hands each sudo to the agent with the kernel’s facts, Always only where the kernel can record the line, a person grants Always, and an unrecordable line offers no Always', {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page, ['slicc:/home# ']);
  await agentUp(page);
  await listsAccount(page, 'amazon-bedrock');
  await connectAccount(page, 'amazon-bedrock', KEY);
  await connectAccount(page, 'adobe', ADOBE_TOKEN);
  await page.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
    window.offers = [];
    document.querySelector('slicc-app').model.approvals.on('approvals', (list) => {
      for (const item of list) window.offers.push([item.command, item.always]);
    });
  });

  await run(
    page,
    'clear; cd /; sudo -u cone sudo jq .rules /etc/slicc/secrets-policy.toml; echo jq-ran'
  );
  const jq = await asked(page, JQ, (item) => item.always === true);
  assert.equal(jq.requester.kind, 'user');
  assert.equal(jq.cwd, '/');
  assert.equal(jq.always, true);
  assert.equal(jq.verdict?.level, 1);
  assert.equal(jq.verdict?.aligned, true);
  assert.equal(jq.verdictError, undefined);
  assert.match(jq.verdict?.reason ?? '', /reads or lists|read or inspect/i);
  const offers = await page.evaluate(() => window.offers);
  const seen = offers.filter(([command]) => JQ.test(command)).map(([, always]) => always);
  assert.equal(seen[0], false, JSON.stringify(offers));
  assert.equal(seen.at(-1), true, JSON.stringify(offers));
  const facts = judgedFor(JQ);
  assert.ok(facts, JSON.stringify(judged).slice(-3000));
  assert.deepEqual(facts.state.request.sudo, { stdin: 'tty', writable: true, rootOnly: true });
  assert.match(facts.state.request.untrusted, /path "\/": root-only/);
  assert.match(
    facts.state.request.untrusted,
    /path "\/etc\/slicc\/secrets-policy\.toml": root-only/
  );
  const askedIds = judged.map((input) => Object.keys(input.questions ?? {}));
  assert.ok(
    askedIds.some(
      (ids) => ids.includes('changes') && ids.includes('plain') && ids.includes('always')
    ),
    JSON.stringify(askedIds)
  );
  assert.ok(
    askedIds.some((ids) => ids.includes('wants_read')),
    JSON.stringify(askedIds)
  );
  const forbidCalls = judged.filter((input) =>
    Object.keys(input.questions ?? {}).includes('forbidden')
  );
  assert.ok(forbidCalls.length >= 2, JSON.stringify(forbidCalls.map((input) => input.state)));
  const nonces = forbidCalls.map(
    (input) => String(input.state?.request?.untrusted ?? '').match(/untrusted-([^>\s]+)/)?.[1]
  );
  assert.equal(new Set(nonces.filter(Boolean)).size >= 2, true, JSON.stringify(nonces));
  assert.doesNotMatch(await sudoers(page), /jq \.rules \/etc\/slicc\/secrets-policy\.toml/);
  assert.deepEqual(await buttons(page, jq.id), ['always', 'deny', 'once']);
  await click(page, jq.id, 'always');
  await shows(page, 'jq-ran');
  await closed(page);
  assert.match(
    await sudoers(page),
    /Cwd \/ Stdin none Cmnd \S*jq \.rules \/etc\/slicc\/secrets-policy\.toml/
  );
  await page.evaluate(() => {
    window.offers = [];
  });
  await run(
    page,
    'clear; cd /; sudo -u cone sudo jq .rules /etc/slicc/secrets-policy.toml; echo jq-again'
  );
  await shows(page, 'jq-again');
  assert.deepEqual(await page.evaluate(() => window.offers), []);
  await run(
    page,
    "clear; cd /; sudo -u cone sudo -k; echo '{}' | sudo -u cone sudo jq .rules /etc/slicc/secrets-policy.toml; echo piped=$?"
  );
  const piped = await asked(page, JQ);
  await click(page, piped.id, 'deny');
  await shows(page, 'piped=1');

  await run(page, 'clear; cd /; sudo -u cone sudo id -gn; echo gn=$?');
  const gn = await asked(page, /\/id -gn$/, (item) => !!item.verdict);
  assert.equal(gn.always, false);
  assert.equal(judgedFor(/\/id -gn$/).state.request.sudo.writable, true);
  assert.equal(judgedFor(/\/id -gn$/).questions.always !== undefined, true);
  assert.deepEqual(await buttons(page, gn.id), ['deny', 'once']);
  await click(page, gn.id, 'once');
  await shows(page, 'gn=0');

  await run(page, 'clear; cd /; sudo -u cone sudo -k; sudo -u cone sudo id -Gn; echo Gn=$?');
  const Gn = await asked(page, /\/id -Gn$/, (item) => item.always === true);
  assert.equal(Gn.always, true);
  assert.deepEqual(await buttons(page, Gn.id), ['always', 'deny', 'once']);
  await click(page, Gn.id, 'always');
  await shows(page, 'Gn=0');
  assert.match(await sudoers(page), /Stdin none Cmnd \S*id -Gn/);

  await run(
    page,
    "clear; cd /; sudo -u cone sudo -k; sudo -u cone sudo printf '%s-' $'a\\rb'; echo cr=$?"
  );
  const cr = await asked(page, /\/printf /, (item) => !!item.verdict);
  assert.equal(cr.always, false);
  const crFacts = judgedFor(/\/printf /);
  assert.equal(crFacts.state.request.sudo.writable, false);
  assert.match(await decide(page, cr.id, 'always'), /Always isn.t offered/);
  assert.deepEqual(await buttons(page, cr.id), ['deny', 'once']);
  await click(page, cr.id, 'once');
  await shows(page, 'cr=0');
  assert.doesNotMatch(await sudoers(page), /printf/);

  forceForbidden(0.9);
  try {
    await run(page, 'clear; cd /; sudo -u cone sudo -k; sudo -u cone sudo id -u; echo vetoed=$?');
    const vetoed = await asked(page, /\/id -u$/, (item) => !!item.verdict);
    assert.equal(vetoed.always, false);
    assert.equal(vetoed.verdict?.level, 1);
    assert.deepEqual(await buttons(page, vetoed.id), ['deny', 'once']);
    await click(page, vetoed.id, 'deny');
    await shows(page, 'vetoed=1');
  } finally {
    clearForcedForbidden();
  }

  await run(
    page,
    'clear; cd /; sudo -u cone sudo /bin/rm -rf /tmp/slicc-judge-absent; echo rm-done=$?'
  );
  const rm = await asked(page, /\/rm /, (item) => !!(item.verdict || item.verdictError));
  assert.equal(rm.verdictError, undefined, JSON.stringify(rm));
  assert.equal(rm.requester.kind, 'user');
  assert.ok(rm.verdict?.level >= 2, JSON.stringify(rm.verdict));
  assert.equal(rm.always, false);
  assert.deepEqual(await buttons(page, rm.id), ['deny', 'once']);
  await click(page, rm.id, 'deny');
  await shows(page, 'rm-done=1');

  await run(page, 'clear; cd /; sudo -u cone sudo /bin/kill -0 1; echo kill-done=$?');
  const killed = await asked(page, /\/kill /, (item) => !!(item.verdict || item.verdictError));
  assert.equal(killed.verdictError, undefined, JSON.stringify(killed));
  assert.equal(killed.requester.kind, 'user');
  assert.ok(killed.verdict?.level >= 2, JSON.stringify(killed.verdict));
  assert.equal(killed.always, false);
  assert.deepEqual(await buttons(page, killed.id), ['deny', 'once']);
  await click(page, killed.id, 'deny');
  await shows(page, 'kill-done=1');

  await run(page, 'clear; cd /; sudo -u cone sudo -k; sudo -u cone sudo id -u; echo person=$?');
  const person = await asked(page, /\/id -u$/, (item) => !!item.verdict);
  assert.deepEqual(await buttons(page, person.id), ['always', 'deny', 'once']);
  await click(page, person.id, 'once');
  await shows(page, 'person=0');
  await closed(page);
  await page.evaluate(() => {
    window.offers = [];
  });
  await run(
    page,
    'clear; cd /; sudo -u cone sudo -n id -u; sudo -u cone sudo ls -la /etc > /dev/null; echo window=$?'
  );
  await shows(page, 'window=0');
  assert.match(await screen(page), /0\s+window=0/);
  assert.deepEqual(await page.evaluate(() => window.offers), []);
  await run(page, 'clear; cd /; sudo -u cone sudo -K; sudo -u cone sudo -n id -u; echo shut=$?');
  await shows(page, 'shut=1');
  assert.match(await screen(page), /a password is required/);

  assert.deepEqual(await approver(page, 'agent'), 'agent');
  try {
    await page.evaluate(() => {
      window.offers = [];
    });
    await run(
      page,
      'clear; cd /; sudo -u cone sudo ls -la /etc > /dev/null; echo judged=$?; sudo -u cone sudo -n ls -la /etc > /dev/null; echo unstamped=$?; echo judge-$((40 + 2))'
    );
    await shows(page, 'judge-42', 5 * 60 * 1000);
    const text = await screen(page);
    assert.match(text, /judged=0/, text);
    assert.match(text, /a password is required\s+unstamped=1/, text);
    assert.deepEqual(await page.evaluate(() => window.offers), []);
  } finally {
    assert.deepEqual(await approver(page, 'user'), 'user');
  }
  assert.deepEqual(page.errors, []);
});

const relabel = (page, version) =>
  page.evaluate(async (version) => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ['opt', 'agent', 'node_modules', '@ai-ecoverse', 'slicc-agent'])
      dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle('package.json');
    const manifest = JSON.parse(await (await handle.getFile()).text());
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify({ ...manifest, version }, null, 2));
    await writable.close();
  }, version);

test('a running agent older than 7.17.0 has no judge, so bios’s own dialog asks with once and deny only and records nothing', {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page, ['slicc:/home# ']);
  await agentUp(page);
  await listsAccount(page, 'amazon-bedrock');
  await connectAccount(page, 'amazon-bedrock', KEY);
  await connectAccount(page, 'adobe', ADOBE_TOKEN);
  await relabel(page, '7.16.1');
  await page.reload();
  await ready(page, ['slicc:/home# ']);
  await agentUp(page);
  const before = judged.length;
  await run(page, 'clear; cd /; sudo -u cone sudo id -Gn; echo older=$?');
  const item = await asked(page, /\/id -Gn$/);
  assert.match(item.id, /^sudo-/);
  assert.equal(item.always, false);
  assert.equal('verdict' in item, false);
  assert.deepEqual(await buttons(page, item.id), ['deny', 'once']);
  assert.match(await decide(page, item.id, 'always'), /Always isn.t offered/);
  await click(page, item.id, 'once');
  await shows(page, 'older=0');
  assert.equal(judged.length, before);
  assert.doesNotMatch(await sudoers(page), /id -Gn/);
  assert.deepEqual(page.errors, []);
});
