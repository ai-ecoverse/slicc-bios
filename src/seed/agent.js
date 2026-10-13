import { apply, merge, readLayer } from './layer.js';
import { failure } from './link.js';
import { text, versions, write } from './update.js';
import { kernelSource } from './users.js';

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

export const BUILD = 'slicc-os.agent-build';

export async function pinBuild(root, url, fetcher = fetch) {
  const base = JSON.parse((await text(root, `${state}/package.json`)) ?? 'null');
  const known = JSON.parse((await text(root, `${state}/build.json`)) ?? 'null');
  if (!url || !base || known?.url === url) return false;
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`the agent build at ${url} answered ${response.status}`);
  const bytes = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const id = Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const file = `rc/slicc-agent-${id}.tgz`;
  await write(root, `${folder}/${file}`, bytes);
  const layer = readLayer(await text(root, `${state}/user.json`));
  layer.pin[PACKAGE] = {
    spec: `file:${file}`,
    field: 'dependencies',
    base: base.dependencies?.[PACKAGE] ?? null,
  };
  await write(root, `${folder}/package.json`, `${JSON.stringify(merge(base, layer), null, 2)}\n`);
  await write(root, `${state}/user.json`, `${JSON.stringify({ ...layer, pending: true })}\n`);
  await write(root, `${state}/build.json`, `${JSON.stringify({ url, file })}\n`);
  return true;
}

export function installAgent(
  start,
  { from = deployed, build = localStorage.getItem(BUILD), ...options } = {}
) {
  return navigator.locks.request(project.lock, async () => {
    const root = await navigator.storage.getDirectory();
    await pinBuild(root, build).catch((error) => console.warn(`agent build: ${error.message}`));
    return apply(root, { ...project, from }, { start, ...options });
  });
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
    ([
      { startAgent, connectAgent, remoteControl, bridgePort, linkEndpoint },
      { createAgentModel },
    ]) => ({
      startAgent,
      connectAgent,
      remoteControl,
      bridgePort,
      linkEndpoint,
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

export async function bridgeAgent(owner, stream, { readOnly, load = loadChat } = {}) {
  if (!owner) throw failure('EAGAIN: the agent is not running');
  const { bridgePort } = await load();
  if (!bridgePort) throw failure('EOPNOTSUPP: this agent cannot be followed');
  const port = await owner.port({ readOnly, pages: false });
  stream.accepted({});
  await pumpLink(stream, bridgePort(port, streamSink(stream)));
}

export async function followAgent(open, { load = loadChat } = {}) {
  const { connectAgent, linkEndpoint } = await load();
  if (!linkEndpoint) throw failure('EOPNOTSUPP: this agent cannot follow');
  const stream = await open({ kind: 'pi' });
  const endpoint = linkEndpoint(streamSink(stream));
  void pumpLink(stream, endpoint);
  return connectAgent(endpoint);
}
