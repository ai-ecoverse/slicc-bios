import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { booted, PACKAGE_BUDGET, ready, watch } from './bios.mjs';
import { launch, VAULT_KEY } from './chrome.mjs';

const chrome = await launch();
const seven = new URL(chrome.url);
const six = {
  '/': '<!doctype html><title>SLICC 6</title><p id="six">six</p><script src="/six.js"></script>\n',
  '/six.js': 'document.getElementById("six").dataset.ran = "yes";\n',
  '/auth/callback': '<!doctype html><title>relay</title><p id="relay">six relay</p>\n',
};
const asked = [];
const www = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://www');
  asked.push(url.pathname);
  if (url.pathname === '/7') return response.writeHead(301, { location: '/7/' }).end();
  if (url.pathname.startsWith('/7/') || url.pathname.startsWith('/fonts/')) {
    const path = url.pathname.startsWith('/7/') ? url.pathname.slice(2) : url.pathname;
    const upstream = await fetch(new URL(`${path}${url.search}`, seven));
    const headers = Object.fromEntries(
      [...upstream.headers].filter(
        ([name]) => !['content-encoding', 'transfer-encoding'].includes(name)
      )
    );
    if (url.pathname === '/7/sw.js') headers['service-worker-allowed'] = '/';
    return response
      .writeHead(upstream.status, headers)
      .end(Buffer.from(await upstream.arrayBuffer()));
  }
  if (url.pathname.startsWith('/os/')) {
    return request.headers['sec-fetch-mode'] === 'navigate'
      ? response.writeHead(302, { location: '/7/' }).end()
      : response.writeHead(404).end();
  }
  const body = six[url.pathname];
  if (!body) return response.writeHead(404).end();
  const type = url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html';
  response.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(body);
});
await new Promise((done) => www.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${www.address().port}`;
after(async () => {
  await new Promise((done) => {
    www.close(done);
    www.closeAllConnections();
  });
  await chrome.close();
});

const manifest = JSON.parse(
  await readFile(new URL('../../src/manifest.json', import.meta.url), 'utf8')
);

function watchSteps(page, t) {
  const start = Date.now();
  const trail = [];
  const vault = new Set();
  const note = (line) => trail.push(`${Date.now() - start} ${line}`);
  const off = chrome.cdp.on(({ method, params = {}, sessionId }) => {
    const url = params.request?.url ?? params.response?.url ?? '';
    const ours = url.startsWith(chrome.vault.origin) || vault.has(params.requestId);
    if (method === 'Network.requestWillBeSent' && url.startsWith(chrome.vault.origin))
      vault.add(params.requestId);
    if (!ours && !(method.startsWith('Fetch.') && url.startsWith(chrome.vault.origin))) return;
    if (!/^(Fetch|Network)\./.test(method) || method === 'Network.dataReceived') return;
    const status = params.responseStatusCode ?? params.response?.status ?? '';
    note(
      `${method} ${sessionId?.slice(0, 8) ?? '-'} ${params.requestId ?? ''} ${url.slice(0, 80)} ${status}`
    );
  });
  t.after(off);
  const dump = async (name) => {
    const tree = await page
      .send('Page.getFrameTree')
      .then(({ frameTree }) =>
        JSON.stringify(frameTree, (key, value) => (key === 'adFrameStatus' ? undefined : value))
      )
      .catch((error) => `frame tree failed: ${error.message}`);
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const signIn = await Promise.race([
      page.evaluate(() => JSON.stringify(globalThis.signInTrail ?? null)),
      new Promise((resolve) => setTimeout(() => resolve('page evaluate hangs 5 s'), 5000)),
    ]).catch((error) => `page evaluate failed: ${error.message}`);
    const lines = [
      `shared-origin step "${name}" has no answer after 20 s`,
      `sign-in trail: ${signIn}`,
      `frames: ${tree.slice(0, 3000)}`,
      `targets: ${targetInfos.map(({ type, url, attached }) => `${type} ${url.slice(0, 80)} ${attached}`).join(' | ')}`,
      ...trail.map((line) => `vault request: ${line}`),
    ];
    for (const line of lines) t.diagnostic(line);
    console.log(lines.join('\n'));
  };
  return async (name, fn) => {
    note(`step ${name}`);
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(dump(name)), 20000);
    });
    try {
      return await fn();
    } finally {
      clearTimeout(timer);
      void late;
    }
  };
}

async function open(t) {
  const page = await chrome.page(t);
  await page.init(
    `() => { if (location.origin === ${JSON.stringify(origin)} && !localStorage.getItem(${JSON.stringify(VAULT_KEY)})) localStorage.setItem(${JSON.stringify(VAULT_KEY)}, ${JSON.stringify(chrome.vault.origin)}); }`
  );
  return page;
}

test('seven boots from /7/ of an origin it shares with six: the UI is /os/, every BIOS file comes from /7/, and six keeps its own routes', async (t) => {
  const page = await open(t);
  const bios = await watch(page);
  asked.length = 0;
  await page.goto(`${origin}/7/`);
  await ready(page);
  assert.deepEqual(bios.states(), booted);

  assert.deepEqual(
    await page.evaluate(async () => ({
      script: navigator.serviceWorker.controller?.scriptURL,
      scope: (await navigator.serviceWorker.ready).scope,
      page: location.href,
    })),
    { script: `${origin}/7/sw.js`, scope: `${origin}/`, page: `${origin}/os/` }
  );
  const outside = asked.filter(
    (path) =>
      !path.startsWith('/7/') &&
      !path.startsWith('/fonts/') &&
      !['/', '/six.js', '/auth/callback', '/favicon.ico'].includes(path)
  );
  assert.deepEqual(outside, []);

  const site = await page.evaluate(async () => {
    const { BIOS, home, sharesOrigin } = await import('/os/site.js');
    return { bios: BIOS, home: home(), shared: sharesOrigin() };
  });
  assert.deepEqual(site, { bios: `${origin}/7/`, home: `${origin}/7`, shared: true });

  const app = await page.send('Page.getAppManifest');
  assert.equal(app.url, `${origin}/7/manifest.json`);
  assert.deepEqual(app.errors, []);
  assert.deepEqual(JSON.parse(app.data), manifest);
  const { installabilityErrors } = await page.send('Page.getInstallabilityErrors');
  assert.deepEqual(
    installabilityErrors.map(({ errorId }) => errorId).filter((id) => id !== 'in-incognito'),
    []
  );
  const icons = await page.evaluate(
    async ({ base, icons }) =>
      Promise.all(
        icons.map(async ({ src }) => {
          const image = new Image();
          image.src = new URL(src, base).href;
          await image.decode();
          return `${new URL(image.src).pathname} ${image.naturalWidth}x${image.naturalHeight}`;
        })
      ),
    { base: app.url, icons: manifest.icons }
  );
  assert.deepEqual(
    icons,
    manifest.icons.map(({ src, sizes }) => `/7/${src} ${sizes}`)
  );

  const tab = await page.tab();
  await tab.goto(`${origin}/`);
  await tab.until(() => document.getElementById('six')?.dataset.ran === 'yes');
  assert.equal(
    await tab.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
    `${origin}/7/sw.js`
  );
  await tab.goto(`${origin}/auth/callback?nonce=n`);
  assert.equal(
    await tab.evaluate(() => document.getElementById('relay')?.textContent),
    'six relay'
  );
  assert.deepEqual(page.errors, []);
});

async function startSettled(page) {
  await page
    .within(PACKAGE_BUDGET, () => import('/os/start.js').then(() => true))
    .catch((error) => {
      throw new Error(
        `seven's /os/start.js didn't settle its top-level await start() within ${PACKAGE_BUDGET / 1000} s; it settles once os.js's boot check() has offered the agent, the betas, the grammars, the tailnet and the optional packages\n${error.message}`,
        { cause: error }
      );
    });
}

test("on a shared origin, sign-in goes through six's relay, the tray hub through the BIOS's folder, and Reload and the uncontrolled trip through the BIOS", async (t) => {
  const page = await open(t);
  const step = watchSteps(page, t);
  await page.goto(`${origin}/7/`);
  await ready(page);
  await startSettled(page);

  const signedIn = await step('sign-in', () =>
    page.evaluate(async () => {
      globalThis.signInTrail = [];
      const trail = (line) =>
        globalThis.signInTrail.push(`${Math.round(performance.now())} ${line}`);
      const { signIn } = await import('/os/adobe.js');
      let state = null;
      const popup = {
        set location(_) {},
        get location() {
          return {
            set href(url) {
              trail('href');
              state = JSON.parse(atob(new URL(url).searchParams.get('state')));
              const redirectUrl = `${location.origin}/auth/callback?nonce=${state.nonce}#access_token=tok-1`;
              setTimeout(() => {
                const relay = new BroadcastChannel('slicc-oauth-relay');
                trail('post');
                relay.postMessage({ type: 'oauth-callback', redirectUrl, nonce: state.nonce });
                relay.close();
              }, 100);
            },
          };
        },
        close() {},
      };
      const listen = (name) => {
        trail(`listen ${name}`);
        const channel = new BroadcastChannel(name);
        channel.addEventListener('message', ({ data }) => trail(`heard ${data?.type}`));
        return channel;
      };
      trail('import done');
      const login = signIn({ shared: true, open: () => popup, listen, hosted: () => false });
      const token = await login('adobe', () => ({ clientId: 'c', scopes: 's' }));
      trail('token');
      const unchecked = signIn({
        shared: true,
        open: () => ({ location: {}, close() {} }),
        listen,
      });
      const refused = await unchecked('adobe', () => ({ clientId: 'c', scopes: 's' })).then(
        () => 'signed in',
        (error) => error.message
      );
      return { token, source: state.source, origin: state.origin ?? null, refused };
    })
  );
  assert.deepEqual(signedIn, {
    token: 'tok-1',
    source: 'opener',
    origin: null,
    refused:
      "Seven couldn't keep the sign-in window out of reach of browser automation, so it didn't open the sign-in. Try again.",
  });

  const hub = await step('hub', () =>
    page.evaluate(async () => {
      const { trayHub } = await import('/os/tray.js');
      const { home } = await import('/os/site.js');
      const posted = [];
      const answers = [
        {
          trayId: 't1',
          capabilities: {
            controller: { url: 'https://www.sliccy.ai/controller/c1' },
            join: { url: 'https://www.sliccy.ai/join/j1' },
            webhook: { url: 'https://www.sliccy.ai/webhook/w1' },
          },
        },
        {
          role: 'leader',
          leaderKey: 'k1',
          websocket: { url: 'wss://www.sliccy.ai/controller/c1/ws' },
        },
      ];
      const fake = async (url) => {
        posted.push(url);
        return new Response(JSON.stringify(answers.shift()), { status: 200 });
      };
      const claimed = await trayHub(home(), fake).lead(null, true);
      return { posted, socket: claimed.url };
    })
  );
  assert.deepEqual(hub, {
    posted: [`${origin}/7/tray`, `${origin}/7/controller/c1`],
    socket: `${origin.replace('http:', 'ws:')}/7/controller/c1/ws`,
  });

  const reload = await step('reload', () =>
    page.evaluate(async () => {
      const { refused } = await import('/os/start.js');
      return new Promise((resolve) => {
        const box = refused(document.implementation.createHTMLDocument(''), resolve);
        box.querySelector('button').click();
      });
    })
  );
  assert.equal(reload, `${origin}/7/`);
  const trip = await step('trip', () =>
    page.evaluate(async () => {
      const { start } = await import('/os/start.js');
      const kept = new Map();
      let went = null;
      await start({
        seat: () => null,
        go: (url) => {
          went = url;
        },
        worker: () => false,
        storage: () => ({
          getItem: (key) => kept.get(key) ?? null,
          setItem: (key, value) => kept.set(key, value),
          removeItem: (key) => kept.delete(key),
        }),
        at: { hash: '#x' },
      });
      return went;
    })
  );
  assert.equal(
    trip,
    `${origin}/7/#x`,
    'a page that lost its worker goes back through seven’s BIOS, not six'
  );
  assert.deepEqual(page.errors, []);
});
