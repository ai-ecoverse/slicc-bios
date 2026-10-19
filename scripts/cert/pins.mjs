import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const GATED =
  /^@ai-ecoverse\/(slicc-kernel|slicc-cdp|slicc-clipboard|slicc-jsh|mcpcat$|wasi-|wasix-|wasm-|py-)/;

export const NPM_LOCKS = [
  'package-lock.json',
  'optional/package-lock.json',
  'agent/package-lock.json',
];
export const PNPM_LOCKS = ['pnpm-lock.yaml', 'agent/pnpm-lock.yaml', 'tailscale/pnpm-lock.yaml'];

const KEY = /^ {2}['"]?(@ai-ecoverse\/[^@'"\s]+)@([^'"(\s:]+)/;
const REGISTRY = /^https:\/\/registry\.npmjs\.org\//;

export function pnpmEntries(text, file, problems) {
  const found = [];
  const lines = (text ?? '').split('\n');
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const top = /^(\w[\w-]*):\s*$/.exec(lines[i]);
    if (top) section = top[1];
    if (section !== 'packages') continue;
    const key = KEY.exec(lines[i]);
    if (!key) continue;
    let block = '';
    for (let j = i + 1; j < lines.length && /^ {4,}|^\s*$/.test(lines[j]); j++)
      block += `${lines[j]}\n`;
    const integrity = /\bintegrity: ([^,}\s]+)/.exec(block)?.[1];
    if (!integrity || /\btarball:/.test(block))
      problems.push(`${file}: ${key[1]}@${key[2]} has no registry integrity`);
    else found.push([key[1], key[2], integrity]);
  }
  return found;
}

export function npmEntries(text, file, problems) {
  const found = [];
  for (const [path, entry] of Object.entries(text ? (JSON.parse(text).packages ?? {}) : {})) {
    if (!path) continue;
    const name = entry.name ?? path.split('node_modules/').at(-1);
    const scoped = name.startsWith('@ai-ecoverse/') || path.includes('node_modules/@ai-ecoverse/');
    if (!scoped) continue;
    if (!entry.integrity || (entry.resolved && !REGISTRY.test(entry.resolved)) || entry.link)
      problems.push(
        `${file}: ${name}@${entry.version} is not a registry tarball with an integrity`
      );
    else found.push([name, entry.version, entry.integrity]);
  }
  return found;
}

export async function lockedFrom(text, projects, problems = []) {
  const found = new Map();
  for (const file of NPM_LOCKS)
    for (const [name, version, integrity] of npmEntries(await text(file), file, problems))
      if (GATED.test(name)) found.set(`${name}@${version}`, integrity);
  for (const file of [
    ...PNPM_LOCKS,
    ...(await projects()).map((id) => `optional/projects/${id}/pnpm-lock.yaml`),
  ])
    for (const [name, version, integrity] of pnpmEntries(await text(file), file, problems))
      if (GATED.test(name)) found.set(`${name}@${version}`, integrity);
  return found;
}

export function locked(packages) {
  return lockedFrom(
    (file) => readFile(join(packages, file), 'utf8').catch(() => null),
    () => readdir(join(packages, 'optional/projects')).catch(() => [])
  );
}

const show = (cwd, ref, path) => {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};

export function lockedAt(cwd, ref, problems) {
  return lockedFrom(
    async (file) => show(cwd, ref, `src/packages/${file}`),
    async () => {
      try {
        return execFileSync(
          'git',
          ['ls-tree', '--name-only', `${ref}:src/packages/optional/projects`],
          {
            cwd,
            encoding: 'utf8',
          }
        )
          .split('\n')
          .filter(Boolean);
      } catch {
        return [];
      }
    },
    problems
  );
}

export function certsAt(cwd, ref) {
  const text = show(cwd, ref, 'src/packages/certs.json');
  return text ? JSON.parse(text) : {};
}
