import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

const SERVED = new URL('../../scripts/ci/served.mjs', import.meta.url).pathname;
const PUBLISH = new URL('../../scripts/ci/publish.sh', import.meta.url).pathname;
const NAME = '@ai-ecoverse/slicc-bios';
const ID = `${NAME}@1.31.10`;
const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const TAR = Buffer.from('the tar of slicc-bios 1.31.10');
const OURS = gzipSync(TAR, { level: 9 });
const PACKED = sri(OURS);

const FAKE = (dir) => `#!/bin/sh
d="${dir}"
echo "$*" >> "$d/calls"
count() { n=$(cat "$d/$1" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$d/$1"; echo "$n"; }
for last; do :; done
case "$1 $2" in
  "version "*) exit 0;;
  "pack --dry-run") echo "[{\\"integrity\\":\\"${PACKED}\\"}]"; exit 0;;
  "pack --pack-destination") cp "$d/ours.tgz" "$last/x.tgz"; exit 0;;
  "pack @"*) case "$*" in *"--prefer-online --cache "*) ;; *) echo "fake npm: a remote pack without a fresh cache" >&2; exit 3;; esac; n=$(count fetches); if [ "$n" -le "$(cat "$d/unfetched")" ]; then echo "npm error code E404" >&2; exit 1; fi; cp "$d/theirs.tgz" "$last/x.tgz"; exit 0;;
  "view @"*)
    if [ "$3" = version ]; then [ -e "$d/listed" ] && { echo 1.31.10; exit 0; }; exit 1; fi
    n=$(count views); if [ ! -e "$d/listed" ] || [ "$n" -le "$(cat "$d/unlisted")" ]; then echo "npm error code E404" >&2; echo "npm error 404 '${ID}' is not in this registry." >&2; exit 1; fi
    cat "$d/integrity"; exit 0;;
  "publish "*)
    case "$(cat "$d/publish")" in
      ok) touch "$d/listed"; echo "npm notice Publishing to https://registry.npmjs.org/"; echo "+ ${ID}"; exit 0;;
      e409) touch "$d/listed"; echo "npm error code E409" >&2; exit 1;;
      *) echo "npm error code E403" >&2; exit 1;;
    esac;;
esac
echo "fake npm: unexpected $*" >&2
exit 2
`;

async function registry({
  served: theirs = OURS,
  listedAs = null,
  listed = true,
  unlisted = 0,
  unfetched = 0,
  publish = 'ok',
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'served-'));
  await writeFile(join(dir, 'ours.tgz'), OURS);
  await writeFile(join(dir, 'theirs.tgz'), theirs);
  await writeFile(join(dir, 'integrity'), `${listedAs ?? sri(theirs)}\n`);
  await writeFile(join(dir, 'unlisted'), String(unlisted));
  await writeFile(join(dir, 'unfetched'), String(unfetched));
  await writeFile(join(dir, 'publish'), publish);
  if (listed) await writeFile(join(dir, 'listed'), '');
  await writeFile(join(dir, 'npm'), FAKE(dir));
  await chmod(join(dir, 'npm'), 0o755);
  return {
    dir,
    calls: async () =>
      (await readFile(join(dir, 'calls'), 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean),
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

async function exec(fake, command, args, extra = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)(command, args, {
      env: {
        ...process.env,
        PATH: `${fake.dir}:${process.env.PATH}`,
        GITHUB_STEP_SUMMARY: '',
        ...extra,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

const wait = (fake, integrity = PACKED) =>
  exec(fake, process.execPath, [
    SERVED,
    'wait',
    '--name',
    NAME,
    '--version',
    '1.31.10',
    '--integrity',
    integrity,
    '--waits',
    '0,0,0',
  ]);

const fetches = async (fake) =>
  (await fake.calls()).filter((call) => call.startsWith(`pack ${ID}`));

test('a version npm lists late passes once it serves the packed integrity and its tarball fetches with it, and every npm answer is in the log', async (t) => {
  const fake = await registry({ unlisted: 2 });
  t.after(fake.done);
  const { code, stdout } = await wait(fake);
  assert.equal(code, 0, stdout);
  assert.match(
    stdout,
    /^published: @ai-ecoverse\/slicc-bios@1\.31\.10 serves the packed tarball, fetched and checked$/m
  );
  assert.equal(
    (stdout.match(/^npm view .* \(round \d+, \d+ s\): exit 1/gm) ?? []).length,
    2,
    stdout
  );
  assert.match(stdout, /stderr: npm error code E404/);
  assert.equal((await fetches(fake)).length, 1);
  assert.match(
    (await fetches(fake))[0],
    new RegExp(`^pack ${ID} --prefer-online --cache \\S+/\\.npm-cache --pack-destination `)
  );
});

test("matching metadata whose tarball can't be fetched yet is waited for, and never served fails after the wait", async (t) => {
  const late = await registry({ unfetched: 2 });
  t.after(late.done);
  const ok = await wait(late);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal((await fetches(late)).length, 3);
  const never = await registry({ unfetched: 99 });
  t.after(never.done);
  const failed = await wait(never);
  assert.equal(failed.code, 1);
  assert.match(
    failed.stdout,
    /^published: FAIL npm doesn't serve @ai-ecoverse\/slicc-bios@1\.31\.10's tarball after 0 min; a re-run of the workflow on main only waits, it never publishes the version again$/m
  );
});

test('a tarball whose bytes are not the integrity npm lists fails at once, even when the listing matches the packed one', async (t) => {
  const fake = await registry({ served: gzipSync(Buffer.from('other bytes')), listedAs: PACKED });
  t.after(fake.done);
  const { code, stdout } = await wait(fake);
  assert.equal(code, 1, stdout);
  assert.match(
    stdout,
    /^published: FAIL npm serves @ai-ecoverse\/slicc-bios@1\.31\.10 with sha512-/m
  );
  assert.equal((await fetches(fake)).length, 1);
});

test('another gzip of the same tar passes, and other contents fail at once without waiting', async (t) => {
  const regzipped = await registry({ served: gzipSync(TAR, { level: 1 }) });
  t.after(regzipped.done);
  const same = await wait(regzipped);
  assert.equal(same.code, 0, same.stdout);
  assert.match(
    same.stdout,
    /serves npm's sha512-.*…, another gzip of the packed tar, tarball, fetched and checked/
  );
  const other = await registry({ served: gzipSync(Buffer.from('a different tar')) });
  t.after(other.done);
  const failed = await wait(other);
  assert.equal(failed.code, 1);
  assert.match(
    failed.stdout,
    /^published: FAIL npm serves .* not the packed .*: other contents, not a flake$/m
  );
  assert.equal((await other.calls()).filter((call) => call.startsWith('view ')).length, 1);
});

test('a version npm never lists fails after the whole wait, and no packed integrity is never a pass', async (t) => {
  const fake = await registry({ listed: false });
  t.after(fake.done);
  const never = await wait(fake);
  assert.equal(never.code, 1);
  assert.match(
    never.stdout,
    /^published: FAIL npm doesn't serve @ai-ecoverse\/slicc-bios@1\.31\.10 after 0 min; a re-run of the workflow on main only waits, it never publishes the version again$/m
  );
  assert.equal((await fake.calls()).length, 4);
  const empty = await wait(fake, '');
  assert.equal(empty.code, 1);
  assert.match(empty.stdout, /^published: FAIL no packed integrity for /m);
});

test('pack prints the integrity npm pack --dry-run reports, and fails without one', async (t) => {
  const fake = await registry();
  t.after(fake.done);
  const packed = await exec(fake, process.execPath, [SERVED, 'pack']);
  assert.equal(packed.code, 0);
  assert.equal(packed.stdout.trim(), PACKED);
  const bad = await registry();
  t.after(bad.done);
  await writeFile(join(bad.dir, 'npm'), '#!/bin/sh\necho "not json"\n');
  assert.equal((await exec(bad, process.execPath, [SERVED, 'pack'])).code, 1);
});

test('the default wait covers several minutes of registry lag with a growing backoff', async () => {
  const { WAITS } = await import(SERVED);
  const total = WAITS.reduce((sum, seconds) => sum + seconds, 0);
  assert.ok(total >= 5 * 60, `${total} s`);
  assert.ok(WAITS.every((seconds, i) => i === 0 || seconds >= WAITS[i - 1]));
});

const publish = (fake) =>
  exec(fake, 'bash', [PUBLISH], {
    TAG: 'v1.31.10',
    RUNNER_TEMP: fake.dir,
    SERVED_WAITS: '0,0',
    PUBLISH_BACKOFF: '0',
  });

test("release.yml's publish step: a version npm already lists is only waited for, never published again", async (t) => {
  const fake = await registry({ publish: 'refuse' });
  t.after(fake.done);
  const run = await publish(fake);
  assert.equal(run.code, 0, run.stdout);
  assert.match(run.stdout, /npm already lists @ai-ecoverse\/slicc-bios@1\.31\.10/);
  assert.equal(
    (await fake.calls()).some((call) => call.startsWith('publish')),
    false
  );
});

test("release.yml's publish step: a publish npm takes ends in the wait for the packed tarball, with npm's output logged", async (t) => {
  const fake = await registry({ listed: false, unlisted: 1 });
  t.after(fake.done);
  const run = await publish(fake);
  assert.equal(run.code, 0, run.stdout);
  assert.match(run.stdout, /npm notice Publishing/);
  assert.match(run.stdout, /^published: .* serves the packed tarball, fetched and checked$/m);
  assert.equal((await fake.calls()).filter((call) => call.startsWith('publish')).length, 1);
});

test("release.yml's publish step: a publish that errors but npm then lists is waited for, and one npm never takes fails after three attempts", async (t) => {
  const taken = await registry({ listed: false, publish: 'e409' });
  t.after(taken.done);
  const ok = await publish(taken);
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /npm error code E409/);
  assert.match(ok.stdout, /^published: .* fetched and checked$/m);
  assert.equal((await taken.calls()).filter((call) => call.startsWith('publish')).length, 1);
  const refused = await registry({ listed: false, publish: 'refuse' });
  t.after(refused.done);
  const failed = await publish(refused);
  assert.equal(failed.code, 1);
  assert.equal((await refused.calls()).filter((call) => call.startsWith('publish')).length, 3);
  assert.match(failed.stdout, /::error::v1\.31\.10 is tagged but not on npm/);
  assert.match(failed.stdout, /npm publish failed \(attempt 3\)/);
});

test('the real npm CLI against a local registry: served.mjs reads what npm view and npm pack really print, and passes on the published tarball', async (t) => {
  const { createServer } = await import('node:http');
  const { mkdir, readdir } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'served-real-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'project');
  const out = join(dir, 'out');
  await mkdir(project, { recursive: true });
  await mkdir(out, { recursive: true });
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({ name: NAME, version: '1.31.10', files: ['index.js'] })
  );
  await writeFile(join(project, 'index.js'), 'export {};\n');
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:npm_config_)?(?:https?|all)[-_]?proxy$|^(?:npm_config_)?no[-_]?proxy$/i.test(key)
    )
  );
  const env = {
    ...inherited,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    npm_config_noproxy: '127.0.0.1,localhost',
    HOME: join(dir, 'home'),
    npm_config_cache: join(dir, 'cache'),
    npm_config_update_notifier: 'false',
    GITHUB_STEP_SUMMARY: '',
  };
  await promisify(execFile)('npm', ['pack', '--pack-destination', out], { cwd: project, env });
  const [file] = await readdir(out);
  const tarball = await readFile(join(out, file));
  const integrity = sri(tarball);
  const server = createServer((request, response) => {
    if (request.url.endsWith('.tgz')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(tarball);
      return;
    }
    if (decodeURIComponent(request.url).startsWith(`/${NAME}`)) {
      const at = `http://127.0.0.1:${server.address().port}`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          name: NAME,
          'dist-tags': { latest: '1.31.10' },
          versions: {
            '1.31.10': {
              name: NAME,
              version: '1.31.10',
              dist: { integrity, tarball: `${at}/slicc-bios-1.31.10.tgz` },
            },
          },
        })
      );
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const registry = { ...env, npm_config_registry: `http://127.0.0.1:${server.address().port}/` };
  const packed = await promisify(execFile)(process.execPath, [SERVED, 'pack'], {
    cwd: project,
    env: registry,
  });
  assert.equal(packed.stdout.trim(), integrity);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      SERVED,
      'wait',
      '--name',
      NAME,
      '--version',
      '1.31.10',
      '--integrity',
      integrity,
      '--waits',
      '0',
    ],
    { cwd: project, env: registry }
  );
  assert.match(
    stdout,
    /^npm view @ai-ecoverse\/slicc-bios@1\.31\.10 dist\.integrity \(round 1, 0 s\): exit 0\n {2}stdout: sha512-/m
  );
  assert.match(
    stdout,
    /^published: @ai-ecoverse\/slicc-bios@1\.31\.10 serves the packed tarball, fetched and checked$/m
  );
});
