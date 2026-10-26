import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { type } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/server.mjs';

export { eventFrame } from './event-frame.mjs';

export const REMOTES = [
  'https://cdn.jsdelivr.net/',
  'https://registry.npmjs.org/',
  'https://raw.githubusercontent.com/',
];

const header = (headers, name) =>
  Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];

function allowed(request) {
  const origin = header(request.headers, 'origin');
  return [
    { name: 'access-control-allow-origin', value: origin ?? '*' },
    ...(origin ? [{ name: 'access-control-allow-credentials', value: 'true' }] : []),
    { name: 'access-control-expose-headers', value: '*' },
    { name: 'vary', value: 'Origin' },
  ];
}

function preflight(request) {
  return [
    ...allowed(request),
    {
      name: 'access-control-allow-methods',
      value: header(request.headers, 'access-control-request-method') ?? 'GET, POST',
    },
    {
      name: 'access-control-allow-headers',
      value: header(request.headers, 'access-control-request-headers') ?? '*',
    },
    { name: 'access-control-max-age', value: '600' },
  ];
}

export async function fakeLlm(cdp, { answer, hosts }) {
  const requests = [];
  const sessions = new Map();
  const closing = new Map();
  let stopped = false;

  const posted = async (params) => {
    const { request, networkId } = params;
    if (request.postDataEntries?.length)
      return Buffer.concat(
        request.postDataEntries.map((entry) => Buffer.from(entry.bytes ?? '', 'base64'))
      );
    if (typeof request.postData === 'string') return Buffer.from(request.postData);
    if (!request.hasPostData || !networkId) return Buffer.alloc(0);
    const found = await cdp
      .send('Network.getRequestPostData', { requestId: networkId }, sessions.get(networkId))
      .catch(() => null);
    if (!found) return Buffer.alloc(0);
    return Buffer.from(found.postData, found.base64Encoded ? 'base64' : 'utf8');
  };

  const fulfil = (requestId, responseCode, responseHeaders, body) =>
    cdp
      .send('Fetch.fulfillRequest', {
        requestId,
        responseCode,
        responseHeaders,
        body: Buffer.from(body ?? []).toString('base64'),
      })
      .catch(() => {});

  const answered = async (params) => {
    const { requestId, request, networkId } = params;
    if (request.method === 'OPTIONS') return fulfil(requestId, 204, preflight(request));
    const body = await posted(params);
    const asked = {
      url: request.url,
      method: request.method,
      headers: Object.entries(request.headers ?? {}),
    };
    requests.push({ ...asked, body: body.toString() });
    const closed = new Promise((resolve) => {
      if (networkId) closing.set(networkId, resolve);
    });
    const reply = await answer(asked, body, { closed });
    if (networkId) closing.delete(networkId);
    const headers = (reply.headers ?? []).map(([name, value]) => ({ name, value: String(value) }));
    return fulfil(requestId, reply.status, [...allowed(request), ...headers], reply.body);
  };

  const served = async ({ requestId, request }) => {
    if (request.method === 'OPTIONS') return fulfil(requestId, 204, preflight(request));
    const body = await download(request.url).catch(() => null);
    if (!body)
      return cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    return fulfil(
      requestId,
      200,
      [...allowed(request), { name: 'content-type', value: type(new URL(request.url).pathname) }],
      body
    );
  };

  cdp.on(async ({ method, params, sessionId }) => {
    if (stopped) return;
    if (method === 'Network.requestWillBeSent' && sessionId)
      sessions.set(params.requestId, sessionId);
    if (method === 'Network.loadingFailed') closing.get(params.requestId)?.(Date.now());
    if (method !== 'Fetch.requestPaused') return;
    const ours = hosts.some((host) => params.request.url.startsWith(host));
    await (ours ? answered(params) : served(params)).catch(() =>
      cdp
        .send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' })
        .catch(() => {})
    );
  });
  await cdp.send('Fetch.enable', {
    patterns: [...new Set([...REMOTES, ...hosts])].map((host) => ({ urlPattern: `${host}*` })),
  });
  return {
    requests,
    close: async () => {
      stopped = true;
    },
  };
}
