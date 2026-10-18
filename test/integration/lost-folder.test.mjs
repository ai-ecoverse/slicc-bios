import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { boot, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { attach } from './cli.mjs';

const chrome = await launch();
after(() => chrome.close());
const cli = process.env.SLICC_CLI;
const BOUND = 30;

const ONE = 'echo data > MNT/w.txt';
const STREAM =
  '( for i in $(seq 1 200000); do echo line-$i || exit 3; [ $i = 200 ] && touch /tmp/streaming; done ) > MNT/w.txt';

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'lost-folder-'));
  await writeFile(join(dir, 'hello.txt'), 'from the host\n');
  return dir;
}

async function mounted(page, command) {
  await run(
    page,
    `clear; ${command} && cat MNT/hello.txt && echo mounted-$((40 + 2))`.replaceAll(
      'MNT',
      '/mnt/lost'
    )
  );
  await shows(page, 'mounted-42', 60000);
}

async function writer(page, command) {
  await run(
    page,
    `clear; rm -f /tmp/writer /tmp/streaming; ( start=$(date +%s); ${command.replaceAll('MNT', '/mnt/lost')}; echo "writer rc=$? after $(( $(date +%s) - start )) s at $(date +%s)" > /tmp/writer ) & echo started-$((40 + 2))`
  );
  await shows(page, 'started-42');
}

async function ended(page, since) {
  for (let tick = 0; ; tick += 1) {
    await run(
      page,
      `clear; cat /tmp/writer 2>/dev/null || echo still-writing; grep ' /mnt/lost ' /proc/mounts; echo tick-${tick}-$((40 + 2))`
    );
    await shows(page, `tick-${tick}-42`);
    const text = await screen(page);
    const done = text.match(/writer rc=(\d+) after \d+ s at (\d+)/);
    if (done) {
      const seconds = Number(done[2]) - since / 1000;
      assert.ok(
        seconds < BOUND,
        `the writer ended ${Math.round(seconds)} s after its folder went away, past ${BOUND} s:\n${text}`
      );
      return { rc: Number(done[1]), seconds, text };
    }
    if ((Date.now() - since) / 1000 >= BOUND) {
      await run(
        page,
        `clear; ps -o pid,stat,etime,args | grep -v 'ps -o'; echo progress-$((40 + 2))`
      );
      await shows(page, 'progress-42');
      const elapsed = Math.round((Date.now() - since) / 1000);
      assert.fail(
        `the writer still runs ${elapsed} s after its folder went away (bound ${BOUND} s):\n${text}\nprocesses (etime is each one's elapsed time):\n${await screen(page)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function streaming(page) {
  await page.within(60000, async () => {
    const tmp = await (await navigator.storage.getDirectory()).getDirectoryHandle('tmp');
    const has = async (name) =>
      tmp.getFileHandle(name).then(
        () => true,
        () => false
      );
    return (await has('streaming')) && !(await has('writer'));
  });
}

async function nomedium(page, since) {
  for (let tick = 0; ; tick += 1) {
    await run(page, `clear; grep ' /mnt/lost ' /proc/mounts; echo medium-${tick}-$((40 + 2))`);
    await shows(page, `medium-${tick}-42`);
    const text = await screen(page);
    if (/\/mnt\/lost hostfs \S*nomedium/.test(text)) return;
    assert.ok(
      (Date.now() - since) / 1000 < BOUND,
      `the mount isn't nomedium ${BOUND} s after its folder went away:\n${text}`
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function linked(t) {
  const dir = await folder();
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  const node = attach(
    cli,
    ['--signal', 'stdio', '--name', 'ref-node', '--no-kernel', '--mount', `${dir}:proj`],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );
  t.after(() => node.kill('SIGKILL'));
  await page.expose('sliccLinkSend', (message) => {
    if (node.exitCode === null && !node.killed) node.stdin.write(`${JSON.stringify(message)}\n`);
  });
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((d) => d.state === 'connected')
  );
  await mounted(page, 'mkdir -p MNT && mount -t hostfs ref-node/proj MNT');
  return { page, lose: () => node.kill('SIGKILL') };
}

async function proxied(t) {
  const dir = await folder();
  const proxy = await startProxy({
    port: 0,
    origins: [new URL(chrome.url).origin],
    mounts: [`${dir}:proj`],
    kernelPort: null,
    log: () => {},
  });
  t.after(() => proxy.close().catch(() => {}));
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}`);
  await ready(page);
  await mounted(page, 'mkdir -p MNT && mount -t hostfs proj MNT');
  return { page, lose: () => proxy.close() };
}

const ways = [
  ['a linked slicc CLI', linked, !cli],
  ['the slicc-node proxy', proxied, false],
];

for (const [name, open, skip] of ways) {
  test(`kernel#1032: once ${name} is gone, a new write to its folder fails within ${BOUND} s and the mount shows nomedium`, {
    skip,
  }, async (t) => {
    const { page, lose } = await open(t);
    await lose();
    const since = Date.now();
    await writer(page, ONE);
    const { rc, text } = await ended(page, since);
    assert.notEqual(rc, 0, text);
    await nomedium(page, since);
    assert.deepEqual(page.errors, []);
  });

  test(`kernel#1032: when ${name} goes away mid-write, the writer fails within ${BOUND} s and the mount shows nomedium (kernel#1062)`, {
    skip,
  }, async (t) => {
    const { page, lose } = await open(t);
    await writer(page, STREAM);
    await streaming(page);
    await lose();
    const since = Date.now();
    const { rc, text } = await ended(page, since);
    assert.notEqual(
      rc,
      0,
      `the writer reported success although its folder went away mid-write:\n${text}`
    );
    await nomedium(page, since);
    assert.deepEqual(page.errors, []);
  });
}
