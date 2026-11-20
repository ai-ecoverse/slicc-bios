import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { biosApprovalId, createApprovals, SUDO_RUN_PROTOCOL } from '../../src/seed/approvals.js';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const UNSEEN = "The kernel's process list isn't available, so it can't be stopped.";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await pause(1);
  }
  assert.fail(`waited ${ms} ms for ${what}`);
}

function tabs() {
  const open = new Set();
  return () => {
    const end = {
      onmessage: null,
      postMessage(data) {
        for (const other of open)
          if (other !== end)
            setImmediate(() => {
              if (open.has(other)) other.onmessage?.({ data: structuredClone(data) });
            });
      },
      close() {
        open.delete(end);
      },
    };
    open.add(end);
    return end;
  };
}

const lone = () => ({ postMessage() {}, onmessage: null });

const ask = (id) => ({
  id,
  kind: 'sudo',
  path: '/usr/local/bin/job',
  argv: ['/usr/local/bin/job'],
  user: 'cone',
  uid: 1000,
  tag: JSON.stringify({ kind: 'agent', agentId: 'cone' }),
  target: 'root',
  cwd: '/',
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  always: false,
  stdin: 'none',
  rootOnly: { '/': true },
  userWritable: [],
});

function kernelOf(pid) {
  let finish;
  const ended = new Promise((resolve) => {
    finish = resolve;
  });
  const kernel = {
    kills: [],
    answer: async () => ({ status: 0, stdout: '', stderr: '' }),
    finish: (exit) => finish(exit),
    protocol: SUDO_RUN_PROTOCOL,
    sudoRun: async () => ({ pid, pgid: pid, ended }),
    async run(argv) {
      if (argv[0] !== 'kill') return { status: 0, stdout: '', stderr: '' };
      kernel.kills.push(argv);
      return kernel.answer(argv);
    },
  };
  return kernel;
}

function listing(rows) {
  return { ps: async () => rows.map((entry) => ({ ...entry })) };
}

const proc = (pid, pgid, tag, uid = 0) => ({ pid, pgid, uid, state: 'S', tags: [tag] });

async function expire(approvals, req) {
  const ended = new AbortController();
  const pending = approvals.approve(req, { signal: ended.signal });
  const id = biosApprovalId(req.id);
  await until(() => approvals.port.list().some((item) => item.id === id), `${id} to be asked`);
  ended.abort('expired');
  assert.equal(await pending, 'deny');
  return id;
}

const row = (approvals, id) => approvals.port.history().find((entry) => entry.approval.id === id);

test('a run whose leader exits with processes left reports them as survivors, Stop signals exactly those, and the list clears once they are gone', async () => {
  const told = [];
  const kernel = kernelOf(50);
  const rows = [];
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => kernel,
    procs: () => listing(rows),
    pollMs: 5,
    lick: async (notice) => {
      told.push(notice);
    },
  });
  approvals.own();
  const id = await expire(approvals, ask('sudo-survivors-done'));
  const tag = `sudo-run:${id}`;
  await approvals.port.run(id);
  await until(() => row(approvals, id)?.run?.state === 'running', 'the run');
  rows.push(
    { ...proc(50, 50, tag), state: 'Z' },
    proc(51, 50, tag),
    proc(52, 52, tag),
    proc(53, 53, 'sudo-run:bios:another'),
    proc(54, 54, tag, 1000)
  );
  kernel.finish({ status: 0 });
  await until(() => row(approvals, id)?.run?.state === 'done', 'the leader to end');
  assert.equal(row(approvals, id).run.status, 0);
  assert.deepEqual(row(approvals, id).run.survivors, [51, 52]);
  await until(() => told.some((notice) => notice.phase === 'end'), 'the end notice');
  assert.deepEqual(told.find((notice) => notice.phase === 'end').survivors, [51, 52]);
  await approvals.port.stopRun(id);
  assert.deepEqual(kernel.kills, [
    ['kill', '-TERM', '51'],
    ['kill', '-TERM', '52'],
  ]);
  rows.length = 0;
  await until(() => row(approvals, id)?.run?.survivors === undefined, 'the survivors to clear');
  assert.equal(row(approvals, id).run.state, 'done');
  await assert.rejects(approvals.port.stopRun(id), /This request isn't running\./);
  assert.equal(kernel.kills.length, 2);
});

test('a stopped run whose processes outlive the stop reports them, and Stop on survivors a kill could not reach says why', async () => {
  const kernel = kernelOf(60);
  const rows = [];
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => kernel,
    procs: () => listing(rows),
    pollMs: 5,
    lick: async () => {},
  });
  approvals.own();
  const id = await expire(approvals, ask('sudo-survivors-stopped'));
  const tag = `sudo-run:${id}`;
  await approvals.port.run(id);
  await until(() => row(approvals, id)?.run?.state === 'running', 'the run');
  await approvals.port.stopRun(id);
  assert.deepEqual(kernel.kills, [['kill', '-TERM', '-60']]);
  assert.equal(row(approvals, id).run.state, 'stopped');
  rows.push(proc(61, 61, tag));
  kernel.finish({ status: 143, signal: 'SIGTERM' });
  await until(() => row(approvals, id)?.run?.survivors?.length === 1, 'the survivor');
  assert.deepEqual(row(approvals, id).run.survivors, [61]);
  assert.equal(row(approvals, id).run.state, 'stopped');
  kernel.answer = async () => ({
    status: 1,
    stdout: '',
    stderr: 'kill: (61) - Operation not permitted',
  });
  await assert.rejects(approvals.port.stopRun(id), {
    message: 'kill: (61) - Operation not permitted',
  });
  assert.deepEqual(row(approvals, id).run.survivors, [61]);
  kernel.answer = async () => {
    rows.length = 0;
    return { status: 1, stdout: '', stderr: 'kill: (61) - No such process' };
  };
  await approvals.port.stopRun(id);
  await until(() => row(approvals, id)?.run?.survivors === undefined, 'the survivor to clear');
  assert.equal(row(approvals, id).run.state, 'stopped');
});

test('Stop issues no kill for survivors that are forged, stale or foreign, and kills only the one that still carries the run', async () => {
  const open = tabs();
  const ownerEnd = open();
  const owner = createApprovals({ channel: ownerEnd, kernel: () => kernelOf(1), pollMs: 60_000 });
  owner.own();
  const next = kernelOf(2);
  const rows = [];
  const follower = createApprovals({
    channel: open(),
    kernel: () => next,
    procs: () => listing(rows),
    pollMs: 60_000,
    lick: async () => {},
  });
  const id = await expire(owner, ask('sudo-survivors-forged'));
  await until(() => row(follower, id)?.state === 'unanswered', 'the follower to see it');
  const tag = `sudo-run:${id}`;
  rows.push(
    { pid: 61, pgid: 61, uid: 0, state: 'S', tags: [] },
    proc(62, 62, 'sudo-run:bios:another'),
    proc(63, 63, tag, 1000),
    { ...proc(64, 64, tag), state: 'Z' },
    proc(66, 66, tag)
  );
  const forged = open();
  const history = follower.port.history().map((entry) =>
    entry.approval.id === id
      ? {
          ...entry,
          run: {
            state: 'done',
            by: 'you',
            at: Date.now(),
            pid: 60,
            survivors: [1, 61, 62, 63, 64, 65, 66],
          },
        }
      : entry
  );
  forged.postMessage({ history });
  await until(() => row(follower, id)?.run?.survivors?.length === 7, 'the forged survivors');
  forged.close();
  ownerEnd.close();
  follower.own();
  await follower.port.stopRun(id);
  assert.deepEqual(next.kills, [['kill', '-TERM', '66']]);
});

test('Stop issues no kill for a survivor whose pid an untagged process took over between the list and the kill', async () => {
  const kernel = kernelOf(80);
  const tagged = [];
  let reads = 0;
  let reuseAfter = Number.POSITIVE_INFINITY;
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => kernel,
    procs: () => ({
      ps: async () => {
        reads += 1;
        const rows = tagged.map((entry) => ({ ...entry }));
        if (reads >= reuseAfter) tagged[0] = { pid: 81, pgid: 81, uid: 0, state: 'S', tags: [] };
        return rows;
      },
    }),
    pollMs: 60_000,
    lick: async () => {},
  });
  approvals.own();
  const id = await expire(approvals, ask('sudo-survivors-reused'));
  await approvals.port.run(id);
  await until(() => row(approvals, id)?.run?.state === 'running', 'the run');
  tagged.push(proc(81, 81, `sudo-run:${id}`));
  kernel.finish({ status: 0 });
  await until(() => row(approvals, id)?.run?.survivors?.join() === '81', 'the survivor');
  reuseAfter = reads + 1;
  await approvals.port.stopRun(id);
  assert.deepEqual(kernel.kills, []);
  assert.equal(tagged[0].tags.length, 0);
});

test('survivors a closed owner reported clear in the tab that takes over once its kernel lists processes', async () => {
  const open = tabs();
  const ownerEnd = open();
  const kernel = kernelOf(70);
  const rows = [];
  const owner = createApprovals({
    channel: ownerEnd,
    kernel: () => kernel,
    procs: () => listing(rows),
    pollMs: 5,
    lick: async () => {},
  });
  owner.own();
  let list = null;
  const follower = createApprovals({
    channel: open(),
    kernel: () => kernelOf(80),
    procs: () => list,
    pollMs: 5,
    lick: async () => {},
  });
  const id = await expire(owner, ask('sudo-survivors-handoff'));
  await owner.port.run(id);
  rows.push(proc(71, 70, `sudo-run:${id}`));
  kernel.finish({ status: 0 });
  await until(
    () => row(follower, id)?.run?.survivors?.join() === '71',
    'the follower to see the survivor'
  );
  ownerEnd.close();
  follower.own();
  await assert.rejects(follower.port.stopRun(id), { message: UNSEEN });
  assert.deepEqual(row(follower, id).run.survivors, [71]);
  list = listing([]);
  await until(() => row(follower, id)?.run?.survivors === undefined, 'the survivor to clear');
  assert.equal(row(follower, id).run.state, 'done');
});

const ci = Boolean(process.env.CI);

test('browser: a Run now whose script leaves a background process shows it as a survivor until Stop ends it', {
  skip: !ci && 'CI only, no local Chrome',
  timeout: 900_000,
}, async (t) => {
  const chrome = await launch({ timeout: 120_000 });
  after(() => chrome.close());
  const page = await chrome.page(t);
  await page.init(`() => {
    globalThis.sliccKernelDebug = true;
    globalThis.sliccApprovalRunNotice = (notice) => {
      (globalThis.survivorNotices ??= []).push(notice);
      return { delivered: true };
    };
  }`);
  await boot(page);
  const made = await page.evaluate(async () => {
    const approvals = globalThis.sliccApprovals;
    const client = await globalThis.sliccKernelClient();
    const who = await client.run(['id', '-u', 'cone']);
    if (who.status !== 0) throw new Error(who.stderr || 'no cone user');
    const path = '/usr/local/bin/slicc-survivor';
    const install = await client.run([
      'bash',
      '-c',
      [
        'mkdir -p /usr/local/bin',
        `printf '#!/bin/sh\\nsleep 600 &\\necho left\\n' > ${path}`,
        `chown 0:0 /usr /usr/local /usr/local/bin ${path}`,
        `chmod 0755 /usr /usr/local /usr/local/bin ${path}`,
      ].join(' && '),
    ]);
    if (install.status !== 0) throw new Error(install.stderr || install.stdout || 'no install');
    const req = {
      id: `sudo-survivor-${Date.now()}`,
      user: 'cone',
      uid: Number(who.stdout.trim()),
      target: 'root',
      argv: [path],
      path,
      cwd: '/',
      stdin: 'none',
      rootOnly: { '/': true },
      userWritable: [],
      tag: JSON.stringify({ kind: 'agent', agentId: 'cone' }),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      always: false,
    };
    const id = `bios:${req.id}`;
    const ended = new AbortController();
    const pending = approvals.approve(req, { signal: ended.signal });
    for (let i = 0; i < 200 && !approvals.port.list().some((item) => item.id === id); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    ended.abort('expired');
    await pending;
    await approvals.port.run(id);
    return id;
  });

  const left = await page.evaluate(async (id) => {
    const runOf = () =>
      globalThis.sliccApprovals.port.history().find((entry) => entry.approval.id === id)?.run;
    const client = await globalThis.sliccKernelClient();
    const deadline = Date.now() + 60_000;
    let seen = null;
    while (Date.now() < deadline) {
      const run = runOf();
      const rows = run?.survivors?.length ? await client.ps() : [];
      const shown = (run?.survivors ?? []).map((pid) => {
        const found = rows.find((entry) => entry.pid === pid);
        return found
          ? {
              pid,
              ppid: found.ppid,
              pgid: found.pgid,
              uid: found.uid,
              argv: found.argv,
              tags: found.tags ?? (found.tag ? [found.tag] : []),
            }
          : { pid };
      });
      seen = {
        run,
        shown,
        notice: (globalThis.survivorNotices ?? []).find(
          (notice) => notice.id === id && notice.phase === 'end'
        ),
      };
      const sleeping = shown.some((entry) => /\bsleep 600$/.test(entry.argv?.join(' ') ?? ''));
      if (run?.state === 'done' && sleeping && seen.notice) return { ...seen, ready: true };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ...seen, ready: false };
  }, made);
  t.diagnostic(`survivors: ${JSON.stringify(left.shown)}`);
  assert.equal(left.ready, true, `a sleep 600 survivor: ${JSON.stringify(left)}`);
  assert.equal(left.run.status, 0);
  for (const entry of left.shown) {
    assert.ok(entry.tags?.includes(`sudo-run:${made}`), JSON.stringify(entry));
    assert.equal(entry.uid, 0, JSON.stringify(entry));
    assert.notEqual(entry.pid, left.run.pid);
  }
  assert.ok(left.notice.survivors?.length, JSON.stringify(left.notice));
  for (const pid of left.notice.survivors) assert.ok(left.run.survivors.includes(pid));

  await page.evaluate((id) => globalThis.sliccApprovals.port.stopRun(id), made);
  const cleared = await page.evaluate(
    async ({ id, pids }) => {
      const runOf = () =>
        globalThis.sliccApprovals.port.history().find((entry) => entry.approval.id === id)?.run;
      const client = await globalThis.sliccKernelClient();
      const deadline = Date.now() + 60_000;
      let seen = null;
      while (Date.now() < deadline) {
        const rows = await client.ps();
        const alive = rows
          .filter((entry) => pids.includes(entry.pid) && entry.state !== 'Z')
          .map((entry) => ({ pid: entry.pid, argv: entry.argv }));
        seen = { run: runOf(), alive };
        if (!seen.run?.survivors && !alive.length) return { ...seen, ready: true };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ...seen, ready: false };
    },
    { id: made, pids: left.run.survivors }
  );
  assert.equal(cleared.ready, true, `Stop to end the survivors: ${JSON.stringify(cleared)}`);
  assert.equal(cleared.run.state, 'done');
  assert.deepEqual(page.errors, []);
});
