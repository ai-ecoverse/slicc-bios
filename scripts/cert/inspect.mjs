#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { argv, exit } from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const usage = 'usage: inspect.mjs <name>@<version> [--against <version>]';

export function parse(args) {
  const [spec, flag, against] = args;
  const at = spec?.lastIndexOf('@') ?? -1;
  if (!spec || at <= 0) throw new Error(usage);
  if (flag && (flag !== '--against' || !against)) throw new Error(usage);
  return { name: spec.slice(0, at), version: spec.slice(at + 1), against: against ?? null };
}

async function view(name, version) {
  const { stdout } = await run('npm', ['view', `${name}@${version}`, '--json'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function tarball(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function provenance(attestations) {
  if (!attestations?.url) return null;
  const response = await fetch(attestations.url);
  if (!response.ok) return { error: `HTTP ${response.status}` };
  const { attestations: list = [] } = await response.json();
  return list.map(({ predicateType, bundle }) => {
    const payload = bundle?.dsseEnvelope?.payload;
    if (!payload) return { predicateType };
    const statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const build = statement.predicate?.buildDefinition;
    const workflow = build?.externalParameters?.workflow;
    const source = build?.resolvedDependencies?.[0];
    return {
      predicateType,
      workflow: workflow ? `${workflow.repository}/${workflow.path}@${workflow.ref}` : null,
      commit: source?.digest?.gitCommit ?? null,
      builder: statement.predicate?.runDetails?.builder?.id ?? null,
    };
  });
}

async function certified(name) {
  try {
    const certs = JSON.parse(
      await readFile(new URL('../../src/packages/certs.json', import.meta.url), 'utf8')
    );
    return Object.entries(certs)
      .filter(([key]) => key.startsWith(`${name}@`))
      .map(([key, value]) => ({
        version: key.slice(name.length + 1),
        sha256: value.sha256 ?? null,
      }));
  } catch {
    return [];
  }
}

async function difference(name, from, to) {
  const spec = (version) => `${name}@${version}`;
  const names = await run(
    'npm',
    ['diff', `--diff=${spec(from)}`, `--diff=${spec(to)}`, '--diff-name-only'],
    {
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  const full = await run('npm', ['diff', `--diff=${spec(from)}`, `--diff=${spec(to)}`], {
    maxBuffer: 512 * 1024 * 1024,
  });
  const dir = new URL('../../artifacts/cert/', import.meta.url);
  await mkdir(dir, { recursive: true });
  const file = new URL(`${name.replace(/[@/]/g, '_')}-${from}-${to}.diff`, dir);
  await writeFile(file, full.stdout);
  return {
    files: names.stdout.split('\n').filter(Boolean),
    diff: file.pathname,
    bytes: full.stdout.length,
  };
}

export async function inspect({ name, version, against }) {
  const meta = await view(name, version);
  const bytes = await tarball(meta.dist.tarball);
  const integrity = integrityOf(bytes);
  return {
    name,
    version,
    tarball: meta.dist.tarball,
    size: bytes.length,
    sha256: sha256Of(bytes),
    integrity,
    integrityMatches: integrity === meta.dist.integrity,
    gitHead: meta.gitHead ?? null,
    repository: meta.repository?.url ?? null,
    published: meta.time?.[version] ?? null,
    scripts: Object.keys(meta.scripts ?? {}).filter((key) => /install|prepare/.test(key)),
    engines: meta.engines ?? null,
    provenance: await provenance(meta.dist.attestations),
    certified: await certified(name),
    against: against ? await difference(name, against, version) : null,
  };
}

if (import.meta.url === `file://${argv[1]}`) {
  try {
    console.log(JSON.stringify(await inspect(parse(argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error.message);
    exit(1);
  }
}
