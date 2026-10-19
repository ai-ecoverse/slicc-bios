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

const READ_ONLY = new Set([
  'cat',
  'df',
  'diff',
  'du',
  'echo',
  'file',
  'grep',
  'head',
  'ls',
  'pwd',
  'readlink',
  'realpath',
  'stat',
  'tail',
  'tree',
  'wc',
]);
const RULES = ['/etc/fnox', '/etc/slicc/secrets-policy.toml'];
const PARENTS = ['/', '/etc', '/etc/slicc'];
const OPAQUE = /[*?[{$`~]|\.\.(\/|$)/;

function resolved(cwd, word) {
  const parts = (word.startsWith('/') ? word : `${cwd}/${word}`).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return `/${out.join('/')}`;
}

function words(argv) {
  return argv.flatMap((word) =>
    String(word)
      .split(/[\s;&|()<>=,'"]+/)
      .flatMap((part) => [part, ...(part.startsWith('-') ? [part.replace(/^-+[^/]*/, '')] : [])])
      .filter(Boolean)
  );
}

const STRICT = /[$`'"\\]/;

function cautious(argv) {
  const shell = argv.indexOf('-c');
  if (shell < 0) return false;
  return argv
    .slice(shell + 1)
    .some((word) => STRICT.test(word) || /(^|[\s;&|(])(cd|pushd)\s/.test(word));
}

const UNCHECKED = { certain: null, maybe: 'the secret rules check' };
let classify = () => UNCHECKED;

export function useSecretRules(check) {
  classify = check;
}

export function secretRules(req) {
  const { argv = [] } = req;
  if (cautious(argv) || argv.slice(1).some((word) => /^[^-].*['"\\]|[$`]/.test(word))) return true;
  const { command, cwd } = approvalText(req);
  const verdict = classify(command, cwd);
  if (verdict?.certain || verdict?.maybe) return true;
  return ownRules(req);
}

function approvalText(req) {
  const { argv = [], path, cwd } = req;
  return {
    command: [path ?? argv[0] ?? '', ...argv.slice(1)].map(quote).join(' '),
    cwd,
  };
}

function ownRules({ argv = [], path, cwd = '/' }) {
  const all = words([path ?? argv[0] ?? '', ...argv.slice(1)]);
  const name = String(path ?? argv[0] ?? '')
    .split('/')
    .pop();
  const reading = READ_ONLY.has(name);
  const inside = (at) => RULES.some((rule) => at === rule || at.startsWith(`${rule}/`));
  if (inside(resolved('/', cwd))) return true;
  for (const word of all.slice(1)) {
    if (/fnox|secrets-policy/.test(word)) return true;
    if (OPAQUE.test(word) && !reading) return true;
    const at = resolved(cwd, word);
    if (inside(at)) return true;
    if (!reading && PARENTS.includes(at)) return true;
  }
  return false;
}

const WRAPPERS = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ash',
  'ksh',
  'mksh',
  'fish',
  'csh',
  'tcsh',
  'rbash',
  'node',
  'jsh',
  'deno',
  'bun',
  'perl',
  'ruby',
  'php',
  'lua',
  'luajit',
  'tclsh',
  'wish',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'busybox',
  'env',
  'xargs',
  'parallel',
  'sudo',
  'su',
  'doas',
  'pkexec',
  'runuser',
  'nohup',
  'nice',
  'ionice',
  'timeout',
  'stdbuf',
  'chroot',
  'setsid',
  'script',
  'watch',
  'time',
  'exec',
  'eval',
  'command',
  'builtin',
  'unshare',
  'nsenter',
  'flock',
  'taskset',
  'chrt',
  'strace',
  'ltrace',
  'gdb',
  'expect',
  'make',
  'vi',
  'vim',
  'nvim',
  'emacs',
  'nano',
  'ed',
  'ex',
  'less',
  'more',
  'man',
  'ssh',
  'scp',
  'sftp',
]);
const INTERPRETER = /^(?:python|pypy|perl|ruby|php|lua|node|tclsh|pwsh)[\d.]*$/;
const WRITERS = new Set([
  'tee',
  'cp',
  'mv',
  'chmod',
  'chown',
  'chgrp',
  'dd',
  'install',
  'ln',
  'link',
  'unlink',
  'rm',
  'rmdir',
  'mkdir',
  'mkfifo',
  'mknod',
  'truncate',
  'touch',
  'rsync',
  'unzip',
  'zip',
  'magick',
  'magick-open',
  'convert',
  'mogrify',
  'gzip',
  'gunzip',
  'bzip2',
  'xz',
  'zstd',
  'patch',
  'git',
  'pnpm',
  'npm',
  'npx',
  'pip',
  'pip3',
  'uv',
  'shred',
  'split',
  'csplit',
  'mount',
  'umount',
  'chattr',
  'setfacl',
  'useradd',
  'usermod',
  'userdel',
  'groupadd',
  'passwd',
  'crontab',
  'curl',
  'wget',
  'sqlite3',
  'openssl',
  'gpg',
  'ssh-keygen',
  'tic',
  'cpio',
  'ar',
]);
const WRITING = {
  find: (args) => args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)$/.test(arg)),
  sed: (args) => args.some((arg) => /^-[^-]*i|^--in-place/.test(arg)),
  tar: (args) => !/^(?:-?t[vzjJaf]*|--list)$/.test(args[0] ?? ''),
  sort: (args) => args.some((arg) => /^-[^-]*o|^--output/.test(arg)),
  uniq: (args) => args.filter((arg) => !arg.startsWith('-')).length > 1,
};
const META = /[$`'"\\;&|<>*?[\]{}()~!\n]/;
const WRITABLE = ['/tmp', '/var/tmp', '/home', '/mnt', '/scoops', '/dev/shm'];

const base = (path) => String(path).split('/').pop();
const under = (path, dirs) => dirs.some((dir) => path.startsWith(`${dir}/`));

export function alwaysAllowed(req) {
  const argv = (req.argv ?? []).map(String);
  const path = String(req.path ?? argv[0] ?? '');
  if (!path.startsWith('/')) return false;
  const names = [base(path), base(argv[0] ?? '')];
  if (names.some((name) => WRAPPERS.has(name) || INTERPRETER.test(name) || WRITERS.has(name)))
    return false;
  const args = argv.slice(1);
  if (names.some((name) => WRITING[name]?.(args))) return false;
  if ([path, ...argv].some((word) => META.test(word))) return false;
  const homes = [...WRITABLE, ...(req.user ? [`/home/${req.user}`] : [])];
  for (const arg of args) {
    if (arg.startsWith('-')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '';
      if (value && !/^\d+$/.test(value) && (!value.startsWith('/') || under(value, homes)))
        return false;
      continue;
    }
    if (!arg.startsWith('/')) return false;
    if (under(arg, homes)) return false;
  }
  return !secretRules(req);
}

const PROBE = [
  'for p in "$@"; do',
  'r=$(realpath -m -- "$p") || exit 1; echo "P $r"; d=$r;',
  'while :; do',
  'if [ -e "$d" ]; then stat -c "S %u %a %F" -- "$d" || exit 1; else echo M; fi;',
  '[ "$d" = / ] && break; d=$(dirname -- "$d");',
  'done; echo E;',
  'done',
].join(' ');

export function operands(req) {
  return (req.argv ?? [])
    .slice(1)
    .map(String)
    .map((arg) => (arg.startsWith('-') ? arg.slice(arg.indexOf('=') + 1) : arg))
    .filter((arg) => arg.startsWith('/'));
}

function chains(stdout) {
  const found = [];
  let current = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('P ')) current = { path: line.slice(2), chain: [] };
    else if (line === 'E') found.push(current);
    else if (line === 'M') current.chain.push(null);
    else if (line.startsWith('S ')) {
      const [uid, mode, ...type] = line.slice(2).split(' ');
      current.chain.push({
        uid: Number(uid),
        mode: Number.parseInt(mode, 8),
        dir: type.join(' ') === 'directory',
      });
    }
  }
  return found;
}

const sound = (entry) => entry !== null && entry.uid === 0 && (entry.mode & 0o022) === 0;

export async function rootChecked(run, req) {
  const paths = [String(req.path ?? req.argv?.[0] ?? ''), ...operands(req)];
  let result;
  try {
    result = await run(['bash', '-c', PROBE, 'probe', ...paths]);
  } catch {
    return false;
  }
  if (result.status !== 0) return false;
  const found = chains(result.stdout ?? '');
  if (found.length !== paths.length) return false;
  const [command, ...rest] = found;
  if (!command.chain.every(sound)) return false;
  return rest.every(({ chain }) => {
    const [own, ...above] = chain;
    if (!above.every(sound)) return false;
    if (own === null) return true;
    return own.dir ? own.uid === 0 : sound(own);
  });
}

export function approval(req) {
  return {
    id: String(req.id),
    kind: 'sudo',
    requester: requester(req),
    command: [req.path ?? req.argv[0], ...req.argv.slice(1)].map(quote).join(' '),
    target: req.target,
    cwd: req.cwd,
    createdAt: req.createdAt,
    expiresAt: req.expiresAt,
    always: req.always !== false && alwaysAllowed(req),
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

export function createApprovals({
  channel = new BroadcastChannel(CHANNEL),
  verify = async () => true,
} = {}) {
  let check = verify;
  const events = emitter();
  const waiting = new Map();
  const mine = new Set();
  let shown = [];
  let owning = false;
  const show = (list) => {
    shown = list;
    events.emit('approvals', shown);
  };
  const end = (id, reason) => {
    if (!shown.some((item) => item.id === id)) return;
    show(shown.filter((item) => item.id !== id));
    const decided = mine.delete(id);
    if (!decided || reason !== 'answered') events.emit('ended', { id, reason });
  };
  const publish = () => {
    const list = [...waiting.values()].map(({ item }) => item);
    show(list);
    channel.postMessage({ list });
  };
  const settle = (id, decision, reason) => {
    const entry = waiting.get(id);
    if (!entry) return;
    waiting.delete(id);
    entry.resolve(decision);
    end(id, reason);
    channel.postMessage({ ended: { id, reason } });
    publish();
  };
  channel.onmessage = ({ data }) => {
    if (owning && data?.hello) publish();
    else if (owning && data?.decide) settle(data.decide.id, data.decide.decision, 'answered');
    else if (!owning && data?.list) show(data.list);
    else if (!owning && data?.ended) end(data.ended.id, data.ended.reason);
  };
  channel.postMessage({ hello: true });
  return {
    port: {
      on: events.on,
      list: () => shown,
      async decide(id, decision) {
        mine.add(id);
        if (owning) settle(id, decision, 'answered');
        else channel.postMessage({ decide: { id, decision } });
      },
    },
    own() {
      owning = true;
      publish();
    },
    verify(next) {
      check = next;
    },
    async offered(req) {
      return req.always !== false && alwaysAllowed(req) && (await check(req).catch(() => false));
    },
    async approve(req, { signal } = {}) {
      const item = approval(req);
      if (item.always) item.always = await check(req).catch(() => false);
      return new Promise((resolve) => {
        waiting.set(item.id, {
          item,
          resolve: (decision) => resolve(decision === 'always' && !item.always ? 'once' : decision),
        });
        publish();
        const stop = () =>
          settle(item.id, 'deny', signal.reason === 'expired' ? 'expired' : 'withdrawn');
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop);
      });
    },
  };
}

export function routeSudo({ agent, fallback, offered, where = () => undefined }) {
  return async (req, options = {}) => {
    const owner = agent();
    if (typeof owner?.approve !== 'function') return fallback(req, options);
    const always = await offered(req);
    if (options.signal?.aborted) return 'deny';
    const place = where(req);
    try {
      const answer = await owner.approve(
        { ...req, always },
        { signal: options.signal, ...(place ? { where: place } : {}) }
      );
      return answer === 'always' && !always ? 'once' : answer;
    } catch (error) {
      if (error?.code === 'EAGAIN') return fallback(req, options);
      return 'deny';
    }
  };
}
