const imsHosts = {
  prod: 'https://ims-na1.adobelogin.com',
  stg1: 'https://ims-na1-stg1.adobelogin.com',
};
export const RELAY = 'https://www.sliccy.ai/auth/callback';
export const CALLBACK = '/auth/callback';
export const NEEDS_PROXY =
  'signing in to Adobe needs slicc-node or slicc-extension: run npx @ai-ecoverse/slicc-node or install slicc-extension';

export function nonce(random = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = random(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function authorizeUrl({ clientId, scopes, imsEnvironment }, port, value) {
  const state = btoa(JSON.stringify({ source: 'local', port, path: CALLBACK, nonce: value }));
  const params = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    response_type: 'token',
    redirect_uri: RELAY,
    state,
  });
  return `${imsHosts[imsEnvironment] ?? imsHosts.prod}/ims/authorize/v2?${params}`;
}

export function tokenFrom(redirectUrl, expected) {
  const url = new URL(redirectUrl);
  if (url.searchParams.get('nonce') !== expected)
    throw new Error('the sign-in answered for another request');
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get('access_token');
  if (!token)
    throw new Error(
      fragment.get('error_description') ?? fragment.get('error') ?? 'Adobe sent no token'
    );
  return token;
}

export const SIGN_IN_TIMEOUT = 10 * 60 * 1000;

export function signIn({
  network,
  open = (url) => window.open(url, 'slicc-sign-in', 'popup,width=520,height=720'),
  fetch: fetcher = (input, init) => globalThis.fetch(input, init),
  every = 1000,
  timeout = SIGN_IN_TIMEOUT,
  notice = () => () => {},
  extension = globalThis.sliccExtension,
}) {
  if (extension?.signIn) {
    return async (_providerId, options) => {
      const config = await options();
      if (!config) throw new Error('this account has no sign-in');
      return extension.signIn(config);
    };
  }
  const proxy = network?.kind === 'local-proxy' ? network.proxy : null;
  return async (_providerId, options) => {
    if (!proxy) throw new Error(NEEDS_PROXY);
    const popup = open('about:blank');
    if (!popup) throw new Error('the browser blocked the sign-in window');
    const value = nonce();
    const headers = { 'X-Bridge-Token': proxy.key };
    try {
      const config = await options();
      if (!config) throw new Error('this account has no sign-in');
      const registered = await fetcher(`${proxy.url}/api/oauth-state`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: value }),
      });
      if (!registered.ok) {
        throw new Error(
          `slicc-node refused the sign-in (${registered.status}); update it with npx @ai-ecoverse/slicc-node@latest`
        );
      }
      popup.location.href = authorizeUrl(config, Number(new URL(proxy.url).port), value);
    } catch (error) {
      popup.close();
      throw error;
    }
    return new Promise((resolve, reject) => {
      let done = false;
      let timer;
      const finish = (error, token) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(deadline);
        hide();
        if (!error) {
          resolve(token);
          return;
        }
        fetcher(`${proxy.url}/api/oauth-state?nonce=${value}`, { method: 'DELETE', headers }).catch(
          () => {}
        );
        popup.close();
        reject(error);
      };
      const poll = async () => {
        let token;
        try {
          const response = await fetcher(`${proxy.url}/api/oauth-result?nonce=${value}`, {
            headers,
          });
          if (done) return;
          if (response.status === 204) {
            timer = setTimeout(poll, every);
            return;
          }
          if (response.status === 404) throw new Error('the sign-in expired; try again');
          if (!response.ok) throw new Error(`slicc-node refused the sign-in (${response.status})`);
          token = tokenFrom((await response.json()).redirectUrl, value);
        } catch (error) {
          finish(error);
          return;
        }
        finish(null, token);
      };
      const deadline = setTimeout(() => finish(new Error('the sign-in timed out')), timeout);
      const hide = notice({
        text: 'signing in to Adobe…',
        cancel: () => finish(new Error('the sign-in was cancelled')),
      });
      timer = setTimeout(poll, every);
    });
  };
}
