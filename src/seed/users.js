import { production } from './site.js';
import { agentTag } from './tags.js';

const MODES = ['off', 'report', 'enforce'];
const KEY = 'slicc-os.users';
const CONE = /^cone(-[1-9]\d*)?$/;
const SCOOP = /^scoop-[a-z0-9][a-z0-9._-]*$/;
export const PRODUCTION_USERS = 'enforce';

export function usersMode({
  hash = location.hash,
  storage = localStorage,
  host = location.hostname,
  warn = console.warn,
} = {}) {
  const asked = new URLSearchParams(hash.slice(1)).get('users');
  if (production(host)) {
    if (asked !== null || storage.getItem(KEY) !== null) {
      storage.removeItem(KEY);
      warn(`seven runs kernel users '${PRODUCTION_USERS}' and ignores any other mode`);
    }
    return PRODUCTION_USERS;
  }
  if (MODES.includes(asked)) storage.setItem(KEY, asked);
  const mode = storage.getItem(KEY);
  return MODES.includes(mode) ? mode : PRODUCTION_USERS;
}

export function agentFor(user) {
  if (CONE.test(user)) return `cone:${user}`;
  if (SCOOP.test(user)) return `scoop:${user.slice('scoop-'.length)}`;
  return null;
}

function refused(text) {
  return Object.assign(new Error(`bios refuses ${text}`), { code: 'EPERM' });
}

function agentUser(name) {
  if (!agentFor(name))
    throw refused(`the kernel user ${name}: agents run as cone, cone-<n> or scoop-<folder>`);
  return name;
}

function cone(name) {
  if (!CONE.test(name)) throw refused(`the group ${name}: an agent's group is its cone's`);
  return name;
}

function spec({ name, home, groups: asked = [], umask, homeGroup, homeMode }) {
  agentUser(name);
  const scoop = SCOOP.test(name);
  const groups = scoop || asked.includes('sudo') ? asked : [...asked, 'sudo'];
  for (const group of groups) if (scoop || group !== 'sudo') cone(group);
  if (scoop && groups.includes('sudo')) throw refused(`sudo for the scoop ${name}`);
  if (homeGroup !== undefined) cone(homeGroup);
  return {
    name,
    groups,
    ...(home === undefined ? {} : { home }),
    ...(umask === undefined ? {} : { umask }),
    ...(homeGroup === undefined ? {} : { homeGroup }),
    ...(homeMode === undefined ? {} : { homeMode }),
  };
}

export function kernelSource(kernel, requests) {
  const bound = requests ? { requests } : {};
  const connect = (options) => {
    if (options === undefined || options === null || !('user' in options))
      return kernel.connect({ tag: agentTag('root'), ...bound });
    const { user, agentId } = options;
    if (typeof user !== 'string')
      throw refused(`${agentId ?? 'an agent'} as a kernel user that isn't a name`);
    if (agentFor(user) !== agentId) {
      throw refused(`${agentId ?? 'an agent'} as the kernel user ${user}`);
    }
    return kernel.connect({ user, tag: agentTag(agentId), ...bound });
  };
  const users = kernel.users;
  if (!users || users.mode === 'off') return { connect };
  return {
    connect,
    users: {
      mode: users.mode,
      add: async (asked) => users.add(spec(asked)),
      remove: async (name, options) => users.remove(agentUser(name), options),
      list: () => users.list(),
    },
    groups: {
      list: () => kernel.groups.list(),
      addMember: async (group, user) => kernel.groups.addMember(cone(group), agentUser(user)),
      removeMember: async (group, user) => kernel.groups.removeMember(cone(group), agentUser(user)),
    },
  };
}

export async function addCone(kernel, name = 'cone') {
  if (!kernel.users || kernel.users.mode === 'off') return null;
  return kernel.users.add({ name, groups: ['sudo'], homeMode: 0o710, umask: 0o077 });
}

export const LEGACY = [
  '/home/.pi',
  '/home/.slicc',
  '/home/sprinkles',
  '/home/.gelatiere',
  '/home/.welcomed',
  '/home/.welcome.json',
  '/home/sessions',
  '/home/.local',
  '/scoops',
];
export const LOCKED = 'var/lib/slicc/legacy-locked';

export async function lockLegacy(kernel, { text, write, root }) {
  if (!kernel.users || kernel.users.mode === 'off') return false;
  if ((await text(root, LOCKED)) !== null) return false;
  const script = 'for p in "$@"; do [ -e "$p" ] && chmod -R go-rwx "$p"; done; true';
  const { status, stderr } = await kernel.run(['bash', '-c', script, 'lock', ...LEGACY], {
    cwd: '/',
  });
  if (status) throw new Error(stderr.trim() || `chmod exited with ${status}`);
  await write(root, LOCKED, `${new Date().toISOString()}\n`);
  return true;
}

export function kernelUsers(mode, hooks = {}) {
  return mode === 'off' ? { users: 'off' } : { users: mode, ...hooks };
}

export function homeSkips(passwd) {
  const homes = (passwd ?? '')
    .split('\n')
    .map((line) => line.split(':')[5])
    .filter((home) => home?.startsWith('/home/'));
  return homes.flatMap((home) => [`${home}/.local/share/pnpm`, `${home}/.cache`]);
}

export function underProtected(target, paths) {
  return paths.some(
    (path) =>
      target === path ||
      target.startsWith(`${path}/`) ||
      target === '/' ||
      path.startsWith(`${target.replace(/\/$/, '')}/`)
  );
}

function places(dropped, paths) {
  const tops = paths
    .filter((path) => dropped.some(({ target }) => underProtected(target, [path])))
    .map((path) => `/${path.split('/')[1]}`);
  return [...new Set(tops)].join(', ');
}

export function dropProtectedMounts({ storage, key, paths, notices }) {
  let list;
  try {
    list = JSON.parse(storage.getItem(key) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const dropped = list.filter(
    (entry) => typeof entry?.target === 'string' && underProtected(entry.target, paths)
  );
  if (!dropped.length) return [];
  storage.setItem(key, JSON.stringify(list.filter((entry) => !dropped.includes(entry))));
  const where = dropped.map(({ target }) => target).join(', ');
  const one = dropped.length === 1;
  notices.show(
    {
      id: `mounts-protected:${where}`,
      tone: 'warning',
      title: one ? 'A remembered folder wasn’t mounted' : 'Some remembered folders weren’t mounted',
      body: `Seven keeps its own code in ${places(dropped, paths)}, so it no longer mounts folders there. Not mounted: ${where}. Mount ${one ? 'it' : 'them'} somewhere else, such as /mnt.`,
      actions: [],
    },
    () => {}
  );
  return dropped;
}
