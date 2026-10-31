import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { attach, cliEnv } from './cli.mjs';

export const CLI =
  process.env.SLICC_CLI ?? fileURLToPath(new URL('../../node_modules/.bin/slicc', import.meta.url));

export async function linkNode(t, page, cdpPort, name = 'guard-fixture', binary = CLI) {
  const home = await mkdtemp(join(tmpdir(), 'linked-node-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    ...cliEnv(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    SLICC_CDP_PORTS: '9300-9309',
  };
  delete env.SLICC_CDP_URL;
  const node = attach(
    binary,
    [
      '--signal',
      'stdio',
      '--name',
      name,
      '--no-kernel',
      '--cdp-extra',
      `http://127.0.0.1:${cdpPort}`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'], env }
  );
  t.after(() => node.kill());
  await page.expose('sliccLinkSend', (message) => node.stdin.write(`${JSON.stringify(message)}\n`));
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  await page.within(120000, () => (globalThis.sliccLinkedBrowsers?.() ?? []).length > 0);
  return page.evaluate(() => globalThis.sliccLinkedBrowsers().map(({ runtime }) => runtime));
}
