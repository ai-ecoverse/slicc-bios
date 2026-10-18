import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digestOf, MAX_JOBS } from './bind.mjs';
import { PACKAGES, parse, projects, ROOT, registryUrl, specs } from './override-pins.mjs';

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
  'guard-set-extension-prompt',
  'guard-set-extension-lagging',
  'guard-set-proxy-prompt',
  'guard-set-proxy-lagging',
  'k4-link',
  'user-packages-keys-favicon',
  'rest',
];

function shardList(text) {
  const list = text?.trim() ? JSON.parse(text) : SHARDS;
  if (!Array.isArray(list) || !list.length) throw new Error(`shards must be a JSON list: ${text}`);
  return list;
}

export function jobs(runs) {
  const planned = runs.flatMap((run) =>
    run.shards.map((shard) => ({
      run: run.id,
      ref: run.ref,
      shard,
      overrides: run.overrides ?? [],
      candidate: run.candidate ?? null,
      repeat: run.repeat ?? 1,
    }))
  );
  if (planned.length > MAX_JOBS) {
    throw new Error(`${planned.length} shard jobs, but the report binds at most ${MAX_JOBS}`);
  }
  return planned;
}

const NAME = /^@[\w.-]+\/[\w.-]+$/;

export const BINDINGS = ['strict', 'legacy'];

export function candidateOf(
  {
    package: name = '',
    artifact = '',
    run = '',
    sha256 = '',
    repo = '',
    id = '',
    digest = '',
    binding = '',
  },
  fallbackRepo = ''
) {
  const given = [name, artifact, run, sha256, id, digest].filter((value) => String(value).trim());
  if (!given.length) return null;
  if (![name, artifact, run, sha256].every((value) => String(value).trim())) {
    throw new Error(
      'a candidate needs candidate-package, candidate-artifact, candidate-run and candidate-sha256'
    );
  }
  if (!NAME.test(name)) throw new Error(`candidate-package is not a scoped package name: ${name}`);
  if (!/^\d+$/.test(String(run))) throw new Error(`candidate-run is not a run id: ${run}`);
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new Error(`candidate-sha256 is not 64 hex digits: ${sha256}`);
  const from = repo || fallbackRepo;
  if (!/^[\w.-]+\/[\w.-]+$/.test(from))
    throw new Error(`candidate-repo is not owner/name: ${from}`);
  const mode = String(binding).trim() || 'strict';
  if (![...BINDINGS, 'plan'].includes(mode)) {
    throw new Error(`candidate-binding is strict or legacy, not ${binding}`);
  }
  const artifactId = String(id).trim();
  const artifactDigest = String(digest).trim();
  if (artifactId && !/^\d+$/.test(artifactId)) {
    throw new Error(`candidate-artifact-id is not an artifact id: ${artifactId}`);
  }
  if (Boolean(artifactId) !== Boolean(artifactDigest)) {
    throw new Error('candidate-artifact-id and candidate-artifact-digest go together; refusing it');
  }
  if (mode === 'strict' && !artifactId) {
    throw new Error(
      'a strict candidate needs candidate-artifact-id and candidate-artifact-digest from the step that uploaded it; refusing it'
    );
  }
  return {
    package: name,
    artifact,
    run: String(run),
    sha256,
    repo: from,
    ...(artifactId ? { id: artifactId, digest: digestOf(artifactDigest) } : {}),
    binding: mode,
  };
}

const BINDING_ENV = ['CANDIDATE_BINDING', 'CANDIDATE_ARTIFACT_ID', 'CANDIDATE_ARTIFACT_DIGEST'];

export function bindingOf(values) {
  if (values.CANDIDATE_BINDING !== undefined) return values.CANDIDATE_BINDING;
  return BINDING_ENV.every((name) => values[name] === undefined) ? 'legacy' : '';
}

function bindingNote(values, runs) {
  if (values.CANDIDATE_BINDING !== undefined || !runs.some(({ candidate }) => candidate)) return '';
  return `canary plan: ${bindingOf(values) || 'strict'} binding, the calling canary.yml passes no candidate-binding`;
}

export function repeatOf(text) {
  const n = Number(text === '' || text === undefined || text === null ? 1 : text);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error(`repeat must be 1 to 10: ${text}`);
  return n;
}

export function prefixOf(label, { called = false, candidate = null } = {}) {
  const text = String(label ?? '').trim();
  if (text) {
    if (!/^[A-Za-z0-9][\w.-]{0,39}$/.test(text)) {
      throw new Error(`label is not 1 to 40 letters, digits, dots, dashes or underscores: ${text}`);
    }
    return `${text}-`;
  }
  if (!called) return '';
  return candidate ? 'candidate-' : 'base-';
}

async function packProof(proof, { runId, repo, dir, prefix = '' }) {
  const { name } = parse(proof.pack);
  const out = join(dir, proof.id);
  await mkdir(out, { recursive: true });
  await exec('npm', ['pack', proof.pack, '--pack-destination', out], { cwd: ROOT });
  const artifact = `${prefix}canary-candidate-${proof.id}`;
  const { pack, sha256, ...rest } = proof;
  return {
    run: {
      overrides: [],
      ...rest,
      candidate: candidateOf({
        package: name,
        artifact,
        run: runId,
        sha256,
        repo,
        binding: 'plan',
      }),
    },
    upload: { name: artifact, path: out },
  };
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

export async function plan(
  event,
  {
    overrides = '',
    expect = '',
    shards = '',
    ref = '',
    candidate = {},
    repeat = '',
    runId = '',
    repo = '',
    label = '',
    packDir = join(ROOT, 'canary-pack'),
  } = {}
) {
  if (event === 'pull_request') {
    const prefix = prefixOf(label);
    const proofs = JSON.parse(await readFile(join(ROOT, 'scripts/canary/proofs.json'), 'utf8'));
    const runs = [];
    const uploads = [];
    for (const proof of proofs) {
      if (!proof.pack) {
        runs.push(proof);
        continue;
      }
      const packed = await packProof(proof, { runId, repo, dir: packDir, prefix });
      runs.push(packed.run);
      uploads.push(packed.upload);
    }
    return { runs, key: '', inputs: null, uploads, prefix };
  }
  if (event === 'schedule') {
    const inputs = await newest();
    const digest = createHash('sha256').update(JSON.stringify(inputs.overrides)).digest('hex');
    const runs = inputs.overrides.length
      ? [{ id: 'canary', overrides: inputs.overrides, shards: SHARDS, expect: [] }]
      : [];
    return {
      runs,
      key: `canary-inputs-${digest.slice(0, 32)}`,
      inputs,
      uploads: [],
      prefix: prefixOf(label),
    };
  }
  if (candidate.binding && !BINDINGS.includes(String(candidate.binding).trim())) {
    throw new Error(`candidate-binding is strict or legacy, not ${candidate.binding}`);
  }
  const list = specs([overrides]);
  const wanted = expect.trim() ? JSON.parse(expect) : [];
  const run = {
    id: 'canary',
    ref,
    overrides: list,
    shards: shardList(shards),
    expect: wanted,
    candidate: candidateOf(candidate, repo),
    repeat: repeatOf(repeat),
  };
  if (!run.overrides.length && !run.candidate && run.repeat > 1) {
    throw new Error('repeat compares a candidate with main’s pins: name overrides or a candidate');
  }
  return {
    runs: [run],
    key: '',
    inputs: null,
    uploads: [],
    prefix: prefixOf(label, { called: event === 'workflow_call', candidate: run.candidate }),
  };
}

async function main() {
  const result = await plan(env.EVENT ?? 'workflow_dispatch', {
    overrides: env.OVERRIDES ?? '',
    expect: env.EXPECT ?? '',
    shards: env.SHARDS ?? '',
    ref: env.BIOS_REF ?? '',
    candidate: {
      package: env.CANDIDATE_PACKAGE ?? '',
      artifact: env.CANDIDATE_ARTIFACT ?? '',
      run: env.CANDIDATE_RUN ?? '',
      sha256: env.CANDIDATE_SHA256 ?? '',
      repo: env.CANDIDATE_REPO ?? '',
      id: env.CANDIDATE_ARTIFACT_ID ?? '',
      digest: env.CANDIDATE_ARTIFACT_DIGEST ?? '',
      binding: bindingOf(env),
    },
    repeat: env.REPEAT ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    repo: env.GITHUB_REPOSITORY ?? '',
    label: env.LABEL ?? '',
  });
  result.runs = await pinRefs(result.runs, env.TOOLS_SHA ?? '');
  const inputs = join(ROOT, 'canary-inputs.json');
  await writeFile(inputs, `${JSON.stringify(result.inputs ?? {}, null, 2)}\n`);
  const lines = [
    `runs=${JSON.stringify(result.runs)}`,
    `jobs=${JSON.stringify(jobs(result.runs))}`,
    `key=${result.key}`,
    `uploads=${JSON.stringify(result.uploads ?? [])}`,
    `prefix=${result.prefix ?? ''}`,
  ];
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  const note = bindingNote(env, result.runs);
  if (note) console.log(note);
  for (const { name, pinned: at, latest: newer } of result.inputs?.checked ?? []) {
    console.log(`${name}: pinned ${at.join(', ')}, latest ${newer}`);
  }
  console.log(`canary plan: PASS ${result.runs.length} runs`);
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const line = `canary plan: FAIL ${error.message}`.replace(/\s+/g, ' ');
    let prefix = '';
    try {
      prefix = prefixOf(env.LABEL ?? '', {
        called: env.EVENT === 'workflow_call',
        candidate: env.CANDIDATE_ARTIFACT || env.CANDIDATE_PACKAGE ? {} : null,
      });
    } catch {
      prefix = '';
    }
    if (env.GITHUB_OUTPUT) {
      await appendFile(env.GITHUB_OUTPUT, `refused=${line}\nprefix=${prefix}\n`);
    }
    console.log(line);
    exit(1);
  }
}
