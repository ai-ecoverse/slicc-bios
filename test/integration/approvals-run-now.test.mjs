import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  createApprovals,
  kernelGate,
  RUN_REASONS,
  runnable,
  SUDO_RUN_PROTOCOL,
  seatApprovals,
} from '../../src/seed/approvals.js';
import { ready } from './bios.mjs';
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
  const record = () =>
    approvals.port.history().find((entry) => entry.approval.id === String(req.id));
  for (let i = 0; i < 50 && record()?.state !== 'unanswered'; i += 1) await turn();
  return { id: String(req.id), record, at };
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
  await approvals.port.decide('sudo-hist', 'once');
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

test('a seat without run gets history only', async () => {
  const licks = [];
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => assert.fail('a seat without run must not call sudoRun'),
    }),
    lick: async (event) => licks.push(event),
  });
  approvals.own();
  await timedOut(approvals, agentReq({ id: 'sudo-seat' }));
  const seat = seatApprovals(approvals.port, { decide: false, run: false });
  assert.equal(typeof seat.history, 'function');
  assert.equal(seat.decide, undefined);
  assert.equal(seat.run, undefined);
  assert.equal(seat.stopRun, undefined);
  assert.equal(seat.history()[0].state, 'unanswered');
  assert.equal(seat.history()[0].runnable, true);
  assert.equal(licks.length, 0);
});

test('sudo-run lick notices fire on start and end', async () => {
  const licks = [];
  const approvals = createApprovals({
    channel: lone(),
    kernel: () => ({
      protocol: SUDO_RUN_PROTOCOL,
      sudoRun: async () => ({ pid: 3, pgid: 3, ended: Promise.resolve({ status: 0 }) }),
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    lick: async (event) => licks.push(event),
  });
  approvals.own();
  const { id, record } = await timedOut(approvals, agentReq({ id: 'sudo-lick' }));
  await approvals.port.run(id);
  for (let i = 0; i < 50 && record()?.run?.state !== 'done'; i += 1) await turn();
  assert.equal(licks.length, 2);
  assert.equal(licks[0].channel, 'sudo-run');
  assert.equal(licks[0].approval, id);
  assert.equal(licks[0].eventId, `${id}:start`);
  assert.equal(licks[1].eventId, `${id}:end`);
  assert.match(licks[0].text, /timed-out sudo/);
});

const ci = Boolean(process.env.CI);

test('browser: timed-out agent sudo Run now goes through sudoRun, with notices and a hash refusal', {
  skip: !ci && 'CI only, no local Chrome',
  timeout: 900_000,
}, async (t) => {
  const chrome = await launch({
    agent: false,
    timeout: 120_000,
  });
  after(async () => {
    await chrome.close();
  });
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto('/');
  await ready(page, undefined, { tools: false });

  const late = await page.evaluate(async () => {
    const approvals = globalThis.sliccApprovals;
    const client = await globalThis.sliccKernelClient();
    const accounts = await client.users.list();
    const cone = accounts.find((entry) => entry.name === 'cone');
    if (!cone) throw new Error('no cone user');
    const write = await client.run(
      ['bash', '-c', "printf 'echo one\\n' > /home/cone/job.sh && chmod 755 /home/cone/job.sh"],
      { user: 'cone' }
    );
    if (write.status !== 0) throw new Error(write.stderr || 'could not write job.sh');
    const bytes = await client.fs.readFile('/home/cone/job.sh');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const which = await client.run(['bash', '-c', 'command -v true; command -v ls']);
    const [truePath, lsPath] = which.stdout.trim().split('\n');
    const ok = {
      id: `sudo-ok-${Date.now()}`,
      user: 'cone',
      uid: cone.uid,
      target: 'root',
      argv: ['true'],
      path: truePath,
      cwd: '/home/cone',
      stdin: 'none',
      rootOnly: { [truePath]: true, '/home/cone': true },
      userWritable: [],
      tag: JSON.stringify({ kind: 'agent', agentId: 'cone' }),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      always: false,
    };
    const bad = {
      id: `sudo-bad-${Date.now()}`,
      user: 'cone',
      uid: cone.uid,
      target: 'root',
      argv: ['/home/cone/job.sh'],
      path: '/home/cone/job.sh',
      cwd: '/home/cone',
      stdin: 'none',
      rootOnly: { '/home/cone': true, '/home/cone/job.sh': false },
      userWritable: [{ path: '/home/cone/job.sh', sha256 }],
      tag: JSON.stringify({ kind: 'agent', agentId: 'cone' }),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      always: false,
    };
    const expire = async (req) => {
      const ended = new AbortController();
      const pending = approvals.approve(req, { signal: ended.signal });
      for (let i = 0; i < 100 && !approvals.port.list().some((item) => item.id === req.id); i += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
      ended.abort('expired');
      await pending;
    };
    await expire(ok);
    await expire(bad);
    await client.run(
      ['bash', '-c', "printf 'echo two\\n' > /home/cone/job.sh && chmod 755 /home/cone/job.sh"],
      { user: 'cone' }
    );
    const history = () =>
      document.querySelector('slicc-app').model.approvals.history?.() ?? approvals.port.history();
    return {
      okId: ok.id,
      badId: bad.id,
      truePath,
      lsPath,
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
    const before = globalThis.sliccSudoRunLicks?.length ?? 0;
    await document.querySelector('slicc-app').model.approvals.run(okId);
    const history = () => document.querySelector('slicc-app').model.approvals.history();
    for (
      let i = 0;
      i < 200 && history().find((entry) => entry.approval.id === okId)?.run?.state !== 'done';
      i += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    const record = history().find((entry) => entry.approval.id === okId);
    return {
      run: record?.run,
      licks: (globalThis.sliccSudoRunLicks ?? []).slice(before).map((event) => ({
        channel: event.channel,
        approval: event.approval,
        eventId: event.eventId,
        text: event.text,
      })),
    };
  }, late.okId);

  assert.equal(ran.run?.state, 'done');
  assert.equal(ran.run?.status, 0);
  assert.equal(ran.licks.length, 2);
  assert.equal(ran.licks[0].channel, 'sudo-run');
  assert.equal(ran.licks[0].approval, late.okId);
  assert.match(ran.licks[0].text, /timed-out sudo/);
  assert.match(ran.licks[1].text, /ended/);

  const refused = await page.evaluate(async (badId) => {
    const before = globalThis.sliccSudoRunLicks?.length ?? 0;
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
    const record = history().find((entry) => entry.approval.id === badId);
    return {
      error,
      run: record?.run ?? null,
      licks: (globalThis.sliccSudoRunLicks ?? []).length - before,
    };
  }, late.badId);

  assert.match(refused.run?.error ?? refused.error ?? '', /changed since it was requested/);
  assert.equal(refused.run?.state, 'failed');

  await page.evaluate((sel) => {
    const walk = (root) => {
      const found = root.querySelector(sel);
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && walk(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    walk(document)?.querySelector('[data-filter="timed-out"]')?.click();
  }, 'slicc-approvals-panel');

  const row = await page.until((id) => {
    const walk = (root) => {
      const found = root.querySelector(`li.row[data-id="${id}"]`);
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && walk(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return walk(document);
  }, late.okId);
  assert.ok(row);

  assert.deepEqual(page.errors, []);
});
