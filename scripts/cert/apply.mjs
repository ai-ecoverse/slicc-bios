#!/usr/bin/env node
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { claims, verdictOf, verify } from './verify.mjs';

export const GATED =
  /^@ai-ecoverse\/(slicc-kernel|slicc-cdp|slicc-clipboard|slicc-jsh|mcpcat$|wasi-|wasix-|wasm-|py-)/;

const PNPM =
  /^ {2}'?(@ai-ecoverse\/[^@'\s]+)@([^'(\s]+)'?:\n {4}resolution: \{integrity: ([^,}\s]+)/gm;

export async function locked(packages) {
  const found = new Map();
  const text = (file) => readFile(join(packages, file), 'utf8').catch(() => null);
  for (const file of [
    'package-lock.json',
    'optional/package-lock.json',
    'agent/package-lock.json',
  ]) {
    const lock = await text(file);
    for (const [path, entry] of Object.entries(lock ? JSON.parse(lock).packages : {})) {
      const name = path.split('node_modules/').at(-1);
      if (path && GATED.test(name)) found.set(`${name}@${entry.version}`, entry.integrity);
    }
  }
  const projects = await readdir(join(packages, 'optional/projects')).catch(() => []);
  for (const file of [
    'pnpm-lock.yaml',
    'agent/pnpm-lock.yaml',
    'tailscale/pnpm-lock.yaml',
    ...projects.map((id) => `optional/projects/${id}/pnpm-lock.yaml`),
  ]) {
    for (const [, name, version, integrity] of ((await text(file)) ?? '').matchAll(PNPM))
      if (GATED.test(name)) found.set(`${name}@${version}`, integrity);
  }
  return found;
}

export function additions(text, certs, pinned) {
  const added = {};
  for (const { name, version, sha256, integrity } of claims(text)) {
    const key = `${name}@${version}`;
    if (certs[key] || integrity.length !== 1 || sha256.length !== 1) continue;
    if (pinned.get(key) !== integrity[0]) continue;
    added[key] = { integrity: integrity[0], sha256: sha256[0] };
  }
  return added;
}

export async function apply({ verdict, packages, lookup }) {
  const text = await readFile(verdict, 'utf8').catch(() => '');
  const { problems } = text.trim() ? await verify(text, lookup) : { problems: [] };
  const { ok, line } = verdictOf(text, problems);
  if (!ok) return { ok: false, line: `cert-apply: FAIL ${line}`, added: [] };
  const path = join(packages, 'certs.json');
  const certs = JSON.parse(await readFile(path, 'utf8'));
  const added = additions(text, certs, await locked(packages));
  const keys = Object.keys(added);
  if (keys.length) await writeFile(path, `${JSON.stringify({ ...certs, ...added }, null, 2)}\n`);
  return {
    ok: true,
    line: keys.length ? `cert-apply: ADDED ${keys.join(', ')}` : 'cert-apply: NOTHING to add',
    added: keys,
  };
}

if (import.meta.url === `file://${argv[1]}`) {
  const [verdict, packages] = argv.slice(2);
  const result = await apply({ verdict, packages }).catch((error) => ({
    ok: false,
    line: `cert-apply: FAIL ${error.message}`,
    added: [],
  }));
  console.log(result.line);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `added=${result.added.length > 0}\n`);
  if (!result.ok) exit(1);
}
