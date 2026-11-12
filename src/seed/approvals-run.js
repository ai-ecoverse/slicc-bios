export const SUDO_RUN_PROTOCOL = Object.freeze([1, 16]);
export const RUNS_DIR = '.slicc/sudo-runs';
export const RUN_TAG = 'sudo-run:';
const MINUTE = 60_000;
export const DEFAULT_MAX_AGE = 1440;

export const RUN_REASONS = Object.freeze({
  kind: 'Only a sudo request can run now.',
  open: 'This request is still open: answer it instead.',
  untimed: 'Only a request that timed out can run now.',
  running: 'This request is already running.',
  ran: 'This request already ran.',
  terminal: 'Run it again in the terminal.',
  validate: 'sudo -v has no command to run.',
  stdin: 'Its input is gone, so it must be asked again.',
  old: 'This request is from before Run now, so it must be asked again.',
  off: 'Run now is off.',
  kernel: `Needs slicc-kernel protocol ${SUDO_RUN_PROTOCOL.join('.')} or later.`,
  missing: 'This request no longer has what Run now needs.',
});

export function tooOld(minutes) {
  const hours = minutes / 60;
  const span = Number.isInteger(hours) ? `${hours} h` : `${minutes} min`;
  return `It timed out over ${span} ago, so it must be asked again.`;
}

export function kernelGate(client) {
  if (typeof client?.sudoRun !== 'function') return RUN_REASONS.kernel;
  const [major = 0, minor = 0] = client.protocol ?? SUDO_RUN_PROTOCOL;
  const [needMajor, needMinor] = SUDO_RUN_PROTOCOL;
  return major > needMajor || (major === needMajor && minor >= needMinor)
    ? true
    : RUN_REASONS.kernel;
}

function runStateReason(run) {
  return run.state === 'starting' || run.state === 'running'
    ? RUN_REASONS.running
    : RUN_REASONS.ran;
}

function replayBlocked(replay, item, record, now, gates) {
  if (replay?.validate || item.validate) return RUN_REASONS.validate;
  if (replay?.stdin === 'pipe' || replay?.stdin === 'file') return RUN_REASONS.stdin;
  if (!replay?.rootOnly) return RUN_REASONS.old;
  const maxAge = gates.maxAgeMinutes ?? DEFAULT_MAX_AGE;
  if (maxAge <= 0) return RUN_REASONS.off;
  if (now - (record.decidedAt ?? item.expiresAt) > maxAge * MINUTE) return tooOld(maxAge);
  if (gates.frozen) return gates.frozen;
  const kernel = gates.kernel ?? true;
  if (kernel !== true) return typeof kernel === 'string' ? kernel : RUN_REASONS.kernel;
  if (!replay?.argv || !replay.path || !replay.cwd || !replay.user) return RUN_REASONS.missing;
  return null;
}

export function runnable(record, now = Date.now(), gates = {}) {
  const { approval: item, state, reason, run } = record;
  if (item?.kind !== 'sudo') return { reason: RUN_REASONS.kind };
  if (state === 'pending') return { reason: RUN_REASONS.open };
  if (state !== 'unanswered' || reason !== 'timeout') return { reason: RUN_REASONS.untimed };
  if (run) return { reason: runStateReason(run) };
  if (item.requester?.kind !== 'agent' || !item.requester?.agentId)
    return { reason: RUN_REASONS.terminal };
  const blocked = replayBlocked(gates.replay, item, record, now, gates);
  return blocked ? { reason: blocked } : true;
}

export function runTag(id) {
  return `${RUN_TAG}${id}`;
}

export function runsHome(user) {
  return user === 'root' ? '/root' : `/home/${user}`;
}

export function runPaths(user, id) {
  const home = runsHome(user);
  const dir = `${home === '/' ? '' : home}/${RUNS_DIR}`;
  return { dir, stdout: `${dir}/${id}.out`, stderr: `${dir}/${id}.err` };
}

export function messageOf(error) {
  if (error?.code === 'ENOSYS') return RUN_REASONS.kernel;
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() || 'the kernel refused to run it';
}

export async function ensureDir(client, user, dir) {
  if (typeof client?.run === 'function') {
    const { status, stderr } = await client.run(['mkdir', '-p', dir], { user });
    if (status !== 0) throw new Error(stderr?.trim() || `can't create ${dir} as ${user}`);
    return;
  }
  if (typeof client?.spawn !== 'function') return;
  const made = await client.spawn(['mkdir', '-p', dir], { user, cwd: '/' });
  if ((await made.exited) !== 0) throw new Error(`can't create ${dir} as ${user}`);
}

export function validPgid(pgid) {
  return Number.isInteger(pgid) && pgid > 1;
}

export async function signalGroup(client, pgid) {
  if (!validPgid(pgid)) throw new Error(`can't stop process group ${pgid}`);
  if (typeof client?.kill === 'function') {
    await client.kill(-pgid);
    return;
  }
  if (typeof client?.run !== 'function')
    throw new Error("this client can't signal a process group");
  const { status, stderr } = await client.run(['kill', '-TERM', `-${pgid}`]);
  if (status !== 0) throw new Error(stderr?.trim() || `kill exited ${status}`);
}

export function startNotice(record, paths) {
  const id = record.approval.id;
  return {
    channel: 'sudo-run',
    approval: id,
    eventId: `${id}:start`,
    agentId: record.approval.requester.agentId,
    title: `sudo runs now: ${record.approval.command}`,
    text: '[the owner ran your timed-out sudo request]',
    body: `The owner ran your timed-out sudo with Run now. Output: ${paths.stdout}`,
  };
}

export function endNotice(record, paths, exit) {
  const id = record.approval.id;
  const status = exit?.status;
  return {
    channel: 'sudo-run',
    approval: id,
    eventId: `${id}:end`,
    agentId: record.approval.requester.agentId,
    title: `sudo run ended: ${record.approval.command}`,
    text: `[your late sudo run ended: exit ${status ?? 'unknown'}]`,
    body: `Full output: ${paths.stdout} and ${paths.stderr}`,
    ...(status !== undefined && status !== 0 ? { severity: 'warn' } : {}),
  };
}

export function failNotice(record, error) {
  const id = record.approval.id;
  return {
    channel: 'sudo-run',
    approval: id,
    eventId: `${id}:end`,
    agentId: record.approval.requester.agentId,
    title: `sudo run ended: ${record.approval.command}`,
    text: `[your late sudo run ended: ${messageOf(error)}]`,
    severity: 'warn',
  };
}
