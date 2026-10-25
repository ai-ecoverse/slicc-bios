import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { attach, cliEnv } from './cli.mjs';
import { nativeTap, origins } from './cli-native-tap.mjs';

export const CLI =
  process.env.SLICC_CLI ?? fileURLToPath(new URL('../../node_modules/.bin/slicc', import.meta.url));

export async function linkNode(t, page, cdpPort, name = 'guard-fixture') {
  const home = await mkdtemp(join(tmpdir(), 'linked-node-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    ...cliEnv(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    SLICC_CDP_PORTS: '9300-9309',
    SLICC_DEBUG: '1',
  };
  delete env.SLICC_CDP_URL;
  const tap = await nativeTap(
    cdpPort,
    join(process.env.PROBE_STDERR_DIR, `native-round-${process.env.PROBE_ROUND}.jsonl`)
  );
  const node = attach(
    CLI,
    [
      '--signal',
      'stdio',
      '--name',
      name,
      '--no-kernel',
      '--cdp-extra',
      `http://127.0.0.1:${tap.port}`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env }
  );
  const log = createWriteStream(
    join(process.env.PROBE_STDERR_DIR, `cli-round-${process.env.PROBE_ROUND}.stderr.log`)
  );
  node.stderr.setEncoding('utf8');
  let partial = '';
  node.stderr
    .pipe(
      new Transform({
        transform(chunk, encoding, callback) {
          const lines = (partial + String(chunk)).split('\n');
          partial = lines.pop();
          callback(null, lines.length ? `${origins(lines.join('\n'))}\n` : '');
        },
        flush(callback) {
          callback(null, origins(partial));
        },
      })
    )
    .pipe(log);
  t.after(async () => {
    node.kill();
    if (!log.writableFinished)
      await new Promise((resolve, reject) => {
        log.once('finish', resolve);
        log.once('error', reject);
      });
    await tap.close();
  });
  await page.expose('sliccLinkSend', (message) => node.stdin.write(`${JSON.stringify(message)}\n`));
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  await page.within(120000, () => (globalThis.sliccLinkedBrowsers?.() ?? []).length > 0);
  return page.evaluate(() => globalThis.sliccLinkedBrowsers().map(({ runtime }) => runtime));
}
