import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { compare } from './plan.mjs';

export const ENFORCE_SINCE = '1.78.0';

const OPEN = { '(': ')', '{': '}', '[': ']' };
const QUOTES = new Set(["'", '"', '`']);

function skip(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === quote) return j;
  }
  return text.length;
}

function topLevel(text, open) {
  const parts = [];
  const stack = [];
  let from = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (QUOTES.has(c)) i = skip(text, i);
    else if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (!stack.length) {
        parts.push(text.slice(from, i));
        return parts;
      }
    } else if (c === ',' && stack.length === 1) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  return parts;
}

function mode(parts) {
  for (const part of parts.map((text) => text.trim())) {
    const literal = /^(['"]?)users\1\s*:\s*(['"`])([^'"`]*)\2\s*$/.exec(part);
    if (literal) return literal[3];
    if (/^(['"]?)users\1\s*(:|$)/.test(part)) return 'dynamic';
    if (/^\.\.\./.test(part) && /users/i.test(part)) return 'dynamic';
  }
  return null;
}

export function kernelCalls(text) {
  return [...text.matchAll(/\bcreateKernel\(\s*/g)].map((match) => {
    const at = match.index + match[0].length;
    const users = text[at] === '{' ? mode(topLevel(text, at)) : 'dynamic';
    return { line: text.slice(0, match.index).split('\n').length, users };
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

export function atLeast(version, floor) {
  return compare(version, floor) >= 0;
}

export function enforceNote(overrides, kernels) {
  const kernel = overrides.find(({ name }) => name === '@ai-ecoverse/slicc-kernel');
  if (!kernel || !atLeast(kernel.version, ENFORCE_SINCE) || !kernels) return null;
  const bare = kernels.filter(({ users }) => users === null);
  if (!bare.length) return null;
  const where = bare.map(({ file, line }) => `${file}:${line}`).join(', ');
  return `This bios ref creates its kernel with no users mode (${where}), so slicc-kernel ${kernel.version} runs under its default, enforce. Expect \`i\`, \`npm\` and \`npx\` by path to fail with exit 126 (kernel #495) until the BIOS installer keeps file modes (#405): that's this ref's setup, not a new kernel bug.`;
}
