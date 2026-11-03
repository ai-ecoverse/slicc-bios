import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { startWww } from './fake-six.mjs';
import { certificate } from './real-extension.mjs';

const WWW = 'https://www.sliccy.ai';
const SEVEN = 'https://seven.sliccy.ai';
const PREVIEW = 'https://preview-seven.sliccy.ai';
let chrome;
let www;
let landing = true;
const hits = [];
const front = createServer(await certificate(), (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  hits.push(url.href);
  if (url.pathname === '/blank') {
    return res.writeHead(200, { 'content-type': 'text/html' }).end('<title>fixture</title>');
  }
  if (url.hostname === 'www.sliccy.ai' && url.pathname === '/7/' && landing) {
    return res.writeHead(200, { 'content-type': 'text/html' }).end('<title>www home</title>');
  }
  if (!['www.sliccy.ai', 'seven.sliccy.ai', 'preview-seven.sliccy.ai'].includes(url.hostname)) {
    return res.writeHead(404).end();
  }
  const upstream = new URL(url.hostname === 'www.sliccy.ai' ? www.origin : chrome.url);
  const proxied = request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: upstream.host },
    },
    (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    }
  );
  proxied.on('error', () => res.writeHead(502).end());
  req.pipe(proxied);
});
await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
chrome = await launch({
  tools: false,
  vault: false,
  args: [
    '--ignore-certificate-errors',
    '--no-proxy-server',
    `--host-resolver-rules=MAP *.sliccy.ai 127.0.0.1:${front.address().port}, MAP sliccy.ai ~NOTFOUND`,
  ],
});
www = await startWww(new URL(chrome.url));
after(async () => {
  front.closeAllConnections();
  await new Promise((resolve) => front.close(resolve));
  await www.close();
  await chrome.close();
});

async function open(t, { origin = SEVEN, value = 'www', profile = false } = {}) {
  const page = await chrome.page(t);
  await page.goto(`${origin}/blank`);
  await page.evaluate(
    async ({ value, profile }) => {
      document.cookie = `slicc-home=${value}; Domain=sliccy.ai; Path=/; Secure; SameSite=Lax; Max-Age=34560000`;
      if (profile) {
        const root = await navigator.storage.getDirectory();
        const os = await root.getDirectoryHandle('os', { create: true });
        const file = await os.getFileHandle('kept.txt', { create: true });
        const writer = await file.createWritable();
        await writer.write('own profile');
        await writer.close();
      }
    },
    { value, profile }
  );
  return page;
}

async function bootingHere(page, origin) {
  await page.until(() => document.querySelector('[data-step="opfs"]')?.dataset.state === 'done');
  assert.equal(await page.evaluate(() => location.origin), origin);
}

for (const hash of ['#slicc-pair=home-fixture&follow', '#follow', '']) {
  test(`a fresh seven follows the home cookie to the fixed www BIOS with ${hash || 'no fragment'}`, async (t) => {
    const page = await open(t);
    hits.length = 0;
    await page.goto(`${SEVEN}/${hash}`);
    await page.until(() => document.title === 'www home');
    assert.equal(await page.evaluate(() => location.href), `${WWW}/7/${hash}`);
    assert.ok(!hits.includes(`${SEVEN}/bios.js`), 'seven started booting before redirecting');
    assert.deepEqual(page.errors, []);
  });
}

test('seven keeps its existing profile despite the home cookie', async (t) => {
  const page = await open(t, { profile: true });
  await page.goto(`${SEVEN}/`);
  await bootingHere(page, SEVEN);
  assert.equal(
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      return (
        await (await (await root.getDirectoryHandle('os')).getFileHandle('kept.txt')).getFile()
      ).text();
    }),
    'own profile'
  );
  assert.equal(await page.evaluate(() => document.cookie.includes('slicc-home=www')), true);
});

test('stay clears the shared cookie, removes only its flag and boots here', async (t) => {
  const page = await open(t);
  await page.goto(`${SEVEN}/?other=yes&stay#follow`);
  await bootingHere(page, SEVEN);
  assert.equal(await page.evaluate(() => location.href), `${SEVEN}/?other=yes#follow`);
  assert.equal(await page.evaluate(() => document.cookie.includes('slicc-home=')), false);
  const { cookies } = await page.send('Network.getCookies', { urls: [WWW, SEVEN] });
  assert.ok(!cookies.some(({ name }) => name === 'slicc-home'));
});

for (const value of ['', 'WWW', 'www2', 'https://other.example/']) {
  test(`cookie value ${JSON.stringify(value)} boots seven without navigating to www`, async (t) => {
    const page = await open(t, { value });
    hits.length = 0;
    await page.goto(`${SEVEN}/`);
    await bootingHere(page, SEVEN);
    assert.ok(!hits.some((url) => url.startsWith(`${WWW}/`)));
  });
}

test('a non-exact host ignores the cookie and the stay flag', async (t) => {
  const page = await open(t, { origin: PREVIEW });
  await page.goto(`${PREVIEW}/?stay#follow`);
  await bootingHere(page, PREVIEW);
  assert.equal(await page.evaluate(() => location.search), '?stay');
  assert.equal(await page.evaluate(() => document.cookie.includes('slicc-home=www')), true);
});

test('a child document ignores the home cookie and stay flag', async (t) => {
  const page = await open(t);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.src = '/?stay#follow';
    document.body.append(frame);
  });
  await page.until(
    () =>
      document.querySelector('iframe')?.contentDocument?.querySelector('[data-step="opfs"]')
        ?.dataset.state === 'done'
  );
  assert.equal(
    await page.evaluate(() => document.querySelector('iframe').contentWindow.location.href),
    `${SEVEN}/?stay#follow`
  );
  assert.equal(await page.evaluate(() => document.cookie.includes('slicc-home=www')), true);
});

test('www sets the cookie when six settles and renews it on later BIOS and OS boots', async (t) => {
  landing = false;
  t.after(() => {
    landing = true;
  });
  const page = await chrome.page(t);
  await page.goto(`${WWW}/`);
  await page.until(() => document.getElementById('six')?.dataset.ran === 'yes');
  await page.goto(`${WWW}/7/`);
  await page.until(() => document.querySelector('.six')?.dataset.state === 'asking');
  await page.evaluate(() => document.querySelector('.six-move').click());
  await page.until(
    () =>
      localStorage.getItem('slicc-os.six') === 'upgraded' &&
      document.cookie.includes('slicc-home=www')
  );
  const { cookies } = await page.send('Network.getCookies', { urls: [WWW] });
  const home = cookies.find(({ name }) => name === 'slicc-home');
  assert.ok(home);
  assert.deepEqual(
    {
      value: home.value,
      domain: home.domain,
      path: home.path,
      secure: home.secure,
      sameSite: home.sameSite,
    },
    { value: 'www', domain: '.sliccy.ai', path: '/', secure: true, sameSite: 'Lax' }
  );
  assert.ok(home.expires * 1000 > Date.now() + 399 * 24 * 60 * 60 * 1000);
  await page.until(() => location.pathname === '/os/' && document.querySelector('slicc-app'));
  for (const path of ['/7/', '/os/']) {
    await page.evaluate(() => {
      document.cookie = 'slicc-home=; Domain=sliccy.ai; Path=/; Secure; SameSite=Lax; Max-Age=0';
    });
    assert.equal(await page.evaluate(() => document.cookie.includes('slicc-home=')), false);
    await page.goto(`${WWW}${path}`);
    await page.until(() => document.cookie.includes('slicc-home=www'));
    await page.until(() => location.pathname === '/os/' && document.querySelector('slicc-app'));
  }
});
