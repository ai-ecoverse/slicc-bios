import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { SHARDS } from '../../scripts/canary/plan.mjs';
import { refresh } from '../../scripts/ci/durations.mjs';
import {
  arm,
  assign,
  SHARDS as CI_SHARDS,
  cost,
  items,
  prNumber,
  SPLIT,
  VARIANTS,
} from '../../scripts/ci/plan.mjs';
import {
  attribute,
  decide,
  failing,
  flips,
  groups,
  itemOf,
  timings,
  trapLine,
  trapped,
} from '../../scripts/ci/shard.mjs';
import {
  body,
  combine,
  key,
  occurrence,
  TRAP_TEST,
  title,
  trapFlips,
} from '../../scripts/ci/summary.mjs';
import { trapRecorder } from './chrome.mjs';

const root = new URL('../../', import.meta.url);
const ci = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
const canary = JSON.parse(await readFile(new URL('scripts/canary/shards.json', root), 'utf8'));
const durations = JSON.parse(await readFile(new URL('scripts/ci/durations.json', root), 'utf8'));
const files = (await readdir(new URL('test/integration/', root)))
  .filter((file) => file.endsWith('.test.mjs'))
  .sort()
  .map((file) => `test/integration/${file}`);
const named = Object.entries(canary)
  .filter(([name]) => name !== 'rest' && name !== 'sweep')
  .map(([shard, { match, env }]) => ({ shard, match, variants: env?.GUARD_VARIANTS ?? null }));
const sharded = new RegExp(canary.rest.exclude);
const runs = (shard) => files.filter((file) => new RegExp(shard.match).test(file));

test("the canary's default shards are its shards.json, in order, without sweep", () => {
  assert.deepEqual(
    SHARDS,
    Object.keys(canary).filter((name) => name !== 'sweep')
  );
  assert.equal(SHARDS.at(-1), 'rest');
});

test("every test file runs in one of the canary's shards, and rest takes exactly what no other shard matches", () => {
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

const VARIANTS_SPLIT = /\/(?:guard-set-[a-z]+|guard-vectors)\.test\.mjs$/;

test("the canary's shards that split a guard-set or guard-vectors file run every variant of the pinned set once", () => {
  const variants = Object.keys(set.variants).sort();
  const split = new Map();
  for (const shard of named.filter(({ variants: list }) => list)) {
    for (const file of runs(shard)) {
      assert.match(file, VARIANTS_SPLIT, shard.shard);
      split.set(file, [...(split.get(file) ?? []), ...shard.variants.split(',')]);
    }
  }
  assert.ok(split.size > 0, 'no shard splits a guard-set file');
  assert.ok(split.has('test/integration/guard-vectors.test.mjs'), 'no shard splits guard-vectors');
  for (const [file, ran] of split) {
    assert.deepEqual([...ran].sort(), variants, file);
    for (const shard of named.filter(({ variants: list }) => !list)) {
      assert.ok(!runs(shard).includes(file), `${shard.shard} runs ${file} whole`);
    }
  }
});

test("ci's plan splits each guard-set file into the pinned set's variants, and every other file is one item", () => {
  assert.deepEqual([...VARIANTS].sort(), Object.keys(set.variants).sort());
  const list = items(files);
  for (const file of files) {
    const own = list.filter((item) => item.split('#')[0] === file);
    if (SPLIT.test(file)) assert.deepEqual(own.sort(), VARIANTS.map((v) => `${file}#${v}`).sort());
    else assert.deepEqual(own, [file]);
  }
});

test("ci's plan puts every item in exactly one shard, the same for a seed and different across seeds", () => {
  const list = items(files);
  const a = assign(list, durations, { seed: 39039722838 });
  const b = assign(list, durations, { seed: 39039722838 });
  const c = assign(list, durations, { seed: 7 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(
    a.map(({ items: group }) => group),
    c.map(({ items: group }) => group)
  );
  assert.ok(a.length <= CI_SHARDS);
  assert.deepEqual(a.flatMap(({ items: group }) => group).sort(), [...list].sort());
  assert.deepEqual(
    a.map(({ shard }) => shard),
    a.map((_, index) => `s${String(index + 1).padStart(2, '0')}`)
  );
});

test("ci's plan keeps every shard within the longest item or 1.5 times the even share", () => {
  const list = items(files);
  const seconds = cost(durations);
  const total = list.reduce((sum, item) => sum + seconds(item), 0);
  const longest = Math.max(...list.map(seconds));
  for (const seed of [1, 2, 3, 39039722838, 4294967295]) {
    for (const { shard, seconds: load } of assign(list, durations, { seed })) {
      assert.ok(
        load <= Math.max(longest, (1.5 * total) / CI_SHARDS),
        `seed ${seed}: ${shard} ${load} s`
      );
    }
  }
});

test("ci's plan names the pull request of a run and of a merge queue run, and every run fails fast and retries", () => {
  assert.equal(prNumber('pull_request', { pull_request: { number: 513 } }), 513);
  assert.equal(
    prNumber('merge_group', {
      merge_group: {
        head_ref:
          'refs/heads/gh-readonly-queue/main/pr-505-7f508e0818fba6c48702eea100b505d677b8d6ed',
      },
    }),
    505
  );
  assert.equal(prNumber('push', {}), null);
  for (const pr of [null, 512, 513]) {
    assert.deepEqual(arm(pr), { pr, arm: 'fail-fast+retry', failFast: true, retry: true });
  }
});

test('ci.yml takes its matrix, fail-fast and retry from the plan', () => {
  assert.match(ci, /fail-fast: \$\{\{ needs\.plan\.outputs\.failfast == 'true' \}\}/);
  assert.match(ci, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/);
  assert.match(ci, /--retry "\$RETRY"/);
  assert.match(ci, /--expect "\$SHARDS"/);
});

test('a shard runs each guard-set file on its own with its variants, and its other files with the first one', () => {
  const p = 'test/integration/guard-set-proxy.test.mjs';
  const e = 'test/integration/guard-set-extension.test.mjs';
  const a = 'test/integration/a.test.mjs';
  assert.deepEqual(groups([a]), [{ env: {}, files: [a] }]);
  assert.deepEqual(groups([`${p}#lagging`, a, `${e}#lagging`]), [
    { env: { GUARD_VARIANTS: 'lagging' }, files: [a, p] },
    { env: { GUARD_VARIANTS: 'lagging' }, files: [e] },
  ]);
  assert.deepEqual(groups([`${p}#lagging`, `${e}#prompt`, `${p}#prompt`]), [
    { env: { GUARD_VARIANTS: 'lagging,prompt' }, files: [p] },
    { env: { GUARD_VARIANTS: 'prompt' }, files: [e] },
  ]);
});

test("a guard-set test reported from its helper module counts for the run's guard-set file", () => {
  const p = 'test/integration/guard-set-proxy.test.mjs';
  const a = 'test/integration/a.test.mjs';
  const results = [
    { file: a, name: 'x', status: 'fail' },
    {
      file: 'test/integration/guard-set.mjs',
      name: 'on the proxy path, lagging detach',
      status: 'pass',
    },
  ];
  assert.deepEqual(
    attribute(results, [a, p]).map(({ file }) => file),
    [a, p]
  );
  assert.deepEqual(failing(attribute(results, [a, p]), [a, p], 1), [a]);
  assert.deepEqual(attribute(results, [a]), results);
});

test('a shard retries the files with a failing test, and the ones a crash left without results', () => {
  const list = ['a.test.mjs', 'b.test.mjs', 'c.test.mjs'];
  const results = [
    { file: 'a.test.mjs', status: 'pass' },
    { file: 'b.test.mjs', status: 'fail' },
  ];
  assert.deepEqual(failing(results, list, 1), ['b.test.mjs', 'c.test.mjs']);
  assert.deepEqual(failing(results, list, 0), ['b.test.mjs']);
});

test('a shard passes on a retry only when the retried files pass and the rest printed their verdicts', () => {
  const log = (pass, fail) => `ℹ tests ${pass + fail}\nℹ pass ${pass}\nℹ fail ${fail}\n`;
  const pins = 'test/integration/pins.test.mjs';
  const flaky = 'test/integration/shell.test.mjs';
  const first = { files: [pins, flaky], log: `ℹ pins: PASS 12 packages\n${log(6, 1)}` };
  assert.deepEqual(decide({ name: 's01', first, retried: null }), {
    ok: false,
    pass: 6,
    why: ['1 failed'],
  });
  assert.deepEqual(decide({ name: 's01', first, retried: { files: [flaky], log: log(1, 0) } }), {
    ok: true,
    pass: 7,
    why: [],
  });
  assert.equal(
    decide({ name: 's01', first, retried: { files: [flaky], log: log(0, 1) } }).ok,
    false
  );
  const silent = { files: [pins, flaky], log: log(6, 1) };
  assert.equal(
    decide({ name: 's01', first: silent, retried: { files: [flaky], log: log(1, 0) } }).ok,
    false
  );
});

test("a shard times each item from its top-level tests, a guard-set file's by the variant in the test's name", () => {
  const p = 'test/integration/guard-set-proxy.test.mjs';
  const extra = { GUARD_VARIANTS: 'lagging,prompt' };
  assert.equal(itemOf('test/integration/a.test.mjs', 'x', extra), 'test/integration/a.test.mjs');
  assert.equal(
    itemOf(p, 'the shared guard vectors … on the proxy path, prompt detach', extra),
    `${p}#prompt`
  );
  assert.equal(itemOf(p, 'the shared set is complete on the proxy path', extra), `${p}#lagging`);
  assert.equal(itemOf(p, 'anything', {}), p);
  assert.deepEqual(
    timings(
      [
        { file: 'test/integration/a.test.mjs', name: 'one', nesting: 0, durationMs: 100 },
        { file: 'test/integration/a.test.mjs', name: 'sub', nesting: 1, durationMs: 60 },
        { file: 'test/integration/a.test.mjs', name: 'two', nesting: 0, durationMs: 50 },
        { file: p, name: 'on the proxy path, lagging detach', nesting: 0, durationMs: 900 },
      ],
      extra
    ),
    { 'test/integration/a.test.mjs': 150, [`${p}#lagging`]: 900 }
  );
});

test('a flip is a top-level test that failed on the first run and passed on the retry', () => {
  const first = {
    results: [
      { file: 'a.test.mjs', name: 'flaky', nesting: 0, status: 'fail', log: 'boom' },
      { file: 'a.test.mjs', name: 'broken', nesting: 0, status: 'fail', log: 'always' },
      { file: 'a.test.mjs', name: 'inner', nesting: 1, status: 'fail', log: 'inner' },
      { file: 'a.test.mjs', name: 'fine', nesting: 0, status: 'pass', log: '' },
    ],
  };
  const retried = {
    results: [
      { file: 'a.test.mjs', name: 'flaky', nesting: 0, status: 'pass', log: '' },
      { file: 'a.test.mjs', name: 'broken', nesting: 0, status: 'fail', log: 'always' },
      { file: 'a.test.mjs', name: 'inner', nesting: 1, status: 'pass', log: '' },
    ],
  };
  assert.deepEqual(flips(first, retried), [{ file: 'a.test.mjs', name: 'flaky', log: 'boom' }]);
  assert.deepEqual(flips(first, null), []);
});

test("a run's summary joins the plan and the shard records, with every shard's timings and flips", () => {
  const summary = combine(
    {
      event: 'merge_group',
      pr: 514,
      arm: 'retry',
      seed: 9,
      shards: [{ shard: 's01' }, { shard: 's02' }],
    },
    [
      {
        shard: 's02',
        run: '7',
        attempt: '1',
        sha: 'abc',
        ok: true,
        wallMs: 5,
        items: ['b'],
        timings: { b: 20 },
        flips: [],
        groups: [],
      },
      {
        shard: 's01',
        run: '7',
        attempt: '1',
        sha: 'abc',
        ok: true,
        wallMs: 9,
        items: ['a'],
        timings: { a: 10 },
        flips: [{ file: 'a', name: 'flaky', log: 'boom' }],
        groups: [{ retry: { files: ['a'] } }],
      },
    ]
  );
  assert.equal(summary.run, '7');
  assert.equal(summary.arm, 'retry');
  assert.deepEqual(summary.planned, ['s01', 's02']);
  assert.deepEqual(summary.timings, { a: 10, b: 20 });
  assert.deepEqual(
    summary.shards.map(({ shard, retried, flips: n }) => [shard, retried, n]),
    [
      ['s01', ['a'], 1],
      ['s02', [], 0],
    ]
  );
  assert.deepEqual(summary.flips, [{ file: 'a', name: 'flaky', log: 'boom', shard: 's01' }]);
  assert.deepEqual(summary.traps, []);
});

test('each pnpm wasm trap retry a page warns about is recorded once, with its test, unless the test forces the trap itself', () => {
  const listeners = [];
  const cdp = { on: (listener) => listeners.push(listener) };
  const written = [];
  let current = { file: 'test/integration/agent.test.mjs', name: 'installs', forced: false };
  trapRecorder(
    cdp,
    () => current,
    (file, text) => written.push([String(file), JSON.parse(text)])
  );
  const warn = (value, type = 'warning') =>
    listeners[0]({ method: 'Runtime.consoleAPICalled', params: { type, args: [{ value }] } });
  warn(
    'bios: pnpm trapped (pnpm: wasm trap in thread 4: memory access out of bounds), the wasm trap of homescoop#1127, slicc-kernel#1172; retrying once'
  );
  warn("bios: pnpm's retry after the wasm trap succeeded (homescoop#1127, slicc-kernel#1172)");
  warn('pnpm trapped twice with the wasm trap of homescoop#1127, slicc-kernel#1172 (x)');
  warn('bios: pnpm trapped (x)', 'log');
  warn('something else');
  listeners[0]({ method: 'Runtime.exceptionThrown', params: {} });
  current = { ...current, forced: true };
  warn('bios: pnpm trapped (forced)');
  current = null;
  warn('bios: pnpm trapped (no test)');
  assert.equal(written.length, 1, 'one line per retry, not one per warning');
  assert.match(written[0][0], /\/artifacts\/pnpm-traps\/\d+\.jsonl$/);
  assert.deepEqual(
    written.map(([, { file, name, line }]) => [file, name, line.slice(0, 22)]),
    [['test/integration/agent.test.mjs', 'installs', 'bios: pnpm trapped (pn']]
  );
  assert.match(written[0][1].at, /^\d{4}-/);
});

test('a shard collects its recorded pnpm traps in time order, says so in a line of its own, and the summary files them as one flaky issue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traps-'));
  try {
    assert.deepEqual(await trapped(join(dir, 'missing')), []);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, '2.jsonl'),
      `${JSON.stringify({ file: 'b', name: 'y', line: 'l2', at: '2026-10-19T02:00:00Z' })}\n`
    );
    await writeFile(
      join(dir, '1.jsonl'),
      `${JSON.stringify({ file: 'a', name: 'x', line: 'l1', at: '2026-10-19T01:00:00Z' })}\n\n`
    );
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    const traps = await trapped(dir);
    assert.deepEqual(
      traps.map(({ line }) => line),
      ['l1', 'l2']
    );
    assert.equal(trapLine('s03', []), null);
    assert.equal(
      trapLine('s03', [...traps, traps[0]]),
      'shard s03: pnpm hit the wasm trap 3x (homescoop#1127), retried in a › x; b › y'
    );
    const summary = combine(null, [
      { shard: 's02', traps: [traps[1]] },
      { shard: 's01', traps: [traps[0]] },
      { shard: 's03' },
    ]);
    assert.deepEqual(
      summary.traps.map(({ shard, line }) => [shard, line]),
      [
        ['s01', 'l1'],
        ['s02', 'l2'],
      ]
    );
    const [flip] = trapFlips(summary);
    assert.equal(key(flip), key(TRAP_TEST));
    assert.equal(flip.shard, 's01 s02');
    assert.equal(flip.log, 's01 a › x: l1\ns02 b › y: l2');
    assert.deepEqual(trapFlips(combine(null, [{ shard: 's01' }])), []);
    assert.equal(
      title(flip),
      'flaky: update.js › pnpm hit the wasm trap and was retried (homescoop#1127)'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a flaky-test issue names the test, links the run, quotes the error, and carries a stable key', () => {
  const flip = {
    file: 'test/integration/shell.test.mjs',
    name: 'pipes ```work```',
    log: 'Error: ~~~~ boom',
    shard: 's03',
  };
  const summary = {
    run: '7',
    attempt: '2',
    event: 'merge_group',
    pr: 514,
    arm: 'retry',
    sha: 'abc',
  };
  assert.equal(key(flip), key({ ...flip, log: 'other', shard: 's09' }));
  assert.notEqual(key(flip), key({ ...flip, name: 'other' }));
  assert.equal(title(flip), 'flaky: shell.test.mjs › pipes ```work```');
  assert.ok(title({ file: 'a', name: 'x'.repeat(400) }).length <= 240);
  const text = body(flip, summary, 'https://github.com', 'ai-ecoverse/slicc-bios');
  assert.match(
    text,
    /https:\/\/github\.com\/ai-ecoverse\/slicc-bios\/actions\/runs\/7\/attempts\/2/
  );
  assert.match(text, /PR #514, arm retry, shard s03/);
  assert.ok(text.includes(`Key: \`${key(flip)}\``));
  assert.equal(text.split('\n~~~~').length, 3, 'the error sits in one fence that it cannot close');
  assert.ok(!occurrence(flip, summary, 'https://github.com', 'r').includes('Key:'));
});

test('durations take the median of the recorded runs, keep the rest, and drop items that are gone', () => {
  const updated = refresh(
    { a: 30, b: 40, gone: 50 },
    [{ timings: { a: 10000, c: 4000 } }, { timings: { a: 20000 } }, { timings: { a: 60000 } }, {}],
    ['a', 'b', 'c', 'd']
  );
  assert.deepEqual(updated, { a: 20, b: 40, c: 4 });
});
