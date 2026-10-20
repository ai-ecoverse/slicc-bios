#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import semver from 'semver';
import { certsAt, lockedAt } from './pins.mjs';

export const HOMESCOOP = {
  repository: 'https://github.com/ai-ecoverse/homescoop',
  workflows: ['.github/workflows/ladder-build.yml', '.github/workflows/publish.yml'],
  exceptions: {
    repo: 'ai-ecoverse/homescoop',
    path: 'certification-exceptions.json',
    ref: '78d41d0ab6757deba5db295fffa6e3f358cd1a9e',
  },
};

const MAIN = {
  'slicc-kernel': 'slicc-kernel',
  'slicc-jsh': 'slicc-jsh',
  mcpcat: 'mcpcat',
  'wasi-slicc': 'slicc-cli',
};

export const STATUS_RULES = {
  'wasi-slicc': {
    since: '1.44.1',
    deny: {
      '1.44.4': 'its release run failed, so it was never certified (slicc-cli coordinator, 10-19)',
    },
    before:
      'pre-PR-cert wasi-slicc (before 1.44.1), not certified by tag any more (cert lane, 10-19)',
  },
};
const TAGGED_TOO = new Set(['slicc-kernel']);

export function writerOf(name) {
  const short = name.replace(/^@ai-ecoverse\//, '');
  if (MAIN[short]) return { kind: 'main', repo: MAIN[short], tag: TAGGED_TOO.has(short) };
  if (/^(wasm-tailscale|slicc-cdp|slicc-clipboard)$/.test(short)) return { kind: 'tag' };
  if (/^(wasm|wasi|wasix|py)-/.test(short)) return { kind: 'homescoop' };
  return { kind: 'none' };
}

export function hexOf(integrity) {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity ?? '');
  return m ? Buffer.from(m[1], 'base64').toString('hex') : null;
}

const VERSION_FILES = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json)$/;
const RELEASERS = new Set(['github-actions[bot]', 'semantic-release-bot']);

export function versionOnly(c) {
  const files = c?.files ?? [];
  if (!files.length || !RELEASERS.has(c.author?.login)) return false;
  return files.every((f) => {
    if (f.filename === 'CHANGELOG.md') return true;
    if (!VERSION_FILES.test(f.filename) || typeof f.patch !== 'string') return false;
    const changed = f.patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
    return changed.length > 0 && changed.every((l) => /^[+-]\s*"version": "[^"]+",?$/.test(l));
  });
}

export function source(gh = {}) {
  const npm = env.NPM_REGISTRY ?? 'https://registry.npmjs.org';
  const api = env.GITHUB_API_URL ?? 'https://api.github.com';
  const get = async (url, headers = {}) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  };
  const github = (path) =>
    get(`${api}${path}`, {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(env.GH_TOKEN ? { authorization: `Bearer ${env.GH_TOKEN}` } : {}),
    });
  const enc = (name) => name.replace('/', '%2f');
  return {
    version: (name, version) => get(`${npm}/${enc(name)}/${encodeURIComponent(version)}`),
    tags: (name) => get(`${npm}/-/package/${enc(name)}/dist-tags`),
    attestations: (name, version) =>
      get(`${npm}/-/npm/v1/attestations/${enc(name)}@${encodeURIComponent(version)}`),
    compare: (repo, commit) => github(`/repos/ai-ecoverse/${repo}/compare/main...${commit}`),
    commit: (repo, commit) => github(`/repos/ai-ecoverse/${repo}/commits/${commit}`),
    statuses: (repo, commit) =>
      github(`/repos/ai-ecoverse/${repo}/commits/${commit}/statuses?per_page=100`),
    checks: (repo, commit) =>
      github(
        `/repos/ai-ecoverse/${repo}/commits/${commit}/check-runs?check_name=cert-review&per_page=100`
      ),
    run: (repo, id) => github(`/repos/ai-ecoverse/${repo}/actions/runs/${id}`),
    suiteRuns: (repo, suite) =>
      github(`/repos/ai-ecoverse/${repo}/actions/runs?check_suite_id=${suite}`),
    exceptions: async () => {
      const { repo, path, ref } = HOMESCOOP.exceptions;
      if (!/^[0-9a-f]{40}$/.test(ref ?? '')) return null;
      const data = await github(`/repos/${repo}/contents/${path}?ref=${ref}`);
      if (!data?.content) return null;
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    },
    ...gh,
  };
}

export async function provenanceOf(src, name, version) {
  const data = await src.attestations(name, version);
  for (const a of data?.attestations ?? []) {
    if (!/slsa\.dev\/provenance/.test(a.predicateType ?? '')) continue;
    const statement = JSON.parse(
      Buffer.from(a.bundle.dsseEnvelope.payload, 'base64').toString('utf8')
    );
    const def = statement.predicate?.buildDefinition ?? {};
    const workflow = def.externalParameters?.workflow ?? {};
    return {
      repository: workflow.repository,
      path: workflow.path,
      ref: workflow.ref,
      commit: def.resolvedDependencies?.[0]?.digest?.gitCommit,
      builder: statement.predicate?.runDetails?.builder?.id,
      subjects: (statement.subject ?? []).map((s) => s.digest?.sha512).filter(Boolean),
    };
  }
  return null;
}

const CALLER = '.github/workflows/cert-review.yml';

export function upstreamRun(run, repo) {
  const full = `ai-ecoverse/${repo}`;
  const url = String(run?.workflow_url ?? '');
  const api = env.GITHUB_API_URL ?? 'https://api.github.com';
  return (
    (run?.path === CALLER || run?.path === `${CALLER}@refs/heads/main`) &&
    run.repository?.full_name === full &&
    [
      `${api}/repos/${full}/actions/workflows/`,
      `${api}/repos/${full}/actions/required_workflows/`,
    ].some((p) => url.startsWith(p))
  );
}

async function certifiedCommit(src, repo, commit) {
  for (const check of (await src.checks(repo, commit))?.check_runs ?? []) {
    if (check.app?.id !== 15368 || check.conclusion !== 'success') continue;
    const id = new RegExp(`^v2:[^:]+:${commit}:(\\d+):(\\d+)$`).exec(check.external_id ?? '')?.[1];
    const run = id ? await src.run(repo, id) : null;
    if (upstreamRun(run, repo) && run.event === 'merge_group' && run.head_sha === commit)
      return `cert-review check ${check.id}: ${check.output?.title ?? 'success'}`;
  }
  const status = ((await src.statuses(repo, commit)) ?? []).find(
    (s) => s.context === 'cert-review'
  );
  if (status?.state === 'success' && status.creator?.login === 'github-actions[bot]')
    return `cert-review status: ${status.description ?? 'success'}`;
  return null;
}

const ok = (why) => ({ ok: true, why });
const no = (why) => ({ ok: false, why });

async function byTag(src, name, version) {
  const tags = (await src.tags(name)) ?? {};
  if (tags.certified === version) return ok('certified (npm dist-tag certified), integrity bound');
  return no(
    `not certified: npm dist-tag certified is ${tags.certified ?? 'unset'}, not ${version}`
  );
}

function fromLadder(prov, bound) {
  return (
    bound &&
    prov.repository === HOMESCOOP.repository &&
    HOMESCOOP.workflows.includes(prov.path) &&
    prov.ref === 'refs/heads/main'
  );
}

function byHomescoop({ name, version, prov, bound, exceptions, pins }) {
  if (!fromLadder(prov, bound))
    return no(
      prov
        ? `provenance is ${prov.repository} ${prov.path} @ ${prov.ref}${bound ? '' : ' for another tarball'}, not homescoop's ladder at main`
        : 'no npm provenance, so not a homescoop ladder release'
    );
  const ruled = exceptionsFor(exceptions, name, version, pins);
  if (ruled.error || ruled.why) return no(ruled.error ?? ruled.why);
  return ok(
    `certified (homescoop ${prov.path.split('/').pop()} at main ${String(prov.commit).slice(0, 12)})`
  );
}

async function certifiedOrParent(src, repo, commit) {
  const found = await certifiedCommit(src, repo, commit);
  if (found) return { found, where: commit };
  const c = await src.commit(repo, commit);
  const parent = c?.parents?.[0]?.sha;
  if (!parent || c.parents.length !== 1 || !versionOnly(c)) return {};
  return { found: await certifiedCommit(src, repo, parent), where: parent };
}

async function byMain(src, { name, version, writer, prov, bound }) {
  const rule = STATUS_RULES[name.replace(/^@ai-ecoverse\//, '')];
  if (rule?.deny?.[version]) return no(`not certified: ${rule.deny[version]}`);
  if (writer.tag && (await byTag(src, name, version)).ok)
    return ok('certified (npm dist-tag certified), integrity bound');
  if (rule?.since && semver.lt(version, rule.since, SEMVER))
    return no(`not certified: ${rule.before}`);
  if (!prov) return no('no npm provenance');
  if (!bound) return no('the provenance names another tarball');
  const repoUrl = `https://github.com/ai-ecoverse/${writer.repo}`;
  if (
    prov.repository !== repoUrl ||
    prov.path !== '.github/workflows/release.yml' ||
    prov.ref !== 'refs/heads/main'
  )
    return no(
      `provenance is ${prov.repository} ${prov.path} @ ${prov.ref}, not ${writer.repo}'s release.yml at main`
    );
  const commit = prov.commit;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) return no('the provenance names no commit');
  const cmp = await src.compare(writer.repo, commit);
  if (!['identical', 'behind'].includes(cmp?.status))
    return no(`${writer.repo} ${commit.slice(0, 12)} is not on main (${cmp?.status ?? 'unknown'})`);
  const { found, where } = await certifiedOrParent(src, writer.repo, commit);
  if (!found)
    return no(
      `${writer.repo} ${commit.slice(0, 12)} on main carries no cert-review success (FAIL or missing upstream)`
    );
  return ok(`certified at ${writer.repo} ${where.slice(0, 12)}: ${found}`);
}

export async function judge(src, key, integrity, exceptions, pins = new Map()) {
  const at = key.lastIndexOf('@');
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  const writer = writerOf(name);
  const done = (r) => ({ key, ok: r.ok, line: `${key}: ${r.why}` });
  if (writer.kind === 'none') return done(no('no certification writer is known for this package'));
  const meta = await src.version(name, version);
  if (!meta) return done(no('not on the registry'));
  if (meta.dist?.integrity !== integrity)
    return done(
      no(`the registry's integrity ${meta.dist?.integrity} is not the lockfile's ${integrity}`)
    );
  if (writer.kind === 'tag') return done(await byTag(src, name, version));
  const prov = await provenanceOf(src, name, version);
  const bound = Boolean(prov?.subjects.includes(hexOf(integrity)));
  const ctx = { name, version, writer, prov, bound, exceptions, pins };
  return done(writer.kind === 'homescoop' ? byHomescoop(ctx) : await byMain(src, ctx));
}

const ENTRY_KEYS = new Set([
  'package',
  'versions',
  'range',
  'verdict',
  'requires',
  'issue',
  'ruling',
]);

function invalid(file) {
  const where = `homescoop's ${HOMESCOOP.exceptions.path}`;
  if (!file)
    return `${where} at the pinned ref could not be read (no pinned ref, missing or unparseable)`;
  const top = Object.keys(file).every((k) => k === 'schema' || k === 'entries');
  if (file.schema !== 1 || !Array.isArray(file.entries) || !top) return `${where} is not schema 1`;
  for (const e of file.entries) {
    const why = invalidEntry(e);
    if (why) return `${where}: ${why}`;
  }
  return null;
}

function invalidEntry(e) {
  if (!e || typeof e !== 'object' || Object.keys(e).some((k) => !ENTRY_KEYS.has(k)))
    return 'an entry has unknown keys';
  if (typeof e.package !== 'string' || 'versions' in e === 'range' in e)
    return 'an entry needs a package and exactly one of versions or range';
  if (
    'versions' in e &&
    !(Array.isArray(e.versions) && e.versions.every((v) => typeof v === 'string'))
  )
    return `${e.package} versions is not a list of strings`;
  if ('range' in e && !semver.validRange(e.range, { includePrerelease: true }))
    return `${e.package} range ${e.range} is not a semver range`;
  if (!['fail', 'requires'].includes(e.verdict))
    return `${e.package} verdict ${e.verdict} is unknown`;
  const reqs = e.requires && typeof e.requires === 'object' ? Object.keys(e.requires) : [];
  if (e.verdict === 'requires' && !reqs.length) return `${e.package} requires names nothing`;
  return null;
}

const SEMVER = { includePrerelease: true };

function unmet(e, pins) {
  for (const [dep, range] of Object.entries(e.requires)) {
    const have = [...pins.keys()]
      .filter((k) => k.slice(0, k.lastIndexOf('@')) === dep)
      .map((k) => k.slice(k.lastIndexOf('@') + 1));
    if (!have.length || !have.every((v) => semver.satisfies(v, range, SEMVER)))
      return `needs ${dep} ${range}, and bios pins ${have.join(', ') || 'none'}`;
  }
  return null;
}

export function exceptionsFor(file, name, version, pins) {
  const error = invalid(file);
  if (error) return { error };
  for (const e of file.entries) {
    if (e.package !== name) continue;
    if (!(e.versions ? e.versions.includes(version) : semver.satisfies(version, e.range, SEMVER)))
      continue;
    const ref = `${e.issue ?? 'no issue'}${e.ruling ? `, ${e.ruling}` : ''}`;
    if (e.verdict === 'fail') return { why: `uncertified by ruling (${ref})` };
    const why = unmet(e, pins);
    if (why) return { why: `${why} (${ref})` };
  }
  return {};
}

export function changes(baseLocked, headLocked, baseCerts, headCerts) {
  const out = new Map();
  for (const [key, integrity] of headLocked)
    if (baseLocked.get(key) !== integrity) out.set(key, { integrity, why: 'pin' });
  for (const [key, entry] of Object.entries(headCerts))
    if (JSON.stringify(baseCerts[key]) !== JSON.stringify(entry) && !out.has(key))
      out.set(key, { integrity: entry.integrity, why: 'certs.json line' });
  return out;
}

export async function releaseState({ cwd, base, head, src = source() }) {
  const problems = [];
  const headLocked = await lockedAt(cwd, head, problems);
  const found = changes(
    await lockedAt(cwd, base),
    headLocked,
    certsAt(cwd, base),
    certsAt(cwd, head)
  );
  if (problems.length)
    return {
      ok: false,
      line: `release-state: FAIL ${problems.slice(0, 10).join('; ')} (an @ai-ecoverse lockfile entry must resolve to a registry tarball with its integrity)`,
      rows: [],
    };
  if (!found.size)
    return {
      ok: true,
      line: 'release-state: PASS no gated pin or certs.json line changes',
      rows: [],
    };
  let exceptions;
  const needs = [...found.keys()].some(
    (k) => writerOf(k.slice(0, k.lastIndexOf('@'))).kind === 'homescoop'
  );
  if (needs) exceptions = await src.exceptions().catch(() => null);
  const rows = [];
  for (const [key, { integrity, why }] of found) {
    try {
      rows.push({ ...(await judge(src, key, integrity, exceptions, headLocked)), why });
    } catch (err) {
      rows.push({ key, why, ok: false, line: `${key}: INCOMPLETE ${err.message}` });
    }
  }
  const bad = rows.filter((r) => !r.ok);
  return {
    ok: bad.length === 0,
    line: bad.length
      ? `release-state: FAIL ${bad.map((r) => r.line).join('; ')}`
      : `release-state: PASS ${rows.map((r) => r.line).join('; ')}`,
    rows,
  };
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      out: { type: 'string' },
      'no-fail': { type: 'boolean', default: false },
    },
  });
  let r;
  if (!values.base)
    r = { ok: true, line: 'release-state: PASS this run has no base to compare', rows: [] };
  else r = await releaseState({ cwd: process.cwd(), base: values.base, head: values.head });
  console.log(r.line);
  for (const row of r.rows) console.log(`  ${row.ok ? 'ok  ' : 'FAIL'} ${row.line} (${row.why})`);
  if (!r.ok)
    console.log(
      'A gated pin reaches seven only as a release its repository certified: pin the certified version, or wait for its repository to certify this one.'
    );
  if (values.out) {
    await mkdir(dirname(values.out), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(r, null, 2)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${r.line}\n`);
  if (!r.ok && !values['no-fail']) exit(1);
}
