#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { appendFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cost, ROOT } from './plan.mjs';
import { missingRequired, summary } from './verdict.mjs';

const REPORTER = './scripts/canary/reporter.mjs';
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
  const byEnv = new Map();
  for (const [file, chosen] of variants) {
    const key = [...chosen].sort().join(',');
    byEnv.set(key, [...(byEnv.get(key) ?? []), file]);
  }
  const out = [...byEnv].map(([key, files]) => ({ env: { GUARD_VARIANTS: key }, files }));
  if (!out.length) return whole.length ? [{ env: {}, files: whole }] : [];
  out[0].files = [...whole, ...out[0].files];
  return out;
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

async function command() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  return manifest.scripts.test
    .replace(/\$\{SLICC_TESTS[^}]*\}/, '')
    .trim()
    .split(/\s+/);
}

async function run(files, extra, tag, dir) {
  const [node, ...args] = await command();
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
  console.log(
    `shard: ${tag}: ${files.join(' ')}${extra.GUARD_VARIANTS ? ` (GUARD_VARIANTS=${extra.GUARD_VARIANTS})` : ''}`
  );
  const code = await new Promise((resolve) => {
    const child = spawn(
      node === 'node' ? process.execPath : node,
      [...args, ...reporters, ...files],
      {
        cwd: ROOT,
        env: { ...env, ...extra },
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
  const results = (await readFile(jsonl, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { files, code, ms: Date.now() - started, log: await readFile(log, 'utf8'), results };
}

async function stash(dir) {
  for (const path of OUTPUTS) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await rename(join(ROOT, path), join(dir, path)).catch(async (error) => {
      if (error.code === 'ENOENT') return;
      if (error.code !== 'EXDEV') throw error;
      await cp(join(ROOT, path), join(dir, path), { recursive: true });
      await rm(join(ROOT, path), { recursive: true, force: true });
    });
  }
}

async function restore(dirs) {
  for (const dir of dirs) {
    for (const path of OUTPUTS) {
      await cp(join(dir, path), join(ROOT, path), { recursive: true, force: true }).catch(() => {});
    }
  }
}

function brief(attempt) {
  if (!attempt) return null;
  return {
    files: attempt.files,
    exit: attempt.code,
    ms: attempt.ms,
    counts: summary(attempt.log),
    failed: failing(attempt.results, attempt.files, attempt.code),
  };
}

export async function shard({ name, items: list, retry, budgetMs, scratch, record }) {
  const started = Date.now();
  const seconds = cost(JSON.parse(await readFile(join(ROOT, 'scripts/ci/durations.json'), 'utf8')));
  const estimate = (files) =>
    files.reduce((sum, file) => {
      const own = list.filter((item) => item.split('#')[0] === file);
      return sum + own.reduce((s, item) => s + seconds(item), 0) * 1000;
    }, 0);
  const stashes = [];
  const done = [];
  let n = 0;
  for (const group of groups(list)) {
    const tag = `run-${++n}`;
    const first = await run(group.files, group.env, tag, scratch);
    stashes.push(join(scratch, `${tag}-outputs`));
    await stash(stashes.at(-1));
    let retried = null;
    let skipped = null;
    const verdict = decide({ name, first, retried: null });
    const failed = failing(first.results, group.files, first.code);
    if (!verdict.ok && retry && failed.length) {
      const need = estimate(failed) * 1.2;
      if (Date.now() - started + need < budgetMs) {
        retried = await run(failed, group.env, `${tag}-retry`, scratch);
        stashes.push(join(scratch, `${tag}-retry-outputs`));
        await stash(stashes.at(-1));
      } else
        skipped = `retry of ${failed.join(' ')} needs ~${Math.round(need / 60000)} min, past the budget`;
    }
    done.push({
      env: group.env,
      first,
      retried,
      skipped,
      verdict: decide({ name, first, retried }),
    });
  }
  await restore(stashes);
  const ok = done.length > 0 && done.every(({ verdict }) => verdict.ok);
  const pass = done.reduce((sum, { verdict }) => sum + verdict.pass, 0);
  const why = done.length ? done.flatMap(({ verdict }) => verdict.why) : ['no test files'];
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
    groups: done.map(({ env: extra, first, retried, skipped, verdict }) => ({
      env: extra,
      first: brief(first),
      retry: brief(retried),
      skipped,
      ok: verdict.ok,
      why: verdict.why,
    })),
  };
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
  const report = await shard({
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
  await mkdir(join(ROOT, 'artifacts/verdicts'), { recursive: true });
  await writeFile(join(ROOT, `artifacts/verdicts/${values.name}.txt`), `${report.line}\n`);
  console.log(report.line);
  const retried = report.groups.filter(({ retry }) => retry);
  for (const group of retried) {
    console.log(`retried ${group.retry.files.join(' ')}: ${group.ok ? 'passed' : 'failed again'}`);
  }
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${report.line}\n`);
  if (!report.ok) exit(1);
}
