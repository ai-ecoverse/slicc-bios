import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROWS = 150;

export function verdict(result, overridden) {
  if (result.status !== 'fail') return result.status;
  if (!overridden) return 'fail';
  if (result.retry === 'pass') return 'flaky';
  if (result.baseline === 'fail') return 'both';
  return 'regression';
}

async function shards(dir, run) {
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
  const overridden = run.overrides.length > 0;
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
    overrides: (pins?.overrides ?? []).map(({ name, version, sha256 }) => ({
      name,
      version,
      sha256,
    })),
    candidates: Object.entries(pins?.candidates ?? {}).map(([key, entry]) => ({
      package: key,
      status: 'candidate, not certified',
      via: entry.via,
      files: entry.files,
    })),
    held: pins?.held ?? [],
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

const cell = (text) =>
  String(text ?? '')
    .split('\n')[0]
    .replaceAll('|', '\\|')
    .slice(0, 200);
const minutes = (ms) => (ms === undefined ? '' : `${(ms / 60000).toFixed(1)} min`);

function rows(results) {
  const shown = results
    .slice(0, ROWS)
    .map((r) => `| ${cell(r.test)} | ${r.shard} | ${cell(r.log)} |`);
  if (results.length > ROWS) shown.push(`| … ${results.length - ROWS} more in canary.json | | |`);
  return ['| test | shard | first line of the failure |', '| :--- | :--- | :--- |', ...shown];
}

export function markdown(report) {
  const lines = [
    `## Canary \`${report.run}\`: ${report.ok ? 'green' : 'red'}`,
    '',
    `bios \`${report.biosRef}\` on \`${report.runner}\`. ${Object.entries(report.counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}.`,
    '',
  ];
  if (report.overrides.length) {
    lines.push('| override | version | sha256 |', '| :--- | :--- | :--- |');
    for (const o of report.overrides) lines.push(`| ${o.name} | ${o.version} | \`${o.sha256}\` |`);
    lines.push('');
  } else lines.push("No overrides: main's own pins.", '');
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
    ['Flaky: failed once, passed on the retry', 'flaky'],
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
    const text = markdown(report);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text);
    console.log(text);
    ok &&= report.ok;
  }
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `ok=${ok}\n`);
  if (!ok) exit(1);
}
