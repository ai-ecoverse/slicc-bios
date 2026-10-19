import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const GATED =
  /^@ai-ecoverse\/(slicc-kernel|slicc-cdp|slicc-clipboard|slicc-jsh|mcpcat$|wasi-|wasix-|wasm-|py-)/;

const PNPM =
  /^ {2}'?(@ai-ecoverse\/[^@'\s]+)@([^'(\s]+)'?:\n {4}resolution: \{integrity: ([^,}\s]+)/gm;

export const NPM_LOCKS = [
  'package-lock.json',
  'optional/package-lock.json',
  'agent/package-lock.json',
];
export const PNPM_LOCKS = ['pnpm-lock.yaml', 'agent/pnpm-lock.yaml', 'tailscale/pnpm-lock.yaml'];

export async function lockedFrom(text, projects) {
  const found = new Map();
  for (const file of NPM_LOCKS) {
    const lock = await text(file);
    for (const [path, entry] of Object.entries(lock ? JSON.parse(lock).packages : {})) {
      const name = path.split('node_modules/').at(-1);
      if (path && GATED.test(name)) found.set(`${name}@${entry.version}`, entry.integrity);
    }
  }
  for (const file of [
    ...PNPM_LOCKS,
    ...(await projects()).map((id) => `optional/projects/${id}/pnpm-lock.yaml`),
  ])
    for (const [, name, version, integrity] of ((await text(file)) ?? '').matchAll(PNPM))
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

export function lockedAt(cwd, ref) {
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
    }
  );
}

export function certsAt(cwd, ref) {
  const text = show(cwd, ref, 'src/packages/certs.json');
  return text ? JSON.parse(text) : {};
}
