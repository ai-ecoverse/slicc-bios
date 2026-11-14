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

export function runFileId(id) {
  return String(id).replaceAll(/[^A-Za-z0-9._-]+/g, '-');
}

export function runsHome(user) {
  return user === 'root' ? '/root' : `/home/${user}`;
}

export function runPaths(user, id) {
  const home = runsHome(user);
  const dir = `${home === '/' ? '' : home}/${RUNS_DIR}`;
  const file = runFileId(id);
  return { dir, stdout: `${dir}/${file}.out`, stderr: `${dir}/${file}.err` };
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

export const NOTICE_ID_MAX = 128;
export const NOTICE_AGENT_ID_MAX = 256;
export const NOTICE_COMMAND_MAX = 1024;
export const NOTICE_PATH_MAX = 1024;
export const NOTICE_TAGS_MAX = 16;
export const NOTICE_TAG_LEN = 256;
export const NOTICE_SURVIVORS_MAX = 64;

function noticeText(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!text) return '';
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

function noticeCommand(command) {
  return noticeText(command, NOTICE_COMMAND_MAX);
}

function noticeId(id) {
  const text = typeof id === 'string' ? id : String(id ?? '');
  return text.length <= NOTICE_ID_MAX ? text : text.slice(0, NOTICE_ID_MAX);
}

function withoutLineSeps(text) {
  return text.replaceAll('\u2028', '').replaceAll('\u2029', '');
}

function noticeAgentId(agentId) {
  const text = withoutLineSeps(typeof agentId === 'string' ? agentId : String(agentId ?? ''));
  return text.length <= NOTICE_AGENT_ID_MAX ? text : text.slice(0, NOTICE_AGENT_ID_MAX);
}

function noticeTags(replay) {
  const tags = [];
  const push = (tag) => {
    if (tags.length >= NOTICE_TAGS_MAX) return;
    if (typeof tag !== 'string' || !tag) return;
    const clean = withoutLineSeps(tag);
    if (!clean) return;
    tags.push(clean.length <= NOTICE_TAG_LEN ? clean : clean.slice(0, NOTICE_TAG_LEN));
  };
  if (typeof replay?.tag === 'string') push(replay.tag);
  if (Array.isArray(replay?.tags)) for (const tag of replay.tags) push(tag);
  return { tags };
}

function noticeSurvivors(survivors) {
  if (!Array.isArray(survivors) || !survivors.length) return {};
  const pids = [];
  for (const item of survivors) {
    if (pids.length >= NOTICE_SURVIVORS_MAX) break;
    const pid = typeof item === 'number' ? item : item?.pid;
    if (Number.isSafeInteger(pid) && pid >= 1) pids.push(pid);
  }
  return pids.length ? { survivors: pids } : {};
}

function noticePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > NOTICE_PATH_MAX)
    return undefined;
  if (value.includes('\u2028') || value.includes('\u2029')) return undefined;
  return value;
}

function noticePaths(paths) {
  if (!paths) return {};
  const stdout = noticePath(paths.stdout);
  const stderr = noticePath(paths.stderr);
  return {
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  };
}

export function startNotice(record, paths, { pid, at, replay } = {}) {
  return {
    id: noticeId(record.approval.id),
    phase: 'start',
    agentId: noticeAgentId(record.approval.requester.agentId),
    command: noticeCommand(record.approval.command),
    requestedAt: record.approval.createdAt,
    at: at ?? record.run?.at ?? Date.now(),
    ...(pid !== undefined ? { pid } : {}),
    ...noticePaths(paths),
    ...noticeTags(replay),
  };
}

export function endNotice(record, paths, exit = {}, { replay, stopped } = {}) {
  const run = record.run ?? {};
  const status = exit?.status !== undefined ? exit.status : run.status;
  const signal = exit?.signal ?? run.signal;
  const survivors = exit?.survivors ?? run.survivors;
  const capped = exit?.capped ?? run.capped;
  const endedAt = exit?.endedAt ?? run.endedAt ?? Date.now();
  const wasStopped = stopped === true || run.state === 'stopped' || exit?.stopped === true;
  return {
    id: noticeId(record.approval.id),
    phase: 'end',
    agentId: noticeAgentId(record.approval.requester.agentId),
    command: noticeCommand(record.approval.command),
    requestedAt: record.approval.createdAt,
    at: run.at ?? endedAt,
    ...(run.pid !== undefined ? { pid: run.pid } : {}),
    endedAt,
    ...(status !== undefined ? { status } : {}),
    ...(typeof signal === 'string' && signal ? { signal } : {}),
    ...noticeSurvivors(survivors),
    ...(wasStopped ? { stopped: true } : {}),
    ...(typeof capped === 'number' ? { capped } : {}),
    ...noticePaths(paths ?? { stdout: run.stdout, stderr: run.stderr }),
    ...noticeTags(replay),
  };
}

export function quietUndelivered(reason) {
  if (typeof reason !== 'string' || !reason) return false;
  return (
    reason === 'This notice was already delivered.' ||
    /already (delivered|ended)/i.test(reason) ||
    /start .* after .*end/i.test(reason) ||
    /end was already/i.test(reason)
  );
}
