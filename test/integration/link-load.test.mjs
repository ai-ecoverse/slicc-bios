import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { devtools, launch } from './chrome.mjs';
import { attach, CLI } from './cli.mjs';

const chrome = await launch({ timeout: 180000 });
after(() => chrome.close());

async function loadProgram(ctx) {
  const sizes = await Promise.all(
    Array.from({ length: 64 }, async (_, i) => {
      const response = await ctx.fetch(`${ctx.argv[1]}?i=${i}`, {
        signal: AbortSignal.timeout(90000),
      });
      const bytes = await response.arrayBuffer();
      if (response.status !== 200 || bytes.byteLength !== 256 * 1024)
        throw new Error(`response ${i}: ${response.status}, ${bytes.byteLength} bytes`);
      return bytes.byteLength;
    })
  );
  await ctx.write(1, `FETCHES ${sizes.length} ${sizes.reduce((sum, size) => sum + size, 0)}\n`);
}

test('diagnostic: 64 parallel kernel fetches and a small pnpm install through the linked exit', {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  assert.ok(CLI, 'the real slicc CLI is installed');
  const payload = Buffer.alloc(256 * 1024, 'x');
  let arrived = 0;
  let peak = 0;
  const waiting = new Set();
  const server = createServer((_request, response) => {
    arrived += 1;
    waiting.add(response);
    peak = Math.max(peak, waiting.size);
    if (waiting.size === 64) {
      for (const pending of waiting) pending.end(payload);
      waiting.clear();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const page = await chrome.page(t);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await boot(page);
  await page.evaluate(async (program) => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ['node_modules', 'link-load'])
      dir = await dir.getDirectoryHandle(part, { create: true });
    const files = {
      'package.json': JSON.stringify({
        name: 'link-load',
        slicc: { commands: { 'link-load': { abi: 'js', module: 'index.mjs' } } },
      }),
      'index.mjs': program,
    };
    for (const [name, body] of Object.entries(files)) {
      const writer = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writer.write(body);
      await writer.close();
    }
  }, `export default ${loadProgram.toString()}`);
  await page.reload();
  await ready(page);
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  const { port: debugPort } = await devtools(chrome);
  const node = attach(
    CLI,
    [
      '--signal',
      'stdio',
      '--name',
      'peak-node',
      '--no-kernel',
      '--cdp',
      `http://127.0.0.1:${debugPort}`,
    ],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
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
      .links?.devices.some((device) => device.name === 'peak-node' && device.state === 'connected')
  );
  await page.evaluate(async () => {
    const network = document.querySelector('slicc-app').model.network;
    const device = network.status().links.devices.find((device) => device.name === 'peak-node');
    await network.setExit({ kind: 'link', id: device.id });
  });
  const fetched = await page.evaluate(async (port) => {
    const client = await globalThis.sliccKernelClient();
    try {
      return await client.run(['link-load', `http://peak-node.slicc.internal:${port}/load`]);
    } finally {
      await client.close();
    }
  }, server.address().port);
  assert.equal(fetched.status, 0, JSON.stringify({ ...fetched, arrived, peak }));
  assert.match(fetched.stdout, /FETCHES 64 16777216/);
  assert.equal(arrived, 64);
  assert.equal(peak, 64);
  console.log(
    `LINK-LOAD ${JSON.stringify({ fetches: arrived, simultaneous: peak, bytes: payload.length * arrived })}`
  );
  const installed = await page.evaluate(async () => {
    const client = await globalThis.sliccKernelClient();
    try {
      return await client.run([
        'bash',
        '-c',
        "mkdir -p /home/link-pnpm && cd /home/link-pnpm && printf '%s' '{\"private\":true}' > package.json && pnpm add is-number@7.0.0 --ignore-scripts",
      ]);
    } finally {
      await client.close();
    }
  });
  assert.equal(installed.status, 0, JSON.stringify(installed));
  console.log(`LINK-LOAD ${JSON.stringify({ pnpm: 'is-number@7.0.0', status: installed.status })}`);
});
