import { readFileSync } from 'node:fs';
import { MIN_EXTENSION_VERSION } from '../../src/seed/extension.js';

export const ROUTES = ['devtools', 'extension', 'link'];

export function guardRoute(kind, { version } = {}) {
  if (!ROUTES.includes(kind))
    throw new Error(`a test guard needs its route (devtools, extension or link), got ${kind}`);
  if (kind === 'devtools') return undefined;
  const stated = version ?? (kind === 'extension' ? MIN_EXTENSION_VERSION : undefined);
  if (typeof stated !== 'string' || !stated)
    throw new Error(`the ${kind} route needs the version its host states`);
  return { kind, version: stated };
}

const TRANSPORT = /extensionConnection\(|sliccLinkedBrowsers|\blinked\b|\.open\(\)/;

function calls(source) {
  const found = [];
  for (const match of source.matchAll(/guardProtected\(/g)) {
    if (/function\s*$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const inside = source.slice(match.index + match[0].length, end);
    const args = [];
    let level = 0;
    let start = 0;
    for (let index = 0; index < inside.length; index += 1) {
      const char = inside[index];
      if ('([{'.includes(char)) level += 1;
      else if (')]}'.includes(char)) level -= 1;
      else if (char === ',' && level === 0) {
        args.push(inside.slice(start, index).trim());
        start = index + 1;
      }
    }
    args.push(inside.slice(start).trim());
    found.push({
      line: source.slice(0, match.index).split('\n').length,
      args: args.filter(Boolean),
    });
  }
  return found;
}

export function routeGaps(files) {
  const gaps = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!TRANSPORT.test(source)) continue;
    for (const { line, args } of calls(source)) {
      if (args.length < 4 || args[3] === 'undefined') gaps.push(`${file.split('/').pop()}:${line}`);
    }
  }
  return gaps;
}
