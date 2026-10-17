import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { SHARDS } from '../../scripts/canary/plan.mjs';

const root = new URL('../../', import.meta.url);
const ci = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
const canary = JSON.parse(await readFile(new URL('scripts/canary/shards.json', root), 'utf8'));
const files = (await readdir(new URL('test/integration/', root)))
  .filter((file) => file.endsWith('.test.mjs'))
  .sort()
  .map((file) => `test/integration/${file}`);
const SHARDED = ci.match(/^ {2}SHARDED: '([^']+)'$/m)[1];
const sharded = new RegExp(SHARDED);

function matrix() {
  const start = ci.indexOf('        include:\n');
  const block = ci.slice(start, ci.indexOf('\n    env:', start));
  return [...block.matchAll(/- shard: (\S+)\n\s+match: '([^']*)'(?:\n\s+variants: (\S+))?/g)].map(
    ([, shard, match, variants]) => ({ shard, match, variants: variants ?? null })
  );
}

const shards = matrix();
const named = shards.filter(({ shard }) => shard !== 'rest');
const runs = (shard) => files.filter((file) => new RegExp(shard.match).test(file));

test("ci.yml's shards and the canary's are the same, with the same files and variants", () => {
  const names = shards.map(({ shard }) => shard);
  assert.deepEqual(names, SHARDS);
  assert.deepEqual(
    names,
    Object.keys(canary).filter((name) => name !== 'sweep')
  );
  for (const { shard, match, variants } of named) {
    assert.equal(canary[shard].match, match, shard);
    assert.equal(canary[shard].env?.GUARD_VARIANTS ?? null, variants, shard);
  }
  assert.deepEqual(shards.at(-1), { shard: 'rest', match: '', variants: null });
  assert.equal(canary.rest.exclude, SHARDED);
});

test('every test file runs in a shard, and rest takes exactly what no other shard matches', () => {
  for (const shard of named) assert.ok(runs(shard).length > 0, `${shard.shard} matches no file`);
  for (const file of files) {
    assert.equal(
      sharded.test(file),
      named.some((shard) => new RegExp(shard.match).test(file)),
      file
    );
  }
  assert.ok(
    files.some((file) => !sharded.test(file)),
    'rest runs no file'
  );
});

test('the shards that split a guard-set file run every variant of the pinned set once', () => {
  const variants = Object.keys(set.variants).sort();
  const split = new Map();
  for (const shard of shards.filter(({ variants: list }) => list)) {
    for (const file of runs(shard)) {
      assert.match(file, /\/guard-set-[a-z]+\.test\.mjs$/, shard.shard);
      split.set(file, [...(split.get(file) ?? []), ...shard.variants.split(',')]);
    }
  }
  assert.ok(split.size > 0, 'no shard splits a guard-set file');
  for (const [file, ran] of split) {
    assert.deepEqual([...ran].sort(), variants, file);
    for (const shard of named.filter(({ variants: list }) => !list)) {
      assert.ok(!runs(shard).includes(file), `${shard.shard} runs ${file} whole`);
    }
  }
});
