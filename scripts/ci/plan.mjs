#!/usr/bin/env node
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { changes, scope, scopes } from './scope.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SHARDS = 14;
export const VARIANTS = ['prompt', 'lagging'];
export const SPLIT = /\/guard-set-[a-z]+\.test\.mjs$/;

export function prNumber(event, payload) {
  if (event === 'pull_request') return payload.pull_request?.number ?? null;
  if (event === 'merge_group') {
    const match = (payload.merge_group?.head_ref ?? '').match(/\/pr-(\d+)-[0-9a-f]+$/);
    return match ? Number(match[1]) : null;
  }
  return null;
}

export function arm(pr) {
  return {
    pr: Number.isInteger(pr) ? pr : null,
    arm: 'fail-fast+retry',
    failFast: true,
    retry: true,
  };
}

export function items(files) {
  return files.flatMap((file) =>
    SPLIT.test(file) ? VARIANTS.map((variant) => `${file}#${variant}`) : [file]
  );
}

export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function cost(durations) {
  const known = Object.values(durations).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 60;
  return (item) => durations[item] ?? median;
}

export function assign(list, durations, { shards = SHARDS, seed }) {
  const rand = random(seed);
  const seconds = cost(durations);
  const total = list.reduce((sum, item) => sum + seconds(item), 0);
  const long = total / shards / 2;
  const shuffled = shuffle(list, rand);
  const order = [
    ...shuffled.filter((item) => seconds(item) >= long),
    ...shuffled.filter((item) => seconds(item) < long),
  ];
  const loads = Array(shards).fill(0);
  const out = Array.from({ length: shards }, () => []);
  for (const item of order) {
    const least = Math.min(...loads);
    const open = loads.flatMap((load, index) => (load === least ? [index] : []));
    const pick = open[Math.floor(rand() * open.length)];
    out[pick].push(item);
    loads[pick] += seconds(item);
  }
  return out
    .map((group, index) => ({
      shard: `s${String(index + 1).padStart(2, '0')}`,
      items: group,
      seconds: Math.round(loads[index]),
    }))
    .filter(({ items: group }) => group.length);
}

export function narrow(files, scoped) {
  if (scoped.rows === null) return files;
  const wanted = new Set(scoped.rows.map((row) => `test/integration/${row}`));
  const picked = files.filter((file) => wanted.has(file));
  if (picked.length || scoped.mode === 'docs') return picked;
  return files.filter((file) => file === 'test/integration/boot.test.mjs');
}

export async function plan({
  event,
  payload,
  seed,
  scoped = { mode: 'full', rows: null, vendors: true },
}) {
  const files = (await readdir(join(ROOT, 'test/integration')))
    .filter((file) => file.endsWith('.test.mjs'))
    .sort()
    .map((file) => `test/integration/${file}`);
  const durations = JSON.parse(await readFile(join(ROOT, 'scripts/ci/durations.json'), 'utf8'));
  const chosen = narrow(files, scoped);
  const shards = chosen.length ? assign(items(chosen), durations, { seed }) : [];
  const skip = [...(shards.length ? [] : ['integration']), ...(scoped.vendors ? [] : ['vendors'])];
  return {
    event,
    seed,
    mode: scoped.mode,
    reason: scoped.reason ?? '',
    vendors: scoped.vendors,
    skip,
    ...arm(prNumber(event, payload)),
    shards,
  };
}

export async function scoping(event) {
  if (event !== 'pull_request') return scope({ event });
  try {
    return scope({ event, ...changes(), map: await scopes() });
  } catch (error) {
    return { mode: 'full', reason: `scoping failed: ${error.message}`, rows: null, vendors: true };
  }
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const payload = env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  const seed = Number(env.GITHUB_RUN_ID) || Date.now();
  const event = env.GITHUB_EVENT_NAME ?? '';
  const planned = await plan({ event, payload, seed, scoped: await scoping(event) });
  const out = join(ROOT, 'artifacts/experiment');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'plan.json'), `${JSON.stringify(planned, null, 2)}\n`);
  const matrix = {
    include: planned.shards.map(({ shard, items: list }) => ({ shard, items: list.join(' ') })),
  };
  const outputs = {
    matrix: JSON.stringify(matrix),
    shards: planned.shards.map(({ shard }) => shard).join(' '),
    arm: planned.arm,
    pr: planned.pr ?? '',
    failfast: String(planned.failFast),
    retry: String(planned.retry),
    seed: String(seed),
    mode: planned.mode,
    vendors: String(planned.vendors),
    skip: planned.skip.join(' '),
  };
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  const table = planned.shards.map(
    ({ shard, items: list, seconds }) =>
      `| ${shard} | ${Math.round(seconds / 60)} min | ${list.map((item) => item.replace('test/integration/', '')).join(', ')} |`
  );
  const summary = [
    `plan: mode ${planned.mode} (${planned.reason}), ${planned.shards.length} shards${planned.skip.length ? `, skips ${planned.skip.join(' and ')}` : ''}`,
    `plan: arm ${planned.arm} (PR ${planned.pr ?? 'none'}), seed ${seed}, ${planned.shards.length} shards`,
    '',
    '| shard | estimate | tests |',
    '| --- | --- | --- |',
    ...table,
  ].join('\n');
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
