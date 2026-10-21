#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import process, { argv, env, exit, stderr, stdout } from 'node:process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';
import { classOf } from '../cert/evidence.mjs';
import { cost, ROOT, SPLIT } from './plan.mjs';
import { missingRequired, summary } from './verdict.mjs';

const REPORTER = fileURLToPath(new URL('../canary/reporter.mjs', import.meta.url));
export const ATTEMPTS = 'attempts';
export const FIRST = `${ATTEMPTS}/attempt-1`;
const OUTPUTS = [
  'artifacts',
  'node_modules/.cache/slicc-harness/coverage',
  'node_modules/.cache/slicc-harness/hotspots',
];

export function groups(list) {
  const variants = new Map();
  const whole = [];
  for (const item of list) {
    const [file, variant] = item.split('#');
    if (variant) variants.set(file, [...(variants.get(file) ?? []), variant]);
    else whole.push(file);
  }
  const out = [...variants].map(([file, chosen]) => ({
    env: { GUARD_VARIANTS: [...chosen].sort().join(',') },
    files: [file],
  }));
  if (!out.length) return whole.length ? [{ env: {}, files: whole }] : [];
  out[0].files = [...whole, ...out[0].files];
  return out;
}

export function attribute(results, files) {
  const split = files.filter((file) => SPLIT.test(file));
  if (split.length !== 1) return results;
  return results.map((result) =>
    files.includes(result.file) ? result : { ...result, file: split[0] }
  );
}

export function failing(results, files, code) {
  const reported = new Set(results.map(({ file }) => file));
  const failed = new Set(results.filter(({ status }) => status === 'fail').map(({ file }) => file));
  if (code !== 0) for (const file of files) if (!reported.has(file)) failed.add(file);
  return files.filter((file) => failed.has(file));
}

export function decide({ name, first, retried }) {
  const counts = summary(first.log);
  const why = [];
  if (!counts) why.push('no test summary');
  else {
    if (counts.fail) why.push(`${counts.fail} failed`);
    if (counts.cancelled) why.push(`${counts.cancelled} cancelled`);
    if (!counts.pass) why.push('0 tests passed');
  }
  why.push(...missingRequired(first.log, first.files));
  if (!why.length) return { ok: true, pass: counts.pass, why: [] };
  if (!retried) return { ok: false, pass: counts?.pass ?? 0, why };
  const again = summary(retried.log);
  const kept = first.files.filter((file) => !retried.files.includes(file));
  const still = [];
  if (!again) still.push('no test summary on retry');
  else {
    if (again.fail) still.push(`${again.fail} failed on retry`);
    if (again.cancelled) still.push(`${again.cancelled} cancelled on retry`);
    if (!again.pass) still.push('0 tests passed on retry');
  }
  still.push(...missingRequired(first.log, kept), ...missingRequired(retried.log, retried.files));
  const firstPass = counts?.pass ?? 0;
  if (still.length) return { ok: false, pass: firstPass, why: [...why, ...still] };
  return { ok: true, pass: firstPass + again.pass, why: [] };
}

async function command(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  return manifest.scripts.test
    .replace(/\$\{SLICC_TESTS[^}]*\}/, '')
    .trim()
    .split(/\s+/);
}

async function run(files, extra, tag, dir, { root, signal, quiet }) {
  const [node, ...args] = await command(root);
  const log = join(dir, `${tag}.log`);
  const jsonl = join(dir, `${tag}.jsonl`);
  const reporters = [
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    `--test-reporter=${REPORTER}`,
    `--test-reporter-destination=${jsonl}`,
  ];
  const started = Date.now();
  const out = createWriteStream(log);
  if (!quiet)
    console.log(
      `shard: ${tag}: ${files.join(' ')}${extra.GUARD_VARIANTS ? ` (GUARD_VARIANTS=${extra.GUARD_VARIANTS})` : ''}`
    );
  const code = await new Promise((resolve) => {
    const child = spawn(
      node === 'node' ? process.execPath : node,
      [...args, ...reporters, ...files],
      {
        cwd: root,
        env: {
          ...Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const stop = () => child.kill('SIGKILL');
    if (signal?.aborted) stop();
    signal?.addEventListener('abort', stop, { once: true });
    child.on('close', () => signal?.removeEventListener('abort', stop));
    child.stdout.on('data', (chunk) => {
      if (!quiet) stdout.write(chunk);
      out.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (!quiet) stderr.write(chunk);
      out.write(chunk);
    });
    child.on('close', (status, signal) => resolve(status ?? signal));
  });
  await new Promise((resolve) => out.end(resolve));
  const results = attribute(
    (await readFile(jsonl, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    files
  );
  return { files, code, ms: Date.now() - started, log: await readFile(log, 'utf8'), results };
}

async function stash(dir, root) {
  for (const path of OUTPUTS) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await rename(join(root, path), join(dir, path)).catch(async (error) => {
      if (error.code === 'ENOENT') return;
      if (error.code !== 'EXDEV') throw error;
      await cp(join(root, path), join(dir, path), { recursive: true });
      await rm(join(root, path), { recursive: true, force: true });
    });
  }
}

export async function restore(stashes, root) {
  for (const { dir, retried } of stashes) {
    for (const path of OUTPUTS) {
      const to = retried && path === 'artifacts' ? FIRST : path;
      await cp(join(dir, path), join(root, to), { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function trapped(dir = join(ROOT, 'artifacts/pnpm-traps')) {
  const names = (await readdir(dir).catch(() => []))
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  const found = [];
  for (const name of names)
    for (const line of (await readFile(join(dir, name), 'utf8')).split('\n'))
      if (line.trim()) found.push(JSON.parse(line));
  return found.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
}

export function trapLine(name, traps) {
  if (!traps.length) return null;
  const where = [...new Set(traps.map(({ file, name: test }) => `${file} › ${test}`))];
  return `shard ${name}: pnpm hit the wasm trap ${traps.length}x (homescoop#1127), retried in ${where.join('; ')}`;
}

const TRACE = /^stall-\d+-trace\.json$/;

export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function clean(attempts) {
  const kept = new Set();
  const passed = new Map();
  for (const attempt of attempts.filter(Boolean)) {
    const reported = new Set(attempt.results.map(({ file }) => file));
    if (attempt.code !== 0)
      for (const file of attempt.files) if (!reported.has(file)) kept.add(file);
    for (const { file, path = [], name, status } of attempt.results) {
      const top = path[0] ?? name;
      const key = `${file}\0${top}`;
      if (status !== 'pass') kept.add(key);
      else if (status === 'pass' && path.length <= 1) passed.set(key, { file, name: top });
    }
  }
  return [...passed.entries()]
    .filter(([key, { file }]) => !kept.has(key) && !kept.has(file) && classOf(file) === null)
    .map(([, test]) => test);
}

export async function trim(tests, root = join(ROOT, 'artifacts')) {
  const dropped = [];
  for (const { file, name } of tests) {
    const dir = join(root, slug(basename(file, '.test.mjs')), slug(name));
    for (const entry of await readdir(dir).catch(() => [])) {
      if (!TRACE.test(entry)) continue;
      const path = join(dir, entry);
      const { size } = await stat(path);
      await rm(path, { force: true });
      dropped.push({ path: path.slice(root.length + 1), bytes: size });
    }
  }
  return dropped;
}

export async function trimShard(done, root = ROOT) {
  const eligible = clean(done.flatMap(({ first, retried }) => [first, retried]));
  const trimmed = [];
  for (const tree of ['artifacts', FIRST]) {
    for (const entry of await trim(eligible, join(root, tree))) {
      trimmed.push({ ...entry, path: `${tree}/${entry.path}` });
    }
  }
  return trimmed;
}

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

export async function compress(root = ROOT) {
  const packed = [];
  for (const tree of ['artifacts', FIRST]) {
    const base = join(root, tree);
    for (const path of await walk(base)) {
      if (!TRACE.test(basename(path))) continue;
      const { size } = await stat(path);
      await pipeline(createReadStream(path), createGzip(), createWriteStream(`${path}.gz`));
      const { size: gzipped } = await stat(`${path}.gz`);
      await rm(path, { force: true });
      packed.push({ path: `${tree}/${path.slice(base.length + 1)}.gz`, bytes: size, gzipped });
    }
  }
  return packed;
}

export function itemOf(file, name, extra = {}) {
  if (!SPLIT.test(file) || !extra.GUARD_VARIANTS) return file;
  const chosen = extra.GUARD_VARIANTS.split(',');
  const variant = chosen.find((v) => name.includes(` ${v} detach`)) ?? chosen[0];
  return `${file}#${variant}`;
}

export function timings(results, extra = {}) {
  const out = {};
  for (const { file, name, nesting, durationMs } of results) {
    if (nesting !== 0 || !file) continue;
    const item = itemOf(file, name, extra);
    out[item] = (out[item] ?? 0) + durationMs;
  }
  return out;
}

export function flips(first, retried) {
  if (!retried) return [];
  const passed = new Set(
    retried.results
      .filter(({ nesting, status }) => nesting === 0 && status === 'pass')
      .map(({ file, name }) => `${file}\u0000${name}`)
  );
  const out = new Map();
  for (const { file, name, nesting, status, log } of first.results) {
    const key = `${file}\u0000${name}`;
    if (nesting === 0 && status === 'fail' && passed.has(key) && !out.has(key)) {
      out.set(key, { file, name, log });
    }
  }
  return [...out.values()];
}

function brief(attempt, extra) {
  if (!attempt) return null;
  return {
    files: attempt.files,
    exit: attempt.code,
    ms: attempt.ms,
    counts: summary(attempt.log),
    failed: failing(attempt.results, attempt.files, attempt.code),
    failedTests: attempt.results
      .filter(({ nesting, status }) => nesting === 0 && status === 'fail')
      .map(({ file, name, log }) => ({ file, name, log })),
    timings: timings(attempt.results, extra),
  };
}

export function failures(report) {
  const out = [];
  for (const group of report.groups ?? []) {
    const flipped = new Set((group.flips ?? []).map(({ file, name }) => `${file}\u0000${name}`));
    const why = group.cancelled
      ? 'cancelled'
      : group.retry
        ? 'failed again'
        : group.skipped
          ? 'not retried'
          : 'failed';
    for (const { file, name, log } of group.first?.failedTests ?? []) {
      if (flipped.has(`${file}\u0000${name}`)) continue;
      out.push({ shard: report.shard, file, name, log, why });
    }
  }
  return out;
}

export const failureLine = ({ shard: name, file, name: test, log, why }) =>
  `failed (${why}) in ${name}: ${file} › ${test}: ${(log || 'no error message').split('\n')[0].slice(0, 300)}`;

function compose(done, { name, list, retry, record, started, cancelled }) {
  const ok = !cancelled && done.length > 0 && done.every(({ verdict }) => verdict.ok);
  const pass = done.reduce((sum, { verdict }) => sum + verdict.pass, 0);
  const why = [
    ...(cancelled ? ['cancelled'] : []),
    ...(done.length ? done.flatMap(({ verdict }) => verdict.why) : ['no test files']),
  ];
  const line = ok ? `shard ${name}: PASS ${pass} tests` : `shard ${name}: FAIL ${why.join(', ')}`;
  const report = {
    ...record,
    shard: name,
    items: list,
    retry,
    ok,
    line,
    startedAt: new Date(started).toISOString(),
    wallMs: Date.now() - started,
    cancelled,
    groups: done.map(({ env: extra, first, retried, skipped, cancelled: stopped, verdict }) => ({
      env: extra,
      first: brief(first, extra),
      retry: brief(retried, extra),
      flips: flips(first, retried),
      skipped,
      cancelled: stopped,
      ok: verdict.ok,
      why: verdict.why,
    })),
  };
  report.timings = Object.assign({}, ...report.groups.map(({ first }) => first.timings));
  report.flips = report.groups.flatMap(({ flips: flipped }) => flipped);
  report.traps = [];
  return report;
}

export async function shard({
  name,
  items: list,
  retry,
  budgetMs,
  scratch,
  record,
  root = ROOT,
  signal,
  quiet = false,
  progress = async () => {},
}) {
  const started = Date.now();
  const seconds = cost(JSON.parse(await readFile(join(root, 'scripts/ci/durations.json'), 'utf8')));
  const estimate = (files) =>
    files.reduce((sum, file) => {
      const own = list.filter((item) => item.split('#')[0] === file);
      return sum + own.reduce((s, item) => s + seconds(item), 0) * 1000;
    }, 0);
  const stashes = [];
  const done = [];
  const context = { name, list, retry, record, started };
  const unfinished = (extra = []) =>
    progress(compose([...done, ...extra], { ...context, cancelled: true }));
  let n = 0;
  const options = { root, signal, quiet };
  for (const group of groups(list)) {
    if (signal?.aborted) break;
    const tag = `run-${++n}`;
    const first = await run(group.files, group.env, tag, scratch, options);
    const kept = { dir: join(scratch, `${tag}-outputs`), retried: false };
    stashes.push(kept);
    await stash(kept.dir, root);
    let retried = null;
    let skipped = null;
    const verdict = decide({ name, first, retried: null });
    const failed = failing(first.results, group.files, first.code);
    const pending = { env: group.env, first, retried: null, skipped, cancelled: true, verdict };
    if (!verdict.ok && retry && failed.length && !signal?.aborted) {
      const need = estimate(failed) * 1.2;
      if (Date.now() - started + need < budgetMs) {
        kept.retried = true;
        await cp(join(kept.dir, 'artifacts'), join(root, FIRST), {
          recursive: true,
          force: true,
        }).catch(() => {});
        await unfinished([pending]);
        retried = await run(failed, group.env, `${tag}-retry`, scratch, options);
        stashes.push({ dir: join(scratch, `${tag}-retry-outputs`), retried: false });
        await stash(stashes.at(-1).dir, root);
      } else
        skipped = `retry of ${failed.join(' ')} needs ~${Math.round(need / 60000)} min, past the budget`;
    }
    done.push({
      env: group.env,
      first,
      retried,
      skipped,
      cancelled: Boolean(signal?.aborted),
      verdict: decide({ name, first, retried }),
    });
    await unfinished();
  }
  await restore(stashes, root);
  const trimmed = await trimShard(done, root);
  const report = compose(done, { ...context, cancelled: Boolean(signal?.aborted) });
  report.traps = await trapped();
  report.trimmed = trimmed;
  report.compressed = await compress(root);
  return report;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      items: { type: 'string', default: '' },
      retry: { type: 'string', default: 'false' },
      'budget-min': { type: 'string', default: '62' },
    },
  });
  const scratch = join(env.RUNNER_TEMP || '/tmp', `slicc-shard-${values.name}`);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  const cancel = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => cancel.abort());
  const report = await shard({
    signal: cancel.signal,
    progress: async (partial) => {
      await mkdir(join(ROOT, ATTEMPTS, 'experiment'), { recursive: true });
      await writeFile(
        join(ROOT, ATTEMPTS, `experiment/${values.name}.json`),
        `${JSON.stringify(partial, null, 2)}\n`
      );
    },
    name: values.name,
    items: values.items.split(/\s+/).filter(Boolean),
    retry: values.retry === 'true',
    budgetMs: Number(values['budget-min']) * 60000,
    scratch,
    record: {
      run: env.GITHUB_RUN_ID ?? null,
      attempt: env.GITHUB_RUN_ATTEMPT ?? null,
      event: env.GITHUB_EVENT_NAME ?? null,
      sha: env.GITHUB_SHA ?? null,
      pr: env.EXPERIMENT_PR || null,
      arm: env.EXPERIMENT_ARM || null,
      seed: env.EXPERIMENT_SEED || null,
    },
  });
  await mkdir(join(ROOT, 'artifacts/experiment'), { recursive: true });
  await writeFile(
    join(ROOT, `artifacts/experiment/${values.name}.json`),
    `${JSON.stringify(report, null, 2)}\n`
  );
  await rm(join(ROOT, ATTEMPTS, `experiment/${values.name}.json`), { force: true });
  await mkdir(join(ROOT, 'artifacts/verdicts'), { recursive: true });
  await writeFile(join(ROOT, `artifacts/verdicts/${values.name}.txt`), `${report.line}\n`);
  console.log(report.line);
  const retried = report.groups.filter(({ retry }) => retry);
  for (const group of retried) {
    console.log(`retried ${group.retry.files.join(' ')}: ${group.ok ? 'passed' : 'failed again'}`);
  }
  for (const { file, name } of report.flips) console.log(`flipped ${file} › ${name}`);
  if (report.compressed.length) {
    const before = report.compressed.reduce((sum, { bytes }) => sum + bytes, 0) / 1048576;
    const after = report.compressed.reduce((sum, { gzipped }) => sum + gzipped, 0) / 1048576;
    console.log(
      `compressed ${report.compressed.length} kept stall traces (${before.toFixed(1)} MB to ${after.toFixed(1)} MB): ${report.compressed.map(({ path }) => path).join(' ')}`
    );
  }
  if (report.trimmed.length) {
    const mb = report.trimmed.reduce((sum, { bytes }) => sum + bytes, 0) / 1048576;
    console.log(
      `trimmed ${report.trimmed.length} stall traces of passing tests (${mb.toFixed(1)} MB): ${report.trimmed.map(({ path }) => path).join(' ')}`
    );
  }
  const traps = trapLine(values.name, report.traps);
  const lines = [report.line, traps, ...failures(report).map(failureLine)].filter(Boolean);
  for (const line of lines.slice(1)) console.log(line);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (!report.ok) exit(1);
}
