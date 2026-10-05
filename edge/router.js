const types = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  wasm: 'application/wasm',
};

function key(url) {
  const label = url.hostname.split('.')[0];
  const path = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  return `${label}${path}`;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const name = key(new URL(request.url));
    const object = await env.BIOS.get(name, { onlyIf: request.headers });
    if (!object) return new Response('not found', { status: 404 });
    const headers = {
      'content-type': types[name.split('.').pop()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      etag: object.httpEtag,
    };
    if (!('body' in object)) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
