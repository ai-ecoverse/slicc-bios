import { fetchText, pnpm, text, versions, write } from './update.js';

const deployed = new URL('../packages/agent/', import.meta.url);
const PACKAGE = '@ai-ecoverse/slicc-agent';
export const folder = 'opt/agent';
const receipt = 'var/lib/slicc/agent/pnpm-lock.yaml';
export const modules = new URL(`../${folder}/node_modules/${PACKAGE}/dist/`, import.meta.url);
export const agentWorker = new URL('agent-worker.js', modules);

export async function recorded() {
  return text(await navigator.storage.getDirectory(), receipt);
}

export async function installed() {
  return (await recorded()) !== null;
}

export async function version() {
  const root = await navigator.storage.getDirectory();
  return (await versions(root, [PACKAGE], `${folder}/`))[PACKAGE];
}

async function install(start, from, report) {
  const root = await navigator.storage.getDirectory();
  const lock = await fetchText('pnpm-lock.yaml', from);
  if (lock === (await text(root, receipt))) return false;
  const manifest = await fetchText('package.json', from);
  await write(root, `${folder}/package.json`, manifest);
  await write(root, `${folder}/pnpm-lock.yaml`, lock);
  const workspace = await fetchText('pnpm-workspace.yaml', from).catch(() => '{}\n');
  await write(root, `${folder}/pnpm-workspace.yaml`, workspace);
  const kernel = await start();
  try {
    await pnpm(kernel, `/${folder}`, report, JSON.parse(manifest).dependencies?.[PACKAGE]);
  } finally {
    kernel.terminate();
  }
  await write(root, receipt, lock);
  return true;
}

export function installAgent(start, { from = deployed, report = () => {} } = {}) {
  return navigator.locks.request('slicc-agent-install', () => install(start, from, report));
}

let chat = null;

export function loadChat({ load = (file) => import(new URL(file, modules)) } = {}) {
  chat ??= Promise.all([load('page.js'), load('spectrum/index.js')]).then(
    ([{ startAgent, connectAgent }, { createAgentModel }]) => ({
      startAgent,
      connectAgent,
      createAgentModel,
    })
  );
  chat.catch(() => {
    chat = null;
  });
  return chat;
}

export async function startChat(kernel, options) {
  const { startAgent } = await loadChat(options);
  return startAgent({
    worker: () => new Worker(agentWorker, { type: 'module', name: 'slicc-agent' }),
    kernel: { connect: () => kernel.connect() },
    held: true,
  });
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
