const SPECIAL = /[\\:*?+(){}]/g;
const LOCAL = ['localhost', '*.localhost', 'localhost.', '*.localhost.'];
export const SUPPORT_PATH = '/api/support/';

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

export function routes(scope) {
  const own = new URL(scope).hostname.replace(SPECIAL, (char) => `\\${char}`);
  const handler = (hostname) => ({
    condition: { urlPattern: only({ hostname }) },
    source: 'fetch-event',
  });
  return [
    {
      condition: { urlPattern: only({ hostname: own, pathname: `${SUPPORT_PATH}*` }) },
      source: 'network',
    },
    handler(own),
    ...LOCAL.map(handler),
    { condition: { urlPattern: only({ protocol: 'https' }) }, source: 'network' },
  ];
}

export function route(event, scope) {
  if (typeof event.addRoutes !== 'function' || typeof URLPattern !== 'function') return;
  let rules;
  try {
    rules = routes(scope);
  } catch {
    return;
  }
  event.waitUntil(Promise.resolve(event.addRoutes(rules)).catch(() => undefined));
}
