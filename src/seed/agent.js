import { fetchText, text, write } from './update.js';

const deployed = new URL('../packages/agent/', import.meta.url);
export const folder = 'opt/agent';
const receipt = 'var/lib/slicc/agent/pnpm-lock.yaml';
export const modules = new URL(
  `../${folder}/node_modules/@ai-ecoverse/slicc-agent/dist/`,
  import.meta.url
);
export const agentWorker = new URL('agent-worker.js', modules);

export async function recorded() {
  return text(await navigator.storage.getDirectory(), receipt);
}

export async function installed() {
  return (await recorded()) !== null;
}

export function progress(output) {
  const last = [...output.matchAll(/resolved (\d+), reused \d+, downloaded \d+, added (\d+)/g)].at(
    -1
  );
  return last ? `${last[2]}/${last[1]}` : null;
}

async function install(start, from, report) {
  const root = await navigator.storage.getDirectory();
  const lock = await fetchText('pnpm-lock.yaml', from);
  if (lock === (await text(root, receipt))) return false;
  report('installing the agent…');
  await write(root, `${folder}/package.json`, await fetchText('package.json', from));
  await write(root, `${folder}/pnpm-lock.yaml`, lock);
  const argv = ['pnpm', 'install', '--frozen-lockfile', '--trust-lockfile'];
  let output = '';
  const onStdout = (chunk) => {
    output = (output + chunk).slice(-512);
    const done = progress(output);
    if (done) report(`installing the agent… ${done}`);
  };
  const kernel = await start();
  try {
    const { status, stderr } = await kernel.run(argv, { cwd: `/${folder}`, onStdout });
    if (status) throw new Error(stderr.trim() || `pnpm exited with ${status}`);
  } finally {
    kernel.terminate();
  }
  await write(root, receipt, lock);
  return true;
}

export function installAgent(start, { from = deployed, report = () => {} } = {}) {
  return navigator.locks.request('slicc-agent-install', () => install(start, from, report));
}

export async function startChat(kernel, { load = (file) => import(new URL(file, modules)) } = {}) {
  const [{ startAgent }, { createAgentModel }] = await Promise.all([
    load('page.js'),
    load('spectrum/index.js'),
  ]);
  const owner = await startAgent({
    worker: () => new Worker(agentWorker, { type: 'module', name: 'slicc-agent' }),
    kernel: { connect: () => kernel.connect() },
  });
  return { owner, connection: await owner.connect(), createAgentModel };
}

export function whenIdle(agent) {
  return new Promise((resolve) => {
    let off = () => {};
    const check = () => {
      if (agent.busy(agent.active())) return false;
      off();
      resolve();
      return true;
    };
    if (!check()) off = agent.on('agents', check);
  });
}

export async function restartChat({ owner, connection, createAgentModel }) {
  void connection.close().catch(() => undefined);
  await owner.restart();
  return { owner, connection: await owner.connect(), createAgentModel };
}
