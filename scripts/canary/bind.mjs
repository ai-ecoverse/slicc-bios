import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const MAX_JOBS = 16;

export function digestOf(text) {
  const value = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`not a sha256 digest: ${text}`);
  return value;
}

export function names(prefix, run, shard) {
  return {
    shard: `${prefix}canary-shard-${run}-${shard}`,
    files: `${prefix}canary-files-${run}-${shard}`,
  };
}

function plain(digest) {
  try {
    return digestOf(digest);
  } catch {
    return null;
  }
}

export function checkArtifact(meta, want) {
  const problems = [];
  if (String(meta?.id ?? '') !== String(want.id)) {
    problems.push(`its id is ${meta?.id ?? 'missing'}, not ${want.id}`);
  }
  if (meta?.name !== want.name) problems.push(`its name is ${meta?.name ?? 'missing'}`);
  if (String(meta?.workflow_run?.id ?? '') !== String(want.run)) {
    problems.push(`it is from run ${meta?.workflow_run?.id ?? 'unknown'}, not ${want.run}`);
  }
  if (String(meta?.workflow_run?.repository_id ?? '') !== String(want.repositoryId)) {
    problems.push(
      `it is from repository ${meta?.workflow_run?.repository_id ?? 'unknown'}, not ${want.repositoryId}`
    );
  }
  if (meta?.expired !== false) problems.push('it has expired');
  if (plain(meta?.digest) !== digestOf(want.digest)) {
    problems.push(
      `its digest is ${meta?.digest || 'missing'}, not sha256:${digestOf(want.digest)}`
    );
  }
  if (problems.length) {
    throw new Error(`artifact ${want.id} (${want.name}): ${problems.join(', ')}; refusing it`);
  }
  return meta;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(path, { api = '', token = '', attempts = 3 } = {}) {
  const base = (api || env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const auth = token || env.GH_TOKEN || env.GITHUB_TOKEN || '';
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await pause(1000 * 2 ** attempt);
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      last = error.message;
      continue;
    }
    if (response.ok) return response.json();
    last = String(response.status);
    if (response.status < 500 && response.status !== 429) break;
  }
  throw new Error(`GET ${path}: ${last}`);
}

export async function verifyArtifact(want, { repo, ...options }) {
  const [repository, meta] = await Promise.all([
    get(`/repos/${repo}`, options),
    get(`/repos/${repo}/actions/artifacts/${want.id}`, options),
  ]);
  return checkArtifact(meta, { ...want, repositoryId: repository.id });
}

export function candidateBinding(candidate, planned = []) {
  if (candidate.binding === 'plan') {
    const row = planned.find(({ name }) => name === candidate.artifact);
    if (!row?.id || !plain(row.digest)) {
      throw new Error(`the plan job uploaded no ${candidate.artifact}; refusing the candidate`);
    }
    return { id: String(row.id), digest: digestOf(row.digest) };
  }
  if (candidate.id || candidate.digest) {
    if (!/^\d+$/.test(String(candidate.id ?? '')) || !plain(candidate.digest)) {
      throw new Error('the candidate needs both an artifact id and a sha256 digest; refusing it');
    }
    return { id: String(candidate.id), digest: digestOf(candidate.digest) };
  }
  if (candidate.binding === 'legacy') return null;
  throw new Error(
    'a strict candidate needs candidate-artifact-id and candidate-artifact-digest; refusing it'
  );
}

export async function bindCandidate(candidate, { planned = [], ...options } = {}) {
  const bound = candidateBinding(candidate, planned);
  if (!bound) {
    return {
      id: '',
      name: candidate.artifact,
      line: `canary candidate: PASS legacy binding, ${candidate.artifact} by name from ${candidate.repo} run ${candidate.run}, sha256 ${candidate.sha256} checked after download`,
    };
  }
  await verifyArtifact(
    { id: bound.id, name: candidate.artifact, run: candidate.run, digest: bound.digest },
    { repo: candidate.repo, ...options }
  );
  return {
    id: bound.id,
    name: '',
    line: `canary candidate: PASS artifact ${bound.id} ${candidate.artifact} from ${candidate.repo} run ${candidate.run}, sha256:${bound.digest}`,
  };
}

export function shardBinding({ index, run, shard, prefix, attempt, uploads }) {
  if (!/^\d+$/.test(String(index)) || Number(index) >= MAX_JOBS) {
    throw new Error(`job index ${index} is not below ${MAX_JOBS}`);
  }
  const named = names(prefix, run, shard);
  const rows = ['shard', 'files']
    .filter((role) => uploads[role]?.id)
    .map((role) => ({
      role,
      name: named[role],
      id: String(uploads[role].id),
      digest: String(uploads[role].digest ?? ''),
      attempt: String(attempt ?? ''),
    }));
  return { key: `binding_${index}`, value: { run, shard, rows } };
}

export function planned(jobs, prefix) {
  return jobs.map(({ run, shard }) => {
    const named = names(prefix, run, shard);
    return { run, shard, name: named.shard, files: named.files };
  });
}

function row(found, role, want, refused) {
  if (!found) return null;
  const problems = [];
  if (found.role !== role) problems.push(`its role is ${found.role}`);
  if (found.name !== want) problems.push(`its name is not ${want}`);
  if (!/^\d+$/.test(String(found.id ?? ''))) problems.push('it has no artifact id');
  if (!plain(found.digest)) problems.push('it has no sha256 digest');
  if (problems.length) {
    refused.push({ name: String(found.name ?? role), reason: problems.join(', ') });
    return null;
  }
  return {
    role,
    name: found.name,
    id: String(found.id),
    digest: digestOf(found.digest),
    attempt: String(found.attempt ?? ''),
  };
}

function parsed(key, text, plan, bound, refused) {
  if (!/^binding_\d+$/.test(key)) {
    refused.push({ name: key, reason: 'not a binding output' });
    return null;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    refused.push({ name: key, reason: 'its binding is not JSON' });
    return null;
  }
  const job = plan.find(({ run, shard }) => run === value?.run && shard === value?.shard);
  if (!job) {
    refused.push({ name: key, reason: `${value?.run}/${value?.shard} is not a planned shard` });
    return null;
  }
  if (bound.has(job)) {
    refused.push({ name: key, reason: `a second binding for ${job.run}/${job.shard}` });
    return null;
  }
  return { job, rows: Array.isArray(value.rows) ? value.rows : [] };
}

function entryOf(job, rows, refused) {
  const entry = {};
  for (const found of rows) {
    const role = ['shard', 'files'].includes(found?.role) ? found.role : null;
    if (!role || entry[role]) {
      refused.push({
        name: String(found?.name ?? job.name),
        reason: role ? `a second ${role} row` : 'not a shard or files row',
      });
      continue;
    }
    entry[role] = row(found, role, role === 'shard' ? job.name : job.files, refused);
  }
  return entry;
}

export function collect(outputs, jobs, prefix) {
  const plan = planned(jobs, prefix);
  const refused = [];
  const bound = new Map();
  for (const [key, text] of Object.entries(outputs ?? {})) {
    if (!text) continue;
    const found = parsed(key, text, plan, bound, refused);
    if (found) bound.set(found.job, entryOf(found.job, found.rows, refused));
  }
  const rows = plan.flatMap((job) =>
    ['shard', 'files'].map((role) => bound.get(job)?.[role]).filter(Boolean)
  );
  const shards = plan
    .filter((job) => bound.get(job)?.shard)
    .map((job) => ({ run: job.run, shard: job.shard, ...bound.get(job).shard }));
  return { planned: plan, shards, rows, refused };
}

export async function verifyShards({ outputs, jobs, prefix, run, repo }, options = {}) {
  const found = collect(outputs, jobs, prefix);
  const verified = [];
  const rows = [];
  const refused = [...found.refused];
  for (const entry of found.rows) {
    try {
      await verifyArtifact(
        { id: entry.id, name: entry.name, run, digest: entry.digest },
        { repo, ...options }
      );
      rows.push(entry);
      const job = found.planned.find(({ name }) => entry.role === 'shard' && name === entry.name);
      if (job) verified.push({ run: job.run, shard: job.shard, ...entry });
    } catch (error) {
      refused.push({ name: entry.name, reason: error.message });
    }
  }
  const missing = found.planned
    .filter(({ run, shard }) => !found.shards.some((s) => s.run === run && s.shard === shard))
    .map(({ name }) => name);
  const ok = jobs.length > 0 && refused.length === 0 && missing.length === 0;
  const why = [
    ...(jobs.length ? [] : ['no planned shards']),
    ...refused.map(({ name, reason }) => `${name}: ${reason}`),
    ...missing.map((name) => `${name}: no binding`),
  ];
  return {
    ok,
    verdict: ok
      ? `canary bindings: PASS ${verified.length} shards, ${rows.length} artifacts`
      : `canary bindings: FAIL ${why.join('; ')}`,
    verified,
    refused,
    missing,
    rows,
  };
}

export function manifest({
  prefix = '',
  uploads = [],
  inputs = {},
  proof = {},
  rows = [],
  report = {},
}) {
  const out = [];
  const add = (role, name, found) => {
    if (!found?.id) return;
    out.push({
      role,
      name,
      id: String(found.id),
      digest: digestOf(found.digest),
      attempt: String(found.attempt ?? ''),
    });
  };
  add('plan', `${prefix}canary-inputs`, inputs);
  if (uploads[0]?.name) add('plan', uploads[0].name, proof);
  out.push(...rows);
  add('report', `${prefix}canary`, report);
  return out;
}

const list = (text) => (text?.trim() ? JSON.parse(text) : []);

async function output(lines) {
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'bindings.json' },
      dir: { type: 'string', default: 'shards' },
      bindings: { type: 'string', default: 'bindings.json' },
    },
  });
  const [command] = positionals;
  if (command === 'candidate') {
    try {
      const candidate = JSON.parse(env.CANDIDATE ?? 'null');
      if (!candidate) throw new Error('no candidate');
      const planRows = manifest({
        prefix: env.PREFIX ?? '',
        uploads: list(env.UPLOADS),
        proof: { id: env.PROOF_ID, digest: env.PROOF_DIGEST },
      });
      const bound = await bindCandidate(candidate, { planned: planRows });
      await output([`id=${bound.id}`, `name=${bound.name}`]);
      console.log(bound.line);
    } catch (error) {
      console.log(`canary candidate: FAIL ${error.message}`);
      exit(1);
    }
    return;
  }
  if (command === 'shard') {
    const { key, value } = shardBinding({
      index: env.INDEX,
      run: env.RUN,
      shard: env.SHARD,
      prefix: env.PREFIX ?? '',
      attempt: env.ATTEMPT,
      uploads: {
        shard: { id: env.SHARD_ID, digest: env.SHARD_DIGEST },
        files: { id: env.FILES_ID, digest: env.FILES_DIGEST },
      },
    });
    await output([`${key}=${JSON.stringify(value)}`]);
    console.log(`${key}=${JSON.stringify(value)}`);
    return;
  }
  if (command === 'shards') {
    const result = await verifyShards({
      outputs: JSON.parse(env.BINDINGS || '{}'),
      jobs: list(env.JOBS),
      prefix: env.PREFIX ?? '',
      run: env.GITHUB_RUN_ID ?? '',
      repo: env.GITHUB_REPOSITORY ?? '',
    });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
    const path =
      result.verified.length === 1 ? `${values.dir}/${result.verified[0].name}` : values.dir;
    await output([`ids=${result.verified.map(({ id }) => id).join(',')}`, `path=${path}`]);
    console.log(result.verdict);
    return;
  }
  if (command === 'manifest') {
    const bindings = JSON.parse(await readFile(values.bindings, 'utf8').catch(() => '{}'));
    const shardRows = Array.isArray(bindings.rows) ? bindings.rows : [];
    const rows = manifest({
      prefix: env.PREFIX ?? '',
      uploads: list(env.UPLOADS),
      inputs: { id: env.INPUTS_ID, digest: env.INPUTS_DIGEST, attempt: env.PLAN_ATTEMPT },
      proof: { id: env.PROOF_ID, digest: env.PROOF_DIGEST, attempt: env.PLAN_ATTEMPT },
      rows: shardRows,
      report: { id: env.REPORT_ID, digest: env.REPORT_DIGEST, attempt: env.GITHUB_RUN_ATTEMPT },
    });
    await output([`artifacts=${JSON.stringify(rows)}`]);
    if (env.GITHUB_STEP_SUMMARY) {
      const table = rows.map(
        (r) => `| ${r.role} | ${r.name} | ${r.id} | \`${r.digest}\` | ${r.attempt} |`
      );
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `\n| role | artifact | id | digest | attempt |\n| :--- | :--- | ---: | :--- | ---: |\n${table.join('\n')}\n`
      );
    }
    console.log(`canary artifacts: ${rows.length} rows`);
    console.log(`artifacts=${JSON.stringify(rows)}`);
    return;
  }
  throw new Error(`bind.mjs candidate|shard|shards|manifest, not ${command}`);
}

if (argv[1] === fileURLToPath(import.meta.url)) await main();
