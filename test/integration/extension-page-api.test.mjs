import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { CURRENT_EXTENSION, realExtension, SEVEN } from './real-extension.mjs';

const SANDBOX =
  "sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self'";
const SEVEN_ORIGIN = new URL(SEVEN).origin;
const PROBE =
  'JSON.stringify({ origin: window.origin, href: location.href, api: typeof window.sliccExtension, ready: document.readyState })';

const real = await realExtension({
  extension: CURRENT_EXTENSION,
  args: ['--disable-popup-blocking'],
});
after(() => real.close());

async function until(what, check, ms = 30000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${what} never happened within ${ms} ms; last saw ${JSON.stringify(last)}`);
}

async function seven(t) {
  const page = await real.page(t);
  await page.goto(SEVEN);
  await ready(page);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.transport), 'extension');
  return page;
}

async function probed(targetId) {
  const { sessionId } = await real.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    return await until(`${targetId} finishing its load`, async () => {
      const answer = await real.cdp
        .send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId)
        .catch(() => null);
      const value = answer?.result?.value;
      const seen = typeof value === 'string' ? JSON.parse(value) : null;
      return seen?.ready === 'complete' && seen.href !== 'about:blank' && seen;
    });
  } finally {
    await real.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

test(`slicc-extension ${CURRENT_EXTENSION.version}: a CSP-sandboxed OPFS document opened top-level on a seven label has an opaque origin and no window.sliccExtension`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const page = await seven(t);
  const path = `tmp/page-api-sandboxed-${Date.now()}.html`;
  const csp = await page.evaluate(async (path) => {
    const root = await navigator.storage.getDirectory();
    const [dir, name] = path.split('/');
    const handle = await (await root.getDirectoryHandle(dir, { create: true })).getFileHandle(
      name,
      { create: true }
    );
    const writable = await handle.createWritable();
    await writable.write('<!doctype html><title>sandboxed</title><p>an agent-written page</p>');
    await writable.close();
    return (await fetch(`/${path}`)).headers.get('content-security-policy');
  }, path);
  assert.equal(csp, SANDBOX);
  const url = new URL(path, SEVEN).href;
  const tab = await page.tab();
  await tab.goto(url);
  const seen = await tab.evaluate(() => ({
    href: location.href,
    origin: window.origin,
    api: typeof window.sliccExtension,
  }));
  assert.deepEqual(seen, { href: url, origin: 'null', api: 'undefined' });
});

test(`slicc-extension ${CURRENT_EXTENSION.version}: a popup a sandboxed iframe opens on a seven label inherits the sandbox and has no window.sliccExtension`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const page = await real.page(t);
  const nonce = Date.now();
  const popup = new URL(`/page-api-popup.html?n=${nonce}`, SEVEN).href;
  const direct = new URL(`/page-api-popup.html?direct=${nonce}`, SEVEN).href;
  real.overrides.set('/page-api-popup.html', '<!doctype html><title>popup</title><p>popup</p>');
  real.overrides.set(
    '/page-api-opener.html',
    `<!doctype html><title>opener</title><script>window.open(${JSON.stringify(popup)}, '_blank');</script>`
  );
  real.overrides.set(
    '/page-api-host.html',
    '<!doctype html><title>host</title><iframe sandbox="allow-scripts allow-popups" src="/page-api-opener.html"></iframe>'
  );

  await page.goto(direct);
  const plain = await page.evaluate(() => ({
    origin: window.origin,
    api: typeof window.sliccExtension,
  }));
  assert.deepEqual(plain, { origin: SEVEN_ORIGIN, api: 'object' });

  await page.goto(new URL('/page-api-host.html', SEVEN).href);
  const opened = await until('the sandboxed iframe opening its popup', async () => {
    const { targetInfos } = await real.cdp.send('Target.getTargets');
    return targetInfos.find((info) => info.type === 'page' && info.url === popup);
  });
  const { origin, href, api } = await probed(opened.targetId);
  assert.deepEqual({ href, origin, api }, { href: popup, origin: 'null', api: 'undefined' });
});

test(`slicc-extension ${CURRENT_EXTENSION.version}: a sprinkle-style sandboxed about:srcdoc frame in seven's page has no window.sliccExtension`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const page = await seven(t);
  const seen = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms');
    frame.srcdoc =
      '<!doctype html><p>sprinkle</p><script>addEventListener("load", () => parent.postMessage({ sprinkle: { href: location.href, origin: window.origin, api: typeof window.sliccExtension } }, "*"));</script>';
    const reported = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the sprinkle frame never reported')), 30000);
      addEventListener('message', function heard({ source, data }) {
        if (source !== frame.contentWindow || !data?.sprinkle) return;
        removeEventListener('message', heard);
        clearTimeout(timer);
        resolve(data.sprinkle);
      });
    });
    document.body.append(frame);
    try {
      return await reported;
    } finally {
      frame.remove();
    }
  });
  assert.deepEqual(seen, { href: 'about:srcdoc', origin: 'null', api: 'undefined' });
});

test(`slicc-extension ${CURRENT_EXTENSION.version}: seven's own page has window.sliccExtension and a call round-trips`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const page = await seven(t);
  const seen = await page.evaluate(async () => {
    const api = window.sliccExtension;
    const answer = await Promise.race([
      api.cdp.send('Browser.getVersion'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Browser.getVersion got no answer in 30 s')), 30000)
      ),
    ]);
    return {
      origin: window.origin,
      api: typeof api,
      cdp: typeof api.cdp?.send,
      on: typeof api.cdp?.on,
      fetch: typeof api.fetch,
      signIn: typeof api.signIn,
      frames: typeof api.frames,
      version: api.version,
      product: answer.product,
    };
  });
  const { product, ...shape } = seen;
  assert.deepEqual(shape, {
    origin: SEVEN_ORIGIN,
    api: 'object',
    cdp: 'function',
    on: 'function',
    fetch: 'function',
    signIn: 'function',
    frames: 'function',
    version: CURRENT_EXTENSION.version,
  });
  assert.match(product, /^Chrome\/\d+\./);
});
