const SPECIAL = /[\\:*?+(){}]/g;
const LOCAL = ['localhost', '*.localhost', 'localhost.', '*.localhost.'];
export const supportPath = (bios) => `${new URL(bios).pathname}api/support/`;

function only(init) {
  return new URLPattern({
    protocol: '*',
    username: '*',
    password: '*',
    hostname: '*',
    port: '*',
    pathname: '*',
    search: '*',
    hash: '*',
    ...init,
  });
}

export function routes(scope, bios = scope) {
  const escape = (text) => text.replace(SPECIAL, (char) => `\\${char}`);
  const own = escape(new URL(scope).hostname);
  const handler = (hostname) => ({
    condition: { urlPattern: only({ hostname }) },
    source: 'fetch-event',
  });
  return [
    {
      condition: { urlPattern: only({ hostname: own, pathname: `${escape(supportPath(bios))}*` }) },
      source: 'network',
    },
    handler(own),
    ...LOCAL.map(handler),
    { condition: { urlPattern: only({ protocol: 'https' }) }, source: 'network' },
  ];
}

export function route(event, scope, bios = scope) {
  if (typeof event.addRoutes !== 'function' || typeof URLPattern !== 'function') return;
  let rules;
  try {
    rules = routes(scope, bios);
  } catch {
    return;
  }
  event.waitUntil(Promise.resolve(event.addRoutes(rules)).catch(() => undefined));
}
