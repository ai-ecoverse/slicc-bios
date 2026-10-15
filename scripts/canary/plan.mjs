import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PACKAGES, projects, ROOT, registryUrl, specs } from './override-pins.mjs';

const exec = promisify(execFile);

export const WATCHED =
  /^@ai-ecoverse\/(slicc-kernel|slicc-jsh|slicc-cdp|slicc-clipboard|slicc-agent|wasm-|wasi-|wasix-|py-)/;

function parts(version) {
  const [main, ...pre] = version.split('-');
  return { main: main.split('.').map(Number), pre: pre.length ? pre.join('-').split('.') : [] };
}

export function compare(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const m = Number(x.pre[i]);
    const n = Number(y.pre[i]);
    const d = Number.isInteger(m) && Number.isInteger(n) ? m - n : x.pre[i].localeCompare(y.pre[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

export async function pinned() {
  const found = new Map();
  for (const dir of await projects()) {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!WATCHED.test(name)) continue;
      const entry = found.get(name) ?? { versions: new Set(), files: [] };
      entry.versions.add(version);
      entry.files.push(relative(PACKAGES, join(dir, 'package.json')));
      found.set(name, entry);
    }
  }
  return found;
}

async function latest(name) {
  const response = await fetch(registryUrl(name), {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`${response.status} ${name}`);
  return (await response.json())['dist-tags']?.latest;
}

export async function newest() {
  const pins = await pinned();
  const checked = await Promise.all(
    [...pins].map(async ([name, { versions }]) => {
      const newer = await latest(name);
      const highest = [...versions].sort(compare).at(-1);
      return { name, pinned: [...versions].sort(compare), latest: newer, highest };
    })
  );
  const overrides = checked
    .filter(({ latest: newer, highest }) => newer && compare(newer, highest) > 0)
    .map(({ name, latest: newer }) => `${name}@${newer}`)
    .sort();
  return { checked: checked.sort((a, b) => a.name.localeCompare(b.name)), overrides };
}

export const SHARDS = [
  'follow-chat',
  'remote-pydata',
  'users-agent-ui',
  'packages-update-cdp',
  'guard',
  'k4-link',
  'rest',
];

function shardList(text) {
  const list = text?.trim() ? JSON.parse(text) : SHARDS;
  if (!Array.isArray(list) || !list.length) throw new Error(`shards must be a JSON list: ${text}`);
  return list;
}

export function jobs(runs) {
  return runs.flatMap((run) =>
    run.shards.map((shard) => ({ run: run.id, ref: run.ref, shard, overrides: run.overrides }))
  );
}

async function sha(ref, fallback) {
  if (!ref) return fallback;
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  await exec('git', ['fetch', '--quiet', '--depth=1', 'origin', ref], { cwd: ROOT });
  return (await exec('git', ['rev-parse', 'FETCH_HEAD'], { cwd: ROOT })).stdout.trim();
}

export async function pinRefs(runs, fallback) {
  const resolved = [];
  for (const run of runs) resolved.push({ ...run, ref: await sha(run.ref, fallback) });
  return resolved;
}

export async function plan(event, { overrides = '', expect = '', shards = '', ref = '' } = {}) {
  if (event === 'pull_request') {
    const proofs = JSON.parse(await readFile(join(ROOT, 'scripts/canary/proofs.json'), 'utf8'));
    return { runs: proofs, key: '', inputs: null };
  }
  if (event === 'schedule') {
    const inputs = await newest();
    const digest = createHash('sha256').update(JSON.stringify(inputs.overrides)).digest('hex');
    const runs = inputs.overrides.length
      ? [{ id: 'canary', overrides: inputs.overrides, shards: SHARDS, expect: [] }]
      : [];
    return { runs, key: `canary-inputs-${digest.slice(0, 32)}`, inputs };
  }
  const list = specs([overrides]);
  const wanted = expect.trim() ? JSON.parse(expect) : [];
  const run = { id: 'canary', ref, overrides: list, shards: shardList(shards), expect: wanted };
  return { runs: [run], key: '', inputs: null };
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const result = await plan(env.EVENT ?? 'workflow_dispatch', {
    overrides: env.OVERRIDES ?? '',
    expect: env.EXPECT ?? '',
    shards: env.SHARDS ?? '',
    ref: env.BIOS_REF ?? '',
  });
  result.runs = await pinRefs(result.runs, env.TOOLS_SHA ?? '');
  const inputs = join(ROOT, 'canary-inputs.json');
  await writeFile(inputs, `${JSON.stringify(result.inputs ?? {}, null, 2)}\n`);
  const lines = [
    `runs=${JSON.stringify(result.runs)}`,
    `jobs=${JSON.stringify(jobs(result.runs))}`,
    `key=${result.key}`,
  ];
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  for (const { name, pinned: at, latest: newer } of result.inputs?.checked ?? []) {
    console.log(`${name}: pinned ${at.join(', ')}, latest ${newer}`);
  }
}
