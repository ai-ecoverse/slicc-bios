#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export const REQUIRED = {
  'pins.test.mjs': /^\s*(?:ℹ\s*)?pins: PASS \d+ packages\s*$/m,
};

export function summary(text) {
  const clean = text.replace(ANSI, '');
  const count = (name) => {
    const found = [...clean.matchAll(new RegExp(`^ℹ ${name} (\\d+)\\s*$`, 'gm'))];
    return found.length ? Number(found.at(-1)[1]) : null;
  };
  const tests = count('tests');
  if (tests === null) return null;
  return {
    tests,
    pass: count('pass') ?? 0,
    fail: count('fail') ?? 0,
    cancelled: count('cancelled') ?? 0,
    skipped: count('skipped') ?? 0,
    todo: count('todo') ?? 0,
  };
}

export function missingRequired(text, files = []) {
  const clean = text.replace(ANSI, '');
  return files
    .filter((file) => REQUIRED[basename(file)] && !REQUIRED[basename(file)].test(clean))
    .map((file) => `${basename(file)} printed no verdict line`);
}

export function shardVerdict(name, text, files = []) {
  const counts = summary(text);
  const why = [];
  if (!counts) why.push('no test summary');
  else {
    if (counts.fail) why.push(`${counts.fail} failed`);
    if (counts.cancelled) why.push(`${counts.cancelled} cancelled`);
    if (!counts.pass) why.push('0 tests passed');
  }
  why.push(...missingRequired(text, files));
  if (why.length) return { ok: false, line: `shard ${name}: FAIL ${why.join(', ')}` };
  return { ok: true, line: `shard ${name}: PASS ${counts.pass} tests` };
}

const SHARD_LINE = /^shard (\S+): (PASS \d+ tests|FAIL .*)$/;

function jobProblems(results, mode, skip) {
  const why = [];
  for (const [job, result] of Object.entries(results)) {
    const want = skip.includes(job) ? 'skipped' : 'success';
    if (result === want) continue;
    const note = want === 'skipped' ? `, but the ${mode} plan skips it` : '';
    why.push(`${job}: ${result || 'no result'}${note}`);
  }
  if (mode === 'full' && skip.length) why.push(`a full plan skips ${skip.join(' and ')}`);
  return why;
}

export function shardsVerdict(expected, lines, results = {}, { mode = 'full', skip = [] } = {}) {
  const seen = new Map();
  for (const line of lines) {
    const match = line.trim().match(SHARD_LINE);
    if (match) seen.set(match[1], match[2]);
  }
  const why = [];
  for (const name of expected) {
    const verdict = seen.get(name);
    if (!verdict) why.push(`${name}: no verdict`);
    else if (!verdict.startsWith('PASS')) why.push(`${name}: ${verdict}`);
  }
  why.push(...jobProblems(results, mode, skip));
  const skipsShards = skip.includes('integration');
  if (!expected.length && !skipsShards) why.push('no shards expected');
  if (expected.length && skipsShards) why.push('shards expected, but the plan skips integration');
  if (why.length) return { ok: false, line: `ci: FAIL ${why.join('; ')}` };
  if (mode === 'full') return { ok: true, line: `ci: PASS ${expected.length} shards` };
  const skipped = skip.length ? `, skipped ${skip.join(' and ')}` : '';
  return { ok: true, line: `ci: PASS ${mode} plan, ${expected.length} shards${skipped}` };
}

export function releaseVerdict(text, tag) {
  if (/^v\d+\.\d+\.\d+$/.test(tag ?? '')) return { ok: true, line: `release: ${tag}` };
  const clean = text.replace(ANSI, '');
  if (/There are no relevant changes, so no new version is released/.test(clean)) {
    const last = clean.match(/Found git tag (v\d+\.\d+\.\d+) associated with version/);
    return {
      ok: true,
      line: `release: NONE no releasable commits since ${last?.[1] ?? 'the last tag'}`,
    };
  }
  return {
    ok: false,
    line: 'release: FAIL semantic-release named no new tag and no "no relevant changes"',
  };
}

export function publishVerdict(name, version, published, already) {
  if (published !== version) {
    return {
      ok: false,
      line: `published: FAIL npm has ${published || 'nothing'} for ${name}@${version}`,
    };
  }
  return { ok: true, line: `published: ${name}@${version}${already ? ' (already on npm)' : ''}` };
}

async function say({ ok, line }, out) {
  console.log(line);
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${line}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (!ok) exit(1);
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: 'string', default: '' },
      log: { type: 'string', default: '' },
      files: { type: 'string', default: '' },
      out: { type: 'string', default: '' },
      dir: { type: 'string', default: '' },
      expect: { type: 'string', default: '' },
      results: { type: 'string', default: '{}' },
      mode: { type: 'string', default: 'full' },
      skip: { type: 'string', default: '' },
      tag: { type: 'string', default: '' },
      version: { type: 'string', default: '' },
      published: { type: 'string', default: '' },
      already: { type: 'boolean', default: false },
    },
  });
  const text = (path) => (path ? readFile(path, 'utf8').catch(() => '') : '');
  if (command === 'shard') {
    const files = values.files.split(/\s+/).filter(Boolean);
    await say(shardVerdict(values.name, await text(values.log), files), values.out);
  } else if (command === 'shards') {
    const expected = values.expect.split(/\s+/).filter(Boolean);
    const lines = [];
    for (const name of expected)
      lines.push(...(await text(join(values.dir, `${name}.txt`))).split('\n'));
    const skip = values.skip.split(/\s+/).filter(Boolean);
    await say(
      shardsVerdict(expected, lines, JSON.parse(values.results), { mode: values.mode, skip })
    );
  } else if (command === 'release') {
    await say(releaseVerdict(await text(values.log), values.tag));
  } else if (command === 'publish') {
    await say(publishVerdict(values.name, values.version, values.published, values.already));
  } else {
    console.error(`verdict: unknown command ${command ?? ''}`);
    exit(2);
  }
}
