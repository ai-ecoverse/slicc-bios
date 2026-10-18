import { apply } from './layer.js';
import { failure } from './link.js';
import { text, versions } from './update.js';
import { kernelSource } from './users.js';
import { takesVault } from './vault.js';

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
let chatFrom = null;
let run = 0;

export function loadChat({ load = (file) => import(new URL(file, modules)), fresh = false } = {}) {
  if (fresh) {
    run += 1;
    chat = null;
  }
  if (chat) return chat;
  const query = run ? `?run=${run}` : '';
  const loading = Promise.all([load(`page.js${query}`), load(`spectrum/index.js${query}`)]).then(
    ([
      { startAgent, connectAgent, connectGuest, remoteControl, bridgePort, linkEndpoint },
      { createAgentModel },
    ]) => ({
      startAgent,
      connectAgent,
      connectGuest,
      remoteControl,
      bridgePort,
      linkEndpoint,
      createAgentModel,
    })
  );
  chat = loading;
  chatFrom = recorded();
  loading.catch(() => {
    if (chat !== loading) return;
    chat = null;
    run += 1;
  });
  return loading;
}

export function vaultWorker(create, vault) {
  if (!vault) return create;
  return () => {
    const worker = create();
    const detach = vault.attach(worker);
    return {
      postMessage: (message, transfer) => worker.postMessage(message, transfer),
      terminate() {
        detach();
        worker.terminate();
      },
    };
  };
}

let chatVault = null;

export function useVault(vault) {
  chatVault = vault;
}

async function outdated() {
  return chat !== null && (await chatFrom) !== (await recorded());
}

export async function startChat(kernel, { vault = chatVault, ...options } = {}) {
  const fresh = options.fresh || (await outdated());
  const { startAgent } = await loadChat({ ...options, fresh });
  const takes = vault && takesVault(await version());
  return startAgent({
    worker: vaultWorker(
      () => new Worker(agentWorker, { type: 'module', name: 'slicc-agent' }),
      takes ? vault : null
    ),
    kernel: kernelSource(kernel),
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

export async function deliverWebhook(owner, name, delivery, { load = loadChat } = {}) {
  if (!owner) throw new Error('the agent is not running');
  const { connectAgent } = await load();
  const connection = await connectAgent(await owner.port());
  try {
    if (typeof connection.webhook !== 'function')
      throw new Error('this slicc-agent takes no webhooks');
    return await connection.webhook(name, delivery);
  } finally {
    connection.close();
  }
}

export function streamSink(stream) {
  let writes = Promise.resolve();
  return {
    write(chunk) {
      writes = writes.then(() => stream.write(chunk)).catch(() => undefined);
    },
    close() {
      writes = writes.then(() => stream.closeWrite());
    },
  };
}

export async function pumpLink(stream, end) {
  try {
    for (let chunk = await stream.read(); chunk; chunk = await stream.read()) end.receive(chunk);
    end.end();
  } catch (error) {
    end.end(error);
  }
}

export async function bridgeAgent(
  owner,
  stream,
  { readOnly, device, guest, load = loadChat } = {}
) {
  if (!owner) throw failure('EAGAIN: the agent is not running');
  const { bridgePort } = await load();
  if (!bridgePort) throw failure('EOPNOTSUPP: this agent cannot be followed');
  const port = await owner.port({
    readOnly,
    pages: false,
    ...(device ? { device } : {}),
    ...(guest ? { guest: { id: guest.id, label: guest.label } } : {}),
  });
  stream.accepted({});
  await pumpLink(stream, bridgePort(port, streamSink(stream)));
}

async function dial(open, linkEndpoint, connect) {
  const stream = await open({ kind: 'pi' });
  const endpoint = linkEndpoint(streamSink(stream));
  void pumpLink(stream, endpoint);
  return connect(endpoint);
}

export async function followAgent(open, { load = loadChat } = {}) {
  const { connectAgent, linkEndpoint } = await load();
  if (!linkEndpoint) throw failure('EOPNOTSUPP: this agent cannot follow');
  return dial(open, linkEndpoint, connectAgent);
}

export async function followGuest(open, { load = loadChat } = {}) {
  const { connectGuest, linkEndpoint } = await load();
  if (!linkEndpoint || !connectGuest) throw failure('EOPNOTSUPP: this agent has no guest seats');
  return dial(open, linkEndpoint, connectGuest);
}
