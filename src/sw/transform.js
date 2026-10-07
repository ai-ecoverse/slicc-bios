import { NODE_STUBS } from './resolve.js';
import { scan } from './scan.js';

const identifier = /^[A-Za-z_$][\w$]*$/;
export const reserved = new Set(
  'await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval'.split(
    ' '
  )
);

function namespaceMembers(source, clause) {
  const namespace = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/)?.[1];
  if (!namespace) return [];
  const access = new RegExp(
    `(?<![\\w$.])${namespace.replaceAll('$', '\\$')}\\.([A-Za-z_$][\\w$]*)`,
    'g'
  );
  return [...new Set([...source.matchAll(access)].map((match) => match[1]))];
}

function clauseNames(list) {
  return list.split(',').map((part) =>
    part
      .trim()
      .replace(/^type\s+/, '')
      .split(/\s+as\s+/)[0]
      .trim()
  );
}

export function importedNames(source, entry) {
  const clause = source.slice(entry.statement, entry.start);
  if (!/^(import|export)\b/.test(clause)) return [];
  const braces = clause.match(/\{([^}]*)\}/);
  const named = braces ? clauseNames(braces[1]) : [];
  const members = clause.startsWith('import') ? namespaceMembers(source, clause) : [];
  return [...named, ...members].filter((name) => identifier.test(name) && !reserved.has(name));
}

function located(target, base) {
  return /^(data|blob|https?):/.test(target) ? target : `${base}${target}`;
}

export function exportNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(match[1]);
  for (const match of source.matchAll(
    /defineProperty\(\s*exports\s*,\s*["']([A-Za-z_$][\w$]*)["']/g
  )) {
    names.add(match[1]);
  }
  names.delete('__esModule');
  return [...names].filter((name) => !reserved.has(name));
}

export function requires(source) {
  return [
    ...new Set(
      [...source.matchAll(/\brequire\(\s*(["'])([^"'\n]+)\1\s*\)/g)].map((match) => match[2])
    ),
  ];
}

function looksCommonJs(path, source) {
  if (path.endsWith('.cjs')) return true;
  return /\b(require\(|module\.exports|exports\.[A-Za-z_$])/.test(source);
}

async function wrap(path, source, resolve, base) {
  const ids = requires(source);
  const lines = [];
  const table = [];
  for (const [index, id] of ids.entries()) {
    const target = await resolve(id, path);
    if (!target) continue;
    const url = target.startsWith(NODE_STUBS) ? `${base}${target}` : located(target, base);
    if (target.endsWith('.json')) {
      lines.push(`import __slicc_${index} from ${JSON.stringify(url)} with { type: 'json' };`);
      table.push(`${JSON.stringify(id)}: { __slicc_cjs: true, default: __slicc_${index} }`);
    } else {
      lines.push(`import * as __slicc_${index} from ${JSON.stringify(url)};`);
      table.push(`${JSON.stringify(id)}: __slicc_${index}`);
    }
  }
  const names = exportNames(source);
  return [
    ...lines,
    `const __slicc_required = {${table.join(', ')}};`,
    'const require = (id) => { const found = __slicc_required[id]; if (!found) throw new Error(`Cannot require ${id} in the browser`); return found.__slicc_cjs ? found.default : found; };',
    'const module = { exports: {} };',
    `(function (module, exports, require) {\n${source}\n}).call(module.exports, module, module.exports, require);`,
    'export default module.exports;',
    'export const __slicc_cjs = true;',
    ...names.map((name) => `export const ${name} = module.exports.${name};`),
  ].join('\n');
}

function needsJsonType(source, entry, target) {
  return (
    !entry.dynamic &&
    target.endsWith('.json') &&
    !/^\s*(with|assert)\b/.test(source.slice(entry.end + 1, entry.end + 40))
  );
}

export async function transform(path, source, { resolve, base = '' }) {
  const { imports, module } = scan(source);
  if (!module && imports.length === 0 && looksCommonJs(path, source))
    return wrap(path, source, resolve, base);
  let out = '';
  let at = 0;
  for (const entry of imports) {
    const target = await resolve(entry.value, path);
    if (!target) continue;
    let url = located(target, base);
    if (target.startsWith(NODE_STUBS)) {
      const names = importedNames(source, entry);
      url = `${base}${target}${names.length ? `?names=${names.join(',')}` : ''}`;
    }
    out += source.slice(at, entry.start) + url;
    at = entry.end;
    if (needsJsonType(source, entry, target)) {
      out += `${source[at]} with { type: 'json' }`;
      at += 1;
    }
  }
  return out + source.slice(at);
}
