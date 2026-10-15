import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { argv, chdir, env, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OUT, overridePins, PACKAGES, ROOT, specs } from './override-pins.mjs';

const REPORTER = './scripts/canary/reporter.mjs';

export async function select(name) {
  const shards = JSON.parse(await readFile(join(ROOT, 'scripts/canary/shards.json'), 'utf8'));
  const picked = shards[name];
  if (!picked) throw new Error(`no shard ${name} in scripts/canary/shards.json`);
  const all = (await readdir(join(ROOT, 'test/integration')))
    .filter((file) => file.endsWith('.test.mjs'))
    .sort()
    .map((file) => `test/integration/${file}`);
  if (picked.match) return all.filter((file) => new RegExp(picked.match).test(file));
  return all.filter((file) => !new RegExp(picked.exclude).test(file));
}

async function command() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  return manifest.scripts.test
    .replace(/\$\{SLICC_TESTS[^}]*\}/, '')
    .trim()
    .split(/\s+/);
}

async function run(files, { canary, log, jsonl }) {
  const [node, ...args] = await command();
  const reporters = [
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    `--test-reporter=${REPORTER}`,
    `--test-reporter-destination=${jsonl}`,
  ];
  const childEnv = { ...env };
  delete childEnv.SLICC_CANARY;
  if (canary) childEnv.SLICC_CANARY = canary;
  const started = Date.now();
  const out = createWriteStream(log);
  const code = await new Promise((resolve) => {
    const child = spawn(
      node === 'node' ? process.execPath : node,
      [...args, ...reporters, ...files],
      {
        cwd: ROOT,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout.on('data', (chunk) => {
      stdout.write(chunk);
      out.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.write(chunk);
      out.write(chunk);
    });
    child.on('close', (status, signal) => resolve(status ?? signal));
  });
  await new Promise((resolve) => out.end(resolve));
  const text = await readFile(jsonl, 'utf8').catch(() => '');
  const results = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const reported = new Set(results.map(({ file }) => file));
  for (const file of files) {
    if (code !== 0 && !reported.has(file)) {
      results.push({
        file,
        name: file,
        nesting: 0,
        status: 'fail',
        durationMs: 0,
        log: `no results (exit ${code})`,
      });
    }
  }
  return { code, ms: Date.now() - started, results };
}

function keyed(results) {
  const seen = new Map();
  return results.map((result) => {
    const base = `${result.file}\u0000${result.name}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return [`${base}\u0000${n}`, result];
  });
}

function label({ file, name }) {
  return name === file ? file : `${basename(file)} › ${name}`;
}

async function certifyForOldRefs(candidates) {
  const test = await readFile(join(ROOT, 'test/integration/pins.test.mjs'), 'utf8').catch(() => '');
  if (test.includes('SLICC_CANARY') || !Object.keys(candidates).length) return;
  const file = join(PACKAGES, 'certs.json');
  const certs = JSON.parse(await readFile(file, 'utf8'));
  for (const [key, { integrity, sha256 }] of Object.entries(candidates)) {
    certs[key] = sha256 ? { integrity, sha256 } : { integrity };
  }
  await writeFile(file, `${JSON.stringify(certs, null, 2)}\n`);
}

async function restore(snapshot) {
  await rm(PACKAGES, { recursive: true, force: true });
  await cp(snapshot, PACKAGES, { recursive: true });
}

export async function shard({ name, overrides, out }) {
  chdir(ROOT);
  await mkdir(out, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const files = await select(name);
  if (!files.length) throw new Error(`no test files in shard ${name}`);
  const scratch = await mkdtemp(join(tmpdir(), 'slicc-canary-shard-'));
  const baseline = join(scratch, 'baseline');
  const candidate = join(scratch, 'candidate');
  await cp(PACKAGES, baseline, { recursive: true });
  const pinsFile = join(out, 'pins.json');
  const pins = overrides.length
    ? await overridePins(overrides, { out: OUT })
    : { overrides: [], changed: [], held: [], candidates: {} };
  await writeFile(pinsFile, `${JSON.stringify(pins, null, 2)}\n`);
  await certifyForOldRefs(pins.candidates);
  await cp(PACKAGES, candidate, { recursive: true });
  const phases = {};
  const first = await run(files, {
    canary: overrides.length ? OUT : null,
    log: join(out, 'candidate.log'),
    jsonl: join(out, 'candidate.jsonl'),
  });
  phases.candidate = first.ms;
  const failing = [...new Set(first.results.filter((r) => r.status === 'fail').map((r) => r.file))];
  const base = new Map();
  const retry = new Map();
  if (failing.length && overrides.length) {
    await restore(baseline);
    const second = await run(failing, {
      canary: null,
      log: join(out, 'baseline.log'),
      jsonl: join(out, 'baseline.jsonl'),
    });
    phases.baseline = second.ms;
    for (const [key, result] of keyed(second.results)) base.set(key, result.status);
    await restore(candidate);
    const suspects = [
      ...new Set(
        keyed(first.results)
          .filter(([key, result]) => result.status === 'fail' && base.get(key) !== 'fail')
          .map(([, result]) => result.file)
      ),
    ];
    if (suspects.length) {
      const third = await run(suspects, {
        canary: OUT,
        log: join(out, 'retry.log'),
        jsonl: join(out, 'retry.jsonl'),
      });
      phases.retry = third.ms;
      for (const [key, result] of keyed(third.results)) retry.set(key, result.status);
    }
  }
  await rm(scratch, { recursive: true, force: true });
  const results = keyed(first.results).map(([key, result]) => ({
    test: label(result),
    file: result.file,
    nesting: result.nesting,
    status: result.status,
    baseline: base.get(key) ?? null,
    retry: retry.get(key) ?? null,
    durationMs: result.durationMs,
    log: result.log,
  }));
  const summary = {
    shard: name,
    files,
    startedAt,
    wallMs: Date.now() - started,
    phases,
    exit: first.code,
    pins,
    results,
  };
  await writeFile(join(out, 'shard.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      shard: { type: 'string' },
      overrides: { type: 'string', default: '[]' },
      out: { type: 'string' },
    },
  });
  const summary = await shard({
    name: values.shard,
    overrides: specs([values.overrides]),
    out: values.out,
  });
  const failed = summary.results.filter((r) => r.status === 'fail').length;
  console.log(
    `shard ${summary.shard}: ${summary.results.length} results, ${failed} failed, ${Math.round(summary.wallMs / 1000)} s`
  );
}
