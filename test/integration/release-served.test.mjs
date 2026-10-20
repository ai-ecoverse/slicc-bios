import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const SERVED = new URL('../../scripts/ci/served.mjs', import.meta.url).pathname;
const NAME = '@ai-ecoverse/slicc-bios';
const PACKED = `sha512-${'A'.repeat(86)}==`;
const OTHER = `sha512-${'B'.repeat(86)}==`;

async function npm(script) {
  const dir = await mkdtemp(join(tmpdir(), 'served-'));
  await writeFile(join(dir, 'state'), '0');
  await writeFile(
    join(dir, 'npm'),
    `#!/bin/sh\nn=$(cat "${dir}/state"); n=$((n + 1)); echo "$n" > "${dir}/state"\necho "$*" >> "${dir}/calls"\n${script}\n`
  );
  await chmod(join(dir, 'npm'), 0o755);
  return {
    dir,
    calls: async () =>
      (await readFile(join(dir, 'calls'), 'utf8').catch(() => '')).trim().split('\n'),
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

async function served(fake, args) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [SERVED, ...args], {
      env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: '' },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: error.stdout };
  }
}

const wait = (integrity = PACKED, waits = '0,0,0') => [
  'wait',
  '--name',
  NAME,
  '--version',
  '1.31.10',
  '--integrity',
  integrity,
  '--waits',
  waits,
];

test('a version npm lists late passes once it serves the packed integrity, and every npm answer is in the log', async (t) => {
  const fake = await npm(
    `if [ "$n" -lt 3 ]; then echo "npm error code E404" >&2; echo "npm error 404 '${NAME}@1.31.10' is not in this registry." >&2; exit 1; fi\necho "${PACKED}"`
  );
  t.after(fake.done);
  const { code, stdout } = await served(fake, wait());
  assert.equal(code, 0, stdout);
  assert.match(stdout, /^published: @ai-ecoverse\/slicc-bios@1\.31\.10 serves the packed sha512-/m);
  assert.equal(
    (stdout.match(/^npm view .* \(round \d+, \d+ s\): exit 1/gm) ?? []).length,
    2,
    stdout
  );
  assert.match(stdout, /stderr: npm error code E404/);
  assert.deepEqual(
    await fake.calls(),
    Array(3).fill(`view ${NAME}@1.31.10 dist.integrity --prefer-online`)
  );
});

async function tarballs(dir, theirs, ours) {
  const { gzipSync } = await import('node:zlib');
  await writeFile(join(dir, 'theirs.tgz'), gzipSync(theirs, { level: 1 }));
  await writeFile(join(dir, 'ours.tgz'), gzipSync(ours, { level: 9 }));
}

const packing = (dir) =>
  `if [ "$1" = view ]; then echo "${OTHER}"; exit 0; fi\nfor last; do :; done\ncase "$2" in @*) cp "${dir}/theirs.tgz" "$last/x.tgz";; *) cp "${dir}/ours.tgz" "$last/x.tgz";; esac`;

test('a version npm serves with another integrity and other contents fails at once, without waiting for it to change', async (t) => {
  const fake = await npm('');
  t.after(fake.done);
  await writeFile(
    join(fake.dir, 'npm'),
    `#!/bin/sh\necho "$*" >> "${fake.dir}/calls"\n${packing(fake.dir)}\n`
  );
  await tarballs(fake.dir, Buffer.from('published tar'), Buffer.from('packed tar'));
  const { code, stdout } = await served(fake, wait());
  assert.equal(code, 1, stdout);
  assert.match(
    stdout,
    new RegExp(
      `^published: FAIL npm serves ${NAME}@1\\.31\\.10 with ${OTHER.replace(/[+/]/g, '\\$&')}, not the packed`,
      'm'
    )
  );
  const calls = await fake.calls();
  assert.equal(calls.filter((call) => call.startsWith('view ')).length, 1);
  assert.match(calls[1], new RegExp(`^pack ${NAME}@1\\.31\\.10 --pack-destination `));
  assert.match(calls[2], /^pack --pack-destination /);
});

test('a version npm serves with another gzip of the same tar passes, since only the compression differs between runners', async (t) => {
  const fake = await npm('');
  t.after(fake.done);
  await writeFile(
    join(fake.dir, 'npm'),
    `#!/bin/sh\necho "$*" >> "${fake.dir}/calls"\n${packing(fake.dir)}\n`
  );
  const tar = Buffer.from('the same tar, byte for byte');
  await tarballs(fake.dir, tar, tar);
  const { code, stdout } = await served(fake, wait());
  assert.equal(code, 0, stdout);
  assert.match(
    stdout,
    /^published: @ai-ecoverse\/slicc-bios@1\.31\.10 serves the packed contents \(npm's sha512-/m
  );
});

test('a version npm never serves fails after the whole wait, and no packed integrity is never a pass', async (t) => {
  const fake = await npm('echo "npm error code E404" >&2; exit 1');
  t.after(fake.done);
  const never = await served(fake, wait());
  assert.equal(never.code, 1);
  assert.match(
    never.stdout,
    /^published: FAIL npm doesn't serve @ai-ecoverse\/slicc-bios@1\.31\.10 after 0 min$/m
  );
  assert.equal((await fake.calls()).length, 4);
  const empty = await served(fake, wait(''));
  assert.equal(empty.code, 1);
  assert.match(empty.stdout, /^published: FAIL no packed integrity for /m);
});

test('pack prints the integrity npm pack --dry-run reports, and fails without one', async (t) => {
  const good = await npm(`echo '[{"integrity":"${PACKED}","filename":"x.tgz"}]'`);
  t.after(good.done);
  const packed = await served(good, ['pack']);
  assert.equal(packed.code, 0);
  assert.equal(packed.stdout.trim(), PACKED);
  assert.deepEqual(await good.calls(), ['pack --dry-run --json']);
  const bad = await npm('echo "not json"');
  t.after(bad.done);
  assert.equal((await served(bad, ['pack'])).code, 1);
});

test('the default wait covers several minutes of registry lag with a growing backoff', async () => {
  const { WAITS } = await import(SERVED);
  const total = WAITS.reduce((sum, seconds) => sum + seconds, 0);
  assert.ok(total >= 5 * 60, `${total} s`);
  assert.ok(WAITS.every((seconds, i) => i === 0 || seconds >= WAITS[i - 1]));
});
