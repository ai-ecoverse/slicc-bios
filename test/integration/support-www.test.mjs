import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { after, test } from 'node:test';
import { pressDeep, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeOpspile } from './fake-opspile.mjs';
import { certificate } from './real-extension.mjs';

const WWW = 'https://www.sliccy.ai';
const SCOPES = 'openid,AdobeID,additional_info.ownerOrg,read_organizations';
const TOKEN = 'dummy-support-token-www-0000';
const accounts = { [TOKEN]: { name: 'Mara Lind', org: 'PAPERMILL@AdobeOrg', enrolled: true } };
const opspile = fakeOpspile({ accounts });
const authorized = [];
const six = [];
const relayed = [];
let seven;

const cors = (req) => ({
  'access-control-allow-origin': req.headers.origin ?? '*',
  'access-control-allow-headers': 'authorization, accept',
  'access-control-allow-methods': 'GET',
});
const relayPage = `<!doctype html><title>relay</title><p>SLICC 6 relay</p><script>
const nonce = new URLSearchParams(location.search).get('nonce');
const channel = new BroadcastChannel('slicc-oauth-relay');
channel.postMessage({ type: 'oauth-callback', nonce, redirectUrl: location.href });
channel.close();
setTimeout(() => window.close(), 200);
</script>`;

function body(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function send(res, { status, headers, body: answer }) {
  res.writeHead(status, Object.fromEntries(headers));
  res.end(answer);
}

async function ims(req, res, url) {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors(req)).end();
  if (url.pathname === '/ims/profile/v1') {
    const account = accounts[req.headers.authorization?.replace(/^Bearer /, '')];
    res.writeHead(account ? 200 : 401, { 'content-type': 'application/json', ...cors(req) });
    return res.end(
      JSON.stringify(account ? { displayName: account.name, ownerOrg: account.org } : {})
    );
  }
  if (url.pathname !== '/ims/authorize/v2') return res.writeHead(404).end();
  authorized.push(Object.fromEntries(url.searchParams));
  const state = JSON.parse(Buffer.from(url.searchParams.get('state'), 'base64').toString());
  const target = `${WWW}/auth/callback?nonce=${state.nonce}#access_token=${TOKEN}&token_type=bearer&expires_in=86399`;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<script>location.replace(${JSON.stringify(target)});</script>`);
}

async function www(req, res, url) {
  if (url.pathname.startsWith('/7/api/support/')) {
    const raw = await body(req);
    const request = { url: url.href, method: req.method, headers: Object.entries(req.headers) };
    return send(res, opspile.answer(request, raw));
  }
  if (url.pathname.startsWith('/api/support/')) {
    six.push(`${req.method} ${url.pathname}`);
    return res.writeHead(404, { 'content-type': 'text/plain' }).end('SLICC 6');
  }
  if (url.pathname === '/auth/callback') {
    relayed.push(url.pathname);
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(relayPage);
  }
  if (url.pathname.startsWith('/os/')) {
    return req.headers['sec-fetch-mode'] === 'navigate'
      ? res.writeHead(302, { location: '/7/' }).end()
      : res.writeHead(404).end();
  }
  if (!url.pathname.startsWith('/7/') && !url.pathname.startsWith('/fonts/'))
    return res.writeHead(404).end();
  const path = url.pathname.startsWith('/7/') ? url.pathname.slice(2) : url.pathname;
  const upstream = await fetch(new URL(`${path}${url.search}`, seven));
  const headers = Object.fromEntries(
    [...upstream.headers].filter(
      ([name]) => !['content-encoding', 'transfer-encoding'].includes(name)
    )
  );
  if (url.pathname === '/7/sw.js') headers['service-worker-allowed'] = '/';
  res.writeHead(upstream.status, headers).end(Buffer.from(await upstream.arrayBuffer()));
}

const front = createServer(await certificate(), (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const answer =
    url.hostname === 'ims-na1.adobelogin.com'
      ? ims(req, res, url)
      : url.hostname === 'adobe-llm-proxy.paolo-moz.workers.dev'
        ? Promise.resolve(
            res.writeHead(200, { 'content-type': 'application/json', ...cors(req) }).end(
              JSON.stringify({
                clientId: 'experience-catalyst-prod',
                scopes: SCOPES,
                imsEnvironment: 'prod',
              })
            )
          )
        : url.hostname === 'www.sliccy.ai'
          ? www(req, res, url)
          : Promise.resolve(res.writeHead(404).end());
  answer.catch(() => res.writeHead(502).end());
});
await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
const port = front.address().port;
const chrome = await launch({
  tools: false,
  vault: false,
  args: [
    '--ignore-certificate-errors',
    '--no-proxy-server',
    `--host-resolver-rules=MAP *.sliccy.ai 127.0.0.1:${port}, MAP ims-na1.adobelogin.com 127.0.0.1:${port}, MAP adobe-llm-proxy.paolo-moz.workers.dev 127.0.0.1:${port}, MAP sliccy.ai ~NOTFOUND`,
  ],
});
seven = new URL(chrome.url);
after(async () => {
  front.closeAllConnections();
  await new Promise((resolve) => front.close(resolve));
  await chrome.close();
});

test('on www.sliccy.ai/7/ the Support port signs in through six’s relay and calls only /7/api/support/', {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto(`${WWW}/7/`);
  await ready(page, undefined, { tools: false });
  await page.until(() => !!document.querySelector('slicc-app').model?.support);
  assert.equal(
    await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
    `${WWW}/7/sw.js`
  );
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let dir = root;
    for (const name of ['7', 'api', 'support'])
      dir = await dir.getDirectoryHandle(name, { create: true });
    const file = await (await dir.getFileHandle('threads', { create: true })).createWritable();
    await file.write('{"items":[{"id":"planted","title":"Planted"}],"changeCursor":"c0"}');
    await file.close();
    const app = document.querySelector('slicc-app');
    window.support = () => app.model.support;
    window.inPanel = (selector) =>
      app.dock.content('support')?.shadowRoot?.querySelector(selector) ?? null;
    app.show('support');
  });
  await page.until(() => !!window.inPanel('[data-sign-in]'));
  await pressDeep(page, '[data-sign-in] [data-action="sign-in"]');
  await page.until(() => window.support().status().state === 'ready');
  assert.deepEqual(await page.evaluate(() => window.support().status()), {
    identity: 'Mara Lind',
    org: 'PAPERMILL@AdobeOrg',
    state: 'ready',
  });

  const [authorize] = authorized;
  assert.equal(authorized.length, 1);
  assert.equal(authorize.client_id, 'experience-catalyst-prod');
  assert.equal(authorize.redirect_uri, `${WWW}/auth/callback`);
  assert.equal(authorize.scope, `${SCOPES}`);
  const state = JSON.parse(Buffer.from(authorize.state, 'base64').toString());
  assert.equal(state.source, 'opener');
  assert.equal(state.origin, undefined);
  assert.deepEqual(relayed, ['/auth/callback']);

  assert.deepEqual(
    await page.evaluate(() =>
      window
        .support()
        .threads()
        .map((item) => item.id)
    ),
    ['sup-preview', 'sup-editor']
  );
  const made = await page.evaluate(() =>
    window.support().create({ key: 'www:1', title: 'Exports', body: 'Exports time out.' })
  );
  assert.match(made.id, /^sup-m\d+$/);
  const polled = opspile.state.calls.filter((call) => call.path === 'changes').length;
  opspile.supportReply('sup-preview', 'On it.');
  await page.until(
    () =>
      window
        .support()
        .threads()
        .find((item) => item.id === 'sup-preview')?.unread === 2
  );
  assert.ok(opspile.state.calls.filter((call) => call.path === 'changes').length > polled);
  assert.ok(opspile.state.calls.every((call) => call.token === TOKEN));
  assert.deepEqual(six, []);
  await page.evaluate(() => window.support().signOut());
  assert.deepEqual(await page.evaluate(() => window.support().status()), { state: 'signed-out' });
  assert.equal(
    (page.console ?? []).some((line) => line.includes(TOKEN)),
    false
  );
});
