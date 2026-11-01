export const POLICY_FILES = ['/etc/fnox/config.toml', '/etc/slicc/secrets-policy.toml'];
const DIRECTORIES = ['/', '/etc', '/etc/fnox', '/etc/slicc'];
const CONFIG = 'default_provider = "seven"\n\n[providers.seven]\ntype = "sealed"\n';
const POLICY_OPS = new Set([
  'materialize',
  'materializeConsume',
  'sessionMaterialize',
  'sessionAnchors',
]);

const trusted = (value) =>
  value?.uid === 0 &&
  Number.isSafeInteger(value.mode) &&
  (value.mode & 0o022) === 0 &&
  value.isSymbolicLink === false;

export function policyDependent(request) {
  return POLICY_OPS.has(request?.op);
}

async function statOf(client, path) {
  try {
    return await client.fs.lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function seedDirectory(kernel, client, path) {
  const stat = await statOf(client, path);
  if (stat) {
    if (!trusted(stat) || stat.isDirectory !== true)
      throw new Error('the policy parent is not trusted');
    return;
  }
  if (path === '/' || path === '/etc') throw new Error('the policy parent is missing');
  const result = await kernel.run(
    ['bash', '--noprofile', '--norc', '-c', 'umask 022; mkdir -- "$1"', 'policy', path],
    { cwd: '/' }
  );
  if (result.status) throw new Error('the policy directory could not be created');
}

async function seedFile(kernel, client, path) {
  const stat = await statOf(client, path);
  if (stat) {
    if (!trusted(stat) || stat.isFile !== true) throw new Error('the policy file is not trusted');
    return;
  }
  const result = await kernel.run(
    [
      'bash',
      '--noprofile',
      '--norc',
      '-c',
      'set -Ce; umask 022; printf "%s" "$2" > "$1"',
      'policy',
      path,
      path === POLICY_FILES[0] ? CONFIG : '',
    ],
    { cwd: '/' }
  );
  if (result.status) throw new Error('the policy file could not be created');
}

export async function seedPolicies(kernel, attach) {
  if (kernel.users?.mode !== 'enforce') return;
  const client = await attach(await kernel.connect());
  try {
    const mounts = await client.mounts();
    const targets = [...DIRECTORIES, ...POLICY_FILES];
    if (
      mounts.some(({ target }) =>
        targets.some((path) => target === '/' || path === target || path.startsWith(`${target}/`))
      )
    )
      throw new Error('the policy path is mounted');
    for (const path of DIRECTORIES) await seedDirectory(kernel, client, path);
    for (const path of POLICY_FILES) await seedFile(kernel, client, path);
  } finally {
    await client.close();
  }
}

export function createPolicySync({ kernel, vault, report = () => {} }) {
  let ready = false;
  let epoch = 0;
  let stopped = false;
  let running = false;
  let working = Promise.resolve();
  let again = false;
  let unwatch;
  let offStatus;
  let offAvailability;
  let connection;
  let watching = false;
  const listeners = new Set();
  const hold = () => {
    ready = false;
    epoch += 1;
    for (const listener of listeners) listener();
  };
  const synchronise = async (version) => {
    const active = vault.forwardEpoch();
    if (active === null || kernel.users?.mode !== 'enforce') return;
    try {
      const files = await Promise.all(
        POLICY_FILES.map((path) => kernel.attest(path, { absent: 'allow' }))
      );
      if (version !== epoch || stopped) return;
      const reply = await vault.call(
        'policy',
        { files },
        { dropAway: true, signal: AbortSignal.timeout(10000) }
      );
      if (version !== epoch || stopped || vault.forwardEpoch() !== active) return;
      ready = files.every((file) => file.absent !== true) && reply.accepted === true;
      if (!ready) report('the credential policy is unavailable');
    } catch {
      report('the credential policy is unavailable');
    }
  };
  const refresh = () => {
    hold();
    again = true;
    if (running || stopped) return working;
    running = true;
    working = (async () => {
      try {
        while (again && !stopped) {
          again = false;
          await synchronise(epoch);
        }
      } finally {
        running = false;
      }
    })();
    return working;
  };
  const connected = () => {
    const next = vault.forwardEpoch();
    if (next === connection) return;
    connection = next;
    void refresh();
  };
  return {
    ready: () => ready && watching && !stopped && vault.forwardEpoch() !== null,
    epoch: () => epoch,
    settled: () => working,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      if (stopped || offStatus) return;
      offStatus = vault.port.on('status', connected);
      offAvailability = vault.port.on('availability', connected);
      unwatch = await kernel.watch([...DIRECTORIES, ...POLICY_FILES], refresh);
      if (typeof unwatch !== 'function') throw new Error('the policy watcher is unavailable');
      watching = true;
      void refresh();
    },
    close() {
      stopped = true;
      hold();
      unwatch?.();
      offStatus?.();
      offAvailability?.();
      listeners.clear();
    },
  };
}
