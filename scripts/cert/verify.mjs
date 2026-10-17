#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { argv, exit } from 'node:process';

const pkg = '(@ai-ecoverse/[a-z0-9._-]+)@([0-9A-Za-z.+-]+)';
const result = new RegExp(`^(?:certified|cert-ci: PASS) ${pkg} sha256=([0-9a-f]{64})\\b`, 'gm');
const entry = new RegExp(
  `^certs\\.json: "${pkg}": \\{ "integrity": "(sha512-[A-Za-z0-9+/=]+)", "sha256": "([0-9a-f]{64})" \\}`,
  'gm'
);

export function claims(text) {
  const found = new Map();
  const at = (name, version) => {
    const key = `${name}@${version}`;
    if (!found.has(key)) found.set(key, { name, version, sha256: new Set(), integrity: new Set() });
    return found.get(key);
  };
  for (const [, name, version, sha256] of text.matchAll(result))
    at(name, version).sha256.add(sha256);
  for (const [, name, version, integrity, sha256] of text.matchAll(entry)) {
    const claim = at(name, version);
    claim.integrity.add(integrity);
    claim.sha256.add(sha256);
  }
  return [...found.values()].map(({ name, version, sha256, integrity }) => ({
    name,
    version,
    sha256: [...sha256],
    integrity: [...integrity],
  }));
}

const REVIEW = new RegExp(`^\\*\\*Cert review: ${pkg}\\*\\*`, 'gm');
const PASSED = new RegExp(`^(?:certified|cert-ci: PASS) ${pkg} sha256=[0-9a-f]{64}\\b`, 'gm');
const FAILED = new RegExp(`^cert-ci: FAIL ${pkg}:`, 'gm');

export function verdictOf(text, problems = []) {
  const ids = (re) =>
    new Set([...text.matchAll(re)].map(([, name, version]) => `${name}@${version}`));
  const reviewed = ids(REVIEW);
  const passed = ids(PASSED);
  const failed = ids(FAILED);
  const named = new Set([...reviewed, ...passed, ...failed]);
  if (!named.size) return { ok: false, line: 'cert-review: FAIL no verdict' };
  const why = [];
  for (const id of named) {
    if (failed.has(id)) why.push(`${id} FAIL`);
    else if (!passed.has(id)) why.push(`${id} has no certified or cert-ci line`);
  }
  if (problems.length) why.push(`sha check: ${problems.join('; ')}`);
  if (why.length) return { ok: false, line: `cert-review: FAIL ${why.join(', ')}` };
  return { ok: true, line: `cert-review: CERTIFIED ${[...named].sort().join(', ')}` };
}

export async function registry(name, version, fetcher = fetch) {
  const meta = await (await fetcher(`https://registry.npmjs.org/${name}/${version}`)).json();
  const response = await fetcher(meta.dist.tarball);
  if (!response.ok) throw new Error(`${name}@${version}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    published: meta.dist.integrity,
  };
}

export async function verify(text, lookup = registry) {
  const problems = [];
  const listed = claims(text);
  for (const claim of listed) {
    const actual = await lookup(claim.name, claim.version);
    const id = `${claim.name}@${claim.version}`;
    if (actual.integrity !== actual.published)
      problems.push(`${id}: the tarball doesn't match the registry's integrity`);
    for (const sha256 of claim.sha256) {
      if (sha256 !== actual.sha256)
        problems.push(`${id}: sha256 ${sha256} is not the tarball's ${actual.sha256}`);
    }
    for (const integrity of claim.integrity) {
      if (integrity !== actual.integrity)
        problems.push(`${id}: integrity ${integrity} is not the tarball's`);
    }
  }
  return { checked: listed.map((claim) => `${claim.name}@${claim.version}`), problems };
}

if (import.meta.url === `file://${argv[1]}`) {
  if (argv[2] === '--verdict') {
    const text = await readFile(argv[3], 'utf8').catch(() => '');
    const { problems } = text.trim() ? await verify(text) : { problems: [] };
    const { ok, line } = verdictOf(text, problems);
    console.log(line);
    if (!ok) exit(1);
  } else {
    const { checked, problems } = await verify(await readFile(argv[2], 'utf8'));
    console.log(`checked: ${checked.join(', ') || 'nothing'}`);
    if (problems.length) {
      console.error(problems.join('\n'));
      exit(1);
    }
  }
}
