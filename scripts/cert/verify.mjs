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
  const { checked, problems } = await verify(await readFile(argv[2], 'utf8'));
  console.log(`checked: ${checked.join(', ') || 'nothing'}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    exit(1);
  }
}
