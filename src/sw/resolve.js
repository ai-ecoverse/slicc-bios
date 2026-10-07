const builtins = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'sqlite',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

export const NODE_STUBS = '/__slicc/node/';
export const conditions = ['browser', 'import', 'module', 'default'];

export function dirname(path) {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

export function join(base, relative) {
  const parts = base.split('/');
  for (const part of relative.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/') || '/';
}

export function builtin(specifier) {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return specifier.startsWith('node:') || builtins.has(name.split('/')[0]) ? name : undefined;
}

function splitBare(specifier) {
  const parts = specifier.split('/');
  const size = specifier.startsWith('@') ? 2 : 1;
  const subpath = parts.slice(size).join('/');
  return { name: parts.slice(0, size).join('/'), subpath: subpath ? `./${subpath}` : '.' };
}

function target(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = target(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (conditions.includes(key)) {
        const found = target(item);
        if (found) return found;
      }
    }
  }
  return undefined;
}

export function exportsTarget(exports, subpath) {
  const sugar =
    typeof exports === 'string' ||
    Array.isArray(exports) ||
    !Object.keys(exports).some((key) => key.startsWith('.'));
  const map = sugar ? { '.': exports } : exports;
  if (subpath in map) return target(map[subpath]);
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= key.length - 1
    ) {
      const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
      return target(value)?.replaceAll('*', middle);
    }
  }
  return undefined;
}

export function createResolver(fs) {
  const manifests = new Map();
  const results = new Map();

  async function manifest(dir) {
    if (!manifests.has(dir)) {
      manifests.set(
        dir,
        fs
          .readText(`${dir}/package.json`)
          .then((text) => (text === undefined ? undefined : JSON.parse(text)))
      );
    }
    return manifests.get(dir);
  }

  async function owner(path) {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      if (!dir.endsWith('/node_modules')) {
        const found = await manifest(dir);
        if (found) return { dir, json: found };
      }
      if (dir === '/') return undefined;
    }
  }

  async function file(path) {
    for (const candidate of [
      path,
      `${path}.js`,
      `${path}.mjs`,
      `${path}.cjs`,
      `${path}.json`,
      `${path}/index.js`,
    ]) {
      if (await fs.isFile(candidate)) return candidate;
    }
    return undefined;
  }

  async function browserMapped(path) {
    const pkg = await owner(path);
    const map = pkg?.json.browser;
    if (!map || typeof map !== 'object') return path;
    const relative = `.${path.slice(pkg.dir.length)}`;
    for (const key of [relative, relative.replace(/\.m?js$/, '')]) {
      const mapped = map[key];
      if (typeof mapped === 'string') return (await file(join(pkg.dir, mapped))) ?? path;
    }
    return path;
  }

  async function packageEntry(dir, json, subpath) {
    if (json.exports !== undefined) {
      const found = exportsTarget(json.exports, subpath);
      return found === undefined ? undefined : join(dir, found);
    }
    if (subpath !== '.') return file(join(dir, subpath));
    const browser = typeof json.browser === 'string' ? json.browser : undefined;
    return file(join(dir, browser ?? json.module ?? json.main ?? 'index.js'));
  }

  async function bare(specifier, importer) {
    const { name, subpath } = splitBare(specifier);
    for (let dir = dirname(importer); ; dir = dirname(dir)) {
      const base = dir === '/' ? '' : dir;
      const json = await manifest(`${base}/node_modules/${name}`);
      if (json) return packageEntry(`${base}/node_modules/${name}`, json, subpath);
      if (dir === '/') return undefined;
    }
  }

  async function resolve(specifier, importer) {
    if (/^(data|blob|https?):/.test(specifier)) return specifier;
    const node = builtin(specifier);
    if (node !== undefined) return `${NODE_STUBS}${node}.js`;
    if (specifier.startsWith('/')) return file(specifier);
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const found = await file(join(dirname(importer), specifier));
      return found && browserMapped(found);
    }
    return bare(specifier, importer);
  }

  return (specifier, importer) => {
    const key = `${dirname(importer)}\0${specifier}`;
    if (!results.has(key)) results.set(key, resolve(specifier, importer));
    return results.get(key);
  };
}
