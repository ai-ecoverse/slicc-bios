import { createServer } from 'node:http';

const frame = `
addEventListener('message', async (event) => {
  if (event.source !== parent || event.data?.type !== 'slicc-vault' || event.data.op !== 'hello') return;
  const port = event.ports[0];
  if (event.data.role === 'agent') return port.close();
  const send = async (message) => {
    const req = message.req;
    const response = await fetch('/rpc', {
      method: 'POST',
      body: JSON.stringify({
        id: message.id,
        op: message.op,
        sealed: req?.op,
        fields: Object.keys(req ?? {}),
        oauthFields: Object.keys(req?.oauth ?? {}),
        marker: message.kernelOAuth,
        stamp: message.stamp,
        access: req?.accessToken === 'fake-initial-access',
        refresh: req?.refreshToken === 'fake-initial-refresh',
      }),
    }).then((reply) => reply.json());
    for (const before of response.before ?? []) port.postMessage(before);
    port.postMessage(response.reply);
  };
  port.onmessage = ({ data }) => void send(data);
  port.start();
  await send({ op: 'welcome' });
});
`;

export const placeholder = 'fnox_proxy_0123456789abcdef01234567';
export const credential = {
  v: 1,
  placeholder,
  state: 'ready',
  expiresAt: 1800003600000,
  refreshable: true,
};

export async function oauthVault() {
  let state = {};
  const requests = [];
  const waiting = new Set();
  const held = new Set();
  const server = createServer(async (request, response) => {
    if (request.url !== '/rpc') {
      response.writeHead(200, {
        'content-type': 'text/html',
        'cross-origin-resource-policy': 'cross-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      response.end(`<script>${frame}</script>`);
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const meta = JSON.parse(body);
    requests.push(meta);
    const op = meta.sealed ?? meta.op;
    for (const listener of waiting) listener(op);
    if (state.hold === op) await new Promise((resolve) => held.add(resolve));
    const status = {
      version: '1.99.0',
      protocol: 1,
      locked: false,
      capabilities: { kernelOAuth: 1 },
      scrub: { needed: false, version: 1, ready: true },
      ...state.status,
    };
    const inner =
      op === 'capabilities'
        ? { v: 1, capabilities: meta.marker === 1 ? { kernelOAuth: 1 } : {} }
        : op === 'oauthRemove'
          ? { v: 1, removed: true }
          : credential;
    const fields =
      meta.op === 'welcome' || meta.op === 'status'
        ? { status }
        : meta.op === 'placeholders'
          ? {
              placeholders: [placeholder],
              scrub: { needed: true, version: 3, ready: true },
              ...state.placeholders,
            }
          : meta.op === 'sealed'
            ? { reply: Object.hasOwn(state, 'reply') ? state.reply : inner }
            : { list: { secrets: [] } };
    const reply = {
      v: 1,
      ...(meta.id === undefined ? {} : { id: meta.id }),
      op: meta.op,
      ...fields,
      ...(meta.op === 'sealed' ? state.envelope : {}),
    };
    if (meta.op === 'sealed' && ['oauthGrant', 'oauthRefresh', 'oauthRemove'].includes(op))
      state = { ...state, ...state.afterMutation };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ reply, before: state.before?.[op] ?? [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    waitFor(op) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(listener);
          reject(new Error(`the fixture did not receive ${op}`));
        }, 10000);
        const listener = (seen) => {
          if (seen !== op) return;
          clearTimeout(timer);
          waiting.delete(listener);
          resolve();
        };
        waiting.add(listener);
      });
    },
    set(next) {
      state = next;
    },
    release() {
      for (const resolve of held) resolve();
      held.clear();
    },
    async close() {
      this.release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
