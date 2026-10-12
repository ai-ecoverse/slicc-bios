import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const probe = `<!doctype html>
<title>probe</title>
<pre id="out">pending</pre>
<script>
  const attempt = async (fn) => {
    try {
      await fn();
      return 'allowed';
    } catch (error) {
      return \`denied: \${error.name}\`;
    }
  };
  (async () => {
    const result = {
      origin: self.origin,
      isolated: self.crossOriginIsolated,
      open: await attempt(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open('slicc-probe');
            request.onsuccess = () => resolve(request.result.close());
            request.onerror = () => reject(request.error);
          })
      ),
      databases: await attempt(() => indexedDB.databases()),
      local: await attempt(() => localStorage.length),
      storage: await attempt(() => navigator.storage.getDirectory()),
    };
    document.getElementById('out').textContent = JSON.stringify(result);
  })();
</script>
`;

const files = {
  'tmp/x.html': probe,
  'home/x.js': 'globalThis.__slicc_pwned = "module";\nexport const x = 1;\n',
  'home/classic.js': 'globalThis.__slicc_pwned = "classic";\n',
  'tmp/w.js': 'self.postMessage("ran");\n',
  'tmp/x.wasm': new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
};

async function write(page) {
  await page.evaluate(
    async (files) => {
      const root = await navigator.storage.getDirectory();
      for (const [path, content] of Object.entries(files)) {
        const parts = path.split('/');
        const name = parts.pop();
        let dir = root;
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(typeof content === 'string' ? content : new Uint8Array(content));
        await writable.close();
      }
    },
    Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        typeof content === 'string' ? content : [...content],
      ])
    )
  );
}

test('an OPFS page outside the code paths runs in an opaque origin without storage', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await write(page);
  const headers = await page.evaluate(async () => {
    const pick = (response) => ({
      status: response.status,
      type: response.headers.get('content-type'),
      csp: response.headers.get('content-security-policy'),
      sniff: response.headers.get('x-content-type-options'),
      coop: response.headers.get('cross-origin-opener-policy'),
      coep: response.headers.get('cross-origin-embedder-policy'),
    });
    return {
      page: pick(await fetch('/tmp/x.html')),
      os: pick(await fetch('/os/')),
    };
  });
  assert.deepEqual(headers.page, {
    status: 200,
    type: 'text/html; charset=utf-8',
    csp: "sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self'",
    sniff: 'nosniff',
    coop: null,
    coep: null,
  });
  assert.deepEqual(headers.os, {
    status: 200,
    type: 'text/html; charset=utf-8',
    csp: "frame-ancestors 'self'",
    sniff: null,
    coop: 'same-origin',
    coep: 'require-corp',
  });

  const tab = await page.tab();
  await tab.goto('/tmp/x.html');
  const text = await tab.until(() => {
    const out = document.getElementById('out')?.textContent;
    return out && out !== 'pending' && out;
  });
  assert.deepEqual(JSON.parse(text), {
    origin: 'null',
    isolated: false,
    open: 'denied: SecurityError',
    databases: 'denied: SecurityError',
    local: 'denied: SecurityError',
    storage: 'denied: SecurityError',
  });
  assert.deepEqual(page.errors, []);
});

test('a page the shell writes to /home still renders as a preview', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await run(
    page,
    `echo '<h1>Preview</h1><script>document.body.dataset.ran = "yes"</script>' > /home/preview.html && ln -s /home/preview.html /os/linked.html && echo written-$((40 + 2))`
  );
  await shows(page, 'written-42');
  const linked = await page.evaluate(() =>
    fetch('/os/linked.html').then((r) => [r.status, r.headers.get('x-served-from')])
  );
  assert.deepEqual(linked, [404, null]);
  const tab = await page.tab();
  await tab.goto('/home/preview.html');
  const shown = await tab.until(
    () =>
      document.body?.dataset.ran === 'yes' && {
        heading: document.querySelector('h1').textContent,
        origin: self.origin,
      }
  );
  assert.deepEqual(shown, { heading: 'Preview', origin: 'null' });
  assert.deepEqual(tab.errors, []);
  assert.deepEqual(page.errors, []);
});

test("seven's pages can't load an OPFS script outside the code paths", async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await write(page);
  const result = await page.evaluate(async () => {
    const imported = await import('/home/x.js').then(
      () => 'loaded',
      (error) => error.name
    );
    const worker = await new Promise((resolve) => {
      const started = new Worker('/tmp/w.js', { type: 'module' });
      started.onmessage = ({ data }) => resolve(data);
      started.onerror = (event) => {
        event.preventDefault();
        resolve('error');
      };
    });
    const classic = await new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = '/home/classic.js';
      script.onload = () => resolve('loaded');
      script.onerror = () => resolve('error');
      document.head.append(script);
    });
    const wasm = await WebAssembly.instantiateStreaming(fetch('/tmp/x.wasm')).then(
      () => 'instantiated',
      (error) => error.name
    );
    const text = await fetch('/home/x.js');
    return {
      imported,
      worker,
      classic,
      wasm,
      pwned: globalThis.__slicc_pwned ?? null,
      type: text.headers.get('content-type'),
      sniff: text.headers.get('x-content-type-options'),
      body: await text.text(),
    };
  });
  assert.deepEqual(result, {
    imported: 'TypeError',
    worker: 'error',
    classic: 'error',
    wasm: 'TypeError',
    pwned: null,
    type: 'text/plain; charset=utf-8',
    sniff: 'nosniff',
    body: 'globalThis.__slicc_pwned = "module";\nexport const x = 1;\n',
  });
  assert.deepEqual(page.errors, []);
});
