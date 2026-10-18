#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { items, ROOT } from './plan.mjs';

const exec = promisify(execFile);

export function refresh(current, summaries, list) {
  const seen = new Map();
  for (const { timings = {} } of summaries) {
    for (const [item, ms] of Object.entries(timings)) {
      if (ms > 0) seen.set(item, [...(seen.get(item) ?? []), ms / 1000]);
    }
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const out = {};
  for (const item of [...list].sort()) {
    const runs = seen.get(item);
    const seconds = runs ? median(runs) : current[item];
    if (seconds !== undefined) out[item] = Math.max(1, Math.round(seconds));
  }
  return out;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string', default: '40' },
      repo: { type: 'string', default: 'ai-ecoverse/slicc-bios' },
    },
  });
  const { stdout } = await exec('gh', [
    'run',
    'list',
    '-R',
    values.repo,
    '-w',
    'ci.yml',
    '-s',
    'completed',
    '-L',
    values.runs,
    '--json',
    'databaseId',
    '--jq',
    '.[].databaseId',
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'slicc-durations-'));
  const summaries = [];
  for (const id of stdout.split('\n').filter(Boolean)) {
    const into = join(dir, id);
    try {
      await exec('gh', [
        'run',
        'download',
        id,
        '-R',
        values.repo,
        '-n',
        'experiment-summary',
        '-D',
        into,
      ]);
      const [name] = (await readdir(into)).filter((file) => file.endsWith('.json'));
      if (name) summaries.push(JSON.parse(await readFile(join(into, name), 'utf8')));
    } catch {}
  }
  await rm(dir, { recursive: true, force: true });
  const file = join(ROOT, 'scripts/ci/durations.json');
  const current = JSON.parse(await readFile(file, 'utf8'));
  const tests = (await readdir(join(ROOT, 'test/integration')))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `test/integration/${name}`);
  const updated = refresh(current, summaries, items(tests));
  await writeFile(file, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(
    `durations: ${Object.keys(updated).length} items from ${summaries.length} run summaries`
  );
}
