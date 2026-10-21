#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

export const WAITS = [5, 10, 15, 20, 30, 30, 45, 60, 60, 60, 60, 60];

export function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) =>
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` })
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function shown({ code, stdout, stderr }) {
  const lines = [`exit ${code}`];
  if (stdout.trim()) lines.push(`stdout: ${stdout.trim()}`);
  if (stderr.trim()) lines.push(`stderr: ${stderr.trim()}`);
  return lines.join('\n  ');
}

export async function packed({ run: exec = run, log = console.log } = {}) {
  const result = await exec('npm', ['pack', '--dry-run', '--json']);
  log(`npm pack --dry-run --json: ${shown({ ...result, stdout: '' })}`);
  if (result.code !== 0) return '';
  try {
    return JSON.parse(result.stdout)[0]?.integrity ?? '';
  } catch {
    return '';
  }
}

async function contents(exec, args, log) {
  const dir = await mkdtemp(join(tmpdir(), 'served-'));
  try {
    const fresh = args.length > 1 ? ['--prefer-online', '--cache', join(dir, '.npm-cache')] : [];
    const result = await exec('npm', [...args, ...fresh, '--pack-destination', dir]);
    log(`npm ${args.join(' ')}: ${shown(result)}`);
    const [file] = (await readdir(dir)).filter((name) => name.endsWith('.tgz'));
    if (result.code !== 0 || !file) return null;
    const bytes = await readFile(join(dir, file));
    return {
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      tar: createHash('sha256').update(gunzipSync(bytes)).digest('hex'),
    };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function sameContents({ id, listed, run: exec = run, log = console.log }) {
  const theirs = await contents(exec, ['pack', id], log);
  if (theirs === null) return 'unfetched';
  if (theirs.integrity !== listed) return 'other';
  const ours = await contents(exec, ['pack'], log);
  if (ours === null) return 'unpacked';
  return theirs.tar === ours.tar ? 'same' : 'other';
}

export async function served({
  name,
  version,
  integrity,
  run: exec = run,
  sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
  log = console.log,
  waits = WAITS,
}) {
  const id = `${name}@${version}`;
  if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity ?? '')) {
    return { ok: false, line: `published: FAIL no packed integrity for ${id}` };
  }
  let waited = 0;
  for (let round = 0; ; round++) {
    const result = await exec('npm', ['view', id, 'dist.integrity', '--prefer-online']);
    log(`npm view ${id} dist.integrity (round ${round + 1}, ${waited} s): ${shown(result)}`);
    const found = result.code === 0 ? result.stdout.trim() : '';
    const same = found ? await sameContents({ id, listed: found, run: exec, log }) : null;
    if (same === 'same') {
      const how =
        found === integrity
          ? 'the packed'
          : `npm's ${found.slice(0, 19)}…, another gzip of the packed tar,`;
      return { ok: true, line: `published: ${id} serves ${how} tarball, fetched and checked` };
    }
    if (same === 'other') {
      return {
        ok: false,
        line: `published: FAIL npm serves ${id} with ${found}, not the packed ${integrity}: other contents, not a flake`,
      };
    }
    if (same === 'unpacked') {
      return { ok: false, line: `published: FAIL npm pack can't pack ${id} here to compare` };
    }
    if (round >= waits.length) {
      const why = same === 'unfetched' ? `serve ${id}'s tarball` : `serve ${id}`;
      return {
        ok: false,
        line: `published: FAIL npm doesn't ${why} after ${Math.round(waited / 60)} min; a re-run of the workflow on main only waits, it never publishes the version again`,
      };
    }
    await sleep(waits[round]);
    waited += waits[round];
  }
}

async function say({ ok, line }) {
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (!ok) exit(1);
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: 'string', default: '' },
      version: { type: 'string', default: '' },
      integrity: { type: 'string', default: '' },
      waits: { type: 'string', default: '' },
    },
  });
  if (command === 'pack') {
    const integrity = await packed({ log: (line) => console.error(line) });
    if (!integrity) {
      console.error('published: FAIL npm pack gave no integrity');
      exit(1);
    }
    console.log(integrity);
  } else if (command === 'wait') {
    const waits = values.waits ? values.waits.split(',').map(Number) : WAITS;
    await say(await served({ ...values, waits }));
  } else {
    console.error(`served: unknown command ${command ?? ''}`);
    exit(2);
  }
}
