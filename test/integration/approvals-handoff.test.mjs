import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  biosApprovalId,
  createApprovals,
  hostApprovals,
  SUDO_RUN_PROTOCOL,
} from '../../src/seed/approvals.js';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const UNSEEN = "The kernel's process list isn't available, so it can't be stopped.";
const INTERRUPTED = 'The tab that started it closed before it ran.';
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

const ask = (id, fields = {}) => ({
  id,
  kind: 'sudo',
  path: '/usr/local/bin/job',
  argv: ['/usr/local/bin/job', '--long'],
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
  ...fields,
});

function kernelOf({ hang = false } = {}) {
  const calls = { sudoRun: [], run: [] };
  let pid = 40;
  return {
    calls,
    protocol: SUDO_RUN_PROTOCOL,
    async sudoRun(replay, options) {
      calls.sudoRun.push({ replay, options });
      if (hang) return new Promise(() => {});
      pid += 1;
      return { pid, pgid: pid, ended: new Promise(() => {}) };
    },
    async run(argv) {
      calls.run.push(argv);
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

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

function twoTabs({ kernel = kernelOf(), procs = () => null } = {}) {
  const open = tabs();
  const ownerEnd = open();
  const followerEnd = open();
  const told = [];
  const owner = createApprovals({
    channel: ownerEnd,
    kernel: () => kernel,
    lick: async () => {},
  });
  owner.own();
  const next = kernelOf();
  const follower = createApprovals({
    channel: followerEnd,
    kernel: () => next,
    procs,
    pollMs: 5,
    lick: async (notice) => {
      told.push(notice);
    },
  });
  return { open, owner, ownerEnd, follower, next, told };
}

test('a tab that takes over from a closed owner keeps its stored replays: a timed-out row stays runnable there and Run now replays it in the new kernel', async () => {
  const { open, owner, ownerEnd, follower, next } = twoTabs();
  const req = ask('sudo-handoff-late');
  const id = await expire(owner, req);
  await until(() => row(follower, id)?.state === 'unanswered', 'the follower to see the timeout');
  const forged = open();
  forged.postMessage({
    history: follower.port.history(),
    replays: [{ ...req, path: '/usr/bin/rm', argv: ['rm', '-rf', '/'] }],
  });
  await pause(5);
  forged.close();
  ownerEnd.close();
  follower.own();
  assert.equal(row(follower, id).runnable, true);
  await follower.port.run(id);
  await until(() => row(follower, id)?.run?.state === 'running', 'the replay to run');
  assert.equal(next.calls.sudoRun.length, 1);
  assert.deepEqual(next.calls.sudoRun[0].replay.argv, req.argv);
  assert.equal(next.calls.sudoRun[0].replay.path, req.path);
  assert.equal(next.calls.sudoRun[0].replay.id, req.id);
  assert.equal(next.calls.sudoRun[0].options.tag, `sudo-run:${id}`);
});

test('a run the closed owner started is found again by its sudo-run tag, so Stop signals that group and never an unknown one', async () => {
  const tagged = [];
  const procs = { ps: async () => tagged.map((entry) => ({ ...entry })) };
  const { owner, ownerEnd, follower, next, told } = twoTabs({ procs: () => procs });
  const id = await expire(owner, ask('sudo-handoff-stop'));
  await owner.port.run(id);
  await until(() => row(follower, id)?.run?.state === 'running', 'the follower to see the run');
  tagged.push(
    { pid: 7, pgid: 7, uid: 0, state: 'S', tags: ['agent:cone', `sudo-run:${id}`] },
    { pid: 8, pgid: 7, uid: 0, state: 'S', tags: [`sudo-run:${id}`] },
    { pid: 9, pgid: 9, uid: 1000, state: 'S', tags: [`sudo-run:${id}`] },
    { pid: 10, pgid: 10, uid: 0, state: 'S', tags: ['sudo-run:bios:another'] }
  );
  ownerEnd.close();
  follower.own();
  await follower.port.stopRun(id);
  assert.deepEqual(next.calls.run, [['kill', '-TERM', '-7']]);
  assert.equal(row(follower, id).run.state, 'stopped');
  assert.equal(row(follower, id).run.pid, 7);
  await until(() => told.length === 1, 'one end notice');
  assert.equal(told[0].id, id);
  assert.equal(told[0].phase, 'end');
  assert.equal(told[0].stopped, true);
});

test('after a handoff, a found run ends when its processes do, a gone one ends at once, and Stop waits for the process list', async () => {
  const tagged = [];
  let listing = null;
  const procs = () => listing;
  const { owner, ownerEnd, follower, told } = twoTabs({ procs });
  const kept = await expire(owner, ask('sudo-handoff-kept'));
  const gone = await expire(owner, ask('sudo-handoff-gone'));
  await owner.port.run(kept);
  await owner.port.run(gone);
  await until(
    () =>
      row(follower, kept)?.run?.state === 'running' &&
      row(follower, gone)?.run?.state === 'running',
    'the follower to see both runs'
  );
  tagged.push({ pid: 70, pgid: 70, uid: 0, state: 'S', tags: [`sudo-run:${kept}`] });
  ownerEnd.close();
  follower.own();
  await assert.rejects(follower.port.stopRun(kept), { message: UNSEEN });
  assert.equal(row(follower, kept).run.state, 'running');
  listing = { ps: async () => tagged.map((entry) => ({ ...entry })) };
  await follower.adopt();
  assert.equal(row(follower, gone).run.state, 'done');
  assert.equal(row(follower, gone).run.status, undefined);
  await assert.rejects(follower.port.stopRun(gone), /This request isn't running\./);
  assert.equal(row(follower, kept).run.state, 'running');
  assert.equal(row(follower, kept).run.pid, 70);
  tagged.length = 0;
  await until(() => row(follower, kept)?.run?.state === 'done', 'the found run to end');
  await until(() => told.length === 2, 'two end notices');
  assert.deepEqual(told.map((notice) => `${notice.id}:${notice.phase}`).sort(), [
    `${gone}:end`,
    `${kept}:end`,
  ]);
  await pause(30);
  assert.equal(told.length, 2);
});

test('a kernel client that failed to attach is attached again at the next lookup', async () => {
  const open = tabs();
  const ownerEnd = open();
  const owner = createApprovals({
    channel: ownerEnd,
    kernel: () => kernelOf(),
    lick: async () => {},
  });
  owner.own();
  let tries = 0;
  const next = Object.assign(kernelOf(), {
    async connect() {
      tries += 1;
      if (tries === 1) throw new Error('not yet');
      return 'port';
    },
  });
  const host = hostApprovals({
    channel: open(),
    kernel: () => next,
    attach: async (port) => {
      assert.equal(port, 'port');
      return { ps: async () => [] };
    },
    deliver: async () => ({ delivered: true }),
    debug: {},
    warn() {},
  });
  const id = await expire(owner, ask('sudo-handoff-retry'));
  await owner.port.run(id);
  await until(() => row(host, id)?.run?.state === 'running', 'the follower to see the run');
  ownerEnd.close();
  host.own();
  await assert.rejects(host.port.stopRun(id), { message: UNSEEN });
  assert.equal(row(host, id).run.state, 'running');
  await host.adopt();
  assert.equal(tries, 2);
  assert.equal(row(host, id).run.state, 'done');
});

test('a run the closed owner was still starting fails after a handoff when no process carries its tag', async () => {
  const procs = { ps: async () => [] };
  const { owner, ownerEnd, follower, told } = twoTabs({
    kernel: kernelOf({ hang: true }),
    procs: () => procs,
  });
  const id = await expire(owner, ask('sudo-handoff-starting'));
  void owner.port.run(id);
  await until(() => row(follower, id)?.run?.state === 'starting', 'the follower to see it start');
  ownerEnd.close();
  follower.own();
  await follower.adopt();
  assert.equal(row(follower, id).run.state, 'failed');
  assert.equal(row(follower, id).run.error, INTERRUPTED);
  assert.deepEqual(told, []);
});

const ci = Boolean(process.env.CI);

test('browser: when the owner tab closes, the tab that takes over keeps a timed-out row runnable and ends the run the closed tab left', {
  skip: !ci && 'CI only, no local Chrome',
  timeout: 900_000,
}, async (t) => {
  const chrome = await launch({ timeout: 120_000 });
  after(() => chrome.close());
  const debug = `() => {
    globalThis.sliccKernelDebug = true;
    globalThis.sliccApprovalRunNotice = (notice) => {
      (globalThis.handoffNotices ??= []).push(notice);
      return { delivered: true };
    };
  }`;
  const is = (wanted) => document.querySelector('slicc-app').model.tabs?.state().role === wanted;
  const a = await chrome.page(t);
  await a.init(debug);
  await boot(a);
  const b = await a.tab();
  await b.init(debug);
  await boot(b);
  assert.equal(await a.until(is, 'owner'), true);
  assert.equal(await b.until(is, 'follower'), true);

  const made = await a.evaluate(async () => {
    const approvals = globalThis.sliccApprovals;
    const client = await globalThis.sliccKernelClient();
    const who = await client.run(['id', '-u', 'cone']);
    if (who.status !== 0) throw new Error(who.stderr || 'no cone user');
    const uid = Number(who.stdout.trim());
    const bin = '/usr/local/bin';
    const install = await client.run([
      'bash',
      '-c',
      [
        `mkdir -p ${bin}`,
        `printf '#!/bin/sh\\nexit 0\\n' > ${bin}/slicc-handoff-ok`,
        `printf '#!/bin/sh\\nsleep 600\\n' > ${bin}/slicc-handoff-long`,
        `chown 0:0 /usr /usr/local ${bin} ${bin}/slicc-handoff-ok ${bin}/slicc-handoff-long`,
        `chmod 0755 /usr /usr/local ${bin} ${bin}/slicc-handoff-ok ${bin}/slicc-handoff-long`,
      ].join(' && '),
    ]);
    if (install.status !== 0) throw new Error(install.stderr || install.stdout || 'no install');
    const req = (name) => ({
      id: `sudo-handoff-${name}-${Date.now()}`,
      user: 'cone',
      uid,
      target: 'root',
      argv: [`${bin}/slicc-handoff-${name}`],
      path: `${bin}/slicc-handoff-${name}`,
      cwd: '/',
      stdin: 'none',
      rootOnly: { '/': true },
      userWritable: [],
      tag: JSON.stringify({ kind: 'agent', agentId: 'cone' }),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      always: false,
    });
    const expire = async (asked) => {
      const ended = new AbortController();
      const pending = approvals.approve(asked, { signal: ended.signal });
      const id = `bios:${asked.id}`;
      for (let i = 0; i < 200 && !approvals.port.list().some((item) => item.id === id); i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      ended.abort('expired');
      await pending;
      return id;
    };
    const okId = await expire(req('ok'));
    const longId = await expire(req('long'));
    await approvals.port.run(longId);
    const runOf = () => approvals.port.history().find((entry) => entry.approval.id === longId)?.run;
    for (let i = 0; i < 400 && runOf()?.state !== 'running'; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 50));
    return { okId, longId, run: runOf() ?? null };
  });
  assert.equal(made.run?.state, 'running', JSON.stringify(made));

  const seen = await b.within(
    60_000,
    ({ okId, longId }) => {
      const history = globalThis.sliccApprovals.port.history();
      const ok = history.find((entry) => entry.approval.id === okId);
      const long = history.find((entry) => entry.approval.id === longId);
      return ok?.state === 'unanswered' && long?.run?.state === 'running' ? long.run : null;
    },
    made
  );
  assert.equal(seen.state, 'running');

  await a.close();
  assert.equal(await b.within(120_000, is, 'owner'), true);
  const taken = await b.within(
    180_000,
    ({ okId, longId }) => {
      const history = globalThis.sliccApprovals.port.history();
      const ok = history.find((entry) => entry.approval.id === okId);
      const long = history.find((entry) => entry.approval.id === longId);
      if (!long?.run || long.run.state === 'running' || ok?.runnable !== true) return null;
      return {
        runnable: ok.runnable,
        run: long.run,
        notices: (globalThis.handoffNotices ?? []).filter((notice) => notice.id === longId),
      };
    },
    made
  );
  assert.equal(taken.runnable, true);
  assert.equal(taken.run.state, 'done');
  assert.equal(taken.run.status, undefined);
  assert.deepEqual(
    taken.notices.map((notice) => notice.phase),
    ['end']
  );

  const ran = await b.evaluate(async (okId) => {
    const approvals = globalThis.sliccApprovals;
    await approvals.port.run(okId);
    const runOf = () => approvals.port.history().find((entry) => entry.approval.id === okId)?.run;
    for (let i = 0; i < 400 && ['starting', 'running'].includes(runOf()?.state); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 50));
    return runOf() ?? null;
  }, made.okId);
  assert.equal(ran?.state, 'done', JSON.stringify(ran));
  assert.equal(ran.status, 0);
  assert.deepEqual(b.errors, []);
});
