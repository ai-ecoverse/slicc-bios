const host = /^(\d{1,5})\.kernel\.localhost$/;
const empty = new Set([204, 205, 304]);

export class Unreachable extends Error {}

export function kernelPort(url) {
  const match = host.exec(new URL(url).hostname);
  const port = match && Number(match[1]);
  return port > 0 && port < 65536 ? port : undefined;
}

function isOs(client, scope) {
  const { pathname } = new URL(client.url);
  return pathname === `${scope}os/` || pathname === `${scope}os/index.html`;
}

async function kernelClient(clients, clientId, scope) {
  const own = clientId ? await clients.get(clientId) : undefined;
  if (own && isOs(own, scope)) return own;
  const windows = await clients.matchAll({ type: 'window' });
  return windows.find((client) => isOs(client, scope));
}

export function exposed(source, origin) {
  const headers = new Headers(source);
  if (!headers.has('access-control-allow-origin')) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
  }
  if (!headers.has('cross-origin-resource-policy')) {
    headers.set('cross-origin-resource-policy', 'cross-origin');
  }
  headers.set('x-served-from', 'kernel');
  return headers;
}

export async function loopback(request, port, { clients, clientId, scope, origin }) {
  const client = await kernelClient(clients, clientId, scope);
  if (!client) throw new Unreachable(`no kernel to reach ${port}.kernel.localhost`);
  const url = new URL(request.url);
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const channel = new MessageChannel();
  const reply = new Promise((resolve) => {
    channel.port1.onmessage = ({ data }) => resolve(data);
  });
  client.postMessage(
    {
      loopback: {
        port,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: [...request.headers],
        body,
      },
    },
    [channel.port2, ...(body ? [body] : [])]
  );
  const answer = await reply;
  channel.port1.close();
  if (answer.code === 'ECONNREFUSED')
    throw new Unreachable(`nothing listens on kernel port ${port}`);
  if (answer.error) throw new Unreachable(`kernel port ${port}: ${answer.error}`);
  const { status, statusText, headers } = answer;
  const content = empty.has(status) || request.method === 'HEAD' ? null : answer.body;
  if (!content) answer.body?.cancel();
  return new Response(content, { status, statusText, headers: exposed(headers, origin) });
}
