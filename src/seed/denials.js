export const LOG = 'var/log/slicc/denials.log';
export const CAP = 1024 * 1024;
export const SPOOL = 'slicc.denials.spool.';

async function folder(root) {
  const parts = LOG.split('/');
  parts.pop();
  let dir = await root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}

async function append(root, text, cap) {
  const name = LOG.split('/').pop();
  const dir = await folder(root);
  const handle = await dir.getFileHandle(name, { create: true });
  const file = await handle.getFile();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (file.size && file.size + bytes > cap) {
    const kept = await (await dir.getFileHandle(`${name}.1`, { create: true })).createWritable();
    await kept.write(await file.arrayBuffer());
    await kept.close();
    const fresh = await handle.createWritable();
    await fresh.write(text);
    await fresh.close();
    return;
  }
  const writable = await handle.createWritable({ keepExistingData: true });
  await writable.seek(file.size);
  await writable.write(text);
  await writable.close();
}

export function denialLog({
  root,
  users,
  mode,
  now = Date.now,
  every = 250,
  batch = 100,
  cap = CAP,
  schedule = setTimeout,
  cancel = clearTimeout,
  events = globalThis,
  spool = events.document ? events.localStorage : null,
  id = `${Date.now()}.${Math.random().toString(36).slice(2)}`,
}) {
  const names = new Map();
  const pending = new Map();
  const inflight = new Set();
  let spooled = [];
  let queue = Promise.resolve();
  let timer = null;
  const keyOf = (denial) =>
    [denial.uid, denial.tag, denial.op, denial.path, denial.errno].join('\0');
  const keep = () => {
    try {
      if (spooled.length) spool?.setItem(SPOOL + id, JSON.stringify(spooled));
      else spool?.removeItem(SPOOL + id);
    } catch (error) {
      console.warn(`denials.log: ${error.message}`);
    }
  };
  const settle = (taken) => {
    inflight.delete(taken);
    if (!spooled.some((entry) => taken.includes(entry))) return;
    spooled = spooled.filter((entry) => !taken.includes(entry));
    keep();
  };
  const nameOf = async (uid) => {
    if (uid !== null && !names.has(uid)) {
      for (const user of (await users()
        ?.list()
        .catch(() => [])) ?? [])
        names.set(user.uid, user.name);
    }
    return names.get(uid) ?? (uid === null ? null : String(uid));
  };
  const flush = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    const taken = [...pending.values()];
    pending.clear();
    if (!taken.length) return queue;
    inflight.add(taken);
    queue = queue
      .then(async () => {
        const lines = [];
        for (const { uid, tag, op, path, errno, count, first, last } of taken) {
          const line = {
            time: new Date(last).toISOString(),
            first: new Date(first).toISOString(),
            count,
            user: await nameOf(uid),
            tag,
            op,
            path,
            errno,
            mode,
          };
          lines.push(`${JSON.stringify(line)}\n`);
        }
        await append(root, lines.join(''), cap);
      })
      .catch((error) => console.warn(`denials.log: ${error.message}`))
      .then(() => settle(taken));
    return queue;
  };
  const add = (entry) => {
    const key = keyOf(entry);
    const known = pending.get(key);
    if (known) {
      known.count += entry.count;
      known.first = Math.min(known.first, entry.first);
      known.last = Math.max(known.last, entry.last);
    } else {
      pending.set(key, entry);
    }
  };
  const hide = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    spooled = [...new Set([...spooled, ...[...inflight].flat(), ...pending.values()])];
    pending.clear();
    keep();
  };
  const drain = () => {
    const keys = [];
    for (let i = 0; i < (spool?.length ?? 0); i += 1) {
      const key = spool.key(i);
      if (key?.startsWith(SPOOL)) keys.push(key);
    }
    for (const key of keys) {
      try {
        const entries = JSON.parse(spool.getItem(key));
        spool.removeItem(key);
        for (const entry of entries) add(entry);
      } catch (error) {
        spool.removeItem(key);
        console.warn(`denials.log: ${error.message}`);
      }
    }
    if (pending.size && timer === null) timer = schedule(flush, every);
  };
  const log = (denial) => {
    const at = now();
    const tag = denial.tag ?? null;
    add({ ...denial, tag, count: 1, first: at, last: at });
    if (pending.size >= batch) return flush();
    if (timer === null) timer = schedule(flush, every);
    return queue;
  };
  log.flush = flush;
  log.drain = drain;
  events.addEventListener?.('pagehide', hide);
  events.addEventListener?.('visibilitychange', () => {
    if (events.document?.visibilityState === 'hidden') void flush();
  });
  return log;
}

export const COMMAND = 'usr/local/bin/slicc-denials';

export const SCRIPT = `#!/bin/bash
log=/${LOG}
json=0
for arg in "$@"; do
  case "$arg" in
    --json) json=1 ;;
    -h|--help)
      echo "usage: slicc-denials [--json]"
      echo "Sums up $log (and $log.1): denials by tag kind, op, errno and path prefix."
      exit 0 ;;
    *) echo "slicc-denials: unknown option $arg" >&2; exit 2 ;;
  esac
done
summary=$(cat "$log.1" "$log" 2>/dev/null | jq -s '
  def kind: (.tag // null) as $t
    | if $t == null then "untagged" else ((try ($t | fromjson | .kind) catch null) // "other") end;
  def prefix: (.path // "" | split("/") | .[1:3] | map(select(. != "")) | "/" + join("/"));
  def tally(f): group_by(f) | map({ key: (.[0] | f), count: (map(.count // 1) | add) }) | sort_by(-.count, .key);
  {
    total: (map(.count // 1) | add // 0),
    since: (map(.first // .time) | min),
    until: (map(.time) | max),
    kinds: tally(kind),
    ops: tally(.op),
    errnos: tally(.errno),
    paths: tally(prefix)
  }') || exit 1
if [ "$json" = 1 ]; then
  printf '%s\\n' "$summary"
else
  printf '%s\\n' "$summary" | jq -r '
    "denials: \\(.total)" + (if .since then " from \\(.since) to \\(.until)" else "" end),
    (["kinds", "ops", "errnos", "paths"][] as $s | "", "by \\($s | rtrimstr("s")):",
      (.[$s][] | "  \\(.count)\\t\\(.key)"))'
fi
`;

export async function installCommand(root, kernel, write) {
  await write(root, COMMAND, SCRIPT);
  const { status, stderr } = await kernel.run(['chmod', '755', `/${COMMAND}`], { cwd: '/' });
  if (status) throw new Error(stderr.trim() || `chmod exited with ${status}`);
}

export async function watchProtected({ kernel, attach, paths, log, busy }) {
  const client = await attach(await kernel.connect());
  const record = (path) =>
    log({ pid: 0, uid: null, tag: null, op: 'protect', path, errno: 'EROFS' });
  return client.fs.watch(paths, { recursive: true }, ({ paths: changed, overflow }) => {
    if (busy()) return;
    for (const path of overflow ? paths : changed) record(path);
  });
}
