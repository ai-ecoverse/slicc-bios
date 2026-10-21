import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { actPackage, boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const exec = promisify(execFile);
const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const PNPM = '@ai-ecoverse/wasi-pnpm';
const TRAP = 'pnpm: wasm trap in thread 4: memory access out of bounds';
const LOG = '/var/log/slicc/pnpm-traps.log';
const repo = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, repo), 'utf8');
const SHIM = `#!/bin/bash
d=/tmp/pnpm-trap
[ -d "$d" ] && echo "$*" >> "$d/runs"
left=$(cat "$d/left" 2>/dev/null || echo 0)
if [ "$left" -gt 0 ]; then
  echo $((left - 1)) > "$d/left"
  echo '${TRAP}' >&2
  exit 134
fi
exec pn "$@"
`;

let files;

async function trapping() {
  const lock = JSON.parse(await read('src/packages/package-lock.json'));
  const entry = lock.packages[`node_modules/${PNPM}`];
  const real = entry.version;
  const fake = `${real}.trap`;
  const dir = await mkdtemp(join(tmpdir(), 'pnpm-trap-'));
  try {
    const tarball = join(dir, 'real.tgz');
    await writeFile(tarball, Buffer.from(await download(entry.resolved)));
    await exec('tar', ['-xzf', tarball, '-C', dir]);
    const manifestPath = join(dir, 'package', 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.version = fake;
    manifest.slicc.commands.pnpm = { script: 'shims/pnpm-trap' };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const shim = join(dir, 'package', 'shims', 'pnpm-trap');
    await writeFile(shim, SHIM);
    await chmod(shim, 0o755);
    const built = join(dir, 'fake.tgz');
    await exec('tar', ['-czf', built, '-C', dir, 'package']);
    const bytes = await readFile(built);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const resolved = `https://registry.npmjs.org/${PNPM}/-/wasi-pnpm-${fake}.tgz`;
    const cached = new URL(
      `node_modules/.cache/slicc-harness/cdn/registry.npmjs.org/${PNPM}/-/wasi-pnpm-${fake}.tgz`,
      repo
    );
    await mkdir(new URL('./', cached), { recursive: true });
    await writeFile(cached, bytes);

    lock.packages[''].dependencies[PNPM] = fake;
    Object.assign(entry, { version: fake, resolved, integrity });
    const pkg = JSON.parse(await read('src/packages/package.json'));
    pkg.dependencies[PNPM] = fake;
    const yaml = (await read('src/packages/pnpm-lock.yaml'))
      .replaceAll(`${PNPM}@${real}`, `${PNPM}@${fake}`)
      .replace(
        new RegExp(`('${PNPM}':\\n {8}specifier: )${real}(\\n {8}version: )${real}`),
        `$1${fake}$2${fake}`
      )
      .replace(
        new RegExp(
          `('${PNPM}@${fake.replaceAll('.', '\\.')}':\\n {4}resolution: \\{integrity: )[^}]+`
        ),
        `$1${integrity}`
      );
    assert.ok(
      !yaml.includes(`${PNPM}@${real}'`) && yaml.includes(integrity),
      'the base lock names the fake pnpm'
    );
    return {
      '/packages/package.json': `${JSON.stringify(pkg, null, 2)}\n`,
      '/packages/package-lock.json': `${JSON.stringify(lock, null, 2)}\n`,
      '/packages/pnpm-lock.yaml': yaml,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

before(async () => {
  files = await trapping();
});

async function said(page, command, mark) {
  await run(page, `clear; ${command}; echo ${mark}-$((40 + 2))`);
  await shows(page, `${mark}-42`, 60000);
  return (await screen(page)).replace(/\s+/g, ' ');
}

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id),
    id
  );

const traps = async (page) =>
  (await said(page, `tail -n 1 ${LOG} | jq -r '"trap " + .outcome + " " + .line'`, 'logged'))
    .match(/trap (.*?) (pnpm: .*?) logged-42/)
    ?.slice(1);

test('a pnpm run that hits the wasm trap once is retried once and the install succeeds; one that traps twice fails naming the trap, with no third run and nothing installed', async (t) => {
  const page = await chrome.page(t);
  page.forceTraps();
  for (const [path, body] of Object.entries(files)) chrome.overrides.set(path, body);
  await boot(page);
  assert.match(
    await said(page, `jq -r '"pnpm " + .version' /node_modules/${PNPM}/package.json`, 'which'),
    /pnpm \S+\.trap /
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'xxd')
  );
  await page.within(5 * 60 * 1000, () => {
    const { updates } = document.querySelector('slicc-app').model;
    const rows = [...updates.list(), ...updates.packages()];
    return rows.every((row) => !/queued|starting|checking|downloading|linking/.test(row.state));
  });

  await said(
    page,
    'mkdir -p /tmp/pnpm-trap && echo 1 > /tmp/pnpm-trap/left && : > /tmp/pnpm-trap/runs',
    'armed'
  );
  assert.equal(await actPackage(page, 'xxd', 'install'), 'ok', (await row(page, 'xxd')).log);
  assert.equal((await row(page, 'xxd')).state, 'installed');
  const once = await said(
    page,
    'echo "runs $(grep -c "^add -g @ai-ecoverse/wasm-xxd@" /tmp/pnpm-trap/runs)"; xxd -v 2>&1 | head -1',
    'once'
  );
  if (!/runs 2 /.test(once))
    assert.fail(`${once}\n${await said(page, 'cat /tmp/pnpm-trap/runs', 'dumped')}`);
  assert.deepEqual(await traps(page), ['recovered', TRAP]);
  assert.ok(
    page.console.some((line) =>
      /^warning bios: pnpm trapped \(pnpm: wasm trap in thread 4: memory access out of bounds\).*homescoop#1127.*retrying once/.test(
        line
      )
    ),
    page.console.join('\n')
  );
  assert.ok(page.console.some((line) => /retry after the wasm trap succeeded/.test(line)));

  await said(page, 'echo 2 > /tmp/pnpm-trap/left && : > /tmp/pnpm-trap/runs', 'rearmed');
  const failed = await actPackage(page, 'bind', 'install');
  assert.match(failed, /^Couldn't install BIND tools \(dig, host, nslookup\): /);
  const dig = await row(page, 'bind');
  assert.equal(dig.state, 'failed');
  assert.match(
    `${failed}\n${dig.log}`,
    /trapped twice with the wasm trap of homescoop#1127, slicc-kernel#1172/
  );
  assert.ok(dig.log.includes(TRAP), dig.log);
  const twice = await said(
    page,
    'echo "runs $(grep -c "^add -g @ai-ecoverse/wasix-bind@" /tmp/pnpm-trap/runs) all $(wc -l < /tmp/pnpm-trap/runs) left $(cat /tmp/pnpm-trap/left)"; command -v dig || echo no-dig; ls "$PNPM_HOME"/global/v11/*/node_modules/@ai-ecoverse 2>/dev/null | grep -cx wasix-bind | sed "s/^/dig-projects /"',
    'twice'
  );
  assert.match(twice, /runs 2 all 2 left 0 /);
  assert.match(twice, /no-dig/);
  assert.match(twice, /dig-projects 0/);
  assert.deepEqual(await traps(page), ['trapped again', TRAP]);
  assert.deepEqual(page.errors, []);
});
