#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GATED } from './pins.mjs';

export const MANIFESTS = [
  'src/packages/package.json',
  'src/packages/optional/package.json',
  'src/packages/agent/package.json',
  'src/packages/tailscale/package.json',
  'src/packages/grammars/package.json',
];

const json = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export function changedPins(base, head) {
  const found = new Map();
  for (const path of MANIFESTS) {
    const before = json(join(base, path))?.dependencies ?? {};
    for (const [name, version] of Object.entries(json(join(head, path))?.dependencies ?? {}))
      if (name.startsWith('@ai-ecoverse/') && before[name] !== version)
        found.set(`${name}@${version}`, {
          name,
          version,
          from: before[name] ?? null,
          gated: GATED.test(name),
        });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]
  );
}

export function shardFlips(shards) {
  const files = new Set();
  for (const file of walk(shards).filter((f) => /experiment\/[^/]+\.json$/.test(f))) {
    for (const group of json(file)?.groups ?? []) {
      if (!group.retry) continue;
      const still = new Set(group.retry.failed ?? []);
      for (const f of group.first?.failed ?? [])
        if (!still.has(f) && /^test\/integration\/[\w./-]+\.test\.mjs$/.test(f)) files.add(f);
    }
  }
  return [...files].sort();
}

export function failedFiles(shards) {
  const files = new Set();
  for (const file of walk(shards).filter((f) => /experiment\/[^/]+\.json$/.test(f))) {
    const report = json(file);
    for (const group of report?.groups ?? []) {
      const last = group.retry ?? group.first;
      for (const f of last?.failed ?? [])
        if (/^test\/integration\/[\w./-]+\.test\.mjs$/.test(f)) files.add(f);
    }
  }
  return [...files].sort();
}

export const scenarioOf = (name) =>
  `scripts/cert/scenarios/${name.replace(/^@ai-ecoverse\//, '')}.txt`;

export function scenario(text) {
  const lines = text.split('\n').map((l) => l.trim());
  const pass = lines.filter((l) => /^# pass:/.test(l)).map((l) => l.replace(/^# pass:\s*/, ''));
  const commands = lines.filter((l) => l && !l.startsWith('#'));
  return { pass, commands };
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const count = (text, name) => {
  const m = [...text.replace(ANSI, '').matchAll(new RegExp(`^ℹ ${name} (\\d+)\\s*$`, 'gm'))].at(-1);
  return m ? Number(m[1]) : null;
};

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return {
    code: r.status ?? (r.signal ? 128 : 1),
    timedOut: r.error?.code === 'ETIMEDOUT' || Boolean(r.signal),
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

export const CLASSES = {
  guard: [
    'guard-set-extension',
    'guard-set-proxy',
    'guard-vectors',
    'sandbox',
    'shared-origin',
    'loopback',
    'path-spawn',
    'pnpm-trap',
    'unshadow',
    'cert',
    'cert-tools',
    'pins',
    'release-state',
    'ci-scope',
    'renovate',
    'shards',
    'pnpm-root',
    'cdp-link-worlds',
    'cdp',
    'sweep',
    'real-extension',
    'guard-no-extension',
    'serve',
  ],
  security: [
    'vault',
    'keys',
    'gpg',
    'fnox',
    'link',
    'pair',
    'follow',
    'follow-guests',
    'follow-leaders',
    'follow-pi',
    'follow-slicc',
    'follow-terminal',
    'follow-version',
    'remote',
    'transport',
    'framing',
    'tailscale',
    'users',
    'sw-activation',
    'mcpcat-users',
    'user-installs',
    'k4',
    'k4-agent',
    'k4-modes',
    'clipboard',
    'jsh',
    'ntfy',
    'ntfy-agent',
    'tray',
    'leaders',
    'beta',
    'vault-endpoints',
    'releases-boundary',
  ],
  'data integrity': [
    'integrity',
    'update',
    'updates',
    'offline-update',
    'k4-upgrade',
    'pydata-update',
    'lost-folder',
    'mounts',
    'mnt-modes',
    'sqlite',
    'user-packages',
    'seed',
    'reuse',
    'packages',
    'optional',
    'old-agent',
    'one-kernel',
    'agent-code',
    'modules',
  ],
};

export const UNCLASSIFIED = [
  'agent-ui',
  'app',
  'boot',
  'canary',
  'catalog-skills',
  'chat',
  'favicon',
  'imagemagick',
  'mcpcat',
  'modes',
  'perl',
  'preview-publish',
  'progress',
  'pydata',
  'quiet-body',
  'ruby',
  'shell',
  'tabs',
  'typescript',
  'zip',
];

export function classOf(file) {
  const name = basename(file).replace(/\.test\.mjs$/, '');
  const found = Object.keys(CLASSES).find((c) => CLASSES[c].includes(name));
  if (found) return found;
  return UNCLASSIFIED.includes(name) ? null : 'an unclassified new file';
}

async function flakyFiles() {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !env.GH_TOKEN) return new Map();
  const found = new Map();
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(
      `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repo}/issues?labels=flaky-test&state=open&per_page=100&page=${page}`,
      {
        headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json' },
      }
    ).catch(() => null);
    if (!r?.ok) break;
    const list = await r.json();
    for (const i of list) {
      const m = /^flaky: ([\w.-]+\.test\.mjs) › /.exec(i.title ?? '');
      if (m && !found.has(m[1])) found.set(m[1], i.number);
    }
    if (list.length < 100) break;
  }
  return found;
}

async function plan({ head, base, shards, out, budget }) {
  mkdirSync(out, { recursive: true });
  const pins = changedPins(base, head);
  const failed = failedFiles(shards);
  const flips = shardFlips(shards).filter((f) => !failed.includes(f));
  const scenarios = pins
    .filter((p) => p.gated)
    .map((p) => ({
      ...p,
      file: scenarioOf(p.name),
      present: existsSync(join(head, scenarioOf(p.name))),
    }));
  const known = await flakyFiles();
  const flaky = Object.fromEntries(
    [...failed, ...flips]
      .filter((f) => known.has(basename(f)))
      .map((f) => [f, known.get(basename(f))])
  );
  const critical = Object.fromEntries(
    [...failed, ...flips].filter(classOf).map((f) => [f, classOf(f)])
  );
  const result = {
    pins,
    failed,
    flips,
    scenarios,
    flaky,
    critical,
    deadline: Date.now() + budget * 60000,
  };
  writeFileSync(join(out, 'plan.json'), `${JSON.stringify(result, null, 2)}\n`);
  const outputs = {
    pins: String(pins.length > 0),
    reruns: String(failed.length + flips.length > 0),
    browser: String(
      failed.some((f) => !flaky[f] || critical[f]) || scenarios.some((s) => s.present)
    ),
  };
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([k, v]) => `${k}=${v}\n`)
        .join('')
    );
  console.log(
    `cert evidence plan: ${pins.length} changed pins, ${failed.length} failed test files, ${scenarios.filter((s) => s.present).length}/${scenarios.length} gated pins with a scenario`
  );
}

function inspect({ base, out }) {
  const { pins } = json(join(out, 'plan.json'));
  mkdirSync(join(out, 'inspect'), { recursive: true });
  for (const p of pins) {
    const args = [
      join(base, 'scripts/cert/inspect.mjs'),
      `${p.name}@${p.version}`,
      ...(p.from ? ['--against', p.from] : []),
    ];
    const r = sh(process.execPath, args, { cwd: base, timeout: 900000 });
    const file = join(out, 'inspect', `${basename(p.name)}.json`);
    writeFileSync(
      file,
      r.code === 0 ? r.out : `${JSON.stringify({ error: r.out.slice(-4000), exit: r.code })}\n`
    );
  }
  if (existsSync(join(base, 'artifacts/cert')))
    cpSync(join(base, 'artifacts/cert'), join(out, 'inspect'), { recursive: true });
}

export function readingOf(row, times) {
  const cut = (runs) => runs.some((x) => x.timedOut);
  const headFails = row.head.filter((x) => x.exit !== 0).length;
  const baseFails = row.base.filter((x) => x.exit !== 0 && !x.timedOut).length;
  const cls = row.class ? `it covers ${row.class}: a fail` : 'a finding';
  if (headFails < row.head.length)
    return {
      outcome: row.class ? 'fail' : 'finding',
      reading: `head flake: failed in its shard, then passed ${row.head.length - headFails} of ${row.head.length} re-runs (${cls})`,
    };
  if (row.head.length < times || cut(row.head))
    return {
      outcome: 'incomplete',
      reading: 'incomplete: the evidence budget ran out on the head',
    };
  if (!row.base.length && !row.inBase)
    return { outcome: 'fail', reading: 'fails every time on the head; not in main' };
  if (cut(row.base))
    return { outcome: 'incomplete', reading: 'incomplete: the evidence budget ran out on main' };
  if (baseFails) return { outcome: 'main-alike', reading: 'fails on main alike' };
  if (row.base.length < times)
    return { outcome: 'incomplete', reading: 'incomplete: the evidence budget ran out on main' };
  return { outcome: 'fail', reading: 'regression: fails every time on the head, passes on main' };
}

export function flipOf(file, cls, issue) {
  if (issue && !cls)
    return {
      outcome: 'known-flaky',
      reading: `known flaky (issue #${issue}); failed, then passed on its shard's retry`,
    };
  return {
    outcome: cls ? 'fail' : 'finding',
    reading: `head flake: failed in its shard, then passed on the shard's retry (${cls ? `it covers ${cls}: a fail` : 'a finding'})`,
  };
}

function retried(times, once) {
  const runs = [];
  for (let i = 0; i < times; i++) {
    const got = once(i);
    if (!got) break;
    runs.push(got);
    if (got.stop) break;
  }
  return runs;
}

function reruns({ head, base, out, times }) {
  const {
    failed,
    flips = [],
    flaky = {},
    deadline = Number.POSITIVE_INFINITY,
  } = json(join(out, 'plan.json'));
  const rows = [];
  const once = (dir, cli, file, side, i) => {
    const left = deadline - Date.now();
    if (left < 60000) return null;
    const started = Date.now();
    const r = sh('npm', ['test'], {
      cwd: dir,
      timeout: Math.min(1800000, left),
      env: { ...env, SLICC_CLI: cli, SLICC_TESTS: file },
    });
    const log = join(out, 'reruns', `${basename(file)}.${side}.${i + 1}.log`);
    mkdirSync(join(out, 'reruns'), { recursive: true });
    writeFileSync(log, r.out.slice(-2_000_000));
    return {
      exit: r.code,
      ...(r.timedOut ? { timedOut: true } : {}),
      pass: count(r.out, 'pass'),
      fail: count(r.out, 'fail'),
      ms: Date.now() - started,
      log: basename(log),
    };
  };
  for (const file of failed) {
    const row = { file, head: [], base: [] };
    rows.push(row);
    row.class = classOf(file);
    row.inBase = existsSync(join(base, file));
    if (flaky[file]) row.issue = flaky[file];
    if (flaky[file] && !row.class) {
      Object.assign(row, {
        outcome: 'known-flaky',
        reading: `known flaky (issue #${flaky[file]}), not re-run`,
      });
      continue;
    }
    if (!existsSync(join(head, file))) {
      Object.assign(row, { outcome: 'removed', reading: 'not in the head tree' });
      continue;
    }
    row.head = retried(times, (i) => {
      const got = once(head, env.SLICC_CLI_HEAD, file, 'head', i);
      return got && { ...got, stop: got.exit === 0 || got.timedOut };
    });
    const allFailed = row.head.length === times && row.head.every((x) => x.exit !== 0);
    if (allFailed && row.inBase)
      row.base = retried(times, (i) => {
        const got = once(base, env.SLICC_CLI_BASE, file, 'base', i);
        return got && { ...got, stop: got.exit !== 0 || got.timedOut };
      });
    for (const x of [...row.head, ...row.base]) delete x.stop;
    Object.assign(row, readingOf(row, times));
  }
  for (const file of flips) {
    const cls = classOf(file);
    rows.push({
      file,
      head: [],
      base: [],
      shardRetry: 'passed',
      class: cls,
      ...(flaky[file] ? { issue: flaky[file] } : {}),
      ...flipOf(file, cls, flaky[file]),
    });
  }
  const incomplete = rows.some((r) => r.outcome === 'incomplete');
  writeFileSync(
    join(out, 'reruns.json'),
    `${JSON.stringify({ times, incomplete, rows }, null, 2)}\n`
  );
  console.log(
    `cert evidence reruns: ${rows.map((r) => `${r.file}: ${r.reading}`).join('; ') || 'none'}`
  );
}

const OUTCOMES = new Set(['fail', 'finding', 'main-alike', 'known-flaky', 'removed', 'incomplete']);

function missingReruns(plan, reruns) {
  const want = [...plan.failed, ...(plan.flips ?? [])];
  if (want.length && !reruns) return ['reruns.json is missing'];
  const why = [];
  for (const f of want) {
    const row = reruns.rows?.find((r) => r.file === f);
    if (!row) why.push(`${f}: no re-run row`);
    else if (!OUTCOMES.has(row.outcome)) why.push(`${f}: no known outcome`);
    else if (row.outcome === 'incomplete') why.push(`${f}: ${row.reading}`);
  }
  return why;
}

function missingScenarios(plan, scen) {
  const present = plan.scenarios.filter((s) => s.present);
  if (present.length && !scen) return ['scenarios.json is missing'];
  const why = [];
  for (const s of present) {
    const name = `${s.name}@${s.version}`;
    const row = scen.find((r) => r.package === name);
    if (!row) why.push(`${name}: no scenario row`);
    else if (row.incomplete || !row.head || !row.base)
      why.push(`${name}: scenario not run on both trees (the evidence budget ran out)`);
  }
  return why;
}

function check({ out }) {
  const plan = json(join(out, 'plan.json'));
  const maybe = (f) => (existsSync(join(out, f)) ? json(join(out, f)) : null);
  const why = [
    ...missingReruns(plan, maybe('reruns.json')),
    ...missingScenarios(plan, maybe('scenarios.json')),
  ];
  if (why.length) {
    console.log(`cert evidence: INCOMPLETE ${why.join('; ')}`);
    process.exitCode = 1;
  } else console.log('cert evidence: COMPLETE');
}

function scenarios({ head, base, out }) {
  const { scenarios: list, deadline = Number.POSITIVE_INFINITY } = json(join(out, 'plan.json'));
  const rows = [];
  for (const s of list) {
    if (!s.present) {
      rows.push({
        package: `${s.name}@${s.version}`,
        gap: `can't judge ${s.name} in seven: no scenario (${s.file})`,
      });
      continue;
    }
    const { pass, commands } = scenario(readFileSync(join(head, s.file), 'utf8'));
    const row = {
      package: `${s.name}@${s.version}`,
      file: s.file,
      pass,
      commands: commands.length,
    };
    const cmds = join(out, 'scenarios', basename(s.name), 'commands.txt');
    mkdirSync(join(out, 'scenarios', basename(s.name)), { recursive: true });
    writeFileSync(cmds, `${commands.join('\n')}\n`);
    for (const [side, dir, cli] of [
      ['head', head, env.SLICC_CLI_HEAD],
      ['base', base, env.SLICC_CLI_BASE],
    ]) {
      const left = deadline - Date.now();
      if (left < 60000) {
        row[side] = { skipped: 'the evidence budget ran out' };
        row.incomplete = true;
        continue;
      }
      const r = sh('npm', ['run', 'test:cert'], {
        cwd: dir,
        timeout: Math.min(3600000, left),
        env: { ...env, SLICC_CLI: cli, CERT_COMMANDS: resolve(cmds) },
      });
      const seven = join(dir, 'artifacts/cert/seven.json');
      if (existsSync(seven))
        cpSync(seven, join(out, 'scenarios', basename(s.name), `${side}.json`));
      writeFileSync(
        join(out, 'scenarios', basename(s.name), `${side}.log`),
        r.out.slice(-2_000_000)
      );
      row[side] = { exit: r.code, results: existsSync(seven) };
      if (r.timedOut) {
        row[side].timedOut = true;
        row.incomplete = true;
      }
    }
    rows.push(row);
  }
  writeFileSync(join(out, 'scenarios.json'), `${JSON.stringify(rows, null, 2)}\n`);
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      head: { type: 'string', default: 'head' },
      base: { type: 'string', default: 'base' },
      shards: { type: 'string', default: '' },
      out: { type: 'string' },
      times: { type: 'string', default: '3' },
      'budget-min': { type: 'string', default: '20' },
    },
  });
  const o = {
    ...values,
    head: resolve(values.head),
    base: resolve(values.base),
    out: resolve(values.out),
    times: Number(values.times),
    budget: Number(values['budget-min']),
  };
  const run = { plan, inspect, reruns, scenarios, check }[command];
  if (!run) {
    console.error(
      'usage: evidence.mjs plan|inspect|reruns|scenarios --head <dir> --base <dir> --out <dir>'
    );
    exit(2);
  }
  await run(o);
}
