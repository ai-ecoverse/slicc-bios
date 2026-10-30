import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { ready, run, shows } from './bios.mjs';
import { CURRENT_EXTENSION, realExtension, SEVEN } from './real-extension.mjs';

function diagnosticConnection(connection) {
  const records = (globalThis.recoveryDiagnosticRecords ??= []);
  const methods = new Map();
  const classify = (url) => {
    if (typeof url !== 'string') return 'missing';
    if (url.startsWith('chrome-error:')) return 'error';
    if (url.includes('vault.sliccy.ai')) return 'vault';
    if (url.includes('seven.sliccy.ai')) return 'seven';
    if (url === '://' || url === '' || url === 'null') return 'opaque';
    if (url === 'about:blank') return 'blank';
    return 'ordinary';
  };
  const record = (direction, text) => {
    if (records.length >= 800) return;
    const message = JSON.parse(text);
    const params = message.params ?? {};
    if (direction === 'send') methods.set(message.id, message.method);
    const method = message.method ?? methods.get(message.id);
    const tree = message.result?.frameTree?.frame ?? params.frame;
    const info = message.result?.targetInfo ?? params.targetInfo;
    const row = {
      at: Date.now(),
      direction,
      id: message.id,
      method,
      session: message.sessionId,
      target: params.targetId ?? info?.targetId,
      destination: params.url === undefined ? undefined : classify(params.url),
      error: message.error?.message,
      attached: message.result?.sessionId,
      frame: tree?.id,
      loader: tree?.loaderId,
      document: tree ? classify(tree.url) : undefined,
      origin: tree ? classify(tree.securityOrigin) : undefined,
      unreachable: tree ? classify(tree.unreachableUrl) : undefined,
      targetType: info?.type,
      targetUrl: info ? classify(info.url) : undefined,
      navigateFrame: message.result?.frameId,
      navigateLoader: message.result?.loaderId,
      navigateError: message.result?.errorText,
      historyIndex: message.result?.currentIndex,
      history: message.result?.entries?.map((entry) => ({
        url: classify(entry.url),
        transition: entry.transitionType,
      })),
    };
    records.push(row);
  };
  const outer = {
    onmessage: null,
    onclose: null,
    send(text) {
      record('send', text);
      connection.send(text);
    },
    close() {
      connection.close();
    },
  };
  connection.onmessage = (text) => {
    record('receive', text);
    outer.onmessage?.(text);
  };
  connection.onclose = (...args) => outer.onclose?.(...args);
  return outer;
}

test('diagnostic recovery of the protected hop records the CLI-facing bridge', {
  timeout: 600000,
}, async (t) => {
  const stand = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>vault</title>');
  });
  await new Promise((resolve) => stand.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => stand.close(resolve)));
  const vault = `http://vault.sliccy.ai:${stand.address().port}/vault`;
  const real = await realExtension({
    extension: CURRENT_EXTENSION,
    rules: ['MAP vault.sliccy.ai 127.0.0.1'],
  });
  t.after(() => real.close());
  const page = await real.page(t);
  const source = await readFile(new URL('../../src/seed/cdp.js', import.meta.url), 'utf8');
  const original =
    'return observe(guardProtected(await open(), own, browser ? tabs.get(browser) : undefined));';
  assert.ok(source.includes(original));
  real.overrides.set(
    '/seed/cdp.js',
    source.replace(
      original,
      `return observe((${diagnosticConnection.toString()})(guardProtected(await open(), own, browser ? tabs.get(browser) : undefined)));`
    )
  );
  real.overrides.set('/recovery-seed.html', '<!doctype html><title>seed</title><h1>Seed</h1>');
  real.overrides.set(
    '/recovery-hop.html',
    `<!doctype html><meta http-equiv="refresh" content="0;url=${vault}">`
  );
  real.overrides.set(
    '/recovery-destination.html',
    '<!doctype html><title>Recovered ordinary tab</title><h1>Recovered ordinary tab</h1>'
  );
  await page.goto(SEVEN);
  await ready(page);
  const address = (path) => {
    const url = new URL(path, real.url);
    url.hostname = 'localhost';
    return url.href;
  };
  const read = (path) =>
    page.evaluate(async (path) => {
      let dir = await navigator.storage.getDirectory();
      const names = path.split('/').filter(Boolean);
      const name = names.pop();
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      return (await (await dir.getFileHandle(name)).getFile()).text();
    }, path);
  try {
    await run(
      page,
      `playwright-cli open ${address('/recovery-seed.html')} > /tmp/blocked-hop 2>&1; playwright-cli goto ${address('/recovery-hop.html')} >> /tmp/blocked-hop 2>&1; playwright-cli eval "document.title" >> /tmp/blocked-hop 2>&1; echo "hop-""finished"`
    );
    await shows(page, 'hop-finished', 180000);
    console.log('DIAGNOSTIC_HOP', await read('/tmp/blocked-hop'));
    await run(
      page,
      `playwright-cli goto ${address('/recovery-destination.html')} > /tmp/blocked-recovery 2>&1; echo recovery-goto-$? >> /tmp/blocked-recovery; playwright-cli eval "location.href + ' ' + document.title" >> /tmp/blocked-recovery 2>&1; echo recovery-read-$? >> /tmp/blocked-recovery; playwright-cli snapshot >> /tmp/blocked-recovery 2>&1; echo recovery-snapshot-$? >> /tmp/blocked-recovery; echo "recovery-""finished"`
    );
    await shows(page, 'recovery-finished', 180000);
    const recovered = await read('/tmp/blocked-recovery');
    console.log('DIAGNOSTIC_RECOVERED', recovered);
    assert.match(recovered, /^recovery-goto-0$/m);
  } finally {
    const records = await page.evaluate(() => globalThis.recoveryDiagnosticRecords ?? []);
    assert.ok(records.length > 0, 'the CLI-facing diagnostic override did not execute');
    for (const row of records) console.log('DIAGNOSTIC_CDP', JSON.stringify(row));
  }
});
