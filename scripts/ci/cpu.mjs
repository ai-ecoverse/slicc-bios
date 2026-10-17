import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, cpus, release, totalmem } from 'node:os';
import { argv, stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const TICK = 100;

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function system() {
  const [, ...fields] = read('/proc/stat').split('\n')[0].trim().split(/\s+/).map(Number);
  const [user, nice, sys, idle, iowait, irq, softirq, steal] = fields;
  return { busy: user + nice + sys + irq + softirq, idle, iowait, steal };
}

export function kind(command) {
  const args = command.split(/[\0 ]+/);
  const program = args[0] ?? '';
  if (/chrom/i.test(program)) {
    const type = args.find((arg) => arg.startsWith('--type='))?.slice(7);
    if (!type) return 'chrome browser';
    if (type === 'utility') {
      const sub = args.find((arg) => arg.startsWith('--utility-sub-type='))?.slice(19) ?? '';
      return `chrome utility ${sub.replace(/\.mojom\.\w+$/, '')}`;
    }
    return `chrome ${type}`;
  }
  if (/(^|\/)node$/.test(program)) {
    return args.some((arg) => arg.startsWith('--test')) ? 'node test' : 'node';
  }
  return 'other';
}

function ticks(stat) {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(' ');
  return Number(fields[11]) + Number(fields[12]);
}

function tasks(pid) {
  try {
    return readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
}

function processes() {
  const found = new Map();
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    const group = kind(read(`/proc/${pid}/cmdline`));
    const threads = group.startsWith('chrome') ? tasks(pid) : [];
    if (threads.length === 0) {
      const total = ticks(read(`/proc/${pid}/stat`));
      if (total !== null) found.set(pid, { ticks: total, kind: group });
      continue;
    }
    for (const tid of threads) {
      const total = ticks(read(`/proc/${pid}/task/${tid}/stat`));
      if (total === null) continue;
      const name = read(`/proc/${pid}/task/${tid}/comm`).trim().replace(/\d+$/, '');
      found.set(`${pid}/${tid}`, { ticks: total, kind: `${group} · ${name}` });
    }
  }
  return found;
}

function quota() {
  const [max, period] = read('/sys/fs/cgroup/cpu.max').trim().split(' ');
  return max && max !== 'max' ? Number(max) / Number(period) : null;
}

export function environment() {
  return {
    cores: availableParallelism(),
    model: cpus()[0]?.model ?? null,
    quota: quota(),
    memory: Math.round(totalmem() / 2 ** 30),
    kernel: release(),
    gvisor: /gVisor/i.test(read('/proc/version')) || release().startsWith('4.4.0'),
  };
}

async function watch(file, every) {
  appendFileSync(file, `${JSON.stringify({ environment: environment() })}\n`);
  let before = system();
  let seen = processes();
  for (;;) {
    await sleep(every);
    const now = system();
    const current = processes();
    const by = {};
    for (const [pid, entry] of current) {
      const delta = entry.ticks - (seen.get(pid)?.ticks ?? 0);
      if (delta > 0) by[entry.kind] = (by[entry.kind] ?? 0) + delta / TICK;
    }
    const seconds = every / 1000;
    const cores = (key) => Math.round(((now[key] - before[key]) / TICK / seconds) * 100) / 100;
    appendFileSync(
      file,
      `${JSON.stringify({
        at: Date.now(),
        busy: cores('busy'),
        idle: cores('idle'),
        iowait: cores('iowait'),
        steal: cores('steal'),
        by: Object.fromEntries(
          Object.entries(by).map(([key, ticks]) => [key, Math.round((ticks / seconds) * 100) / 100])
        ),
      })}\n`
    );
    before = now;
    seen = current;
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
}

export function summary(lines) {
  const env = lines.find((line) => line.environment)?.environment ?? {};
  const rows = lines.filter((line) => line.at);
  const cores = env.quota ?? env.cores ?? 1;
  const busy = rows.map((row) => row.busy);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
  const by = {};
  for (const row of rows)
    for (const [key, value] of Object.entries(row.by)) by[key] = (by[key] ?? 0) + value;
  const top = Object.entries(by)
    .map(([key, total]) => [key, total / (rows.length || 1)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14);
  const saturated = rows.filter((row) => row.busy >= 0.9 * cores).length;
  return {
    env,
    samples: rows.length,
    mean: mean(busy),
    p50: percentile(busy, 0.5),
    p90: percentile(busy, 0.9),
    steal: mean(rows.map((row) => row.steal)),
    iowait: mean(rows.map((row) => row.iowait)),
    saturated: rows.length ? saturated / rows.length : 0,
    top,
  };
}

function markdown(name, result) {
  const { env } = result;
  const fixed = (value) => value.toFixed(2);
  return [
    `### CPU on the runner: ${name}`,
    '',
    `${env.cores} cores${env.quota ? `, quota ${env.quota}` : ''}, ${env.model}, ${env.memory} GiB, kernel ${env.kernel}${env.gvisor ? ' (gVisor)' : ''}; ${result.samples} samples.`,
    '',
    `Busy cores: mean ${fixed(result.mean)}, p50 ${fixed(result.p50)}, p90 ${fixed(result.p90)}; steal ${fixed(result.steal)}, iowait ${fixed(result.iowait)}; ${Math.round(result.saturated * 100)} % of samples at ≥ 90 % of the cores.`,
    '',
    '| process | mean cores |',
    '| :--- | ---: |',
    ...result.top.map(([key, value]) => `| ${key} | ${fixed(value)} |`),
    '',
  ].join('\n');
}

const [mode, file, name = 'tests', every = '2000'] = argv.slice(2);
if (mode === 'watch') {
  if (existsSync('/proc/stat')) await watch(file, Number(every));
} else if (mode === 'report') {
  const lines = read(file)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  stdout.write(
    lines.length
      ? markdown(name, summary(lines))
      : `### CPU on the runner: ${name}\n\nNo samples.\n`
  );
}
