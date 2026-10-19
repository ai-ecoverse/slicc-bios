#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { failureLine, failures } from './shard.mjs';

export const LABEL = 'flaky-test';

export function combine(plan, records) {
  const shards = [...records].sort((a, b) => a.shard.localeCompare(b.shard));
  const first = shards[0] ?? {};
  return {
    run: first.run ?? null,
    attempt: first.attempt ?? null,
    event: plan?.event ?? first.event ?? null,
    sha: first.sha ?? null,
    pr: plan?.pr ?? first.pr ?? null,
    arm: plan?.arm ?? first.arm ?? null,
    seed: plan?.seed ?? first.seed ?? null,
    planned: (plan?.shards ?? []).map(({ shard }) => shard),
    shards: shards.map(
      ({ shard, ok, cancelled = false, wallMs, items, groups = [], flips = [] }) => ({
        shard,
        ok,
        cancelled,
        wallMs,
        items,
        retried: groups.filter(({ retry }) => retry).flatMap(({ retry }) => retry.files),
        flips: flips.length,
      })
    ),
    timings: Object.assign({}, ...shards.map(({ timings = {} }) => timings)),
    flips: shards.flatMap(({ shard, flips = [] }) => flips.map((flip) => ({ ...flip, shard }))),
    traps: shards.flatMap(({ shard, traps = [] }) => traps.map((trap) => ({ ...trap, shard }))),
    failures: shards.flatMap((record) => failures(record)),
  };
}

export const TRAP_TEST = {
  file: 'src/seed/update.js',
  name: 'pnpm hit the wasm trap and was retried (homescoop#1127)',
};

export function trapFlips(summary) {
  if (!summary.traps?.length) return [];
  const log = summary.traps
    .map(({ shard, file, name, line }) => `${shard} ${file} › ${name}: ${line}`)
    .join('\n');
  return [
    { ...TRAP_TEST, shard: [...new Set(summary.traps.map(({ shard }) => shard))].join(' '), log },
  ];
}

export function key({ file, name }) {
  return createHash('sha256').update(`${file}\u0000${name}`).digest('hex').slice(0, 16);
}

export function title({ file, name }) {
  const text = `flaky: ${basename(file)} › ${name}`;
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function fence(log) {
  const text = (log || 'no error message').slice(0, 3000);
  return `~~~~\n${text.replaceAll('~~~~', '~ ~ ~ ~')}\n~~~~`;
}

export function occurrence(flip, summary, server, repo) {
  const run = summary.run
    ? `${server}/${repo}/actions/runs/${summary.run}${summary.attempt ? `/attempts/${summary.attempt}` : ''}`
    : 'unknown run';
  const pr = summary.pr ? `, PR #${summary.pr}` : '';
  return [
    `- Run: ${run}`,
    `- Event: ${summary.event ?? 'unknown'}${pr}, arm ${summary.arm ?? 'unknown'}, shard ${flip.shard}`,
    `- Commit: ${summary.sha ?? 'unknown'}`,
    '',
    'The first run failed with:',
    '',
    fence(flip.log),
  ].join('\n');
}

export function body(flip, summary, server, repo) {
  return [
    `\`${flip.file}\` › ${flip.name} failed, then passed when its shard ran the file again on the same commit.`,
    '',
    occurrence(flip, summary, server, repo),
    '',
    `Every later flip of this test adds a comment here. Key: \`${key(flip)}\``,
  ].join('\n');
}

async function api(path, { method = 'GET', payload } = {}) {
  const response = await fetch(`${env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!response.ok) {
    const error = new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function openIssues(repo) {
  const found = [];
  for (let page = 1; page <= 10; page++) {
    const list = await api(
      `/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=100&page=${page}`
    );
    found.push(...list.filter((issue) => !issue.pull_request));
    if (list.length < 100) break;
  }
  return found;
}

export async function report(summary, { repo, server }) {
  const unique = new Map();
  for (const flip of [...summary.flips, ...trapFlips(summary)])
    if (!unique.has(key(flip))) unique.set(key(flip), flip);
  if (!unique.size) return [];
  await api(`/repos/${repo}/labels`, {
    method: 'POST',
    payload: {
      name: LABEL,
      color: 'fbca04',
      description: 'A test that failed, then passed on a retry',
    },
  }).catch((error) => {
    if (error.status !== 422) throw error;
  });
  const issues = await openIssues(repo);
  const filed = [];
  for (const [id, flip] of unique) {
    const issue = issues.find((candidate) => (candidate.body ?? '').includes(`Key: \`${id}\``));
    if (issue) {
      await api(`/repos/${repo}/issues/${issue.number}/comments`, {
        method: 'POST',
        payload: { body: occurrence(flip, summary, server, repo) },
      });
      filed.push({ ...flip, issue: issue.html_url, new: false });
    } else {
      const created = await api(`/repos/${repo}/issues`, {
        method: 'POST',
        payload: { title: title(flip), body: body(flip, summary, server, repo), labels: [LABEL] },
      });
      filed.push({ ...flip, issue: created.html_url, new: true });
    }
  }
  return filed;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string', default: 'artifacts/experiment' },
      issues: { type: 'boolean', default: false },
    },
  });
  const names = await readdir(values.dir).catch(() => []);
  const read = async (name) => JSON.parse(await readFile(join(values.dir, name), 'utf8'));
  const plan = names.includes('plan.json') ? await read('plan.json') : null;
  const records = [];
  for (const name of names.filter((n) => /^s\d+\.json$/.test(n))) records.push(await read(name));
  const summary = combine(plan, records);
  const lines = [
    `experiment: arm ${summary.arm} (PR ${summary.pr ?? 'none'}), ${records.length} shard records${summary.planned.length ? ` of ${summary.planned.length} planned` : ''}, ${summary.flips.length} flipped tests, ${summary.traps.length} pnpm wasm traps retried`,
    ...summary.failures.map(failureLine),
  ];
  for (const { shard, file, name } of summary.traps)
    lines.push(
      `flaky: pnpm hit the wasm trap (homescoop#1127) in ${shard} ${basename(file ?? '')} › ${name}, retried`
    );
  if (values.issues && (summary.flips.length || summary.traps.length)) {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) lines.push('flaky: no token, no issues filed');
    else {
      try {
        const filed = await report(summary, {
          repo: env.GITHUB_REPOSITORY,
          server: env.GITHUB_SERVER_URL || 'https://github.com',
        });
        summary.issues = filed.map(({ file, name, issue, new: fresh }) => ({
          file,
          name,
          issue,
          new: fresh,
        }));
        for (const { file, name, issue, new: fresh } of filed) {
          lines.push(
            `flaky: ${basename(file)} › ${name}: ${fresh ? 'filed' : 'noted on'} ${issue}`
          );
        }
      } catch (error) {
        lines.push(`flaky: could not file issues (${error.message.split('\n')[0].slice(0, 200)})`);
      }
    }
  }
  await writeFile(join(values.dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(lines.join('\n'));
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}
