import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { argv, chdir, env, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findPacked, OUT, overridePins, PACKAGES, ROOT, specs } from './override-pins.mjs';
import { usersModes } from './users.mjs';

const REPORTER = './scripts/canary/reporter.mjs';
const PACKUMENTS = './scripts/canary/packuments.mjs';

export async function picked(name) {
  const shards = JSON.parse(await readFile(join(ROOT, 'scripts/canary/shards.json'), 'utf8'));
  const found = shards[name];
  if (!found) throw new Error(`no shard ${name} in scripts/canary/shards.json`);
  return found;
}

export async function select(name) {
  const found = await picked(name);
  const all = (await readdir(join(ROOT, 'test/integration')))
    .filter((file) => file.endsWith('.test.mjs'))
    .sort()
    .map((file) => `test/integration/${file}`);
  if (found.match) return all.filter((file) => new RegExp(found.match).test(file));
  return all.filter((file) => !new RegExp(found.exclude).test(file));
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
      [...(canary ? [`--import=${PACKUMENTS}`] : []), ...args, ...reporters, ...files],
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
        path: [],
        status: 'fail',
        durationMs: 0,
        log: `no results (exit ${code})`,
      });
    }
  }
  return { code, ms: Date.now() - started, results };
}

function keyOf({ file, name, path }) {
  return [file, ...(path ?? [name])].join(' › ');
}

function keyed(results) {
  const seen = new Map();
  return results.map((result) => {
    const base = keyOf(result);
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

async function repeated(files, times, { canary, out, phase }) {
  const runs = [];
  let ms = 0;
  for (let n = 1; n <= times; n++) {
    const tag = times > 1 ? `${phase}-${n}` : phase;
    const done = await run(files, {
      canary,
      log: join(out, `${tag}.log`),
      jsonl: join(out, `${tag}.jsonl`),
    });
    ms += done.ms;
    runs.push(done);
  }
  return { runs, ms };
}

function statuses(runs) {
  const found = new Map();
  for (const { results } of runs) {
    for (const [key, result] of keyed(results)) {
      found.set(key, [...(found.get(key) ?? []), result.status]);
    }
  }
  return found;
}

async function artifactsFor(candidate, dir) {
  if (!candidate) return [];
  const file = await findPacked(dir, candidate.package);
  return [{ file, ...candidate }];
}

export async function shard({ name, overrides, out, candidate = null, dir = '', repeat = 1 }) {
  chdir(ROOT);
  await mkdir(out, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const files = await select(name);
  if (!files.length) throw new Error(`no test files in shard ${name}`);
  Object.assign(env, (await picked(name)).env ?? {});
  const scratch = await mkdtemp(join(tmpdir(), 'slicc-canary-shard-'));
  const baseline = join(scratch, 'baseline');
  const candidatePins = join(scratch, 'candidate');
  await cp(PACKAGES, baseline, { recursive: true });
  const pinsFile = join(out, 'pins.json');
  const artifacts = await artifactsFor(candidate, dir);
  const changed = overrides.length > 0 || artifacts.length > 0;
  const pins = changed
    ? await overridePins(overrides, { out: OUT, artifacts })
    : { overrides: [], changed: [], held: [], candidates: {} };
  await writeFile(pinsFile, `${JSON.stringify(pins, null, 2)}\n`);
  await certifyForOldRefs(pins.candidates);
  await cp(PACKAGES, candidatePins, { recursive: true });
  const phases = {};
  const canary = changed ? OUT : null;
  const tried = await repeated(files, repeat, { canary, out, phase: 'candidate' });
  const first = tried.runs[0];
  phases.candidate = tried.ms;
  const seen = statuses(tried.runs);
  const base = new Map();
  const retry = new Map();
  const failing = [
    ...new Set(
      tried.runs.flatMap(({ results }) =>
        results.filter((r) => r.status === 'fail').map((r) => r.file)
      )
    ),
  ];
  if (failing.length && changed) {
    await restore(baseline);
    const main = await repeated(failing, repeat, { canary: null, out, phase: 'baseline' });
    phases.baseline = main.ms;
    for (const [key, list] of statuses(main.runs)) base.set(key, list);
    await restore(candidatePins);
    const suspects =
      repeat > 1
        ? []
        : [
            ...new Set(
              keyed(first.results)
                .filter(
                  ([key, result]) => result.status === 'fail' && base.get(key)?.[0] !== 'fail'
                )
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
  const results = keyed(first.results).map(([key, result]) => {
    const runs = seen.get(key) ?? [result.status];
    return {
      test: label(result),
      key: keyOf(result),
      file: result.file,
      nesting: result.nesting,
      status: runs.includes('fail') ? 'fail' : result.status,
      baseline: base.get(key)?.[0] ?? null,
      retry: retry.get(key) ?? null,
      ...(repeat > 1 ? { runs, baselines: base.get(key) ?? [] } : {}),
      durationMs: result.durationMs,
      log:
        result.log ||
        tried.runs
          .flatMap(({ results: all }) => keyed(all))
          .find(([k, r]) => k === key && r.log)?.[1].log,
    };
  });
  const summary = {
    shard: name,
    files,
    startedAt,
    wallMs: Date.now() - started,
    phases,
    exit: tried.runs.find(({ code }) => code !== 0)?.code ?? 0,
    repeat,
    pins,
    kernels: await usersModes(ROOT),
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
      candidate: { type: 'string', default: '' },
      'candidate-dir': { type: 'string', default: '.canary-candidate' },
      repeat: { type: 'string', default: '1' },
    },
  });
  const candidate =
    values.candidate && values.candidate !== 'null' ? JSON.parse(values.candidate) : null;
  const summary = await shard({
    name: values.shard,
    overrides: specs([values.overrides]),
    out: values.out,
    candidate,
    dir: values['candidate-dir'],
    repeat: Number(values.repeat) || 1,
  });
  const failed = summary.results.filter((r) => r.status === 'fail').length;
  console.log(
    `shard ${summary.shard}: ${summary.results.length} results, ${failed} failed, ${Math.round(summary.wallMs / 1000)} s`
  );
}
