import { apply } from './layer.js';
import { text, versions } from './update.js';

const deployed = new URL('../packages/agent/', import.meta.url);
const PACKAGE = '@ai-ecoverse/slicc-agent';
export const folder = 'opt/agent';
const state = 'var/lib/slicc/agent';
const receipt = `${state}/pnpm-lock.yaml`;
export const project = {
  id: 'agent',
  folder,
  state,
  from: deployed,
  primary: PACKAGE,
  workspace: true,
  lock: 'slicc-agent-install',
};
export const modules = new URL(`../${folder}/node_modules/${PACKAGE}/dist/`, import.meta.url);
export const agentWorker = new URL('agent-worker.js', modules);

export async function recorded() {
  const root = await navigator.storage.getDirectory();
  const lock = await text(root, receipt);
  return lock === null ? null : lock + ((await text(root, `${state}/applied.json`)) ?? '');
}

export async function installed() {
  return (await recorded()) !== null;
}

export async function version() {
  const root = await navigator.storage.getDirectory();
  return (await versions(root, [PACKAGE], `${folder}/`))[PACKAGE];
}

export function installAgent(start, { from = deployed, ...options } = {}) {
  return navigator.locks.request(project.lock, async () =>
    apply(await navigator.storage.getDirectory(), { ...project, from }, { start, ...options })
  );
}

let chat = null;
let run = 0;

export function loadChat({ load = (file) => import(new URL(file, modules)), fresh = false } = {}) {
  if (fresh) {
    run += 1;
    chat = null;
  }
  if (chat) return chat;
  const query = run ? `?run=${run}` : '';
  const loading = Promise.all([load(`page.js${query}`), load(`spectrum/index.js${query}`)]).then(
    ([{ startAgent, connectAgent, remoteControl }, { createAgentModel }]) => ({
      startAgent,
      connectAgent,
      remoteControl,
      createAgentModel,
    })
  );
  chat = loading;
  loading.catch(() => {
    if (chat !== loading) return;
    chat = null;
    run += 1;
  });
  return loading;
}

export async function startChat(kernel, options) {
  const { startAgent } = await loadChat(options);
  return startAgent({
    worker: () => new Worker(agentWorker, { type: 'module', name: 'slicc-agent' }),
    kernel: { connect: () => kernel.connect() },
    held: true,
  });
}

export async function restartChat(kernel, running, options = {}) {
  await loadChat({ ...options, fresh: true }).finally(() => running.release());
  return startChat(kernel, options);
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

export async function remoteAgent(owner, { load = loadChat, cone } = {}) {
  if (!owner) return null;
  const { connectAgent, remoteControl } = await load();
  if (!remoteControl) return null;
  const connection = await connectAgent(await owner.port());
  const remote = remoteControl(connection, cone ? { agent: cone } : {});
  return {
    prompt: (args) => remote.prompt(args),
    watch: (args) => remote.watch(args),
    abort: () => remote.abort(),
    close: () => connection.close(),
  };
}
