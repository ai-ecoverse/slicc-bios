import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { boot, ready, run, trust } from './bios.mjs';
import { launch } from './chrome.mjs';
import { cliEnv, HOST_CDP } from './cli.mjs';

const cli = process.env.SLICC_CLI;
const chrome = await launch();
after(() => chrome.close());

const PORTS = [17180, 17189];
const STEP = 60_000;
const origin = new URL(chrome.url).origin;

const short = (fp) => `${fp.slice(0, 4)}…${fp.slice(-2)}`;
const fragment = (url) => new URL(url).hash.slice('#slicc-pair='.length).split('.');

async function scratch(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function slicc(t, args, { home, env = {} }) {
  const node = spawn(cli, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cliEnv({
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      SLICC_LOOPBACK_PORTS: PORTS.join('-'),
      SLICC_NO_TELEMETRY: '1',
      SLICC_NO_UPDATE_CHECK: '1',
      ...env,
    }),
  });
  const said = [];
  const urls = [];
  const out = [];
  createInterface({ input: node.stderr }).on('line', (line) => said.push(line));
  createInterface({ input: node.stdout }).on('line', (line) => {
    out.push(line);
    if (line.includes('#slicc-pair=')) urls.push(line.trim());
  });
  const exited = new Promise((resolve) => node.on('exit', (code) => resolve(code)));
  const run = { node, said, urls, out, exited };
  run.url = async (n = 1) => {
    const end = Date.now() + STEP;
    while (urls.length < n) {
      if (node.exitCode !== null) assert.fail(`slicc exited ${node.exitCode}: ${said.join('\n')}`);
      if (Date.now() > end) assert.fail(`slicc printed no pairing URL: ${said.join('\n')}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return urls[n - 1];
  };
  run.saw = async (pattern) => {
    const end = Date.now() + STEP;
    while (!said.some((line) => pattern.test(line))) {
      if (Date.now() > end) assert.fail(`slicc never said ${pattern}: ${said.join('\n')}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  run.stop = async () => {
    if (node.exitCode === null) node.kill('SIGTERM');
    return exited;
  };
  t.after(() => run.stop());
  return run;
}

const pairArgs = (name, extra = []) => [
  'pair',
  '--page',
  `${origin}/`,
  '--name',
  name,
  '--no-kernel',
  '--no-jerk',
  ...extra,
];

const network = (page, fn, ...args) =>
  page.evaluate(
    new Function(
      'args',
      `return (${fn})(document.querySelector('slicc-app').model.network, ...args)`
    ),
    args
  );

const pairing = (page) => network(page, (n) => n.status().links?.pairing ?? null);
const devices = (page) => network(page, (n) => n.status().links?.devices ?? []);

async function pairingIs(page, state, ms = STEP) {
  await page
    .within(
      ms,
      (state) =>
        document.querySelector('slicc-app')?.model?.network?.status().links?.pairing?.state ===
        state,
      state
    )
    .catch(async (error) => {
      throw new Error(
        `pairing never ${state}: ${error.message}\n${JSON.stringify(await pairing(page))}`
      );
    });
}

async function deviceIs(page, id, state, ms = STEP) {
  await page
    .within(
      ms,
      ([id, state]) =>
        document
          .querySelector('slicc-app')
          .model.network.status()
          .links?.devices.some((d) => d.id === id && d.state === state),
      [id, state]
    )
    .catch(async (error) => {
      throw new Error(
        `device ${id.slice(0, 8)} never ${state}: ${error.message}\n${JSON.stringify(await devices(page))}`
      );
    });
}

async function enter(page, url) {
  return network(
    page,
    (n, url) =>
      n.pairComputer(url).then(
        () => null,
        (error) => error.message
      ),
    url
  );
}

async function confirm(page) {
  await network(page, (n) => void n.confirmPairing());
}

async function kernelFile(page, name) {
  return page.evaluate(async (name) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return (await (await home.getFileHandle(name)).getFile()).text();
  }, name);
}

async function shell(page, command, name) {
  await run(page, `${command} > /home/${name}.txt 2>&1; echo $? > /home/${name}.done`);
  await page.until(async (name) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return home.getFileHandle(`${name}.done`).then(
      async (handle) => (await handle.getFile()).size > 0,
      () => false
    );
  }, name);
  return {
    code: (await kernelFile(page, `${name}.done`)).trim(),
    out: (await kernelFile(page, `${name}.txt`)).trim(),
  };
}

async function listen(t, name, port = 0) {
  const hits = [];
  const server = createServer((request, response) => response.end(`${name} ${request.url}\n`));
  server.on('connection', () => hits.push(name));
  const bound = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (!bound) return null;
  t.after(() => server.close());
  return { hits, port: server.address().port };
}

test('seven pairs slicc pair on this computer without CDP: the link carries kernel curl and a folder, survives a reload and a restart of slicc, and Unlink makes slicc forget it', {
  skip: !cli,
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const home = await scratch(t, 'pair-home-');
  const folder = await scratch(t, 'pair-folder-');
  await writeFile(join(folder, 'hello.txt'), 'from the paired folder\n');
  const fixture = await listen(t, 'fixture');
  const decoy = await listen(t, 'decoy');
  const debug = [];
  for (const port of HOST_CDP) {
    const held = await listen(t, `debug ${port}`, port);
    if (held) debug.push(held);
  }
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  const args = pairArgs('quay-studio', ['--mount', `${folder}:proj`]);
  const env = { SLICC_PROTECTED_PORTS: String(decoy.port) };
  let node = slicc(t, args, { home, env });
  const url = await node.url();
  const [port, , fp] = fragment(url);
  assert.ok(
    Number(port) >= PORTS[0] && Number(port) <= PORTS[1],
    url.replace(/\.[^.]+\./, '.…token….')
  );
  assert.equal(await pairing(page).then((p) => p?.state), 'idle');
  assert.equal(await enter(page, url), null);
  assert.deepEqual(await pairing(page), { state: 'confirm', code: short(fp) });
  await confirm(page);
  await pairingIs(page, 'linked');
  assert.deepEqual(await pairing(page), { state: 'linked', code: short(fp), name: 'quay-studio' });
  await node.saw(new RegExp(`paired with seven on ${origin.replaceAll('.', '\\.')} \\(`));
  await deviceIs(page, fp, 'connected');
  const row = (await devices(page)).find((d) => d.id === fp);
  assert.equal(row.mode, 'local');
  assert.equal(row.kind, 'cli');
  assert.equal(row.name, 'quay-studio');
  assert.equal(row.host, 'quay-studio.slicc.internal');
  assert.equal('control' in row, false);
  assert.equal('access' in row, false);
  assert.deepEqual(row.folders, [{ name: 'proj', source: 'quay-studio/proj', readonly: false }]);
  assert.deepEqual(
    await shell(
      page,
      `curl -s --noproxy '*' http://quay-studio.slicc.internal:${fixture.port}/hi`,
      'pair-curl'
    ),
    { code: '0', out: 'fixture /hi' }
  );
  for (const { port: blocked, hits } of [...debug, decoy]) {
    const refused = await shell(
      page,
      `curl -s --noproxy '*' http://quay-studio.slicc.internal:${blocked}/json/version`,
      `pair-debug-${blocked}`
    );
    assert.notEqual(refused.code, '0', `${blocked} answered: ${refused.out}`);
    assert.deepEqual(hits, [], `${blocked} saw a connection`);
  }
  assert.equal(
    await network(page, (n) => n.mountFolder('quay-studio/proj')),
    '/mnt/quay-studio/proj'
  );
  assert.deepEqual(await shell(page, 'cat /mnt/quay-studio/proj/hello.txt', 'pair-read'), {
    code: '0',
    out: 'from the paired folder',
  });
  assert.deepEqual(
    await shell(
      page,
      'echo written by seven > /mnt/quay-studio/proj/back.txt && ls /mnt/quay-studio/proj',
      'pair-write'
    ),
    { code: '0', out: 'back.txt\nhello.txt' }
  );
  assert.equal(await readFile(join(folder, 'back.txt'), 'utf8'), 'written by seven\n');

  await page.reload();
  await ready(page);
  await deviceIs(page, fp, 'connected');
  assert.equal(node.urls.length, 1);

  await node.stop();
  await deviceIs(page, fp, 'offline');
  node = slicc(t, args, { home, env });
  await node.saw(/this computer: quay-studio/);
  await deviceIs(page, fp, 'connected');

  await network(page, (n, id) => n.unlink(id), fp);
  await node.saw(/unlinked by seven on .*; it must pair again to link/);
  assert.deepEqual(
    (await devices(page)).filter((d) => d.id === fp),
    []
  );
  await node.stop();
  const unpair = slicc(t, ['unpair'], { home });
  assert.equal(await unpair.exited, 0, unpair.said.join('\n'));
  assert.deepEqual(unpair.out, ['no paired sevens']);
  assert.deepEqual(page.errors, []);
});

test('seven refuses a wrong code, a used link, a stopped slicc and a debugging port, and pairs from the address bar after a confirm', {
  skip: !cli,
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const home = await scratch(t, 'pair-refuse-');
  const watched = [];
  for (const port of HOST_CDP) {
    const held = await listen(t, `debug ${port}`, port);
    if (held) watched.push(held);
  }
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  const node = slicc(t, pairArgs('quay-studio'), { home });
  const url = await node.url();
  const [port, token, fp] = fragment(url);
  const wrong = `${origin}/#slicc-pair=${port}.${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}.${fp}`;
  assert.equal(await enter(page, wrong), null);
  await confirm(page);
  await pairingIs(page, 'failed');
  assert.deepEqual(await pairing(page), {
    state: 'failed',
    code: short(fp),
    error:
      'slicc refused this pairing link: it’s wrong, already used or expired. Press Enter in slicc for a new one.',
  });
  await node.saw(/refused a pairing request from .*: the token is wrong, used or expired/);
  assert.deepEqual(await devices(page), []);
  await network(page, (n) => n.cancelPairing());

  for (const blocked of [9222, 9229, 80]) {
    const message = await enter(page, `${origin}/#slicc-pair=${blocked}.${token}.${fp}`);
    assert.match(message, new RegExp(`^Seven never pairs over port ${blocked}: `));
    assert.equal((await pairing(page)).state, 'idle');
  }
  assert.equal(
    await enter(page, `${origin}/#nothing-here`),
    'That isn’t a pairing link from slicc pair.'
  );

  await page.goto(`/#slicc-pair=9222.${token}.${fp}`);
  await pairingIs(page, 'failed');
  assert.equal(
    (await pairing(page)).error,
    'Seven never pairs over port 9222: it’s a browser’s debugging port.'
  );
  assert.equal(await page.evaluate(() => location.hash), '');
  for (const { port: watchedPort, hits } of watched)
    assert.deepEqual(hits, [], `${watchedPort} saw a connection`);

  await page.goto(`/#slicc-pair=${port}.${token}.${fp}`);
  await pairingIs(page, 'confirm');
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(
    await page.evaluate(() =>
      document.querySelector('slicc-app').dock.api.panels.some((p) => p.id === 'network')
    ),
    true
  );
  await confirm(page);
  await pairingIs(page, 'linked');
  await deviceIs(page, fp, 'connected');

  assert.equal(await enter(page, url), null);
  await confirm(page);
  await pairingIs(page, 'failed');
  assert.match((await pairing(page)).error, /^slicc refused this pairing link/);
  await network(page, (n) => n.cancelPairing());

  node.node.stdin.write('\n');
  const fresh = await node.url(2);
  await node.stop();
  assert.equal(await enter(page, fresh), null);
  await confirm(page);
  await pairingIs(page, 'failed');
  assert.equal(
    (await pairing(page)).error,
    `Nothing answered on port ${port}, or slicc refused this page’s origin: is slicc still running on this computer?`
  );
  await deviceIs(page, fp, 'offline');
  assert.deepEqual(page.errors, []);
});

test('slicc open with seven already open: the new tab hands the pairing to the tab running SLICC, both show it, and the new tab keeps the device once the first one closes', {
  skip: !cli,
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const home = await scratch(t, 'pair-open-');
  const owner = await chrome.page(t);
  await boot(owner);
  await owner.until(() => document.querySelector('slicc-app').model.tabs?.state().role === 'owner');
  const node = slicc(t, ['open', ...pairArgs('quay-studio').slice(1)], {
    home,
    env: { SLICC_OPEN_COMMAND: 'true' },
  });
  const url = await node.url();
  await node.saw(/opened the pairing URL in the default browser/);
  const [, , fp] = fragment(url);
  const fresh = await owner.tab();
  await fresh.goto(`/${new URL(url).hash}`);
  await fresh.until(
    () => document.querySelector('slicc-app').model.tabs?.state().role === 'follower'
  );
  await pairingIs(fresh, 'confirm');
  await pairingIs(owner, 'confirm');
  await confirm(fresh);
  await pairingIs(fresh, 'linked');
  await deviceIs(owner, fp, 'connected');
  await deviceIs(fresh, fp, 'connected');
  assert.deepEqual(owner.errors, []);
  await owner.close();
  await fresh.within(
    STEP,
    () => document.querySelector('slicc-app').model.tabs?.state().role === 'owner'
  );
  await deviceIs(fresh, fp, 'connected');
  assert.equal(
    await fresh.evaluate(
      (id) => Object.keys(JSON.parse(localStorage.getItem('slicc-os.paired'))).includes(id),
      fp
    ),
    true
  );
  assert.equal(node.urls.length, 1);
  assert.deepEqual(fresh.errors, []);
});

test('a new tab whose seven version differs from the running tab’s says why it can’t pair, and nothing pairs', {
  skip: !cli,
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const home = await scratch(t, 'pair-skew-');
  const owner = await chrome.page(t);
  await boot(owner);
  await owner.until(() => document.querySelector('slicc-app').model.tabs?.state().role === 'owner');
  const switchboard = await owner.evaluate(async () => {
    const os = await (await navigator.storage.getDirectory()).getDirectoryHandle('os');
    return (await (await os.getFileHandle('switchboard.js')).getFile()).text();
  });
  await trust(owner, { 'os/switchboard.js': `${switchboard}\n` });
  const node = slicc(t, pairArgs('quay-studio'), { home });
  const url = await node.url();
  const fresh = await owner.tab();
  await fresh.goto(`/os/${new URL(url).hash}`);
  await pairingIs(fresh, 'failed');
  assert.deepEqual(await pairing(fresh), {
    state: 'failed',
    error:
      'Another SLICC tab runs a different version, so this tab can’t link slicc. Reload the SLICC tabs, then open the pairing link again.',
  });
  assert.notEqual(
    await fresh.evaluate(() => document.querySelector('slicc-app').model.tabs.state().skew),
    null
  );
  assert.equal(await fresh.evaluate(() => location.hash), '');
  assert.equal((await pairing(owner)).state, 'idle');
  assert.deepEqual(await devices(owner), []);
  assert.deepEqual(
    node.said.filter((line) => /pairing|paired/.test(line) && !/to link seven/.test(line)),
    []
  );
});

test('a slicc that forgot this seven: its offline row says so, and pairing again clears it', {
  skip: !cli,
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const home = await scratch(t, 'pair-forgot-');
  const page = await chrome.page(t);
  await boot(page);
  let node = slicc(t, pairArgs('quay-studio'), { home });
  const [, , fp] = fragment(await node.url());
  assert.equal(await enter(page, node.urls[0]), null);
  await confirm(page);
  await deviceIs(page, fp, 'connected');
  await node.stop();
  const unpair = slicc(t, ['unpair', '--all'], { home });
  assert.equal(await unpair.exited, 0, unpair.said.join('\n'));
  assert.deepEqual(unpair.out, ['forgot 1 paired sevens']);
  node = slicc(t, pairArgs('quay-studio'), { home });
  await node.url();
  await page.within(
    STEP,
    (id) =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links.devices.some((d) => d.id === id && d.note),
    fp
  );
  const row = (await devices(page)).find((d) => d.id === fp);
  assert.equal(row.state, 'offline');
  assert.equal(row.note, 'quay-studio no longer knows this seven. Pair it again.');
  node.node.stdin.write('\n');
  assert.equal(await enter(page, await node.url(2)), null);
  await confirm(page);
  await deviceIs(page, fp, 'connected');
  assert.equal((await devices(page)).find((d) => d.id === fp).note, undefined);
  assert.deepEqual(page.errors, []);
});
