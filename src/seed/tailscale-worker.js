const open = new Map();
const dropped = new Set();
let ipn = null;
let reported = '';

function send(message, transfer = []) {
  self.postMessage(message, transfer);
}

function report() {
  const status = ipn?.status();
  if (status && status !== reported) {
    reported = status;
    send({ status: JSON.parse(status) });
  }
}

function later() {
  setTimeout(report, 0);
}

function failure(error) {
  return {
    message: error?.message ?? String(error),
    ...(typeof error?.code === 'string' && error.code ? { code: error.code } : {}),
    ...(typeof error?.status === 'number' ? { status: error.status } : {}),
  };
}

async function start({ wasm, exec, config, state }) {
  const glue = URL.createObjectURL(new Blob([exec], { type: 'text/javascript' }));
  try {
    await import(glue);
  } finally {
    URL.revokeObjectURL(glue);
  }
  const go = new self.Go();
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
  void go.run(instance);
  while (typeof self.newIPN !== 'function') await new Promise((resolve) => setTimeout(resolve, 10));
  const kept = { ...state };
  ipn = self.newIPN({
    stateStorage: {
      getState: (key) => kept[key] ?? '',
      setState: (key, value) => {
        kept[key] = value;
        send({ state: { key, value } });
      },
    },
    hostname: config.hostname,
    ephemeral: config.ephemeral === true,
    ...(config.authKey ? { authKey: config.authKey } : {}),
    ...(config.controlURL ? { controlURL: config.controlURL } : {}),
    ...(config.exitNode ? { exitNode: config.exitNode } : {}),
  });
  if (ipn instanceof Error) {
    const error = ipn;
    ipn = null;
    throw error;
  }
  let running = false;
  ipn.run({
    notifyState: (backend) => {
      send({ backend });
      if (backend === 'NeedsLogin') ipn.login();
      if (backend === 'Running' && !running) {
        running = true;
        if (config.exitNode)
          ipn.setExitNode(config.exitNode).catch((error) => send({ warning: failure(error) }));
      }
      later();
    },
    notifyNetMap: later,
    notifyBrowseToURL: (url) => send({ login: url }),
    notifyPanicRecover: (error) => send({ warning: { message: error } }),
  });
  setInterval(report, 5000);
}

async function fetchOne({ id, ...request }) {
  try {
    const response = await ipn.fetch(request);
    if (dropped.delete(id)) {
      response.cancel();
      return;
    }
    open.set(id, response);
    send({
      head: {
        id,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    });
  } catch (error) {
    dropped.delete(id);
    send({ error: { id, ...failure(error) } });
  }
}

async function readOne(id) {
  const response = open.get(id);
  if (!response) return;
  try {
    const bytes = await response.read();
    if (bytes === null) {
      open.delete(id);
      send({ end: { id } });
    } else send({ chunk: { id, bytes } }, [bytes.buffer]);
  } catch (error) {
    open.delete(id);
    send({ error: { id, ...failure(error) } });
  }
}

async function dialOne({ id, network, addr }) {
  try {
    const conn = await ipn.dial(network, addr);
    open.set(id, conn);
    send({ dialled: { id, localAddr: conn.localAddr, remoteAddr: conn.remoteAddr } });
  } catch (error) {
    send({ error: { id, ...failure(error) } });
  }
}

async function writeOne({ id, op = id, bytes }) {
  const conn = open.get(id);
  if (!conn?.write) return send({ error: { id: op, message: 'no such connection' } });
  try {
    send({ wrote: { id: op, n: await conn.write(bytes) } });
  } catch (error) {
    send({ error: { id: op, ...failure(error) } });
  }
}

function closeWriteOne(id) {
  open.get(id)?.closeWrite?.();
}

function closeOne(id) {
  open.get(id)?.close();
  open.delete(id);
}

function cancelOne(id) {
  const response = open.get(id);
  if (response) {
    open.delete(id);
    response.cancel();
  } else dropped.add(id);
}

async function settle(id, work) {
  try {
    await work;
    send({ done: { id } });
    report();
  } catch (error) {
    send({ error: { id, ...failure(error) } });
  }
}

export function handle(data) {
  if (data.start) return start(data.start).catch((error) => send({ failed: failure(error) }));
  if (!ipn)
    return send({
      error: {
        id:
          data.fetch?.id ??
          data.dial?.id ??
          data.write?.op ??
          data.write?.id ??
          data.exitNode?.id ??
          data.logout ??
          data.read,
        message: 'tailscale is not running',
      },
    });
  if (data.fetch) return fetchOne(data.fetch);
  if (data.read !== undefined) return readOne(data.read);
  if (data.cancel !== undefined) return cancelOne(data.cancel);
  if (data.dial) return dialOne(data.dial);
  if (data.write) return writeOne(data.write);
  if (data.close !== undefined) return closeOne(data.close);
  if (data.closeWrite !== undefined) return closeWriteOne(data.closeWrite);
  if (data.exitNode) return settle(data.exitNode.id, ipn.setExitNode(data.exitNode.expr));
  if (data.logout !== undefined) return settle(data.logout, Promise.resolve(ipn.logout()));
  if (typeof data.login === 'string') return ipn.login(data.login);
  if (data.login) return ipn.login();
}

self.addEventListener('message', ({ data }) => void handle(data));
