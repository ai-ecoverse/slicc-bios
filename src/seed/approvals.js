import {
  DEFAULT_MAX_AGE,
  endNotice,
  ensureDir,
  failNotice,
  kernelGate,
  messageOf,
  RUN_REASONS,
  runnable,
  runPaths,
  runTag,
  signalGroup,
  startNotice,
  validPgid,
} from './approvals-run.js';

export {
  DEFAULT_MAX_AGE,
  kernelGate,
  RUN_REASONS,
  runnable,
  runPaths,
  runsHome,
  runTag,
  SUDO_RUN_PROTOCOL,
  tooOld,
  validPgid,
} from './approvals-run.js';

const CHANNEL = 'slicc-approvals';
const SAFE = /^[\w@%+=:,./-]+$/;

export function quote(word) {
  return SAFE.test(word) ? word : `'${String(word).replaceAll("'", `'\\''`)}'`;
}

export function requester({ user, tag }) {
  let parsed = null;
  try {
    parsed = JSON.parse(tag);
  } catch {}
  if (parsed?.kind === 'agent' && typeof parsed.agentId === 'string') {
    return { kind: 'agent', name: user, agentId: parsed.agentId };
  }
  if (parsed?.kind === 'user' && typeof parsed.where === 'string') {
    const where = parsed.where.startsWith('terminal:') ? 'a terminal' : parsed.where;
    return { kind: 'user', name: user, where };
  }
  return { kind: 'user', name: user };
}

export const BIOS_APPROVAL = 'bios:';

export function biosApprovalId(id) {
  const raw = String(id);
  return raw.startsWith(BIOS_APPROVAL) ? raw : `${BIOS_APPROVAL}${raw}`;
}

export function approval(req) {
  return {
    id: biosApprovalId(req.id),
    kind: 'sudo',
    requester: requester(req),
    command: req.validate
      ? `start a sudo timestamp for ${req.user} (no command)`
      : [req.path ?? req.argv[0], ...req.argv.slice(1)].map(quote).join(' '),
    target: req.target,
    cwd: req.cwd,
    createdAt: req.createdAt,
    expiresAt: req.expiresAt,
    always: false,
  };
}

export const TRAY_WAIT = 5 * 60 * 1000;
let trays = 0;

export function trayApproval({ op, stamp, device }, now = Date.now()) {
  trays += 1;
  return {
    id: `tray:${now}:${trays}`,
    kind: 'tray',
    op,
    requester: requester(stamp ?? {}),
    ...(device ? { device: { id: device.id, name: device.name } } : {}),
    createdAt: now,
    expiresAt: now + TRAY_WAIT,
  };
}

export function replayOf(req) {
  if (!req || typeof req !== 'object') return null;
  const {
    id,
    user,
    uid,
    target,
    argv,
    path,
    cwd,
    stdin,
    rootOnly,
    userWritable,
    tag,
    tags,
    validate,
  } = req;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  if (typeof user !== 'string' || !Array.isArray(argv)) return null;
  return {
    id: String(id),
    user,
    ...(uid === undefined ? {} : { uid }),
    ...(target === undefined ? {} : { target }),
    argv: [...argv],
    ...(path === undefined ? {} : { path }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(stdin === undefined ? {} : { stdin }),
    ...(rootOnly === undefined ? {} : { rootOnly }),
    ...(userWritable === undefined ? {} : { userWritable }),
    ...(tag === undefined ? {} : { tag }),
    ...(tags === undefined ? {} : { tags: [...tags] }),
    ...(validate === undefined ? {} : { validate }),
  };
}

function emitter() {
  const listeners = new Map();
  return {
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type).delete(listener);
    },
    emit(type, value) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(value);
    },
  };
}

export function seatApprovals(port, { decide = false, run = false } = {}) {
  const next = {
    on: (type, listener) => port.on(type, listener),
    list: () => port.list(),
  };
  if (typeof port.history === 'function') next.history = () => port.history();
  if (decide && typeof port.decide === 'function')
    next.decide = (id, decision, ...rest) => port.decide(id, decision, ...rest);
  if (run && typeof port.run === 'function') next.run = (id) => port.run(id);
  if (run && typeof port.stopRun === 'function') next.stopRun = (id) => port.stopRun(id);
  return next;
}

function settledRecord(item, decision, reason, at) {
  if (reason === 'expired')
    return { approval: item, state: 'unanswered', reason: 'timeout', decidedAt: at };
  if (reason === 'withdrawn')
    return { approval: item, state: 'withdrawn', reason: 'withdrawn', decidedAt: at };
  if (decision === 'once' || decision === 'always')
    return {
      approval: item,
      state: 'approved',
      decidedAt: at,
      answer: decision,
      decidedBy: 'you',
    };
  return { approval: item, state: 'rejected', decidedAt: at, decidedBy: 'you' };
}

function watchEnded({
  started,
  id,
  record,
  running,
  paths,
  replay,
  remember,
  listed,
  runs,
  tell,
  now,
}) {
  void Promise.resolve(started.ended)
    .then((exit) => {
      const current = listed().find((item) => item.approval.id === id);
      if (current?.run?.state === 'stopped') return;
      const prior = current?.run ?? running;
      const base = current ?? record;
      const status = exit?.status === undefined ? {} : { status: exit.status };
      const signal = exit?.signal ? { signal: exit.signal } : {};
      remember(
        { ...base, run: { ...prior, state: 'done', endedAt: now(), ...status, ...signal } },
        { replay, pgid: started.pgid }
      );
      runs.delete(id);
      void tell(endNotice(record, paths, exit));
    })
    .catch((error) => {
      const current = listed().find((item) => item.approval.id === id);
      if (current?.run?.state === 'stopped') return;
      const prior = current?.run ?? running;
      const base = current ?? record;
      remember(
        { ...base, run: { ...prior, state: 'failed', endedAt: now(), error: messageOf(error) } },
        { replay }
      );
      runs.delete(id);
    });
}

async function finishStop(ctx, id, record, baseRun, started) {
  const { held, kernel, remember, runs, now } = ctx;
  const running = { ...baseRun, state: 'running', pid: started.pid };
  try {
    await signalGroup(kernel(), started.pgid);
  } catch (error) {
    held.set(id, { ...(held.get(id) ?? {}), stop: false, pgid: started.pgid });
    runs.set(id, { pgid: started.pgid, ended: started.ended });
    remember(
      { ...record, runnable: true, run: { ...running, error: messageOf(error) } },
      { pgid: started.pgid }
    );
    return running;
  }
  held.set(id, { ...(held.get(id) ?? {}), stop: false, pgid: started.pgid });
  const stopped = { ...baseRun, state: 'stopped', pid: started.pid, endedAt: now() };
  remember({ ...record, runnable: true, run: stopped }, { pgid: started.pgid });
  runs.delete(id);
  return stopped;
}

async function runOwned(ctx, id) {
  const { listed, held, gatesOf, remember, kernel, runner, runs, tell, now } = ctx;
  const record = listed().find((entry) => entry.approval.id === id);
  if (!record) throw new Error("This request isn't here.");
  const entry = held.get(id);
  const verdict = runnable(record, now(), gatesOf(entry?.replay));
  if (verdict !== true) throw new Error(verdict.reason);
  const replay = entry?.replay;
  if (!replay) throw new Error(RUN_REASONS.missing);
  const client = kernel();
  if (typeof client?.sudoRun !== 'function') throw new Error(RUN_REASONS.kernel);
  const who = runner() ?? { by: 'you' };
  const at = now();
  const paths = runPaths(replay.user, id);
  const baseRun = {
    by: who.by,
    ...(who.device ? { device: who.device } : {}),
    at,
    stdout: paths.stdout,
    stderr: paths.stderr,
  };
  remember({ ...record, runnable: true, run: { ...baseRun, state: 'starting' } }, { replay });
  await tell(startNotice(record, paths));
  try {
    await ensureDir(client, replay.user, paths.dir);
    const started = await client.sudoRun(replay, {
      stdout: paths.stdout,
      stderr: paths.stderr,
      tag: runTag(id),
    });
    if (held.get(id)?.stop) {
      const stopped = await finishStop(ctx, id, record, baseRun, started);
      watchEnded({
        started,
        id,
        record,
        running: stopped,
        paths,
        replay,
        remember,
        listed,
        runs,
        tell,
        now,
      });
      return;
    }
    const running = { ...baseRun, state: 'running', pid: started.pid };
    remember({ ...record, runnable: true, run: running }, { replay, pgid: started.pgid });
    runs.set(id, { pgid: started.pgid, ended: started.ended });
    watchEnded({ started, id, record, running, paths, replay, remember, listed, runs, tell, now });
  } catch (error) {
    held.set(id, { ...(held.get(id) ?? {}), stop: false });
    remember(
      { ...record, run: { ...baseRun, state: 'failed', endedAt: now(), error: messageOf(error) } },
      { replay }
    );
    runs.delete(id);
    void tell(failNotice(record, error));
    throw new Error(messageOf(error));
  }
}

async function stopOwned(ctx, id) {
  const { listed, held, runs, kernel, remember, now } = ctx;
  const record = listed().find((entry) => entry.approval.id === id);
  if (!record?.run || (record.run.state !== 'running' && record.run.state !== 'starting'))
    throw new Error("This request isn't running.");
  const pgid = runs.get(id)?.pgid ?? held.get(id)?.pgid;
  if (record.run.state === 'starting' && !validPgid(pgid)) {
    held.set(id, { ...(held.get(id) ?? {}), stop: true });
    return;
  }
  try {
    await signalGroup(kernel(), pgid);
  } catch (error) {
    remember(
      { ...record, run: { ...record.run, state: 'running', error: messageOf(error) } },
      { pgid }
    );
    throw new Error(messageOf(error));
  }
  const { error: _error, ...clean } = record.run;
  remember({ ...record, run: { ...clean, state: 'stopped', endedAt: now() } });
  runs.delete(id);
}

export const APPROVALS_LAYOUT = { side: 'right', open: [] };

export function hostApprovals({
  kernel,
  runner = () => ({ by: 'you' }),
  debug = globalThis,
  ...rest
} = {}) {
  const licks = [];
  const lick = async (event) => {
    licks.push(event);
  };
  const approvals = createApprovals({ kernel, lick, runner, ...rest });
  if (debug.sliccKernelDebug === true) {
    debug.sliccApprovals = approvals;
    debug.sliccSudoRunLicks = licks;
  }
  return approvals;
}

export function createApprovals({
  channel = new BroadcastChannel(CHANNEL),
  kernel = () => null,
  lick = null,
  runner = () => ({ by: 'you' }),
  maxAgeMinutes = DEFAULT_MAX_AGE,
  now = Date.now,
} = {}) {
  const events = emitter();
  const waiting = new Map();
  const held = new Map();
  const mine = new Set();
  const runs = new Map();
  let shown = [];
  let past = [];
  let owning = false;

  const gatesOf = (replay) => ({
    maxAgeMinutes: typeof maxAgeMinutes === 'function' ? maxAgeMinutes() : maxAgeMinutes,
    kernel: kernelGate(kernel()),
    replay,
  });
  const withRunnable = (record) => {
    if (
      record.state !== 'unanswered' ||
      record.reason !== 'timeout' ||
      record.approval.kind !== 'sudo'
    )
      return record;
    return {
      ...record,
      runnable: runnable(record, now(), gatesOf(held.get(record.approval.id)?.replay)),
    };
  };
  const listed = () =>
    [...(owning ? past.map(withRunnable) : past)].sort(
      (a, b) => b.approval.createdAt - a.approval.createdAt
    );
  const publishHistory = () => {
    const records = listed();
    events.emit('history', records);
    if (owning) channel.postMessage({ history: records });
    return records;
  };
  const show = (list) => {
    shown = list;
    events.emit('approvals', shown);
  };
  const remember = (record, extra = {}) => {
    const id = record.approval.id;
    const previous = past.findIndex((entry) => entry.approval.id === id);
    const next = { ...record };
    past =
      previous >= 0
        ? past.map((entry, index) => (index === previous ? next : entry))
        : [next, ...past];
    if (extra.replay !== undefined || held.has(id)) {
      const prior = held.get(id) ?? {};
      const replay = extra.replay !== undefined ? { replay: extra.replay } : {};
      const pgid = extra.pgid !== undefined ? { pgid: extra.pgid } : {};
      held.set(id, { ...prior, ...replay, ...pgid });
    }
    publishHistory();
    return next;
  };
  const end = (id, reason) => {
    if (!shown.some((item) => item.id === id)) return;
    show(shown.filter((item) => item.id !== id));
    const decided = mine.delete(id);
    if (!decided || reason !== 'answered') events.emit('ended', { id, reason });
  };
  const publish = () => {
    show([...waiting.values()].map(({ item }) => item));
    channel.postMessage({ list: shown });
  };
  const offers = (id, decision) => decision !== 'always' || waiting.get(id)?.item.always === true;
  const tell = async (event) => {
    if (typeof lick === 'function')
      try {
        await lick(event);
      } catch {}
  };
  const ctx = { listed, held, gatesOf, remember, kernel, runner, runs, tell, now };
  const settle = (id, decision, reason) => {
    const entry = waiting.get(id);
    if (!entry) return;
    waiting.delete(id);
    remember(settledRecord(entry.item, decision, reason, now()), { replay: entry.replay });
    entry.resolve(decision);
    end(id, reason);
    channel.postMessage({ ended: { id, reason } });
    publish();
  };
  const wait = (item, signal, replay = null) =>
    new Promise((resolve) => {
      waiting.set(item.id, { item, resolve, replay });
      if (replay) held.set(item.id, { replay });
      remember({ approval: item, state: 'pending' }, { replay });
      publish();
      const stop = () =>
        settle(item.id, 'deny', signal.reason === 'expired' ? 'expired' : 'withdrawn');
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop);
    });

  channel.onmessage = ({ data }) => {
    if (owning && data?.hello) {
      publish();
      publishHistory();
    } else if (owning && data?.decide && offers(data.decide.id, data.decide.decision))
      settle(data.decide.id, data.decide.decision, 'answered');
    else if (owning && data?.run) void runOwned(ctx, data.run.id).catch(() => undefined);
    else if (owning && data?.stopRun) void stopOwned(ctx, data.stopRun.id).catch(() => undefined);
    else if (!owning && data?.list) show(data.list);
    else if (!owning && data?.ended) end(data.ended.id, data.ended.reason);
    else if (!owning && data?.history) {
      past = data.history;
      events.emit('history', past);
    }
  };
  channel.postMessage({ hello: true });

  return {
    port: {
      on: events.on,
      list: () => shown,
      history: () => listed(),
      async decide(id, decision) {
        const item = shown.find((entry) => entry.id === id);
        if (decision === 'always' && item?.always !== true)
          throw new Error("Always isn't offered for this request.");
        mine.add(id);
        if (owning) settle(id, decision, 'answered');
        else channel.postMessage({ decide: { id, decision } });
      },
      async run(id) {
        if (owning) return runOwned(ctx, id);
        channel.postMessage({ run: { id } });
        for (let i = 0; i < 100; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (listed().find((entry) => entry.approval.id === id)?.run) return;
        }
        throw new Error('Run now did not start.');
      },
      async stopRun(id) {
        if (owning) return stopOwned(ctx, id);
        channel.postMessage({ stopRun: { id } });
      },
    },
    own() {
      owning = true;
      publish();
      publishHistory();
    },
    approve(req, { signal } = {}) {
      return wait(approval(req), signal, replayOf(req)).then((decision) => {
        if (decision !== 'once') return 'deny';
        return req.timestamp === true ? { answer: 'once', timestamp: true } : 'once';
      });
    },
    async askTray(request, { timers = globalThis } = {}) {
      const item = trayApproval(request);
      const ended = new AbortController();
      const timer = timers.setTimeout(() => ended.abort('expired'), TRAY_WAIT);
      const gone = () => ended.abort('withdrawn');
      request.signal?.addEventListener('abort', gone);
      if (request.signal?.aborted) gone();
      try {
        return (await wait(item, ended.signal)) === 'once';
      } finally {
        timers.clearTimeout(timer);
        request.signal?.removeEventListener('abort', gone);
      }
    },
  };
}

export function routeSudo({ agent, judges = () => false, fallback, where = () => undefined }) {
  return async (req, options = {}) => {
    const owner = agent();
    if (typeof owner?.approve !== 'function' || !judges()) return fallback(req, options);
    const place = where(req);
    try {
      return await owner.approve(req, {
        signal: options.signal,
        ...(place ? { where: place } : {}),
      });
    } catch (error) {
      if (error?.code === 'EAGAIN') return fallback(req, options);
      return 'deny';
    }
  };
}

export function mergeApprovalsPorts(host, agent) {
  const pick = (id) => {
    if (host.history?.().some((entry) => entry.approval.id === id)) return host;
    if (agent.history?.().some((entry) => entry.approval.id === id)) return agent;
    return null;
  };
  const history = () => {
    const hostRows = host.history?.() ?? [];
    const agentRows = agent.history?.() ?? [];
    return [...hostRows, ...agentRows].sort((a, b) => b.approval.createdAt - a.approval.createdAt);
  };
  const run = (id) => {
    const port = pick(id);
    if (!port?.run) throw new Error("This request isn't here.");
    return port.run(id);
  };
  const stopRun = (id) => {
    const port = pick(id);
    if (!port?.stopRun) throw new Error("This request isn't running.");
    return port.stopRun(id);
  };
  return { history, run, stopRun };
}
