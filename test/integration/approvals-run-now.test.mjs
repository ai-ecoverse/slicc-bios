import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  biosApprovalId,
  createApprovals,
  endNotice,
  hostApprovals,
  kernelGate,
  mergeApprovalsPorts,
  RUN_REASONS,
  routeSudo,
  runnable,
  SUDO_RUN_PROTOCOL,
  startNotice,
} from '../../src/seed/approvals.js';
import {
  startNotice as buildStart,
  NOTICE_COMMAND_MAX,
  NOTICE_PATH_MAX,
} from '../../src/seed/approvals-run.js';
import { agentUp, ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const lone = () => ({ postMessage() {}, onmessage: null });

const agentReq = (fields = {}) => ({
  id: 'sudo-late-1',
  kind: 'sudo',
  path: '/usr/bin/true',
  argv: ['true'],
  user: 'cone',
  uid: 1000,
  tag: JSON.stringify({ kind: 'agent', agentId: 'cone' }),
  target: 'root',
  cwd: '/home/cone',
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_000_060_000,
  always: false,
  stdin: 'none',
  rootOnly: { '/usr/bin/true': true, '/home/cone': true },
  userWritable: [],
  ...fields,
});

async function timedOut(approvals, req = agentReq(), at = Date.now()) {
  const ended = new AbortController();
  const pending = approvals.approve(req, { signal: ended.signal });
  for (let i = 0; i < 50 && !approvals.port.list().length; i += 1) await turn();
  ended.abort('expired');
  assert.equal(await pending, 'deny');
  const id = biosApprovalId(req.id);
  const record = () => approvals.port.history().find((entry) => entry.approval.id === id);
  for (let i = 0; i < 50 && record()?.state !== 'unanswered'; i += 1) await turn();
  return { id, record, at };
}

test('runnable is true only for a timed-out agent sudo with a replay the kernel can re-check', () => {
  const base = {
    approval: {
      id: 'a',
      kind: 'sudo',
      requester: { kind: 'agent', name: 'cone', agentId: 'cone' },
      command: '/usr/bin/true',
      target: 'root',
      cwd: '/home/cone',
      createdAt: 1,
      expiresAt: 2,
      always: false,
    },
    state: 'unanswered',
    reason: 'timeout',
    decidedAt: 3,
  };
  const replay = {
    id: 'a',
    user: 'cone',
    uid: 1000,
    target: 'root',
    argv: ['true'],
    path: '/usr/bin/true',
    cwd: '/home/cone',
    stdin: 'none',
    rootOnly: { '/usr/bin/true': true },
    userWritable: [],
  };
  assert.equal(runnable(base, 4, { kernel: true, replay }), true);
  assert.deepEqual(runnable({ ...base, state: 'pending' }, 4, { kernel: true, replay }), {
    reason: RUN_REASONS.open,
  });
  assert.deepEqual(
    runnable(
      {
        ...base,
        approval: {
          ...base.approval,
          requester: { kind: 'user', name: 'root', where: 'a terminal' },
        },
      },
      4,
      { kernel: true, replay }
    ),
    { reason: RUN_REASONS.terminal }
  );
  assert.deepEqual(runnable(base, 4, { kernel: true, replay: { ...replay, validate: true } }), {
    reason: RUN_REASONS.validate,
  });
  assert.deepEqual(runnable(base, 4, { kernel: true, replay: { ...replay, stdin: 'pipe' } }), {
    reason: RUN_REASONS.stdin,
  });
  assert.deepEqual(
    runnable(base, 4, { kernel: true, replay: { ...replay, rootOnly: undefined } }),
    {
      reason: RUN_REASONS.old,
    }
  );
  assert.deepEqual(runnable(base, 4, { kernel: RUN_REASONS.kernel, replay }), {
    reason: RUN_REASONS.kernel,
  });
  assert.deepEqual(runnable(base, 4, { kernel: true, maxAgeMinutes: 0, replay }), {
    reason: RUN_REASONS.off,
  });
  assert.deepEqual(
    runnable(base, 3 + 1440 * 60_000 + 1, { kernel: true, maxAgeMinutes: 1440, replay }),
    { reason: 'It timed out over 24 h ago, so it must be asked again.' }
  );
  assert.deepEqual(
    runnable({ ...base, run: { state: 'running', by: 'you', at: 3, pid: 1 } }, 4, {
      kernel: true,
      replay,
    }),
    { reason: RUN_REASONS.running }
  );
  assert.deepEqual(
    runnable({ ...base, run: { state: 'done', by: 'you', at: 3, status: 0 } }, 4, {
      kernel: true,
      replay,
    }),
    { reason: RUN_REASONS.ran }
  );
});

test('kernelGate follows sudoRun and protocol 1.16', () => {
  assert.equal(kernelGate({ sudoRun: async () => {}, protocol: SUDO_RUN_PROTOCOL }), true);
  assert.equal(kernelGate({ sudoRun: async () => {}, protocol: [1, 15] }), RUN_REASONS.kernel);
  assert.equal(kernelGate({}), RUN_REASONS.kernel);
});

test('history records and history events track pending, decided and timed-out sudo', async () => {
  const seen = [];
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({ sudoRun: async () => {} }),
  });
  approvals.own();
  approvals.port.on('history', (list) => seen.push(list.map((entry) => entry.state)));
  const ended = new AbortController();
  const pending = approvals.approve(agentReq({ id: 'sudo-hist' }), { signal: ended.signal });
  for (let i = 0; i < 50 && !approvals.port.list().length; i += 1) await turn();
  assert.equal(approvals.port.history()[0].state, 'pending');
  await approvals.port.decide(biosApprovalId('sudo-hist'), 'once');
  assert.equal(await pending, 'once');
  assert.equal(approvals.port.history()[0].state, 'approved');
  assert.equal(approvals.port.history()[0].answer, 'once');
  const late = await timedOut(approvals, agentReq({ id: 'sudo-hist-2' }));
  assert.equal(late.record().state, 'unanswered');
  assert.equal(late.record().reason, 'timeout');
  assert.equal(late.record().runnable, true);
  assert.ok(seen.some((states) => states.includes('unanswered')));
});

test('run calls sudoRun and refuses when the record is not runnable', async () => {
  const calls = [];
  const ended = { status: 0 };
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async (replay, options) => {
        calls.push({ replay, options });
        return { pid: 42, pgid: 42, ended: Promise.resolve(ended) };
      },
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    lick: async () => {},
  });
  approvals.own();
  const { id, record } = await timedOut(approvals);
  assert.equal(record().runnable, true);
  await approvals.port.run(id);
  for (let i = 0; i < 50 && record()?.run?.state !== 'done'; i += 1) await turn();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].replay.path, '/usr/bin/true');
  assert.equal(calls[0].options.tag, `sudo-run:${id}`);
  assert.equal(record().run.state, 'done');
  assert.equal(record().run.pid, 42);
  assert.equal(record().run.status, 0);
  await assert.rejects(approvals.port.run(id), /already ran|already running/);

  const terminal = createApprovals({
    channel: lone(),
    kernel: () => ({ sudoRun: async () => assert.fail('ran') }),
  });
  terminal.own();
  const user = agentReq({
    id: 'sudo-term',
    tag: JSON.stringify({ kind: 'user', where: 'terminal:1' }),
  });
  const late = await timedOut(terminal, user);
  assert.deepEqual(late.record().runnable, { reason: RUN_REASONS.terminal });
  await assert.rejects(terminal.port.run(late.id), /terminal/);
});

test('stopRun signals the running group', async () => {
  const killed = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => ({
        pid: 9,
        pgid: 9,
        ended: gate.then(() => ({ status: 143, signal: 'SIGTERM' })),
      }),
      kill: async (pid) => {
        killed.push(pid);
        release();
      },
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
  });
  approvals.own();
  const { id, record } = await timedOut(approvals, agentReq({ id: 'sudo-stop' }));
  const running = approvals.port.run(id);
  for (let i = 0; i < 50 && record()?.run?.state !== 'running'; i += 1) await turn();
  assert.equal(record().run.state, 'running');
  await approvals.port.stopRun(id);
  await running.catch(() => undefined);
  assert.deepEqual(killed, [-9]);
  assert.equal(record().run.state, 'stopped');
});

test('a hanging start notice does not delay stopRun kill', async () => {
  const killed = [];
  let releaseEnd;
  const ended = new Promise((resolve) => {
    releaseEnd = resolve;
  });
  const notices = [];
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => ({
        pid: 70,
        pgid: 70,
        ended: ended.then(() => ({ status: 143, signal: 'SIGTERM' })),
      }),
      kill: async (pid) => {
        killed.push(pid);
        releaseEnd();
      },
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    lick: async (notice) => {
      notices.push(notice);
      if (notice.phase === 'start') await new Promise(() => {});
    },
  });
  approvals.own();
  const { id, record } = await timedOut(approvals, agentReq({ id: 'sudo-hang-start' }));
  const running = approvals.port.run(id);
  for (let i = 0; i < 50 && record()?.run?.state !== 'running'; i += 1) await turn();
  assert.equal(record().run.state, 'running');
  assert.equal(record().run.pid, 70);
  await approvals.port.stopRun(id);
  assert.deepEqual(killed, [-70]);
  assert.equal(record().run.state, 'stopped');
  assert.equal(notices.filter((notice) => notice.phase === 'start').length, 1);
  assert.equal(notices.filter((notice) => notice.phase === 'end').length, 1);
  await running.catch(() => undefined);
});

test('an exit during stopRun yields one end notice only', async () => {
  const notices = [];
  let releaseKill;
  const killGate = new Promise((resolve) => {
    releaseKill = resolve;
  });
  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => ({ pid: 71, pgid: 71, ended }),
      kill: async () => {
        resolveEnded({ status: 0 });
        await killGate;
      },
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    lick: async (notice) => notices.push(notice),
  });
  approvals.own();
  const { id, record } = await timedOut(approvals, agentReq({ id: 'sudo-double-end' }));
  const running = approvals.port.run(id);
  for (let i = 0; i < 50 && record()?.run?.state !== 'running'; i += 1) await turn();
  const stopping = approvals.port.stopRun(id);
  for (let i = 0; i < 50 && notices.filter((n) => n.phase === 'end').length < 1; i += 1)
    await turn();
  releaseKill();
  await stopping;
  await running.catch(() => undefined);
  for (let i = 0; i < 20; i += 1) await turn();
  assert.equal(notices.filter((notice) => notice.phase === 'end').length, 1);
});

test('notice fields stay within agent checkNotice limits', () => {
  const longCommand = 'x'.repeat(5000);
  const longPath = `/${'y'.repeat(3000)}`;
  const notice = buildStart(
    {
      approval: {
        id: 'bios:sudo-cap',
        command: longCommand,
        createdAt: 1,
        requester: { agentId: 'cone' },
      },
      run: { at: 2 },
    },
    { stdout: longPath, stderr: '/home/cone/.slicc/sudo-runs/ok.err' },
    { pid: 1, at: 2 }
  );
  assert.equal(notice.command.length, NOTICE_COMMAND_MAX);
  assert.equal(notice.command.endsWith('...'), true);
  assert.equal(notice.stdout, undefined);
  assert.equal(notice.stderr, '/home/cone/.slicc/sudo-runs/ok.err');
  assert.ok(notice.stderr.length <= NOTICE_PATH_MAX);
  assert.ok(notice.id.length <= 128);
  assert.ok(notice.agentId.length <= 256);
});

test('a failed kill after the process exits still sends one end notice', async () => {
  const notices = [];
  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => ({ pid: 72, pgid: 72, ended }),
      kill: async () => {
        resolveEnded({ status: 0 });
        await turn();
        throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      },
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    lick: async (notice) => notices.push(notice),
  });
  approvals.own();
  const { id, record } = await timedOut(approvals, agentReq({ id: 'sudo-kill-fail-exit' }));
  const running = approvals.port.run(id);
  for (let i = 0; i < 50 && record()?.run?.state !== 'running'; i += 1) await turn();
  await assert.rejects(approvals.port.stopRun(id), /Operation not permitted/);
  for (let i = 0; i < 50 && notices.filter((n) => n.phase === 'end').length < 1; i += 1)
    await turn();
  assert.equal(notices.filter((notice) => notice.phase === 'start').length, 1);
  assert.equal(notices.filter((notice) => notice.phase === 'end').length, 1);
  assert.equal(notices.find((notice) => notice.phase === 'end')?.status, 0);
  assert.equal(record()?.run?.state, 'done');
  await running.catch(() => undefined);
});

test('stop during starting waits for sudoRun then signals the new pgid', async () => {
  const killed = [];
  let releaseRun;
  const gate = new Promise((resolve) => {
    releaseRun = resolve;
  });
  let releaseEnd;
  const ended = new Promise((resolve) => {
    releaseEnd = resolve;
  });
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => {
        await gate;
        return {
          pid: 21,
          pgid: 21,
          ended: ended.then(() => ({ status: 143, signal: 'SIGTERM' })),
        };
      },
      kill: async (pid) => {
        killed.push(pid);
        releaseEnd();
      },
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
  });
  approvals.own();
  const { id, record } = await timedOut(approvals, agentReq({ id: 'sudo-pending-stop' }));
  const started = approvals.port.run(id);
  for (let i = 0; i < 50 && record()?.run?.state !== 'starting'; i += 1) await turn();
  assert.equal(record().run.state, 'starting');
  await approvals.port.stopRun(id);
  assert.equal(record().run.state, 'starting');
  assert.deepEqual(killed, []);
  releaseRun();
  await started;
  for (let i = 0; i < 50 && record()?.run?.state !== 'stopped'; i += 1) await turn();
  assert.deepEqual(killed, [-21]);
  assert.equal(record().run.state, 'stopped');
  assert.equal(record().run.pid, 21);
});

test('a failed stop stays running with the error and a retry can succeed', async () => {
  const kills = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => ({
        pid: 17,
        pgid: 17,
        ended: gate.then(() => ({ status: 143, signal: 'SIGTERM' })),
      }),
      run: async (argv) => {
        if (argv[0] === 'mkdir') return { status: 0, stdout: '', stderr: '' };
        kills.push(argv);
        if (kills.length === 1) return { status: 1, stderr: 'kill: (17) - No such process' };
        release();
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
  });
  approvals.own();
  const { id, record } = await timedOut(approvals, agentReq({ id: 'sudo-stop-retry' }));
  const running = approvals.port.run(id);
  for (let i = 0; i < 50 && record()?.run?.state !== 'running'; i += 1) await turn();
  await assert.rejects(approvals.port.stopRun(id), /No such process/);
  assert.equal(record().run.state, 'running');
  assert.match(record().run.error, /No such process/);
  assert.equal(record().run.pid, 17);
  await approvals.port.stopRun(id);
  await running.catch(() => undefined);
  assert.equal(kills.length, 2);
  assert.equal(record().run.state, 'stopped');
  assert.equal(record().run.error, undefined);
});

test('a pending stop whose kill fails keeps the run running with the error', async () => {
  const kills = [];
  let releaseRun;
  const gate = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => {
        await gate;
        return {
          pid: 23,
          pgid: 23,
          ended: new Promise(() => {}),
        };
      },
      run: async (argv) => {
        if (argv[0] === 'mkdir') return { status: 0, stdout: '', stderr: '' };
        kills.push(argv);
        return { status: 1, stderr: 'kill: Operation not permitted' };
      },
    }),
  });
  approvals.own();
  const { id, record } = await timedOut(approvals, agentReq({ id: 'sudo-pending-kill-fail' }));
  const started = approvals.port.run(id);
  for (let i = 0; i < 50 && record()?.run?.state !== 'starting'; i += 1) await turn();
  await approvals.port.stopRun(id);
  releaseRun();
  await started;
  for (let i = 0; i < 50 && record()?.run?.state !== 'running'; i += 1) await turn();
  assert.equal(record().run.state, 'running');
  assert.match(record().run.error, /Operation not permitted/);
  assert.equal(kills.length, 1);
  await assert.rejects(approvals.port.stopRun(id), /Operation not permitted/);
  assert.equal(record().run.state, 'running');
  assert.equal(kills.length, 2);
});

test('bios history and run stay empty for an ask the agent held, and own one bios timeout once', async () => {
  const bios = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => assert.fail('agent-held asks must not reach bios sudoRun'),
    }),
  });
  bios.own();
  const agentRecords = [];
  const sudo = routeSudo({
    judges: () => true,
    agent: () => ({
      approve: async (req, { signal } = {}) => {
        const id = `apr-${req.id}`;
        agentRecords.push({
          approval: {
            id,
            kind: 'sudo',
            requester: { kind: 'agent', name: req.user, agentId: 'cone' },
            command: req.path,
            createdAt: req.createdAt,
            expiresAt: req.expiresAt,
            always: false,
          },
          state: 'unanswered',
          reason: 'timeout',
          decidedAt: Date.now(),
          runnable: true,
        });
        await new Promise((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'deny';
      },
    }),
    fallback: (...args) => bios.approve(...args),
  });
  const ended = new AbortController();
  const pending = sudo(agentReq({ id: 'kernel-agent-1' }), { signal: ended.signal });
  for (let i = 0; i < 20; i += 1) await turn();
  ended.abort('expired');
  assert.equal(await pending, 'deny');
  assert.equal(bios.port.history().length, 0);
  await assert.rejects(bios.port.run(biosApprovalId('kernel-agent-1')), /isn't here/);
  await assert.rejects(bios.port.run('apr-kernel-agent-1'), /isn't here/);
  assert.equal(agentRecords.length, 1);

  const calls = [];
  const host = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async (replay) => {
        calls.push(replay);
        return { pid: 31, pgid: 31, ended: Promise.resolve({ status: 0 }) };
      },
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    lick: async () => {},
  });
  host.own();
  const fallback = routeSudo({
    judges: () => false,
    agent: () => ({ approve: async () => assert.fail('agent without judge') }),
    fallback: (...args) => host.approve(...args),
  });
  const late = new AbortController();
  const hostPending = fallback(agentReq({ id: 'kernel-bios-1' }), { signal: late.signal });
  for (let i = 0; i < 50 && !host.port.list().length; i += 1) await turn();
  late.abort('expired');
  assert.equal(await hostPending, 'deny');
  const id = biosApprovalId('kernel-bios-1');
  assert.equal(host.port.history().length, 1);
  assert.equal(host.port.history()[0].approval.id, id);
  assert.equal(host.port.history()[0].state, 'unanswered');
  await host.port.run(id);
  for (let i = 0; i < 50 && host.port.history()[0]?.run?.state !== 'done'; i += 1) await turn();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'kernel-bios-1');
  await assert.rejects(host.port.run(id), /already ran/);

  let agentRuns = 0;
  const merged = mergeApprovalsPorts(host.port, {
    history: () => agentRecords,
    run: async () => {
      agentRuns += 1;
    },
    stopRun: async () => assert.fail('merged stop must not hit the agent for a bios id'),
  });
  assert.equal(merged.history().length, 2);
  assert.equal(
    merged.history().filter((entry) => entry.approval.id === 'apr-kernel-agent-1').length,
    1
  );
  assert.equal(merged.history().filter((entry) => entry.approval.id === id).length, 1);
  await assert.rejects(merged.run(id), /already ran/);
  assert.equal(calls.length, 1);
  await merged.run('apr-kernel-agent-1');
  assert.equal(agentRuns, 1);
  assert.equal(calls.length, 1);
});

test('approvalRunNotice facts fire on start and end with the exact shape', async () => {
  const notices = [];
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => ({ pid: 3, pgid: 3, ended: Promise.resolve({ status: 0 }) }),
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    lick: async (notice) => notices.push(notice),
  });
  approvals.own();
  const { id, record } = await timedOut(approvals, agentReq({ id: 'sudo-lick' }));
  await approvals.port.run(id);
  for (let i = 0; i < 50 && record()?.run?.state !== 'done'; i += 1) await turn();
  assert.equal(notices.length, 2);
  assert.match(id, /^bios:/);
  assert.equal(notices[0].phase, 'start');
  assert.equal(notices[0].id, id);
  assert.equal(notices[0].agentId, 'cone');
  assert.equal(typeof notices[0].command, 'string');
  assert.equal(typeof notices[0].requestedAt, 'number');
  assert.equal(typeof notices[0].at, 'number');
  assert.equal(notices[0].pid, 3);
  assert.equal(notices[0].channel, undefined);
  assert.equal(notices[0].eventId, undefined);
  assert.equal(notices[0].text, undefined);
  assert.equal(notices[1].phase, 'end');
  assert.equal(notices[1].id, id);
  assert.equal(notices[1].status, 0);
  assert.equal(typeof notices[1].endedAt, 'number');
  assert.equal(typeof notices[1].stdout, 'string');
  assert.equal(typeof notices[1].stderr, 'string');
  assert.ok(Array.isArray(notices[0].tags));
  assert.ok(Array.isArray(notices[1].tags));
  assert.deepEqual(Object.keys(notices[0]).sort(), [
    'agentId',
    'at',
    'command',
    'id',
    'phase',
    'pid',
    'requestedAt',
    'stderr',
    'stdout',
    'tags',
  ]);
  assert.equal(
    startNotice(
      record(),
      { stdout: notices[0].stdout, stderr: notices[0].stderr },
      {
        pid: 3,
        at: notices[0].at,
      }
    ).id,
    id
  );
  assert.equal(
    endNotice(
      record(),
      { stdout: notices[1].stdout, stderr: notices[1].stderr },
      { status: 0, endedAt: notices[1].endedAt }
    ).phase,
    'end'
  );
});

test('a kernel-refused run sends no approvalRunNotice', async () => {
  const notices = [];
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => {
        throw Object.assign(new Error("sudo: that isn't a sudo request this kernel can run"), {
          code: 'EINVAL',
        });
      },
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    lick: async (notice) => notices.push(notice),
  });
  approvals.own();
  const { id, record } = await timedOut(approvals, agentReq({ id: 'sudo-refuse' }));
  await assert.rejects(
    approvals.port.run(id),
    /isn't a sudo request|refused|EINVAL|changed|root-only|may no longer/i
  );
  for (let i = 0; i < 50 && record()?.run?.state !== 'failed'; i += 1) await turn();
  assert.equal(record()?.run?.state, 'failed');
  assert.equal(notices.length, 0);
});

test('hostApprovals delivers through approvalRunNotice and warns once when missing or undelivered', async () => {
  const seen = [];
  const warnings = [];
  const debug = { sliccKernelDebug: true };
  const withMethod = hostApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => ({ pid: 9, pgid: 9, ended: Promise.resolve({ status: 0 }) }),
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    deliver: async (notice) => {
      seen.push(notice);
      return { delivered: true };
    },
    debug,
    warn: (...args) => warnings.push(args.join(' ')),
  });
  withMethod.own();
  const ok = await timedOut(withMethod, agentReq({ id: 'sudo-deliver' }));
  await withMethod.port.run(ok.id);
  for (let i = 0; i < 50 && ok.record()?.run?.state !== 'done'; i += 1) await turn();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].phase, 'start');
  assert.equal(seen[1].phase, 'end');
  assert.equal(debug.sliccApprovalRunNotices?.length, 2);
  assert.equal(warnings.length, 0);

  const undelivered = [];
  const falseDeliver = hostApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => ({ pid: 10, pgid: 10, ended: Promise.resolve({ status: 0 }) }),
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    deliver: async (notice) => {
      undelivered.push(notice);
      return { delivered: false, reason: 'target gone' };
    },
    debug: { sliccKernelDebug: true },
    warn: (...args) => warnings.push(args.join(' ')),
  });
  falseDeliver.own();
  const late = await timedOut(falseDeliver, agentReq({ id: 'sudo-undelivered' }));
  await falseDeliver.port.run(late.id);
  for (let i = 0; i < 50 && late.record()?.run?.state !== 'done'; i += 1) await turn();
  assert.equal(undelivered.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /target gone/);

  const missingWarn = [];
  const missing = [];
  const noMethod = hostApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => ({ pid: 11, pgid: 11, ended: Promise.resolve({ status: 0 }) }),
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    deliver: async (notice) => {
      missing.push(notice);
      return { delivered: false, reason: 'this slicc-agent has no approvalRunNotice' };
    },
    debug: { sliccKernelDebug: true },
    warn: (...args) => missingWarn.push(args.join(' ')),
  });
  noMethod.own();
  const old = await timedOut(noMethod, agentReq({ id: 'sudo-old-agent' }));
  await noMethod.port.run(old.id);
  for (let i = 0; i < 50 && old.record()?.run?.state !== 'done'; i += 1) await turn();
  assert.equal(missing.length, 2);
  assert.equal(missingWarn.length, 1);
  assert.match(missingWarn[0], /no approvalRunNotice/);
});

const ci = Boolean(process.env.CI);

test('browser: timed-out agent sudo Run now goes through sudoRun, with notices and a hash refusal', {
  skip: !ci && 'CI only, no local Chrome',
  timeout: 900_000,
}, async (t) => {
  const chrome = await launch({
    agent: true,
    timeout: 120_000,
  });
  after(async () => {
    await chrome.close();
  });
  const page = await chrome.page(t);
  await page.init(`() => {
    globalThis.sliccKernelDebug = true;
  }`);
  await page.goto('/');
  await ready(page);
  await agentUp(page);
  const agentVersion = await page.evaluate(async () => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ['opt', 'agent', 'node_modules', '@ai-ecoverse', 'slicc-agent'])
      dir = await dir.getDirectoryHandle(part);
    return JSON.parse(await (await (await dir.getFileHandle('package.json')).getFile()).text())
      .version;
  });
  t.diagnostic(`slicc-agent ${agentVersion}`);
  {
    const [major, minor] = agentVersion.split('.').map(Number);
    assert.ok(
      major > 7 || (major === 7 && minor >= 34),
      `need slicc-agent ≥ 7.34.0 for approvalRunNotice licks, got ${agentVersion}`
    );
  }

  const late = await page.evaluate(async () => {
    const approvals = globalThis.sliccApprovals;
    const client = await globalThis.sliccKernelClient();
    const idOut = await client.run(['id', '-u', 'cone']);
    if (idOut.status !== 0) throw new Error(idOut.stderr || 'no cone user');
    const coneUid = Number(idOut.stdout.trim());
    if (!Number.isInteger(coneUid)) throw new Error(`bad cone uid: ${idOut.stdout}`);
    const jobPath = '/home/cone/job.sh';
    const write = await client.run(
      [
        'bash',
        '-c',
        [
          `printf '#!/bin/sh\\necho one\\n' > ${jobPath}`,
          `chmod 755 ${jobPath}`,
          `test -x ${jobPath}`,
          `stat -c '%u %a' ${jobPath}`,
        ].join(' && '),
      ],
      { user: 'cone' }
    );
    if (write.status !== 0)
      throw new Error(write.stderr || write.stdout || 'could not write job.sh');
    const bytes = await client.fs.readFile(jobPath);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const okPath = '/usr/local/bin/slicc-run-now-ok';
    const install = await client.run([
      'bash',
      '-c',
      [
        'mkdir -p /usr/local/bin',
        `printf '#!/bin/sh\\nexit 0\\n' > ${okPath}`,
        'chown 0:0 /usr /usr/local /usr/local/bin',
        `chown 0:0 ${okPath}`,
        'chmod 0755 /usr /usr/local /usr/local/bin',
        `chmod 0755 ${okPath}`,
        `test -x ${okPath}`,
        `stat -c '%u %a' /usr /usr/local /usr/local/bin ${okPath}`,
      ].join(' && '),
    ]);
    if (install.status !== 0)
      throw new Error(install.stderr || install.stdout || `could not install ${okPath}`);
    const ok = {
      id: `sudo-ok-${Date.now()}`,
      user: 'cone',
      uid: coneUid,
      target: 'root',
      argv: [okPath],
      path: okPath,
      cwd: '/',
      stdin: 'none',
      rootOnly: { '/': true },
      userWritable: [],
      tag: JSON.stringify({ kind: 'agent', agentId: 'cone' }),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      always: false,
    };
    const bad = {
      id: `sudo-bad-${Date.now()}`,
      user: 'cone',
      uid: coneUid,
      target: 'root',
      argv: [jobPath],
      path: jobPath,
      cwd: '/',
      stdin: 'none',
      rootOnly: { '/': true },
      userWritable: [{ path: jobPath, sha256 }],
      tag: JSON.stringify({ kind: 'agent', agentId: 'cone' }),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      always: false,
    };
    const expire = async (req) => {
      const ended = new AbortController();
      const pending = approvals.approve(req, { signal: ended.signal });
      const approvalId = `bios:${req.id}`;
      for (
        let i = 0;
        i < 100 && !approvals.port.list().some((item) => item.id === approvalId);
        i += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 0));
      ended.abort('expired');
      await pending;
    };
    await expire(ok);
    await expire(bad);
    const rewrite = await client.run(
      [
        'bash',
        '-c',
        [
          `printf '#!/bin/sh\\necho two\\n' > ${jobPath}`,
          `chmod 755 ${jobPath}`,
          `test -x ${jobPath}`,
        ].join(' && '),
      ],
      { user: 'cone' }
    );
    if (rewrite.status !== 0)
      throw new Error(rewrite.stderr || rewrite.stdout || 'could not rewrite job.sh');
    const after = await client.fs.readFile(jobPath);
    const afterDigest = await crypto.subtle.digest('SHA-256', after);
    const afterSha = [...new Uint8Array(afterDigest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    if (afterSha === sha256) throw new Error('job.sh hash did not change after rewrite');
    const history = () =>
      document.querySelector('slicc-app').model.approvals.history?.() ?? approvals.port.history();
    return {
      okId: `bios:${ok.id}`,
      badId: `bios:${bad.id}`,
      okPath,
      jobPath,
      sha256,
      afterSha,
      history: history().map((entry) => ({
        id: entry.approval.id,
        state: entry.state,
        reason: entry.reason,
        runnable: entry.runnable,
        command: entry.approval.command,
        kind: entry.approval.requester.kind,
      })),
      surface: Boolean(
        document.querySelector('slicc-app')?.surfaces?.some((item) => item.id === 'approvals')
      ),
      hasHistory: typeof document.querySelector('slicc-app').model.approvals.history === 'function',
    };
  });

  assert.equal(late.surface, true);
  assert.equal(late.hasHistory, true);
  const okRow = late.history.find((entry) => entry.id === late.okId);
  const badRow = late.history.find((entry) => entry.id === late.badId);
  assert.equal(okRow?.state, 'unanswered');
  assert.equal(okRow?.runnable, true);
  assert.equal(okRow?.kind, 'agent');
  assert.equal(badRow?.runnable, true);

  await page.evaluate(() => document.querySelector('slicc-app').show?.('approvals'));
  await page.until((sel) => {
    const walk = (root) => {
      const found = root.querySelector(sel);
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && walk(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return !!walk(document);
  }, 'slicc-approvals-panel');

  const ran = await page.evaluate(async (okId) => {
    const licksOf = (id) => {
      const { agent } = document.querySelector('slicc-app').model;
      return agent
        .messages(agent.active())
        .filter(
          (message) =>
            message.role === 'lick' && message.channel === 'sudo-run' && message.approval === id
        )
        .map((message) => ({
          approval: message.approval,
          channel: message.channel,
          title: message.title ?? '',
          text: message.text ?? '',
          body: message.body ?? '',
        }));
    };
    const before = licksOf(okId).length;
    await document.querySelector('slicc-app').model.approvals.run(okId);
    const history = () => document.querySelector('slicc-app').model.approvals.history();
    for (
      let i = 0;
      i < 200 && history().find((entry) => entry.approval.id === okId)?.run?.state !== 'done';
      i += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    for (let i = 0; i < 200 && licksOf(okId).length < before + 2; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const record = history().find((entry) => entry.approval.id === okId);
    return {
      run: record?.run,
      licks: licksOf(okId).slice(before),
    };
  }, late.okId);

  assert.equal(ran.run?.state, 'done');
  assert.equal(ran.run?.status, 0);
  assert.equal(typeof ran.run?.pid, 'number');
  assert.equal(ran.licks.length, 2);
  assert.equal(ran.licks[0].channel, 'sudo-run');
  assert.equal(ran.licks[0].approval, late.okId);
  assert.match(ran.licks[0].title, /sudo runs now/);
  assert.match(ran.licks[0].text, /the owner ran your timed-out sudo request/);
  assert.match(ran.licks[0].body, /Output: \//);
  assert.match(ran.licks[0].body, /\.slicc\/sudo-runs\//);
  assert.doesNotMatch(ran.licks[0].body, /Its output isn't shown here/);
  assert.equal(ran.licks[1].channel, 'sudo-run');
  assert.equal(ran.licks[1].approval, late.okId);
  assert.match(ran.licks[1].text, /your late sudo run ended: exit 0/);
  assert.match(ran.licks[1].body, /Its output isn't shown here/);
  assert.match(ran.licks[1].body, /\.slicc\/sudo-runs\//);
  assert.equal(ran.run.stdout, ran.licks[0].body.match(/Output: (\S+)/)?.[1]);
  assert.match(
    ran.licks[1].body,
    new RegExp(`${ran.run.stdout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  );
  assert.match(
    ran.licks[1].body,
    new RegExp(`${ran.run.stderr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  );
  assert.deepEqual(
    ran.licks.map((lick) =>
      /sudo runs now/.test(lick.title)
        ? `${lick.approval}:start`
        : /late sudo run ended/.test(lick.text)
          ? `${lick.approval}:end`
          : null
    ),
    [`${late.okId}:start`, `${late.okId}:end`]
  );

  const refused = await page.evaluate(async (badId) => {
    const licksOf = (id) => {
      const { agent } = document.querySelector('slicc-app').model;
      return agent
        .messages(agent.active())
        .filter(
          (message) =>
            message.role === 'lick' && message.channel === 'sudo-run' && message.approval === id
        );
    };
    const before = licksOf(badId).length;
    const error = await document
      .querySelector('slicc-app')
      .model.approvals.run(badId)
      .then(
        () => null,
        (err) => err.message
      );
    const history = () => document.querySelector('slicc-app').model.approvals.history();
    for (let i = 0; i < 100; i += 1) {
      const record = history().find((entry) => entry.approval.id === badId);
      if (record?.run?.state === 'failed' || error) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const record = history().find((entry) => entry.approval.id === badId);
    return {
      error,
      run: record?.run ?? null,
      licks: licksOf(badId).length - before,
    };
  }, late.badId);

  assert.match(refused.run?.error ?? refused.error ?? '', /changed since it was requested/);
  assert.equal(refused.run?.state, 'failed');
  assert.equal(refused.licks, 0);

  await page.evaluate((id) => {
    const walk = (root) => {
      const found = root.querySelector('slicc-approvals-panel');
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && walk(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const panel = walk(document);
    if (!panel) throw new Error('no slicc-approvals-panel');
    if (typeof panel.reveal === 'function') panel.reveal(id);
    else {
      panel.filter = 'timed-out';
      panel.shadowRoot?.querySelector('[data-filter="timed-out"]')?.click();
    }
  }, late.okId);

  const dumpApprovals = () =>
    page.evaluate((want) => {
      const walk = (root, visit) => {
        visit(root);
        for (const element of root.querySelectorAll?.('*') ?? []) {
          if (element.shadowRoot) walk(element.shadowRoot, visit);
        }
      };
      const rows = [];
      let panel = null;
      walk(document, (root) => {
        if (!panel && root.querySelector)
          panel = root.querySelector('slicc-approvals-panel') ?? panel;
        for (const row of root.querySelectorAll?.('li.row') ?? []) {
          rows.push({
            dataId: row.getAttribute('data-id'),
            state: row.getAttribute('data-state'),
            kind: row.getAttribute('data-kind'),
            text: (row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
          });
        }
      });
      const history =
        document
          .querySelector('slicc-app')
          ?.model?.approvals?.history?.()
          ?.map((entry) => ({
            id: entry.approval?.id,
            state: entry.state,
            reason: entry.reason,
            runnable: entry.runnable,
            run: entry.run?.state,
          })) ?? null;
      return {
        want,
        filter: panel?.filter ?? null,
        dataFilterShown: panel?.shadowRoot
          ?.querySelector('[data-filter-shown]')
          ?.getAttribute('data-filter-shown'),
        filters: [...(panel?.shadowRoot?.querySelectorAll('[data-filter]') ?? [])].map((el) => ({
          filter: el.getAttribute('data-filter'),
          pressed: el.getAttribute('aria-pressed'),
          selected: el.classList.contains('selected'),
        })),
        empty: panel?.shadowRoot?.querySelector('[data-empty]')?.textContent?.trim() ?? null,
        rows,
        history,
      };
    }, late.okId);

  let row;
  try {
    row = await page.until((id) => {
      const walk = (root) => {
        const found = [...(root.querySelectorAll?.('li.row') ?? [])].find(
          (el) => el.getAttribute('data-id') === id
        );
        if (found) return found;
        for (const element of root.querySelectorAll?.('*') ?? []) {
          const inner = element.shadowRoot && walk(element.shadowRoot);
          if (inner) return inner;
        }
        return null;
      };
      return walk(document);
    }, late.okId);
  } catch (error) {
    const dump = await dumpApprovals().catch((dumpError) => ({
      dumpFailed: dumpError.message,
    }));
    throw new Error(`${error.message}\napprovals dump: ${JSON.stringify(dump, null, 2)}`);
  }
  assert.ok(row);

  assert.deepEqual(page.errors, []);
});
