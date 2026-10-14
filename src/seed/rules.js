const rulePaths = ['/etc/fnox', '/etc/fnox/config.toml', '/etc/slicc/secrets-policy.toml'];
const ruleParents = ['/', '/etc', '/etc/slicc'];
function absolute(cwd, word) {
  const parts = [];
  for (const part of `${word.startsWith('/') ? '' : cwd}/${word}`.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
    const alias = parts.join('/').match(/^proc\/([^/]+)\/(?:task\/[^/]+\/)?(root|cwd)$/);
    if (alias?.[2] === 'root') parts.length = 0;
    else if (alias && /^(?:self|thread-self)$/.test(alias[1]))
      parts.splice(0, parts.length, ...cwd.split('/').filter(Boolean));
  }
  return `/${parts.join('/')}`;
}
function pattern(path) {
  const source = path
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*');
  return new RegExp(`^${source}$`);
}
const opaque = /^\/(?:proc\/[^/]+\/(?:task\/[^/]+\/)?(?:cwd|fd|map_files)|dev\/fd)(?:\/|$)/;
const readOnly = [
  'cat',
  'cd',
  'df',
  'diff',
  'du',
  'echo',
  'file',
  'grep',
  'head',
  'ls',
  'pwd',
  'readlink',
  'realpath',
  'stat',
  'tail',
  'tree',
  'wc',
];
function candidates(word) {
  if (word === '--') return [];
  if (word.startsWith('--')) return [word];
  if (!word.startsWith('-')) return [word];
  const slash = word.indexOf('/');
  const cluster = Array.from(word.slice(2), (_whole, index) => word.slice(index + 2));
  return [...cluster, ...(slash > 2 ? [word.slice(slash)] : [])];
}
function protects(path, whole) {
  const inside = (candidate) => candidate === '/etc/fnox' || candidate.startsWith('/etc/fnox/');
  if (opaque.test(path)) return true;
  if (/[[{$]/.test(path)) {
    const prefix = path.slice(0, path.search(/[*?[{$]/));
    return inside(prefix) || rulePaths.some((rule) => rule.startsWith(prefix));
  }
  if (!/[*?]/.test(path))
    return inside(path) || rulePaths.includes(path) || (whole && ruleParents.includes(path));
  const glob = pattern(path);
  const top = path.split('/').slice(0, 3).join('/');
  return (
    rulePaths.some((rule) => glob.test(rule)) ||
    (top !== path && pattern(top).test('/etc/fnox')) ||
    (whole && ruleParents.some((parent) => glob.test(parent)))
  );
}
const command = (word) => word.split('/').pop() ?? '';
const trusted = (word) => readOnly.includes(word.replace(/^\/(?:usr\/)?bin\/(?=[^/]+$)/, ''));
const expansion = /\$\([^)]*\)?|\$\{[^}]*\}?|\$[\w@*#?$!-]*|`[^`]*`?/;
function moved(cwds, word) {
  for (const cwd of [...cwds]) {
    const next = absolute(cwd, word);
    if (protects(next, false) || cwds.size >= 64) return next;
    cwds.add(next);
  }
  return null;
}
function touched(cwds, word, whole) {
  for (const candidate of candidates(word))
    for (const cwd of cwds) {
      const path = absolute(cwd, candidate);
      if (protects(path, whole)) return path;
    }
  return null;
}
function ansi(command) {
  const escape =
    /\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3})|([\s\S]))/g;
  return command
    .replace(
      /\$'((?:[^'\\]|\\[\s\S])*)'/g,
      (_whole, body) =>
        `'${body
          .replace(escape, (_match, hex, short, long, octal, plain) => {
            if (octal) return String.fromCharCode(Number.parseInt(octal, 8));
            if (plain) return plain;
            return String.fromCodePoint(
              Math.min(Number.parseInt(hex ?? short ?? long, 16), 1114111)
            );
          })
          .replace(/'/g, "'\\''")}'`
    )
    .replace(/\$"/g, '"');
}
function unglob(command) {
  const chars = Array.from(command);
  const close = new Map();
  const open = [];
  for (const [index, char] of chars.entries()) {
    if (char === '(') open.push(index);
    else if (char === ')' && open.length) close.set(open.pop(), index);
  }
  const out = [];
  for (let index = 0; index < chars.length; index++) {
    const end = close.get(index);
    if (end !== void 0 && /^[?*+@!]$/.test(out.at(-1) ?? '')) {
      out[out.length - 1] = '*';
      index = end;
    } else out.push(chars[index]);
  }
  return out.join('');
}
const separators = /[;&|\n()`]/;
function hide(char) {
  return separators.test(char) ? String.fromCharCode(57344 + char.charCodeAt(0)) : char;
}
function unshield(segment) {
  return segment.replace(/[\ue000-\ue07f]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 57344)
  );
}
function shield(text) {
  let out = '';
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === '"' && char === '\\') out += hide(char) + hide(text[++index] ?? '');
    else if (quote) {
      out += char === quote ? char : hide(char);
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"') {
      quote = char;
      out += char;
    } else if (char === '\\') out += char + hide(text[++index] ?? '');
    else out += char;
  }
  return out;
}
function quoted(segment) {
  const words = [];
  let word = '';
  let quote = '';
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];
    if (quote === '"' && char === '\\' && /["\\$`\n]/.test(segment[index + 1] ?? ''))
      word += segment[++index];
    else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === '\\') word += segment[++index] ?? '';
    else if (/[\s<>=]/.test(char)) {
      words.push(word);
      word = '';
    } else word += char;
  }
  return [...words, word];
}
function commas(words) {
  return words
    .flatMap((word) => (word.includes(',') ? [word, ...word.split(',')] : [word]))
    .filter(Boolean);
}
function scan(words, cwds, whole) {
  let cd = false;
  for (const [index, word] of words.entries()) {
    let hit = null;
    if (index === 0 || words[index - 1] === '-c') {
      cd = ['cd', 'pushd'].includes(command(word));
      hit = touched(cwds, word, whole);
    } else if (!cd) hit = touched(cwds, word, whole);
    else if (!word.startsWith('-')) {
      cd = false;
      hit = moved(cwds, word);
    }
    if (hit) return hit;
  }
  return null;
}
export function dialogRules(approval) {
  if (approval.command.length > 4096) return `${approval.command.slice(0, 40)}\u2026`;
  const start = absolute('/', approval.cwd ?? '/');
  if (protects(start, false)) return start;
  const cwds = new Set([start]);
  const text = unglob(ansi(approval.command.replace(/\\\n/g, '')));
  const plain = text
    .split(separators)
    .map((segment) => commas(segment.split(/[\s<>=]+/).map((word) => word.replace(/['"\\]/g, ''))));
  const aware = shield(text)
    .split(separators)
    .map((segment) => commas(quoted(unshield(segment))));
  const segments = JSON.stringify(aware) === JSON.stringify(plain) ? plain : [...plain, ...aware];
  const whole = segments.some((words) => words.length > 0 && !trusted(words[0]));
  for (const words of segments) {
    const hit = scan(words, cwds, whole);
    if (hit) return hit;
  }
  const named = segments
    .flat()
    .find((word) => !word.startsWith('/') && /fnox|secrets-policy/.test(word));
  if (named) return absolute([...cwds].pop() ?? start, named);
  const home = segments.flat().find((word) => /^~(?:[+-](?:\/|$)|.*\/\.\.(?:\/|$))/.test(word));
  if (home) return home;
  return segments.flat().some((word) => word.includes('$')) || text.includes('`')
    ? text.match(expansion)[0]
    : null;
}
