import { edit, entries, FIELDS, readLayer } from './layer.js';
import { fence, STORE, text, write } from './update.js';

export const folder = 'opt/user';
export const MODULES = `/${folder}/node_modules`;
export const LOCK = 'slicc-user-packages';
export const DROPPED =
  'Seven now uses the versions it ships for the agent and its tools. To add your own packages, use /opt/user (Install / Update › Your packages).';
const UNINSTALLED = 'Not installed in /opt/user yet. Retry installs it.';
const HOME = '/var/lib/slicc/user/home';
const SYSTEM = '/usr/local/share/pnpm';
const HYGIENE = ['--ignore-scripts', '--ignore-pnpmfile', '--config.userconfig=/dev/null'];
const CLEAN = {
  HOME,
  XDG_CONFIG_HOME: `${HOME}/.config`,
  XDG_CACHE_HOME: `${HOME}/.cache`,
  PNPM_HOME: SYSTEM,
  PATH: `${SYSTEM}/bin:/usr/local/bin:/usr/bin:/bin`,
  NODE_OPTIONS: '',
  SLICC_WASM_BACKTRACE: '1',
};
const READABLE = ['chmod', '-R', 'u=rwX,go=rX', `/${folder}`];
const REQUIRED = ['dependencies', 'devDependencies'];
const MANIFEST = {
  name: 'slicc-user-packages',
  private: true,
  description:
    'Your packages: skills, prompt templates, roles and commands for every user of seven. Root owns this project, and cones and scoops read it.',
  dependencies: {},
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const firstLine = (message) => message.split('\n')[0].trim();

function parse(data) {
  try {
    return data === null ? null : JSON.parse(data);
  } catch {
    return null;
  }
}

export function droppedNotice(grammars) {
  return {
    id: 'pins-dropped',
    tone: 'info',
    title: grammars
      ? 'Your pinned versions and added grammar packages were removed'
      : 'Your pinned versions were removed',
    body: DROPPED,
    actions: [],
  };
}

async function directory(root, path) {
  let dir = root;
  for (const part of path.split('/')) dir = await dir.getDirectoryHandle(part, { create: true });
}

export async function ensure(root) {
  if ((await text(root, `${folder}/package.json`)) === null)
    await write(root, `${folder}/package.json`, json(MANIFEST));
  await fence(root, `/${folder}`);
  await directory(root, HOME.slice(1));
}

export async function adopt(root, project, { move, strict }) {
  const layer = readLayer(await text(root, `${project.state}/user.json`));
  const added = Object.keys(layer.add);
  const moved = move ? added : [];
  const pins = strict ? Object.keys(layer.pin) : [];
  const adds = strict && !move ? added : [];
  if (moved.length) {
    const manifest = parse(await text(root, `${folder}/package.json`)) ?? structuredClone(MANIFEST);
    const have = entries(manifest);
    for (const name of moved.filter((name) => !have.has(name))) {
      const { spec, field } = layer.add[name];
      const into = FIELDS.includes(field) ? field : 'dependencies';
      manifest[into] = { ...manifest[into], [name]: spec };
    }
    await write(root, `${folder}/package.json`, json(manifest));
  }
  const names = [...moved, ...pins, ...adds];
  if (names.length) await edit(root, project, names);
  return { moved, pins, adds };
}

export async function missing(root) {
  const manifest = parse(await text(root, `${folder}/package.json`)) ?? {};
  const out = [];
  for (const field of REQUIRED) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if ((await text(root, `${folder}/node_modules/${name}/package.json`)) === null)
        out.push(name);
    }
  }
  return out;
}

function bins(manifest) {
  if (typeof manifest?.bin === 'string') return [manifest.name.split('/').pop()];
  return Object.keys(manifest?.bin ?? {});
}

export async function rows(root, errors = new Map()) {
  const manifest = parse(await text(root, `${folder}/package.json`));
  const out = [];
  for (const [name, { spec }] of entries(manifest)) {
    const installed = parse(await text(root, `${folder}/node_modules/${name}/package.json`));
    const shipped = (await text(root, `node_modules/${name}/package.json`)) !== null;
    const error = errors.get(name) ?? (installed ? null : UNINSTALLED);
    out.push({
      id: `user:user:${name}`,
      package: name,
      label: name,
      description: installed?.description ?? 'Added with pnpm',
      commands: bins(installed),
      origin: 'user',
      pin: { base: null, range: spec, project: `/${folder}` },
      state: error ? 'failed' : 'installed',
      version: installed?.version ?? spec,
      offered: null,
      progress: null,
      error,
      actions: installed ? ['remove'] : ['retry', 'remove'],
      ...(shipped ? { warnings: [`Seven ships its own ${name} and ignores this one.`] } : {}),
    });
  }
  return out;
}

export function createUserPackages({
  root,
  kernel,
  projects,
  strict,
  notices,
  locks = navigator.locks,
}) {
  const errors = new Map();
  const locked = (task) => locks.request(LOCK, task);
  const run = async (argv) => {
    const { status, stderr } = await kernel().run(argv, { cwd: `/${folder}`, env: CLEAN });
    if (status) throw new Error(stderr.trim() || `${argv[0]} exited with ${status}`);
  };
  const pnpm = async (argv) => {
    await ensure(root);
    await locks.request(STORE, () => run(['pnpm', ...argv, ...HYGIENE]));
    await run(READABLE);
  };
  async function install() {
    let names = [];
    let failure = null;
    try {
      await locked(async () => {
        names = await missing(root);
        if (names.length) await pnpm(['install', '--no-frozen-lockfile']);
      });
    } catch (error) {
      failure = firstLine(error.message);
    }
    const left = new Set(await missing(root));
    for (const name of [...errors.keys()]) if (!left.has(name)) errors.delete(name);
    if (failure) for (const name of names) errors.set(name, failure);
  }
  return {
    rows: () => rows(root, errors),
    async tidy() {
      await locked(() => ensure(root));
      const on = strict();
      let pins = 0;
      let grammars = 0;
      for (const [id, project] of Object.entries(projects)) {
        const found = await locks.request(project.lock, () =>
          locked(() => adopt(root, project, { move: id === 'agent', strict: on }))
        );
        pins += found.pins.length;
        grammars += found.adds.length;
      }
      if (pins + grammars) notices.show(droppedNotice(grammars > 0), () => {});
      await install();
    },
    async act(name, action) {
      if (action === 'retry') return install();
      try {
        await locked(() => pnpm(['remove', name]));
        errors.delete(name);
      } catch (error) {
        errors.set(name, firstLine(error.message));
      }
    },
  };
}
