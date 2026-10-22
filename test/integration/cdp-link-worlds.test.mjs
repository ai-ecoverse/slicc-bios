import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boot, ready, run, shows } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { attach, CLI, cliEnv } from './cli.mjs';
import { certificate } from './real-extension.mjs';

const cli = CLI;
const candidate = process.env.SLICC_CDP_CANDIDATE;
const body = `<!doctype html><title>LINK-DRIVEN</title><h1>Ordinary page</h1><button onclick="document.title='CLICKED'">Click me</button><input aria-label="Name"><select aria-label="Flavor"><option value="a">Apple</option><option value="b">Berry</option></select><input type="file" aria-label="Attachment"><button draggable="true">Drag source</button><button ondragover="event.preventDefault()" ondrop="document.body.dataset.dropped='yes'">Drop target</button><script>Object.defineProperty(document,'modelContext',{value:{getTools:()=>[{name:'echo',description:'Echo a value',inputSchema:{type:'object',properties:{value:{type:'string'}}}}],executeTool:async(_name,input)=>(typeof input==='string'?JSON.parse(input):input).value}});</script>`;

async function text(page, path) {
  return page.evaluate(async (path) => {
    const client = await globalThis.sliccKernelClient();
    try {
      return new TextDecoder().decode(await client.fs.readFile(path));
    } finally {
      await client.close();
    }
  }, path);
}

async function shell(page, command, name) {
  await run(
    page,
    `{ ${command}; } > /tmp/${name} 2>&1; echo exit-$? >> /tmp/${name}; echo "${name}-""done"`
  );
  await shows(page, `${name}-done`, 60000).catch(async (error) => {
    throw new Error(`Stage ${name}: ${error.message}\n${await text(page, `/tmp/${name}`)}`);
  });
  return text(page, `/tmp/${name}`);
}

async function installCandidate(page) {
  if (!candidate) return;
  const bytes = (await readFile(candidate)).toString('base64');
  const installed = await page.evaluate(async (encoded) => {
    const client = await globalThis.sliccKernelClient();
    try {
      const pkg = '/tmp/cdp-link-candidate';
      await client.fs.mkdir(`${pkg}/bin`, { recursive: true });
      await client.fs.writeFile(
        `${pkg}/package.json`,
        JSON.stringify({
          name: 'cdp-link-candidate',
          slicc: { abi: 'wasi', commands: { 'playwright-cli': { wasm: 'bin/playwright-cli' } } },
        })
      );
      await client.fs.writeFile(
        `${pkg}/bin/playwright-cli`,
        Uint8Array.from(atob(encoded), (each) => each.charCodeAt(0))
      );
      return await client.run(['chmod', '755', `${pkg}/bin/playwright-cli`]);
    } finally {
      await client.close();
    }
  }, bytes);
  assert.equal(installed.status, 0, installed.stderr);
  const selected = await shell(
    page,
    'export PATH=/tmp/cdp-link-candidate/bin:$PATH; playwright-cli --version',
    'candidate'
  );
  assert.match(selected, /playwright-cli /);
  assert.match(selected, /exit-0/);
}

const ref = (snapshot, name) => {
  const found = new RegExp(`"${name}"[^\n]*\\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];
  assert.ok(found, snapshot);
  return found;
};

test('slicc-cdp#377: the kernel facade and slicc-cli link drive ordinary tabs with an isolated extension world', {
  skip: !cli,
  timeout: 240000,
}, async (t) => {
  let port;
  for (let next = 9300; next <= 9309; next += 1) {
    const probe = createServer();
    try {
      await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(next, '127.0.0.1', resolve);
      });
      port = next;
      await new Promise((resolve) => probe.close(resolve));
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  assert.ok(port, 'a test CDP port in 9300-9309 is free');
  const stand = http((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/vault' ? '<title>VAULT-MARK</title>' : body);
  });
  const secure = https(await certificate(), (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  await Promise.all(
    [stand, secure].map(
      (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    )
  );
  t.after(() => {
    for (const server of [stand, secure]) {
      server.closeAllConnections();
      server.close();
    }
  });
  const chrome = await launch({
    extensions: [fileURLToPath(new URL('./fixtures/injected-frame', import.meta.url))],
    args: [
      `--remote-debugging-port=${port}`,
      '--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1',
      '--ignore-certificate-errors',
    ],
  });
  t.after(() => chrome.close());
  await debuggerUrl(port);
  const devtools = async (path, init) =>
    (await fetch(`http://127.0.0.1:${port}${path}`, init)).json();
  const user = (
    await devtools(`/json/new?https://localhost:${secure.address().port}/ordinary`, {
      method: 'PUT',
    })
  ).id;
  const page = await chrome.page(t);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await boot(page);
  await ready(page);
  const home = await mkdtemp(join(tmpdir(), 'cdp-link-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    ...cliEnv(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    SLICC_CDP_PORTS: '9300-9309',
  };
  delete env.SLICC_CDP_URL;
  const node = attach(
    cli,
    [
      '--signal',
      'stdio',
      '--name',
      'cdp-fixture',
      '--no-kernel',
      '--cdp-extra',
      `http://127.0.0.1:${port}`,
    ],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    }
  );
  t.after(() => node.kill());
  await page.expose('sliccLinkSend', (message) => node.stdin.write(`${JSON.stringify(message)}\n`));
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((device) => device.state === 'connected')
  );
  await page.until(
    () => document.querySelector('slicc-app').model.network.status().browser.via === 'link'
  );
  await installCandidate(page);
  const userSnapshot = await shell(
    page,
    `playwright-cli eval --tab ${user} 'document.title' && playwright-cli eval --tab ${user} 'document.documentElement.dataset.extensionFixture' && playwright-cli snapshot --tab ${user}`,
    'user-link'
  );
  assert.match(userSnapshot, /LINK-DRIVEN/);
  assert.match(userSnapshot, /[a-p]{32}/);
  assert.match(userSnapshot, /exit-0/);
  const clicked = await shell(
    page,
    `playwright-cli click --tab ${user} ${ref(userSnapshot, 'Click me')} && playwright-cli eval --tab ${user} 'document.title'`,
    'user-click'
  );
  assert.match(clicked, /CLICKED/);
  assert.match(clicked, /exit-0/);
  const fresh = await shell(
    page,
    `playwright-cli open http://localhost:${stand.address().port}/fresh && playwright-cli eval 'document.title' && playwright-cli eval 'document.documentElement.dataset.extensionFixture' && playwright-cli snapshot`,
    'fresh-link'
  );
  assert.match(fresh, /Opened .*\[targetId: [A-F0-9]+\]/);
  const freshId = /\[targetId: ([A-F0-9]+)\]/.exec(fresh)[1];
  assert.match(fresh, /LINK-DRIVEN/);
  assert.match(fresh, /[a-p]{32}/);
  assert.match(fresh, /exit-0/);
  const driven = await shell(
    page,
    `playwright-cli click ${ref(fresh, 'Click me')} && playwright-cli eval 'document.title'`,
    'fresh-click'
  );
  assert.match(driven, /CLICKED/);
  assert.match(driven, /exit-0/);
  for (const [name, command] of [
    ['fill', (snapshot) => `playwright-cli fill ${ref(snapshot, 'Name')} Ada`],
    ['select', (snapshot) => `playwright-cli select ${ref(snapshot, 'Flavor')} b`],
    [
      'upload',
      (snapshot) =>
        `echo upload-fixture > /tmp/upload.txt && playwright-cli upload ${ref(snapshot, 'Attachment')} /tmp/upload.txt`,
    ],
    [
      'drag',
      (snapshot) =>
        `playwright-cli drag ${ref(snapshot, 'Drag source')} ${ref(snapshot, 'Drop target')}`,
    ],
  ]) {
    const snapshot = await shell(page, 'playwright-cli snapshot', `${name}-snapshot`);
    const output = await shell(page, command(snapshot), `${name}-action`);
    assert.match(output, /exit-0/, output);
    assert.doesNotMatch(output, /slicc: refused:/, output);
  }
  const tools = await shell(
    page,
    `playwright-cli webmcp-list && playwright-cli webmcp-call echo '{"value":"WEBMCP-MARK"}' && playwright-cli discover --tab ${freshId} --once http://localhost:${stand.address().port}/fresh --no-probe --json`,
    'tools-link'
  );
  assert.match(tools, /WEBMCP-MARK/);
  assert.match(tools, /exit-0/);
  assert.doesNotMatch(tools, /slicc: refused:/);
  const tabs = await devtools('/json/list');
  const seven = tabs.find((tab) => tab.url.startsWith(new URL('/os/', chrome.url).href)).id;
  const vault = (
    await devtools(`/json/new?http://vault.sliccy.ai:${stand.address().port}/vault`, {
      method: 'PUT',
    })
  ).id;
  await page.send('Page.bringToFront');
  for (const [name, tab] of [
    ['seven', seven],
    ['vault', vault],
  ]) {
    const refused = await shell(
      page,
      `playwright-cli eval --tab ${tab} 'document.title'`,
      `refused-${name}`
    );
    assert.equal(refused, "slicc: refused: target is on seven's origin\nexit-1\n");
    assert.doesNotMatch(refused, /VAULT-MARK/);
  }
  assert.deepEqual(page.errors, []);
});
