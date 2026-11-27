import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { env, execPath, getuid, kill } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const OFF = 'export const LEASE_PRODUCT_VERSION = 0;\n';
export const ON = 'export const LEASE_PRODUCT_VERSION = 1;\n';
export const GATE = 'seed/lease-build.js';
export const SPELLINGS = [
  'export const LEASE_PRODUCT_VERSION = 0 ;\n',
  'export const LEASE_PRODUCT_VERSION =0;\n',
  'export const LEASE_PRODUCT_VERSION=0;\n',
  'export const LEASE_PRODUCT_VERSION = 0;',
  'export const LEASE_PRODUCT_VERSION = 0\n',
  'export const LEASE_PRODUCT_VERSION = 00;\n',
  'export const LEASE_PRODUCT_VERSION = -0;\n',
  'export const LEASE_PRODUCT_VERSION = 0.0;\n',
  'export const LEASE_PRODUCT_VERSION = 0x0;\n',
  'export const LEASE_PRODUCT_VERSION = false;\n',
  "export const LEASE_PRODUCT_VERSION = '0';\n",
  'export let LEASE_PRODUCT_VERSION = 0;\n',
  'export const LEASE_PRODUCT_VERSION  = 0;\n',
  'export const LEASE_PRODUCT_VERSION =\t0;\n',
  '\uFEFFexport const LEASE_PRODUCT_VERSION = 0;\n',
];

const exec = promisify(execFile);
const rules = new Map();

export function intercept(name, rule) {
  if (!rules.has(name)) {
    const real = fs[name];
    const active = new Set();
    rules.set(name, { real, active });
    fs[name] = (...args) => {
      for (const each of active) {
        const answer = each(real, ...args);
        if (answer) return answer.value;
      }
      return real(...args);
    };
    syncBuiltinESMExports();
  }
  const { real, active } = rules.get(name);
  active.add(rule);
  return () => {
    active.delete(rule);
    if (active.size === 0 && rules.get(name)?.active === active) {
      fs[name] = real;
      rules.delete(name);
      syncBuiltinESMExports();
    }
  };
}

export function denying(name, at) {
  return intercept(name, (_real, path) => {
    if (String(path) !== at) return null;
    const call = name.replace(/Sync$/, '');
    throw Object.assign(new Error(`EACCES: permission denied, ${call} '${at}'`), {
      code: 'EACCES',
      errno: -13,
      syscall: call,
      path: at,
    });
  });
}

export const root = getuid?.() === 0;

export async function tree(t, layout = {}, { root = 'dir' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'publish-tree-'));
  const locked = [];
  t.after(async () => {
    for (const path of locked) await chmod(path, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const src = join(dir, 'src');
  const outside = join(dir, 'outside');
  const entries = {
    'index.html': '<!doctype html>\n',
    'seed/boot.js': 'export {};\n',
    [GATE]: OFF,
    ...layout,
  };
  await mkdir(join(outside, 'seed'), { recursive: true });
  await writeFile(join(outside, 'lease-build.js'), OFF);
  await writeFile(join(outside, GATE), OFF);
  if (root === 'file') await writeFile(src, OFF);
  if (root === 'dir' || root === 'link') {
    const real = root === 'link' ? join(dir, 'real-src') : src;
    if (root === 'link') await symlink('real-src', src);
    await mkdir(real);
    for (const [path, content] of Object.entries(entries)) {
      if (content === null) continue;
      const at = join(real, path);
      await mkdir(dirname(at), { recursive: true });
      if (typeof content === 'string') await writeFile(at, content);
      else if (content.link) await symlink(content.link, at);
      else if (content.fifo) await exec('mkfifo', [at]);
      else if (content.socket) {
        const server = createServer();
        await new Promise((resolve) => server.listen(at, resolve));
        t.after(() => server.close());
      } else {
        if (content.dir) await mkdir(at);
        else await writeFile(at, content.content);
        if (content.unreadable === 'fd') {
          t.after(denying(content.dir ? 'readdirSync' : 'openSync', at));
        } else {
          await chmod(at, 0);
          locked.push(at);
          await access(at, fs.constants.R_OK).then(
            () => {
              throw new Error(`${at} is still readable at mode 000`);
            },
            () => {}
          );
        }
      }
    }
  }
  const files = Object.keys(entries).filter((path) => typeof entries[path] === 'string');
  return { dir, src, outside, files: files.sort() };
}

export const refusals = [
  {
    name: 'src/seed/lease-build.js sets LEASE_PRODUCT_VERSION = 1',
    layouts: [{ [GATE]: ON }],
    reason: /^src\/seed\/lease-build\.js isn't exactly /,
  },
  {
    name: 'src/seed/lease-build.js is missing',
    layouts: [{ [GATE]: null }, { [GATE]: null, 'lease-build.js': OFF }],
    reason: /^src\/seed\/lease-build\.js is missing$/,
  },
  {
    name: 'src/seed/lease-build.js has one byte more',
    layouts: [{ [GATE]: `${OFF}\n` }, { [GATE]: `${OFF} ` }, { [GATE]: ` ${OFF}` }],
    reason: /^src\/seed\/lease-build\.js isn't exactly /,
  },
  {
    name: 'src/seed/lease-build.js ends its line with CRLF',
    layouts: [{ [GATE]: OFF.replace('\n', '\r\n') }],
    reason: /^src\/seed\/lease-build\.js isn't exactly /,
  },
  {
    name: 'src/seed/lease-build.js spells the value another way',
    layouts: SPELLINGS.map((spelling) => ({ [GATE]: spelling })),
    reason: /^src\/seed\/lease-build\.js isn't exactly /,
  },
  {
    name: 'a file in src/ is a symbolic link',
    layouts: [
      { [GATE]: { link: 'boot.js' }, 'seed/boot.js': OFF },
      { 'seed/alias.js': { link: 'boot.js' } },
      { 'seed/linked': { link: '.' } },
    ],
    reason: /^"src\/seed\/(lease-build\.js|alias\.js|linked)" is a symbolic link$/,
  },
  {
    name: 'a path in src/ resolves outside src/',
    layouts: [
      { [GATE]: { link: '../../outside/lease-build.js' } },
      { 'seed/boot.js': null, [GATE]: null, seed: { link: '../outside/seed' } },
      { 'up.js': { link: '../outside/lease-build.js' } },
      { parent: { link: '..' } },
      { 'gone.js': { link: 'nowhere.js' } },
    ],
    reason: /^"src\/(seed\/lease-build\.js|seed|up\.js|parent|gone\.js)" is a symbolic link$/,
  },
  {
    name: 'src/ itself is a symbolic link to a valid tree',
    layouts: [{}],
    root: 'link',
    reason: /^src\/ is a symbolic link$/,
  },
  {
    name: 'src/ is missing',
    layouts: [{}],
    root: 'missing',
    reason: /^src\/ can't be read \(ENOENT\)$/,
  },
  {
    name: 'src/ is a file',
    layouts: [{}],
    root: 'file',
    reason: /^src\/ isn't a directory$/,
  },
  {
    name: 'a file or a directory in src/ can’t be read',
    layouts: (root ? ['fd'] : ['fd', 'chmod']).flatMap((unreadable) => [
      { [GATE]: { content: OFF, unreadable } },
      { 'seed/boot.js': { content: 'export {};\n', unreadable } },
      { locked: { dir: true, unreadable } },
    ]),
    reason: /^"src\/(seed\/lease-build\.js|seed\/boot\.js|locked)" can't be read \(EACCES\)$/,
  },
  {
    name: 'an entry in src/ is a FIFO or a socket',
    layouts: [{ 'seed/pipe': { fifo: true } }, { s: { socket: true } }],
    reason: /^"src\/(seed\/pipe|s)" isn't a regular file$/,
  },
  {
    name: 'a name in src/ can’t be a key in the bucket as it is',
    layouts: [{ 'a\\b.js': 'x' }, { 'a%2Fb.js': 'x' }, { 'seed/a%5cb.js': 'x' }],
    reason: /^"src\/(a\\\\b\.js|a%2Fb\.js|seed\/a%5cb\.js)" can't be a key in the bucket$/,
  },
];

export const strays = [
  '../x',
  '/x',
  'x/',
  'a//b',
  './x',
  'a/./b',
  'a/../b',
  '..',
  'a%2Fb',
  'a%2fb',
  'a%5Cb',
  'a\\b',
  'a\0b',
  '\uD800',
  '',
  7,
  null,
];

export function swapping(at, swap) {
  let done = false;
  return intercept('lstatSync', (real, path, ...rest) => {
    if (done || String(path) !== at) return null;
    done = true;
    const value = real(path, ...rest);
    swap();
    return { value };
  });
}

export function listing(at, extra) {
  return intercept('readdirSync', (real, path, ...rest) =>
    String(path) === at ? { value: [...real(path, ...rest), extra] } : null
  );
}

export async function unnamed(made) {
  const raw = Buffer.from([0x61, 0xff]);
  const at = join(made.src, 'seed');
  const written = await writeFile(Buffer.concat([Buffer.from(`${at}/`), raw]), 'x').then(
    () => null,
    (error) => error
  );
  if (written === null) return () => {};
  if (written.code !== 'EILSEQ') throw written;
  return listing(at, raw);
}

export function races(made) {
  const gate = join(made.src, GATE);
  const seed = join(made.src, 'seed');
  return [
    {
      name: 'src/seed/lease-build.js turns into a symbolic link to a valid copy between its check and its read',
      at: gate,
      swap: () => {
        fs.rmSync(gate);
        fs.symlinkSync(join(made.outside, 'lease-build.js'), gate);
      },
      reason: /^"src\/seed\/lease-build\.js" can't be read \(ELOOP\)$/,
    },
    {
      name: 'src/seed/ turns into a symbolic link to a valid copy outside src/ between its check and its read',
      at: seed,
      swap: () => {
        fs.renameSync(seed, join(made.dir, 'seed-was'));
        fs.symlinkSync(join(made.outside, 'seed'), seed);
      },
      reason: /^"src\/seed" moved while it was read$/,
    },
    {
      name: 'src/seed/lease-build.js turns into a directory between its check and its read',
      at: gate,
      swap: () => {
        fs.rmSync(gate);
        fs.mkdirSync(gate);
      },
      reason: /^"src\/seed\/lease-build\.js" isn't a regular file$/,
    },
  ];
}

const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
export const DEPLOY = ci.match(/\n {6}deploy: (.+)\n/)[1];
export const AFTER_RELEASE = ci
  .match(/\n {6}after-release: \|\n((?: {8}.*\n)+)/)[1]
  .replace(/^ {8}/gm, '');

const cli = fileURLToPath(new URL('../../edge/publish.mjs', import.meta.url));
const modules = fileURLToPath(new URL('../../node_modules', import.meta.url));
const PRELOAD = `import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { PUBLISH_TEST_REQUESTS: log, PUBLISH_TEST_ANY: any, PUBLISH_TEST_FIFO: fifo } = process.env;
globalThis.fetch = async (input) => {
  fs.appendFileSync(log, \`\${input?.url ?? input}\\n\`);
  throw new Error('this test sends no request');
};
if (any) {
  process.env = new Proxy(process.env, {
    get: (target, name) =>
      typeof name === 'string' && !(name in target) && !name.startsWith('NODE_')
        ? any
        : Reflect.get(target, name),
  });
}
if (fifo) {
  const lstat = fs.lstatSync;
  let done = false;
  fs.lstatSync = (path, ...rest) => {
    const stats = lstat(path, ...rest);
    if (!done && String(path) === fifo) {
      done = true;
      fs.rmSync(fifo);
      execFileSync('mkfifo', [fifo]);
    }
    return stats;
  };
  syncBuiltinESMExports();
}
`;

export async function checkout(t, layout, options) {
  const made = await tree(t, layout, options);
  const dir = await realpath(made.dir);
  await mkdir(join(dir, 'edge'));
  await copyFile(cli, join(dir, 'edge', 'publish.mjs'));
  await symlink(modules, join(dir, 'node_modules'));
  await writeFile(join(dir, 'preload.mjs'), PRELOAD);
  return { ...made, dir, src: join(dir, 'src') };
}

export async function step(made, command, { vars = {}, any, fifo } = {}) {
  const files = Object.fromEntries(
    ['requests', 'summary', 'output'].map((name) => [name, join(made.dir, `${name}.txt`)])
  );
  for (const path of Object.values(files)) await writeFile(path, '');
  const child = spawn('bash', ['-eo', 'pipefail', '-c', command], {
    cwd: made.dir,
    detached: true,
    env: {
      PATH: `${dirname(execPath)}:${env.PATH}`,
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      NODE_OPTIONS: `--import=${pathToFileURL(join(made.dir, 'preload.mjs'))}`,
      PUBLISH_TEST_REQUESTS: files.requests,
      ...(any && { PUBLISH_TEST_ANY: any }),
      ...(fifo && { PUBLISH_TEST_FIFO: fifo }),
      ...vars,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    kill(-child.pid, 'SIGKILL');
  }, 30_000);
  const [status] = await once(child, 'close');
  clearTimeout(timer);
  const text = async (path) => readFile(path, 'utf8');
  return {
    status,
    late,
    stdout,
    stderr,
    summary: await text(files.summary),
    output: await text(files.output),
    requests: (await text(files.requests)).split('\n').filter(Boolean),
  };
}
