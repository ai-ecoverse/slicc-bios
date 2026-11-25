import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pressDeep, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeLlm } from './fake-llm.mjs';
import { fakeOpspile } from './fake-opspile.mjs';

const ADOBE = 'https://adobe-llm-proxy.paolo-moz.workers.dev/';
const SCOPES = 'openid,AdobeID,additional_info.projectedProductContext,additional_info.ownerOrg';
const MARA = 'dummy-support-token-mara-0000';
const JONAS = 'dummy-support-token-jonas-0000';
const SHORT = 'dummy-support-token-short-0000';
const SECRET = 'Builds fail since Monday.';
const accounts = {
  [MARA]: {
    name: 'Mara Lind',
    user: 'MARA1234@AdobeID',
    org: 'PAPERMILL@AdobeOrg',
    enrolled: true,
    expires: 86399,
  },
  [JONAS]: {
    name: 'Jonas Berg',
    user: 'JONAS5678@AdobeID',
    org: 'QUAYLABS@AdobeOrg',
    enrolled: false,
    expires: 86399,
  },
  [SHORT]: {
    name: 'Mara Lind',
    user: 'MARA1234@AdobeID',
    org: 'PAPERMILL@AdobeOrg',
    enrolled: true,
    expires: 36,
  },
};

const certs = mkdtempSync(join(tmpdir(), 'support-ims-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=ims-na1.adobelogin.com',
    '-keyout',
    join(certs, 'key.pem'),
    '-out',
    join(certs, 'cert.pem'),
  ],
  { stdio: 'ignore' }
);
const signIns = [MARA, JONAS, SHORT];
const authorized = [];
const profiles = [];
const cors = (req) => ({
  'access-control-allow-origin': req.headers.origin ?? '*',
  'access-control-allow-headers': 'authorization, accept',
  'access-control-allow-methods': 'GET',
});
const ims = createServer(
  { key: readFileSync(join(certs, 'key.pem')), cert: readFileSync(join(certs, 'cert.pem')) },
  (req, res) => {
    const url = new URL(req.url, 'https://ims-na1.adobelogin.com');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors(req));
      return res.end();
    }
    if (url.pathname === '/ims/profile/v1') {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      profiles.push(token);
      const account = accounts[token];
      res.writeHead(account ? 200 : 401, { 'content-type': 'application/json', ...cors(req) });
      return res.end(
        JSON.stringify(
          account
            ? {
                displayName: account.name,
                email: 'someone@example.com',
                userId: account.user,
                ownerOrg: account.org,
              }
            : { error: 'invalid_token' }
        )
      );
    }
    if (url.pathname !== '/ims/authorize/v2') {
      res.writeHead(404);
      return res.end();
    }
    authorized.push(Object.fromEntries(url.searchParams));
    const state = JSON.parse(Buffer.from(url.searchParams.get('state'), 'base64').toString());
    const token = signIns.shift();
    const target = `${state.origin}/auth/callback?nonce=${state.nonce}#access_token=${token}&token_type=bearer&expires_in=${accounts[token].expires}`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<script>location.replace(${JSON.stringify(target)});</script>`);
  }
);
await new Promise((resolve) => ims.listen(0, '127.0.0.1', resolve));

const chrome = await launch({
  intercept: [],
  args: [
    `--host-resolver-rules=MAP ims-na1.adobelogin.com:443 127.0.0.1:${ims.address().port}`,
    '--ignore-certificate-errors',
  ],
});
const origin = new URL(chrome.url).origin;
const opspile = fakeOpspile({ accounts });
const configs = [];
const network = await fakeLlm(chrome.cdp, {
  hosts: [ADOBE, `${origin}/api/support/`],
  answer: async (request, raw) => {
    if (request.url.startsWith(ADOBE)) {
      configs.push(request.url);
      return {
        status: 200,
        headers: [['content-type', 'application/json']],
        body: Buffer.from(
          JSON.stringify({
            clientId: 'experience-catalyst-prod',
            scopes: SCOPES,
            imsEnvironment: 'prod',
            models: [],
          })
        ),
      };
    }
    return opspile.answer(request, raw);
  },
});
after(async () => {
  ims.close();
  await network.close();
  await chrome.close();
  rmSync(certs, { recursive: true, force: true });
});

const calls = () => opspile.state.calls;
async function eventually(check, what, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what}: still false after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const changes = () => calls().filter((call) => call.path === 'changes');
const lists = () => calls().filter((call) => call.path === 'threads' && call.method === 'GET');

test('seven offers spectrum’s Support panel on its port: sign-in, list, conversation, changes and a not-enrolled account', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(
    `() => { if (location.origin === ${JSON.stringify(origin)}) { localStorage.setItem('slicc-os.sign-in', 'relay'); localStorage.setItem('slicc-os.support', 'on'); } }`
  );
  await page.goto('/');
  await ready(page, undefined, { tools: false });
  await page.until(() => !!document.querySelector('slicc-app').model?.support);
  assert.deepEqual(
    await page.evaluate(() => {
      const surface = document
        .querySelector('slicc-app')
        .surfaces.find((item) => item.id === 'support');
      return surface && { tag: surface.tag, side: surface.side, open: surface.open };
    }),
    { tag: 'slicc-support', side: 'right', open: [] }
  );
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const api = await (await root.getDirectoryHandle('api', { create: true })).getDirectoryHandle(
      'support',
      { create: true }
    );
    const file = await (await api.getFileHandle('threads', { create: true })).createWritable();
    await file.write('{"items":[{"id":"planted","title":"Planted"}],"changeCursor":"c0"}');
    await file.close();
    const app = document.querySelector('slicc-app');
    window.support = () => app.model.support;
    window.panel = () => app.dock.content('support')?.shadowRoot ?? null;
    window.inPanel = (selector) => window.panel()?.querySelector(selector) ?? null;
    window.panelText = (selector) =>
      window.inPanel(selector)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
    window.rail = () => app.shadowRoot.querySelector('#rail-support');
    window.supportSeen = { status: [], thread: [] };
    window.support().on('status', (status) => window.supportSeen.status.push(status));
    window.support().on('thread', (id) => window.supportSeen.thread.push(id));
    app.show('support');
  });
  await page.until(() => !!window.inPanel('[data-sign-in]'));
  assert.match(
    await page.evaluate(() => window.panelText('[data-sign-in]')),
    /Get help from Adobe Support/
  );
  assert.deepEqual(await page.evaluate(() => window.support().status()), { state: 'signed-out' });
  const refusals = (asks) =>
    page.evaluate(
      (asks) =>
        Promise.all(
          asks.map(([method, ...args]) =>
            window
              .support()
              [method](...args)
              .then(
                () => 'sent',
                (error) => error.message
              )
          )
        ),
      asks
    );
  assert.deepEqual(
    await refusals([
      ['create', { key: 'k:none', title: 'Help', body: 'Please.' }],
      ['reply', { key: 'k:none', thread: 'sup-preview', body: 'Please.' }],
    ]),
    ['Sign in with Adobe first.', 'Sign in with Adobe first.']
  );
  assert.equal(calls().length, 0, 'nothing is sent without a sign-in');

  await pressDeep(page, '[data-sign-in] [data-action="sign-in"]');
  await page.until(() => window.support().status().state === 'ready');
  assert.deepEqual(await page.evaluate(() => window.support().status()), {
    identity: 'Mara Lind',
    org: 'PAPERMILL@AdobeOrg',
    state: 'ready',
  });
  assert.deepEqual(
    await page.evaluate(() => window.supportSeen.status.map((status) => status.state)),
    ['signing-in', 'loading', 'ready']
  );
  const [authorize] = authorized;
  assert.equal(authorize.client_id, 'experience-catalyst-prod');
  assert.equal(authorize.redirect_uri, 'https://www.sliccy.ai/auth/callback');
  assert.equal(authorize.response_type, 'token');
  assert.equal(authorize.scope, SCOPES);
  assert.equal(configs.length, 1);
  assert.deepEqual(profiles, [MARA]);
  const asked = () =>
    calls().filter(
      (call) => (call.path !== 'changes' && call.path !== 'threads') || call.method !== 'GET'
    ).length;
  const sentBefore = asked();
  const tricks = ['.', '..', '%2e%2e', 'a/../b', 'a%2Fb'];
  const tricked = await refusals(
    tricks.flatMap((id) => [
      ['thread', id],
      ['reply', { key: 'k:trick', thread: id, body: 'Hi.' }],
      ['read', id, 'm1'],
      ['read', 'sup-preview', id],
    ])
  );
  assert.deepEqual(new Set(tricked), new Set(['That request isn’t there anymore.']));
  const oversize = await refusals([
    ['create', { key: 'k:long', title: 'x'.repeat(121), body: 'Hi.' }],
    ['create', { key: 'k:long', title: 'Long', body: 'x'.repeat(2001) }],
    ['reply', { key: 'k:long', thread: 'sup-preview', body: 'x'.repeat(2001) }],
  ]);
  assert.equal(oversize.length, 3);
  for (const said of oversize) assert.match(said, /^That’s longer than Support takes/);
  assert.equal(asked(), sentBefore, 'refused ids and drafts send nothing');
  await page.until(() => window.panel()?.querySelectorAll('li.row[data-id]').length === 2);
  assert.deepEqual(
    await page.evaluate(() =>
      [...window.panel().querySelectorAll('li.row[data-id]')].map((row) => [
        row.dataset.id,
        row.hasAttribute('data-unread'),
        row.hasAttribute('data-resolved'),
      ])
    ),
    [
      ['sup-preview', true, false],
      ['sup-editor', false, true],
    ]
  );
  assert.equal(
    await page.evaluate(() => window.panelText('[data-account] .who')),
    'Signed in as Mara Lind, PAPERMILL@AdobeOrg'
  );
  await page.until(() => /1 unread/.test(window.rail()?.getAttribute('accessible-label') ?? ''));
  assert.ok(lists().every((call) => call.token === MARA));
  assert.equal(
    (chrome.vault.state.records ?? []).some((record) => record.provider === 'adobe'),
    false,
    'Support keeps its token out of the vault'
  );

  await pressDeep(page, 'li.row[data-id="sup-preview"] .head');
  await page.until(() => window.panel()?.querySelectorAll('article.message[data-id]').length === 2);
  assert.deepEqual(
    await page.evaluate(() =>
      [...window.panel().querySelectorAll('article.message')].map((m) => [
        m.dataset.id,
        m.dataset.author,
      ])
    ),
    [
      ['m1', 'customer'],
      ['m2', 'support'],
    ]
  );
  await eventually(
    () => calls().some((call) => call.method === 'PUT' && call.body?.through === 'm2'),
    'the open conversation is acknowledged'
  );
  await page.until(() => window.support().unread() === 0);

  opspile.supportReply('sup-preview', 'We found it.');
  await page.until(() => window.panel()?.querySelectorAll('article.message[data-id]').length === 3);
  assert.ok(await page.evaluate(() => window.supportSeen.thread.includes('sup-preview')));
  assert.match(
    await page.evaluate(() => window.panelText('article.message:last-of-type')),
    /We found it\./
  );

  await page.evaluate(() => window.inPanel('sp-textfield[name="reply"]').focus());
  await page.insert('Thanks, it works now.');
  await pressDeep(page, '[data-action="send"]');
  await eventually(
    () => calls().some((call) => call.path === 'threads/sup-preview/replies'),
    'the panel’s reply reaches Opspile'
  );
  const reply = calls().find((call) => call.path === 'threads/sup-preview/replies');
  assert.deepEqual(reply.body, { body: 'Thanks, it works now.' });
  assert.match(reply.key, /\S/);
  await page.until(() => window.panel()?.querySelectorAll('article.message[data-id]').length === 4);

  const made = await page.evaluate(() =>
    window.support().create({ key: 'intent:1', title: 'Exports', body: 'Exports time out.' })
  );
  const again = await page.evaluate(() =>
    window.support().create({ key: 'intent:1', title: 'Exports', body: 'Exports time out.' })
  );
  assert.deepEqual(again, made);
  assert.deepEqual(
    calls()
      .filter((call) => call.method === 'POST' && call.path === 'threads')
      .map((call) => call.key),
    ['intent:1', 'intent:1']
  );
  assert.equal(await page.evaluate(() => window.support().status().channel), 'Mill support');
  assert.equal(
    await page.evaluate(() =>
      window
        .support()
        .create({ key: 'intent:1', title: 'Other', body: 'Something else.' })
        .then(
          () => 'resolved',
          (error) => error.message
        )
    ),
    'That request key was already used for something else.'
  );
  await page.until(
    (id) =>
      window
        .support()
        .threads()
        .some((item) => item.id === id),
    made.id
  );

  const relisted = lists().length;
  opspile.state.fail.push({ path: /^changes$/, status: 410, code: 'cursor_expired' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await eventually(() => lists().length > relisted, 'a 410 starts again from the list');
  await page.until(() => window.support().status().state === 'ready');

  const kept = await page.evaluate(() => window.support().threads().length);
  opspile.state.fail.push({
    path: /^changes$/,
    status: 503,
    code: 'unavailable',
    headers: [['retry-after', '1']],
  });
  await page.until(() => window.support().status().state === 'offline');
  const offline = await page.evaluate(() => window.support().status());
  assert.equal(offline.identity, 'Mara Lind');
  assert.match(offline.detail, /can’t reach Adobe Support/);
  assert.equal(await page.evaluate(() => window.support().threads().length), kept);
  await page.until(() => window.support().status().state === 'ready');

  await page.evaluate(() => window.inPanel('[data-action="back"]')?.click());
  await pressDeep(page, '[data-account] [data-action="sign-out"]');
  await page.until(() => !!window.inPanel('[data-sign-in]'));
  assert.deepEqual(await page.evaluate(() => window.support().status()), { state: 'signed-out' });

  await pressDeep(page, '[data-sign-in] [data-action="sign-in"]');
  await page.until(() => window.support().status().state === 'not-enrolled');
  assert.deepEqual(await page.evaluate(() => window.support().status()), {
    identity: 'Jonas Berg (user ID JONAS5678@AdobeID)',
    org: 'QUAYLABS@AdobeOrg',
    state: 'not-enrolled',
  });
  await page.until(() => !!window.inPanel('[data-empty="not-enrolled"]'));
  const card = await page.evaluate(() => ({
    note: window.panelText('[data-empty="not-enrolled"]'),
    account: window.panelText('[data-account] .who'),
  }));
  assert.deepEqual(card, {
    note: 'Support isn’t set up for QUAYLABS@AdobeOrg yet. Ask your Adobe contact to add you, or sign in with another account.',
    account: 'Signed in as Jonas Berg (user ID JONAS5678@AdobeID), QUAYLABS@AdobeOrg',
  });
  t.diagnostic(`not-enrolled card: ${card.note} | ${card.account}`);
  await page.screenshot(new URL('not-enrolled.png', page.dir));
  assert.deepEqual(await page.evaluate(() => window.support().threads()), []);
  assert.equal(await page.evaluate(() => window.panel().querySelectorAll('li.row').length), 0);
  const switched = calls().findIndex((call) => call.token === JONAS);
  assert.ok(
    calls()
      .slice(switched)
      .every((call) => call.token === JONAS)
  );

  await pressDeep(page, '[data-account] [data-action="sign-out"]');
  await page.until(() => !!window.inPanel('[data-sign-in]'));
  const quiet = calls().length;
  await new Promise((resolve) => setTimeout(resolve, 12000));
  assert.equal(
    calls().length,
    quiet,
    'nothing is sent for longer than a poll interval after sign-out'
  );

  await pressDeep(page, '[data-sign-in] [data-action="sign-in"]');
  await page.until(() => window.support().status().state === 'ready');
  await page.until(() => window.panel()?.querySelectorAll('li.row[data-id]').length > 0);
  await page.screenshot(new URL('list.png', page.dir));
  await page.until(() => window.support().status().state === 'signed-out');
  await page.until(() => !!window.inPanel('[data-sign-in]'));
  assert.deepEqual(await page.evaluate(() => window.support().threads()), []);

  const logged = (page.console ?? []).join('\n');
  for (const secret of [MARA, JONAS, SHORT, SECRET]) assert.equal(logged.includes(secret), false);
  assert.deepEqual(page.errors, []);
});
