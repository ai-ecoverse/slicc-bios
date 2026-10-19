#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import { GATED } from '../cert/apply.mjs';

export const PINNED = [
  'src/packages/package.json',
  'src/packages/optional/package.json',
  'src/packages/agent/package.json',
];
export const GATE_FILES = [
  ...PINNED,
  'src/packages/tailscale/package.json',
  'src/packages/grammars/package.json',
];
export const BOT = 'github-actions[bot]';
export const RENOVATE = 'renovate[bot]';

const pkg = '(@ai-ecoverse/[a-z0-9._-]+)@([0-9A-Za-z.+-]+)';
const PASSED = new RegExp(`^(?:certified|cert-ci: PASS) ${pkg} sha256=[0-9a-f]{64}\\b`, 'gm');
const NAMED = new RegExp(
  `^(?:\\*\\*Cert review: ${pkg}\\*\\*|(?:certified|cert-ci: PASS|cert-ci: FAIL) ${pkg})`,
  'gm'
);
const CHECKED = /<sub>sha check ok:/;

export function changed(base, head, keep = () => true) {
  const found = new Set();
  for (const path of GATE_FILES) {
    const before = base[path]?.dependencies ?? {};
    for (const [name, version] of Object.entries(head[path]?.dependencies ?? {}))
      if (name.startsWith('@ai-ecoverse/') && keep(name) && before[name] !== version)
        found.add(`${name}@${version}`);
  }
  return [...found].sort();
}

export const LABEL = 'label the PR cert-review';
export const FORK =
  'cert review never runs fork code: push the change to a branch of this repository and open the PR from there';

export function gate(
  pins,
  comments,
  none = 'no pinned @ai-ecoverse package changes',
  hint = LABEL
) {
  if (!pins.length) return { ok: true, line: `cert-gate: PASS ${none}` };
  const reviews = comments.filter((comment) => comment.user === BOT);
  const why = [];
  for (const id of pins) {
    const latest = reviews.findLast((comment) =>
      [...comment.body.matchAll(NAMED)].some(
        (match) => `${match[1] ?? match[3]}@${match[2] ?? match[4]}` === id
      )
    );
    const passed =
      latest &&
      CHECKED.test(latest.body) &&
      [...latest.body.matchAll(PASSED)].some(([, name, version]) => `${name}@${version}` === id);
    if (!latest) why.push(`${id} has no cert review (${hint})`);
    else if (!passed) why.push(`${id} is not certified by its latest cert review`);
  }
  if (why.length) return { ok: false, line: `cert-gate: FAIL ${why.join(', ')}` };
  return { ok: true, line: `cert-gate: CERTIFIED ${pins.join(', ')}` };
}

async function api(path, accept = 'application/vnd.github+json') {
  const response = await fetch(`${env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    headers: {
      accept,
      authorization: `Bearer ${env.GH_TOKEN}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (response.status === 404 && accept.endsWith('.raw')) return null;
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return accept.endsWith('.raw') ? response.text() : response.json();
}

async function manifests(repo, ref) {
  const found = {};
  for (const path of GATE_FILES) {
    const text = await api(
      `/repos/${repo}/contents/${path}?ref=${ref}`,
      'application/vnd.github.raw'
    );
    if (text) found[path] = JSON.parse(text);
  }
  return found;
}

async function comments(repo, number) {
  const all = [];
  for (let page = 1; ; page++) {
    const list = await api(`/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    all.push(...list.map((comment) => ({ user: comment.user?.login, body: comment.body ?? '' })));
    if (list.length < 100) return all;
  }
}

async function main() {
  const event = env.GITHUB_EVENT_NAME ?? '';
  const repo = env.GITHUB_REPOSITORY;
  const payload = env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  const number = Number(payload.pull_request?.number ?? payload.inputs?.pr ?? 0);
  if (!number)
    return { ok: true, line: `cert-gate: PASS ${event || 'this run'} is not for a pull request` };
  const pr = await api(`/repos/${repo}/pulls/${number}`);
  const renovate = pr.user?.login === RENOVATE;
  if (event === 'workflow_dispatch' && pr.head.sha !== env.GITHUB_SHA)
    return {
      ok: false,
      line: `cert-gate: FAIL this run is on ${env.GITHUB_SHA}, #${number}'s head is ${pr.head.sha}`,
    };
  const { merge_base_commit: base } = await api(
    `/repos/${repo}/compare/${pr.base.ref}...${pr.head.sha}`
  );
  const keep = renovate ? () => true : (name) => GATED.test(name);
  const pins = changed(await manifests(repo, base.sha), await manifests(repo, pr.head.sha), keep);
  const none = renovate ? 'no pinned @ai-ecoverse package changes' : 'no gated pin changes';
  const fork = pr.head.repo?.full_name !== repo;
  return gate(pins, await comments(repo, number), none, fork ? FORK : LABEL);
}

if (import.meta.url === `file://${argv[1]}`) {
  const { ok, line } = await main().catch((error) => ({
    ok: false,
    line: `cert-gate: FAIL ${error.message}`,
  }));
  console.log(line);
  if (!ok) exit(1);
}
