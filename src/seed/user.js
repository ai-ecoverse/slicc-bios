import { entries, FIELDS, readLayer } from './layer.js';
import { text, write } from './update.js';

export const folder = 'opt/user';
export const state = 'var/lib/slicc/user';
export const BIN = `/${folder}/node_modules/.bin`;
export const SYSTEM_PATH = '/usr/local/share/pnpm/bin:/usr/local/bin:/usr/bin:/bin';
export const PATH = `${SYSTEM_PATH}:${BIN}`;
export const LOCK = 'slicc-user-packages';
export const DROPPED =
  'Seven now uses the versions it ships for the agent and its tools. Your pinned versions were removed.';
export const DROPPED_GRAMMARS =
  'Seven now uses the versions it ships for the agent and its tools. Your pinned versions and added grammar packages were removed.';
export function droppedNotice(grammars) {
  return {
    id: 'pins-dropped',
    tone: 'info',
    title: 'Your pinned versions were removed',
    body: grammars ? DROPPED_GRAMMARS : DROPPED,
    actions: [],
  };
}
const HOME = `/${state}/home`;
const HYGIENE = ['--ignore-scripts', '--ignore-pnpmfile', '--config.userconfig=/dev/null'];
const CLEAN = {
  HOME,
  XDG_CONFIG_HOME: `${HOME}/.config`,
  XDG_CACHE_HOME: `${HOME}/.cache`,
  PNPM_HOME: '/usr/local/share/pnpm',
  PATH: SYSTEM_PATH,
  NODE_OPTIONS: '',
};
const SAVE = {
  dependencies: [],
  devDependencies: ['--save-dev'],
  optionalDependencies: ['--save-optional'],
};
const MANIFEST = {
  name: 'slicc-user-packages',
  private: true,
  description:
    'Your packages: skills, prompts and roles the agent reads after its own. Root owns this project; cones read it.',
  dependencies: {},
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function parse(data) {
  try {
    return data === null ? null : JSON.parse(data);
  } catch {
    return null;
  }
}

export function locked(task, locks = navigator.locks) {
  return locks.request(LOCK, task);
}

async function run(kernel, argv) {
  const { status, stderr } = await kernel.run(argv, { cwd: `/${folder}`, env: CLEAN });
  if (status) throw new Error(stderr.trim() || `${argv[0]} exited with ${status}`);
}

export async function ensure(root, kernel) {
  if ((await text(root, `${folder}/package.json`)) === null)
    await write(root, `${folder}/package.json`, json(MANIFEST));
  await write(root, `${state}/home/.keep`, '');
  await run(kernel, ['chmod', '-R', 'u=rwX,go=rX', `/${folder}`]);
}

export async function pnpm(root, kernel, argv) {
  await ensure(root, kernel);
  await run(kernel, ['pnpm', ...argv, ...HYGIENE]);
  await run(kernel, ['chmod', '-R', 'u=rwX,go=rX', `/${folder}`]);
}

export function adds(additions) {
  const groups = new Map();
  for (const [name, { spec, field }] of Object.entries(additions)) {
    const flags = SAVE[field] ?? SAVE.dependencies;
    const key = flags.join(' ');
    if (!groups.has(key)) groups.set(key, { flags, specs: [] });
    groups.get(key).specs.push(`${name}@${spec}`);
  }
  return [...groups.values()].map(({ flags, specs }) => ['add', ...flags, ...specs]);
}

export async function move(root, kernel, project, edit) {
  const layer = readLayer(await text(root, `${project.state}/user.json`));
  const names = Object.keys(layer.add);
  if (!names.length) return [];
  for (const argv of adds(layer.add)) await pnpm(root, kernel, argv);
  await edit(root, project, names);
  return names;
}

export function enforcing(kernel) {
  return kernel?.users?.mode === 'enforce';
}

export async function drop(root, project, edit, { additions = false } = {}) {
  const layer = readLayer(await text(root, `${project.state}/user.json`));
  const names = [...Object.keys(layer.pin), ...(additions ? Object.keys(layer.add) : [])];
  if (!names.length) return [];
  await edit(root, project, names);
  return names;
}

export async function shipped(root, project) {
  return new Set(entries(parse(await text(root, `${project.state}/package.json`))).keys());
}

export async function rows(root, agent) {
  const manifest = parse(await text(root, `${folder}/package.json`));
  if (!manifest) return [];
  const own = await shipped(root, agent);
  const out = [];
  for (const field of FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      const installed = parse(await text(root, `${folder}/node_modules/${name}/package.json`));
      const ships =
        own.has(name) ||
        (await text(root, `${agent.folder}/node_modules/${name}/package.json`)) !== null;
      out.push({
        id: `user:user:${name}`,
        package: name,
        label: name,
        description: installed?.description ?? 'Added with pnpm',
        commands: [],
        origin: 'user',
        pin: { base: null, range: spec, project: `/${folder}` },
        state: 'installed',
        version: installed?.version ?? spec,
        offered: null,
        progress: null,
        error: null,
        actions: ['remove'],
        ...(ships
          ? { warnings: [`Seven's agent ships its own ${name} and ignores this one.`] }
          : {}),
      });
    }
  }
  return out;
}

export function remove(root, kernel, name) {
  return pnpm(root, kernel, ['remove', name]);
}
