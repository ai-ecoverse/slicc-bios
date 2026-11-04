import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const AGENT = new URL('../../src/packages/agent/', import.meta.url);
const HOUR = 60 * 60 * 1000;

async function checkReleaseAge(
  project,
  { fetcher = fetch, now = Date.now(), timeout = 15000 } = {}
) {
  const workspace = await readFile(new URL('pnpm-workspace.yaml', project), 'utf8');
  const gate = workspace.match(/^minimumReleaseAge: (\d+)\s*$/m);
  assert.ok(gate, 'agent workspace must declare minimumReleaseAge in minutes');
  const minimum = Number(gate[1]) * 60 * 1000 + HOUR;
  const lock = await readFile(new URL('pnpm-lock.yaml', project), 'utf8');
  const section = lock.match(/^packages:\n([\s\S]*?)(?=^\S|(?![\s\S]))/m)?.[1];
  assert.ok(section, 'agent lockfile must contain a packages section');
  const packages = new Map();
  for (const line of section.split('\n').filter((row) => /^ {2}\S/.test(row))) {
    const entry = line.match(
      /^ {2}'?((?:@[^/\s]+\/)?[^@'\s]+)@(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)'?:$/
    );
    assert.ok(entry, `unsupported agent lockfile entry: ${line}`);
    const [, name, version] = entry;
    if (name.startsWith('@ai-ecoverse/')) continue;
    if (!packages.has(name)) packages.set(name, new Set());
    packages.get(name).add(version);
  }
  assert.ok(packages.size, 'agent lockfile must contain third-party packages');
  const queue = [...packages];
  const young = [];
  const errors = [];
  async function worker() {
    while (queue.length) {
      const [name, versions] = queue.shift();
      try {
        const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const packument = await response.json();
        for (const version of versions) {
          const published = packument.time?.[version];
          const at = typeof published === 'string' ? Date.parse(published) : NaN;
          if (!Number.isFinite(at)) throw new Error(`missing or invalid time[${version}]`);
          const ready = at + minimum;
          if (now < ready) {
            young.push(
              `${name}@${version}: published ${published}; old enough ${new Date(ready).toISOString()} (including one-hour margin)`
            );
          }
        }
      } catch (error) {
        errors.push(`${name}: registry lookup failed: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, () => worker()));
  assert.equal(
    errors.length + young.length,
    0,
    [
      `Agent dependencies must clear minimumReleaseAge=${gate[1]} minutes plus one hour.`,
      ...errors.sort(),
      ...young.sort(),
    ].join('\n')
  );
}

test('shipped agent dependencies clear the workspace release-age gate before beta and owner-pin resolution', {
  timeout: 600000,
}, async () => {
  await checkReleaseAge(AGENT);
});

test('agent release-age gate uses the workspace file and registry publish times without the network', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-release-age-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = pathToFileURL(`${directory}/`);
  const workspace = new URL('pnpm-workspace.yaml', project);
  await writeFile(
    workspace,
    "minimumReleaseAge: 120\nminimumReleaseAgeExclude:\n  - '@ai-ecoverse/*'\n"
  );
  await writeFile(
    new URL('pnpm-lock.yaml', project),
    `lockfileVersion: '9.0'
packages:
  '@ai-ecoverse/young@1.0.0':
    resolution: {}
  '@third/young@2.0.0-beta.1':
    resolution: {}
  old@1.0.0:
    resolution: {}
  old@2.0.0:
    resolution: {}
snapshots:
  ignored@1.0.0: {}
`
  );
  const now = Date.parse('2026-11-04T12:00:00.000Z');
  const requested = [];
  const fetcher = async (url, { signal }) => {
    assert.ok(signal instanceof AbortSignal);
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    requested.push(name);
    assert.ok(!name.startsWith('@ai-ecoverse/'));
    return {
      ok: true,
      json: async () => ({
        time:
          name === 'old'
            ? { '1.0.0': '2020-01-01T00:00:00.000Z', '2.0.0': '2020-01-02T00:00:00.000Z' }
            : { '2.0.0-beta.1': '2026-11-04T09:30:00.000Z' },
      }),
    };
  };
  await assert.rejects(
    checkReleaseAge(project, { fetcher, now }),
    /@third\/young@2\.0\.0-beta\.1: published 2026-11-04T09:30:00.000Z; old enough 2026-11-04T12:30:00.000Z/
  );
  assert.deepEqual(requested.sort(), ['@third/young', 'old']);
  await checkReleaseAge(project, { fetcher, now: now + HOUR / 2 });
  await writeFile(workspace, 'minimumReleaseAge: 60\n');
  await checkReleaseAge(project, { fetcher, now });
  await assert.rejects(
    checkReleaseAge(project, { fetcher: async () => ({ ok: false, status: 503 }), now }),
    /registry lookup failed: HTTP 503/
  );
  await assert.rejects(
    checkReleaseAge(project, { fetcher: async () => ({ ok: true, json: async () => ({}) }), now }),
    /missing or invalid time/
  );
  await assert.rejects(
    checkReleaseAge(project, {
      fetcher: async () => {
        throw new Error('request timed out');
      },
      now,
    }),
    /registry lookup failed: request timed out/
  );
});

test('agent registry lookups bound concurrency and abort on timeout', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-release-age-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = pathToFileURL(`${directory}/`);
  await writeFile(new URL('pnpm-workspace.yaml', project), 'minimumReleaseAge: 60\n');
  await writeFile(
    new URL('pnpm-lock.yaml', project),
    `packages:\n${Array.from({ length: 14 }, (_, i) => `  package-${i}@1.0.0:\n    resolution: {}`).join('\n')}\n`
  );
  let active = 0;
  let peak = 0;
  let calls = 0;
  await checkReleaseAge(project, {
    fetcher: async () => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { ok: true, json: async () => ({ time: { '1.0.0': '2020-01-01T00:00:00.000Z' } }) };
    },
  });
  assert.equal(calls, 14);
  assert.equal(peak, 6);
  await assert.rejects(
    checkReleaseAge(project, {
      timeout: 5,
      fetcher: async (_url, { signal }) => {
        await setTimeout(1000, undefined, { signal });
        assert.fail('registry request should have been aborted');
      },
    }),
    /registry lookup failed: The operation was aborted/
  );
});
