const MODES = ['report', 'enforce'];
const KEY = 'slicc-os.users';
const CONE = /^cone(-[1-9]\d*)?$/;
const SCOOP = /^scoop-[a-z0-9][a-z0-9._-]*$/;

export function usersMode({ hash = location.hash, storage = localStorage } = {}) {
  const asked = new URLSearchParams(hash.slice(1)).get('users');
  if (MODES.includes(asked)) storage.setItem(KEY, asked);
  if (asked === 'off') storage.removeItem(KEY);
  const mode = storage.getItem(KEY);
  return MODES.includes(mode) ? mode : 'off';
}

export function terminalUser({ mode, storage = localStorage } = {}) {
  const user = storage.getItem('slicc-os.terminal-user');
  return mode !== 'off' && user && agentFor(user) ? user : null;
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

function spec({ name, home, groups = [], umask, homeGroup, homeMode }) {
  agentUser(name);
  const scoop = SCOOP.test(name);
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

export function agentTag(agentId) {
  return JSON.stringify({ kind: 'agent', agentId });
}

export function terminalTag(where) {
  return JSON.stringify({ kind: 'user', where: `terminal:${where}` });
}

export function kernelSource(kernel) {
  const connect = (options) => {
    if (!options?.user) return kernel.connect();
    const { user, agentId } = options;
    if (agentFor(user) !== agentId) {
      throw refused(`${agentId ?? 'an agent'} as the kernel user ${user}`);
    }
    return kernel.connect({ user, tag: agentTag(agentId) });
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

export function boundTo(user) {
  return user ? { user } : {};
}

export function kernelUsers(mode, hooks) {
  return mode === 'off' ? {} : { users: mode, ...hooks };
}
