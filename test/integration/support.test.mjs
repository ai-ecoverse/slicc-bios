import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
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
  [MARA]: { name: 'Mara Lind', org: 'PAPERMILL@AdobeOrg', enrolled: true, expires: 86399 },
  [JONAS]: { name: 'Jonas Berg', org: 'QUAYLABS@AdobeOrg', enrolled: false, expires: 86399 },
  [SHORT]: { name: 'Mara Lind', org: 'PAPERMILL@AdobeOrg', enrolled: true, expires: 36 },
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
            ? { displayName: account.name, email: 'someone@example.com', ownerOrg: account.org }
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

test('seven’s Support port signs in with Adobe, follows the changes and resets for each account', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(
    `() => { if (location.origin === ${JSON.stringify(origin)}) { localStorage.setItem('slicc-os.sign-in', 'relay'); localStorage.setItem('slicc-os.support', 'on'); } }`
  );
  await page.goto('/');
  await ready(page, undefined, { tools: false });
  await page.until(() => !!document.querySelector('slicc-app').model?.support);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const api = await (await root.getDirectoryHandle('api', { create: true })).getDirectoryHandle(
      'support',
      { create: true }
    );
    const file = await (await api.getFileHandle('threads', { create: true })).createWritable();
    await file.write('{"items":[{"id":"planted","title":"Planted"}],"changeCursor":"c0"}');
    await file.close();
    const support = () => document.querySelector('slicc-app').model.support;
    window.support = support;
    window.supportSeen = { status: [], thread: [] };
    support().on('status', (status) => window.supportSeen.status.push(status));
    support().on('thread', (id) => window.supportSeen.thread.push(id));
    const button = document.createElement('button');
    button.id = 'support-sign-in';
    button.textContent = 'Sign in';
    button.style.cssText = 'position:fixed;top:0;left:0;z-index:99999';
    button.addEventListener('click', () => {
      window.supportSignedIn = support()
        .signIn()
        .then(
          () => 'resolved',
          (error) => error.message
        );
    });
    document.body.append(button);
  });
  assert.deepEqual(await page.evaluate(() => window.support().status()), { state: 'signed-out' });
  const signIn = async () => {
    await page.evaluate(() => {
      window.supportSignedIn = null;
      document.getElementById('support-sign-in').focus();
    });
    await page.press('Enter');
    return page.until(() => window.supportSignedIn);
  };

  assert.equal(await signIn(), 'resolved');
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
  assert.deepEqual(
    await page.evaluate(() =>
      window
        .support()
        .threads()
        .map((item) => [item.id, item.unread, item.resolved])
    ),
    [
      ['sup-preview', 1, false],
      ['sup-editor', 0, true],
    ]
  );
  assert.equal(await page.evaluate(() => window.support().unread()), 1);
  assert.ok(lists().every((call) => call.token === MARA));
  assert.equal(
    (chrome.vault.state.records ?? []).some((record) => record.provider === 'adobe'),
    false,
    'Support keeps its token out of the vault'
  );

  const conversation = await page.evaluate(() => window.support().thread('sup-preview'));
  assert.deepEqual(
    conversation.messages.map((m) => [m.id, m.author, m.name]),
    [
      ['m1', 'customer', 'Mara Lind'],
      ['m2', 'support', 'Adobe Support'],
    ]
  );
  await page.evaluate(() => window.support().read('sup-preview', 'm2'));
  assert.equal(await page.evaluate(() => window.support().unread()), 0);

  const polled = changes().length;
  opspile.supportReply('sup-editor', 'Reopened: it is slow again.');
  await page.until(() => window.supportSeen.thread.includes('sup-editor'));
  assert.ok(changes().length > polled);
  assert.equal(
    await page.evaluate(
      () =>
        window
          .support()
          .threads()
          .find((item) => item.id === 'sup-editor').unread
    ),
    1
  );

  const made = await page.evaluate(() =>
    window.support().create({ key: 'intent:1', title: 'Exports', body: 'Exports time out.' })
  );
  const again = await page.evaluate(() =>
    window.support().create({ key: 'intent:1', title: 'Exports', body: 'Exports time out.' })
  );
  assert.deepEqual(again, made);
  const posts = calls().filter((call) => call.method === 'POST');
  assert.deepEqual(
    posts.map((call) => call.key),
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
  const replied = await page.evaluate(
    (thread) => window.support().reply({ key: 'intent:2', thread, body: 'Still slow.' }),
    'sup-editor'
  );
  assert.match(replied.id, /^m\d+$/);

  const relisted = lists().length;
  opspile.state.fail.push({ path: /^changes$/, status: 410, code: 'cursor_expired' });
  await new Promise((resolve) => setTimeout(resolve, 2500));
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

  assert.equal(await signIn(), 'resolved');
  await page.until(() => window.support().status().state === 'not-enrolled');
  assert.deepEqual(await page.evaluate(() => window.support().status()), {
    identity: 'Jonas Berg',
    org: 'QUAYLABS@AdobeOrg',
    state: 'not-enrolled',
  });
  assert.deepEqual(await page.evaluate(() => window.support().threads()), []);
  assert.equal(await page.evaluate(() => window.support().unread()), 0);
  const switched = calls().findIndex((call) => call.token === JONAS);
  assert.ok(
    calls()
      .slice(switched)
      .every((call) => call.token === JONAS)
  );

  await page.evaluate(() => window.support().signOut());
  assert.deepEqual(await page.evaluate(() => window.support().status()), { state: 'signed-out' });
  const quiet = calls().length;
  await new Promise((resolve) => setTimeout(resolve, 12000));
  assert.equal(calls().length, quiet);

  assert.equal(await signIn(), 'resolved');
  await page.until(() => window.support().status().state === 'ready');
  await page.until(() => window.support().status().state === 'signed-out');
  assert.deepEqual(await page.evaluate(() => window.support().threads()), []);

  const logged = (page.console ?? []).join('\n');
  for (const secret of [MARA, JONAS, SHORT, SECRET]) assert.equal(logged.includes(secret), false);
  assert.deepEqual(page.errors, []);
});
