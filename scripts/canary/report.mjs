import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { enforceNote } from './users.mjs';

const ROWS = 150;

export function classify(runs, baselines, overridden) {
  const failed = runs.filter((status) => status === 'fail').length;
  if (!failed) return runs[0] ?? 'pass';
  if (!overridden) return 'fail';
  const base = baselines.filter((status) => status === 'fail').length;
  if (failed === runs.length && baselines.length && base === 0) return 'regression';
  if (failed === runs.length && baselines.length && base === baselines.length) return 'both';
  return 'flaky';
}

export function verdict(result, overridden) {
  if (result.runs?.length > 1) return classify(result.runs, result.baselines ?? [], overridden);
  if (result.status !== 'fail') return result.status;
  if (!overridden) return 'fail';
  if (result.retry === 'pass') return 'flaky';
  if (result.baseline === 'fail') return 'both';
  return 'regression';
}

const failures = (list = []) =>
  `${list.filter((status) => status === 'fail').length}/${list.length}`;

async function shards(dir, run) {
  const only = await readFile(join(dir, 'shard.json'), 'utf8').catch(() => null);
  if (only) return [JSON.parse(only)];
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith(`canary-shard-${run}-`)) continue;
    const text = await readFile(join(dir, entry.name, 'shard.json'), 'utf8').catch(() => null);
    if (text) found.push(JSON.parse(text));
  }
  return found.sort((a, b) => a.shard.localeCompare(b.shard));
}

const PARENT = /^\d+ subtests? failed$/;

function hit(result, { test = '', log = '' }) {
  return result.test.includes(test) && (result.log ?? '').includes(log);
}

export function merge({ run, biosRef, runner, url, found, expected }) {
  const pins = found.find((shard) => shard.pins?.overrides?.length)?.pins ?? found[0]?.pins;
  const kernels = found.find((shard) => shard.kernels)?.kernels ?? null;
  const overridden = run.overrides.length > 0 || (pins?.overrides?.length ?? 0) > 0;
  const results = found.flatMap((shard) =>
    shard.results
      .filter((result) => !PARENT.test(result.log ?? ''))
      .map((result) => ({
        shard: shard.shard,
        test: result.test,
        status: result.status,
        baseline: result.baseline,
        retry: result.retry,
        verdict: verdict(result, overridden),
        ...(result.runs?.length > 1
          ? { failed: { candidate: failures(result.runs), baseline: failures(result.baselines) } }
          : {}),
        durationMs: result.durationMs,
        log: result.log,
      }))
  );
  const regressions = results.filter((r) => r.verdict === 'regression');
  const failed = results.filter((r) => r.verdict === 'fail');
  const expect = run.expect.map((wanted) => ({
    ...wanted,
    found: regressions.some((r) => hit(r, wanted)),
  }));
  const unexpected = regressions.filter((r) => !run.expect.some((wanted) => hit(r, wanted)));
  const strict = run.strict ?? run.expect.length === 0;
  const missingShards = expected.filter((name) => !found.some((shard) => shard.shard === name));
  const unexplainedExits = found
    .filter((shard) => shard.exit !== 0 && !shard.results.some((r) => r.status === 'fail'))
    .map(({ shard, exit: code }) => ({ shard, exit: code }));
  const ok =
    missingShards.length === 0 &&
    unexplainedExits.length === 0 &&
    failed.length === 0 &&
    expect.every((wanted) => wanted.found) &&
    (!strict || unexpected.length === 0);
  return {
    biosRef,
    run: run.id,
    runner,
    url,
    repeat: run.repeat ?? 1,
    overrides: (pins?.overrides ?? []).map(({ name, version, sha256 }) => ({
      name,
      version,
      sha256,
    })),
    candidates: Object.entries(pins?.candidates ?? {}).map(([key, entry]) => ({
      package: key,
      status: entry.source
        ? `candidate (artifact ${entry.source.run}/${entry.source.artifact}, sha256 ${entry.sha256})`
        : 'candidate, not certified',
      via: entry.via,
      files: entry.files,
      ...(entry.source ? { source: entry.source, sha256: entry.sha256 } : {}),
    })),
    held: pins?.held ?? [],
    kernels,
    notes: [enforceNote(pins?.overrides ?? [], kernels)].filter(Boolean),
    shards: found.map(({ shard, files, startedAt, wallMs, phases, exit: code }) => ({
      shard,
      files: files.length,
      startedAt,
      wallMs,
      phases,
      exit: code,
    })),
    missingShards,
    unexplainedExits,
    counts: Object.fromEntries(
      ['pass', 'skip', 'fail', 'regression', 'both', 'flaky'].map((v) => [
        v,
        results.filter((r) => r.verdict === v).length,
      ])
    ),
    expect,
    ok,
    results,
  };
}

const LISTED = 100;

export function summary(report, artifact = null) {
  const pick = (kind) =>
    report.results
      .filter((r) => r.verdict === kind)
      .slice(0, LISTED)
      .map(({ shard, test, failed, log }) => ({
        shard,
        test,
        ...(failed ? { failed } : {}),
        log: String(log ?? '').slice(0, 300),
      }));
  return {
    ok: report.ok,
    run: report.run,
    biosRef: report.biosRef,
    url: report.url,
    repeat: report.repeat,
    overrides: report.overrides,
    candidates: report.candidates.map(({ package: key, status, via }) => ({
      package: key,
      status,
      via,
    })),
    counts: report.counts,
    regressions: pick('regression'),
    both: pick('both'),
    flaky: pick('flaky'),
    failures: pick('fail'),
    missingShards: report.missingShards,
    unexplainedExits: report.unexplainedExits,
    ...(artifact ? { artifact } : {}),
  };
}

const cell = (text) =>
  String(text ?? '')
    .split('\n')[0]
    .replaceAll('|', '\\|')
    .slice(0, 200);
const minutes = (ms) => (ms === undefined ? '' : `${(ms / 60000).toFixed(1)} min`);

function rows(results) {
  const shown = results
    .slice(0, ROWS)
    .map(
      (r) =>
        `| ${cell(r.test)} | ${r.shard} | ${r.failed ? `${r.failed.candidate} vs ${r.failed.baseline}` : ''} | ${cell(r.log)} |`
    );
  if (results.length > ROWS) shown.push(`| … ${results.length - ROWS} more in canary.json | | | |`);
  return [
    '| test | shard | failed (candidate vs main’s pins) | first line of the failure |',
    '| :--- | :--- | :--- | :--- |',
    ...shown,
  ];
}

const repeated = ({ repeat }) => (repeat > 1 ? `, each test ${repeat} times` : '');

export function markdown(report) {
  const lines = [
    `## Canary \`${report.run}\`: ${report.ok ? 'green' : 'red'}`,
    '',
    `bios \`${report.biosRef}\` on \`${report.runner}\`${repeated(report)}. ${Object.entries(
      report.counts
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}.`,
    '',
  ];
  if (report.overrides.length) {
    lines.push('| override | version | sha256 |', '| :--- | :--- | :--- |');
    for (const o of report.overrides) lines.push(`| ${o.name} | ${o.version} | \`${o.sha256}\` |`);
    lines.push('');
  } else lines.push("No overrides: the ref's own pins.", '');
  for (const note of report.notes ?? []) lines.push(`> **Note:** ${note}`, '');
  if (report.candidates.length) {
    lines.push('| package | status | via |', '| :--- | :--- | :--- |');
    for (const c of report.candidates) lines.push(`| ${c.package} | ${c.status} | ${c.via} |`);
    lines.push('');
  }
  for (const h of report.held) {
    lines.push(`- held: ${h.name}@${h.version} in ${h.file}, pinned by ${h.by.join(', ')}`);
  }
  if (report.held.length) lines.push('');
  lines.push(
    '| shard | files | wall | candidate | baseline rerun | retry | exit |',
    '| :--- | ---: | ---: | ---: | ---: | ---: | ---: |'
  );
  for (const s of report.shards) {
    lines.push(
      `| ${s.shard} | ${s.files} | ${minutes(s.wallMs)} | ${minutes(s.phases.candidate)} | ${minutes(s.phases.baseline)} | ${minutes(s.phases.retry)} | ${s.exit} |`
    );
  }
  for (const name of report.missingShards) lines.push(`| ${name} | | no result | | | | |`);
  lines.push('');
  for (const { shard, exit: code } of report.unexplainedExits) {
    lines.push(
      `- **${shard}** exited ${code} with no failing test (a crash or a failing teardown).`
    );
  }
  if (report.unexplainedExits.length) lines.push('');
  if (report.expect.length) {
    lines.push('| expected regression | log | found |', '| :--- | :--- | :--- |');
    for (const e of report.expect) {
      lines.push(`| ${cell(e.test)} | ${cell(e.log)} | ${e.found ? 'yes' : '**no**'} |`);
    }
    lines.push('');
  }
  const groups = [
    ['Regressions: pass on main’s pins, fail with the overrides', 'regression'],
    ['Failures on both: fail on main’s pins too', 'both'],
    ['Flaky: failed in some runs, not in all', 'flaky'],
    ['Failures', 'fail'],
  ];
  for (const [title, kind] of groups) {
    const picked = report.results.filter((r) => r.verdict === kind);
    if (!picked.length) continue;
    lines.push(`### ${title} (${picked.length})`, '', ...rows(picked), '');
  }
  return `${lines.join('\n')}\n`;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      runs: { type: 'string' },
      out: { type: 'string', default: 'canary' },
    },
  });
  const runs = JSON.parse(values.runs);
  let ok = true;
  const summaries = [];
  for (const run of runs) {
    const report = merge({
      run,
      biosRef: run.ref ?? '',
      runner: env.CANARY_RUNNER ?? '',
      url: env.RUN_URL ?? '',
      found: await shards(values.dir, run.id),
      expected: run.shards,
    });
    const dir = runs.length === 1 ? values.out : join(values.out, run.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'canary.json'), `${JSON.stringify(report, null, 2)}\n`);
    summaries.push(summary(report));
    const text = markdown(report);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text);
    console.log(text);
    ok &&= report.ok;
  }
  await mkdir(values.out, { recursive: true });
  const result = runs.length === 1 ? summaries[0] : { ok, runs: summaries };
  await writeFile(join(values.out, 'result.json'), `${JSON.stringify(result)}\n`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `ok=${ok}\n`);
  if (!ok) exit(1);
}
