import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { offered } from './catalog.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const lock = JSON.parse(
  readFileSync(new URL('../../src/packages/package-lock.json', import.meta.url), 'utf8')
);
const tools = JSON.parse(
  readFileSync(new URL('../../src/packages/tools.json', import.meta.url), 'utf8')
);
const TOOLS = 'opt/slicc/tools/node_modules';
const base = [
  ...Object.entries(lock.packages)
    .filter(([path, entry]) => path && entry.resolved && !entry.os && !entry.cpu && !entry.optional)
    .map(([path, entry]) => ({
      name: path.split('node_modules/').at(-1),
      version: entry.version,
      at: 'node_modules',
    })),
  ...(
    await Promise.all(
      Object.keys(tools).map(async (name) => ({
        name,
        version: await offered(name).catch(() => null),
        at: TOOLS,
      }))
    )
  ).filter(({ version }) => version),
];

const present = (command) => `command -v ${command}`;
const CALLS = {
  bzip2recover: present('bzip2recover'),
  chroot: present('chroot'),
  who: present('who'),
  pinky: present('pinky'),
  stty: present('stty'),
  tty: present('tty'),
  umount: present('umount'),
  tset: present('tset'),
  reset: present('reset'),
  pkill: present('pkill'),
  hostid: 'hostid',
  nice: 'nice true',
  users: 'users',
  '[': '[ 1 = 1 ]',
  cat: 'cat /dev/null',
  echo: 'echo x',
  false: 'false',
  mktemp: 'mktemp -u',
  printf: 'printf x',
  pwd: 'pwd',
  sleep: 'sleep 0',
  test: 'test 1',
  true: 'true',
  yes: 'yes | head -1',
  mount: 'mount',
  clear: 'clear',
  tput: 'tput cols',
  ps: 'ps',
  free: 'free',
  pgrep: 'pgrep bash',
  kill: 'kill -l',
  uptime: 'uptime',
  pidof: 'pidof bash',
  which: 'which bash',
  pbcopy: 'pbcopy --help',
  pbpaste: 'pbpaste --help',
  xclip: 'xclip -help',
  xsel: 'xsel --help',
  'wl-copy': 'wl-copy --help',
  'wl-paste': 'wl-paste --help',
  sccopy: 'sccopy --help',
  scpaste: 'scpaste --help',
};
const SHELL = new Set(['yes', '[']);
const EXITS = {
  false: [1],
  bunzip2: [0, 2],
  bzcat: [0, 2],
  i: [0, 2],
  chcon: [1],
  runcon: [1],
};

const REAL = [
  [
    'wasm-grep',
    'grep -c, grep -n',
    `[ "$(grep -c a s.txt)" = 3 ] && [ "$(grep -n beta s.txt)" = 2:beta ]`,
  ],
  ['wasm-grep', 'egrep', `[ "$(egrep '^g' s.txt)" = gamma ]`],
  ['wasm-sed', 'sed -n, sed -i', `sed -i s/beta/BETA/ s.txt && [ "$(sed -n 2p s.txt)" = BETA ]`],
  ['wasm-xz', 'xz -k, xz -dc', `xz -k s.txt && [ "$(xz -dc s.txt.xz)" = "$(<s.txt)" ]`],
  ['wasm-xz', 'xzgrep', `[ "$(xzgrep -c BETA s.txt.xz)" = 1 ]`],
  ['wasm-jq', 'jq -c', `[ "$(printf '{"k":[1,2]}' | jq -c .k)" = '[1,2]' ]`],
  [
    'wasm-findutils',
    'find -name',
    `: > f.one && [ "$(find . -maxdepth 1 -name 'f.*')" = ./f.one ]`,
  ],
  ['wasm-findutils', 'xargs', `[ "$(printf '1\\n2\\n' | xargs echo)" = '1 2' ]`],
  [
    'wasm-diffutils',
    'diff -u, cmp',
    `printf 'a\\nb\\n' > d1 && printf 'a\\nc\\n' > d2 && cmp d1 d1 && { diff -u d1 d2 > d.patch; [ $? = 1 ]; } && [[ "$(<d.patch)" == *'+c'* ]]`,
  ],
  [
    'wasm-patch',
    'patch',
    `printf 'a\\nb\\n' > d3 && patch -s d3 < d.patch && [ "$(<d3)" = "$(<d2)" ]`,
  ],
  ['wasm-gawk', 'awk', `[ "$(echo 'a b' | awk '{ print $2 }')" = b ]`],
  ['wasm-gzip', 'gzip -c, gunzip -c', `[ "$(gzip -c s.txt | gunzip -c)" = "$(<s.txt)" ]`],
  ['wasm-bzip2', 'bzip2 -c, bunzip2 -c', `[ "$(bzip2 -c s.txt | bunzip2 -c)" = "$(<s.txt)" ]`],
  ['wasm-tar', 'tar -c, tar -t', `tar -cf t.tar s.txt && [ "$(tar -tf t.tar)" = s.txt ]`],
];

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const DIR = '/home/.sweep';

function script(commands) {
  const lines = [
    `D=${DIR}; R=$D/sweep.tsv; W=$D/work; O=$D/out`,
    'mkdir -p "$W"; : > "$R"',
    'note() { local o; o=$(<"$O"); o=${o//$\'\\n\'/ }; o=${o//$\'\\t\'/ }; printf \'%s\\t%s\\t%s\\t%s\\t%s\\n\' "$1" "$2" "$3" "$4" "${o:0:200}" >> "$R"; }',
  ];
  for (const { pkg, command } of commands) {
    const call = CALLS[command] ?? `${command} --version`;
    const line = SHELL.has(command)
      ? `timeout 60 bash -c ${quote(call)}`
      : call.startsWith('command -v ')
        ? call
        : `timeout 60 ${call}`;
    lines.push(`(cd "$W" && ${line}) </dev/null >"$O" 2>&1; note SW ${pkg} ${quote(command)} $?`);
  }
  lines.push(
    `(cd "$W" && printf 'alpha\\nbeta\\ngamma\\n' > s.txt) >"$O" 2>&1; note RL setup setup $?`
  );
  REAL.forEach(([pkg, , check], index) => {
    lines.push(`(cd "$W" && ${check}) </dev/null >"$O" 2>&1; note RL ${pkg} ${index} $?`);
  });
  return `${lines.join('\n')}\n`;
}

async function installed(page) {
  return page.evaluate(
    async (list) => {
      const root = await navigator.storage.getDirectory();
      const found = {};
      for (const { name, at } of list) {
        try {
          let dir = root;
          for (const part of [...at.split('/'), ...name.split('/')]) {
            dir = await dir.getDirectoryHandle(part);
          }
          const file = await (await dir.getFileHandle('package.json')).getFile();
          const manifest = JSON.parse(await file.text());
          found[name] = {
            version: manifest.version,
            commands: Object.keys(manifest.slicc?.commands ?? {}),
          };
        } catch (error) {
          found[name] = { error: error.message };
        }
      }
      return found;
    },
    base.map(({ name, at }) => ({ name, at }))
  );
}

async function put(page, path, text) {
  await page.evaluate(
    async ([path, text]) => {
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop();
      let dir = await navigator.storage.getDirectory();
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    },
    [path, text]
  );
}

async function get(page, path) {
  return page.evaluate(async (path) => {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    let dir = await navigator.storage.getDirectory();
    try {
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return null;
    }
  }, path);
}

test('every base-set and tool command answers --version or a trivial call, each tool at the version seven offers, and grep, sed, xz, jq, find, diff and patch do real work', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const found = await installed(page);
  const commands = [];
  for (const { name, version } of base) {
    assert.equal(found[name]?.version, version, `${name} in OPFS: ${JSON.stringify(found[name])}`);
    const pkg = name.split('/').at(-1);
    for (const command of found[name].commands) commands.push({ pkg, command });
  }
  assert.ok(commands.length >= 100, `found ${commands.length} base-set and tool commands`);
  await put(page, `${DIR.slice(1)}/sweep.sh`, script(commands));
  await run(page, `clear; bash ${DIR}/sweep.sh >/dev/null 2>&1; echo "@@SWEEP""-DONE@@"`);
  await shows(page, '@@SWEEP-DONE@@', 840000);
  const rows = ((await get(page, `${DIR.slice(1)}/sweep.tsv`)) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  const sweep = new Map(
    rows
      .filter(([kind]) => kind === 'SW')
      .map(([, p, c, rc, out]) => [`${p} ${c}`, { rc: Number(rc), out }])
  );
  const real = new Map(
    rows
      .filter(([kind]) => kind === 'RL')
      .map(([, p, i, rc, out]) => [`${p} ${i}`, { rc: Number(rc), out }])
  );
  for (const { pkg, command } of commands) {
    const call = CALLS[command] ?? `${command} --version`;
    await t.test(`${pkg} · ${call}`, () => {
      const got = sweep.get(`${pkg} ${command}`);
      assert.ok(got, `${command} didn't report back`);
      const allowed = EXITS[command] ?? [0];
      assert.ok(
        allowed.includes(got.rc),
        `rc=${got.rc} (wanted ${allowed.join(' or ')}): ${got.out}`
      );
    });
  }
  const setup = real.get('setup setup');
  assert.equal(setup?.rc, 0, `the real-use scratch file: ${JSON.stringify(setup)}`);
  for (const [index, [pkg, what]] of REAL.entries()) {
    await t.test(`${pkg} · real use: ${what}`, () => {
      const got = real.get(`${pkg} ${index}`);
      assert.ok(got, `${what} didn't report back`);
      assert.equal(got.rc, 0, `rc=${got.rc}: ${got.out}`);
    });
  }
});
