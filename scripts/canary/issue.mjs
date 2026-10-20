import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const exec = promisify(execFile);
export const TITLE = 'canary: the scheduled canary is red';
export const LABEL = 'known-issue';

export function issueText(result, inputs = {}, url = '') {
  const offers = Object.entries(inputs.catalog ?? {}).map(
    ([name, version]) => `- \`${name}@${version ?? 'nothing offered'}\``
  );
  const overrides = (inputs.overrides ?? []).map((spec) => `- \`${spec}\``);
  const lines = [
    `**${result.verdict ?? 'canary: FAIL with no verdict'}**`,
    '',
    url ? `Run: ${url}` : 'Run: (no URL)',
    '',
    ...(overrides.length ? ['Overrides:', ...overrides, ''] : []),
    ...(offers.length
      ? ['What the optional catalog offered (npm `latest` through the gate):', ...offers, '']
      : []),
    'A bad homescoop `latest` reaches seven before bios CI sees it: deny it in homescoop’s certification-exceptions.json, or fix it upstream.',
  ];
  return { title: TITLE, body: lines.join('\n') };
}

async function gh(args) {
  const { stdout } = await exec('gh', args, { env });
  return stdout.trim();
}

export async function file({ result, inputs, url, repo, run = gh }) {
  if (result.ok) return 'canary issue: PASS the canary is green, nothing to file';
  const { title, body } = issueText(result, inputs, url);
  const found = JSON.parse(
    await run([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--label',
      LABEL,
      '--search',
      `"${title}" in:title`,
      '--json',
      'number,title',
    ])
  ).find((issue) => issue.title === title);
  if (found) {
    await run(['issue', 'comment', String(found.number), '--repo', repo, '--body', body]);
    return `canary issue: commented on #${found.number}`;
  }
  const made = await run([
    'issue',
    'create',
    '--repo',
    repo,
    '--title',
    title,
    '--label',
    LABEL,
    '--body',
    body,
  ]);
  return `canary issue: filed ${made}`;
}

const json = async (path, fallback) =>
  JSON.parse(await readFile(path, 'utf8').catch(() => JSON.stringify(fallback)));

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { dir: { type: 'string', default: 'canary' }, inputs: { type: 'string' } },
  });
  const result = await json(join(values.dir, 'result.json'), {
    ok: false,
    verdict: 'canary: FAIL the report left no result.json',
  });
  const inputs = values.inputs ? await json(values.inputs, {}) : {};
  console.log(
    await file({ result, inputs, url: env.RUN_URL ?? '', repo: env.GITHUB_REPOSITORY ?? '' })
  );
}
