import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const ENFORCE_SINCE = '1.78.0';

function call(text, start) {
  let depth = 0;
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

export function kernelCalls(text) {
  return [...text.matchAll(/\bcreateKernel\(/g)].map((match) => {
    const args = call(text, match.index);
    const mode = /\busers\s*:\s*(['"`])([^'"`]*)\1/.exec(args)?.[2];
    const named = /\busers\s*[:,}]|\.\.\.\s*[\w.]*users/i.test(args);
    return {
      line: text.slice(0, match.index).split('\n').length,
      users: mode ?? (named ? 'dynamic' : null),
    };
  });
}

async function scripts(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') found.push(...(await scripts(path)));
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found.sort();
}

export async function usersModes(root) {
  const found = [];
  for (const file of await scripts(join(root, 'src'))) {
    for (const entry of kernelCalls(await readFile(file, 'utf8'))) {
      found.push({ file: relative(root, file), ...entry });
    }
  }
  return found;
}

function parts(version) {
  return version.split('-')[0].split('.').map(Number);
}

export function atLeast(version, floor) {
  const [x, y] = [parts(version), parts(floor)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
}

export function enforceNote(overrides, kernels) {
  const kernel = overrides.find(({ name }) => name === '@ai-ecoverse/slicc-kernel');
  if (!kernel || !atLeast(kernel.version, ENFORCE_SINCE) || !kernels) return null;
  const bare = kernels.filter(({ users }) => users === null);
  if (!bare.length) return null;
  const where = bare.map(({ file, line }) => `${file}:${line}`).join(', ');
  return `This bios ref creates its kernel with no users mode (${where}), so slicc-kernel ${kernel.version} runs under its default, enforce. Expect \`i\`, \`npm\` and \`npx\` by path to fail with exit 126 (kernel #495) until the BIOS installer keeps file modes (#405): that's this ref's setup, not a new kernel bug.`;
}
