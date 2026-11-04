import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { agentUp, connectAccount, listsAccount, ready, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
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

function verdict(body) {
  const { input } = JSON.parse(body.toString());
  judged.push(input);
  const untrusted = input.state?.request?.untrusted ?? '';
  const replay = /\/id -gn\n/.test(untrusted) ? 0.9 : 0.02;
  const answers = {
    level: {
      type: 'choice',
      choice: 'routine',
      probabilities: { routine: 0.97, permissions: 0.02, harm: 0.01 },
      confidence: 0.97,
    },
    aligned: { type: 'noul', noul: 0.95 },
    always: { type: 'noul', noul: replay },
  };
  const asked = Object.keys(input.questions ?? {});
  return {
    success: true,
    result: { answers: Object.fromEntries(asked.map((id) => [id, answers[id]])) },
  };
}

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
      return actions?.includes('once') ? actions.filter((a) => ['always', 'once', 'deny'].includes(a)).sort() : null;`
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
      const list = await page.evaluate(() =>
        JSON.stringify(document.querySelector('slicc-app').model.approvals.list())
      );
      throw new Error(
        `${error.message}\napprovals: ${list}\njudged: ${JSON.stringify(judged).slice(-3000)}`
      );
    });
}

const judgedFor = (pattern) =>
  judged.find((input) =>
    pattern.test(String(input.state?.request?.untrusted ?? '').split('\n')[1] ?? '')
  );

test('with the agent up, bios hands each sudo to the agent with the kernel’s facts, Always comes only from the agent’s verdict, and a line the kernel can’t record offers no Always and records nothing', {
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
  assert.equal(await decide(page, jq.id, 'always'), 'decided');
  await shows(page, 'jq-ran');
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
    "clear; cd /; echo '{}' | sudo -u cone sudo jq .rules /etc/slicc/secrets-policy.toml; echo piped=$?"
  );
  const piped = await asked(page, JQ);
  await click(page, piped.id, 'deny');
  await shows(page, 'piped=1');

  await run(page, 'clear; cd /; sudo -u cone sudo id -gn; echo gn=$?');
  const gn = await asked(page, /\/id -gn$/, (item) => !!item.verdict);
  assert.equal(gn.always, false);
  assert.equal(judgedFor(/\/id -gn$/).state.request.sudo.writable, true);
  assert.deepEqual(await buttons(page, gn.id), ['deny', 'once']);
  await click(page, gn.id, 'once');
  await shows(page, 'gn=0');

  await run(page, 'clear; cd /; sudo -u cone sudo id -Gn; echo Gn=$?');
  const Gn = await asked(page, /\/id -Gn$/, (item) => item.always === true);
  assert.deepEqual(await buttons(page, Gn.id), ['always', 'deny', 'once']);
  await click(page, Gn.id, 'always');
  await shows(page, 'Gn=0');
  assert.match(await sudoers(page), /Stdin none Cmnd \S*id -Gn/);

  await run(page, "clear; cd /; sudo -u cone sudo printf '%s-' $'a\\rb'; echo cr=$?");
  const cr = await asked(page, /\/printf /, (item) => !!item.verdict);
  assert.equal(cr.always, false);
  const crFacts = judgedFor(/\/printf /);
  assert.equal(crFacts.state.request.sudo.writable, false);
  assert.match(await decide(page, cr.id, 'always'), /Always isn.t offered/);
  assert.deepEqual(await buttons(page, cr.id), ['deny', 'once']);
  await click(page, cr.id, 'once');
  await shows(page, 'cr=0');
  assert.doesNotMatch(await sudoers(page), /printf/);
  assert.deepEqual(page.errors, []);
});
