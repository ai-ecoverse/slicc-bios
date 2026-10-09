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

function authorize({ clientId, scopes, imsEnvironment }, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    response_type: 'token',
    redirect_uri: RELAY,
    state: btoa(JSON.stringify(state)),
  });
  return `${imsHosts[imsEnvironment] ?? imsHosts.prod}/ims/authorize/v2?${params}`;
}

export function authorizeUrl(config, port, value) {
  return authorize(config, { source: 'local', port, path: CALLBACK, nonce: value });
}

export function relayUrl(config, origin, value) {
  return authorize(config, { source: 'origin', origin, nonce: value });
}

const SLICCY = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sliccy\.ai$/;
export const CHANNEL = 'slicc-sign-in';
export const FORCE_RELAY = 'slicc-os.sign-in';

export function relayed(origin) {
  return SLICCY.test(origin ?? '') && origin !== 'https://www.sliccy.ai';
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

export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const stop = () => reject(cancelled());
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export const SIGN_IN_TIMEOUT = 10 * 60 * 1000;

export const cancelled = () => new DOMException('the sign-in was cancelled', 'AbortError');

function waiting({ popup, signal, timeout, start, abandon = () => {} }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let stop = () => {};
    const cancel = () => finish(cancelled());
    const finish = (error, token) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      stop();
      signal?.removeEventListener('abort', cancel);
      if (!error) {
        resolve(token);
        return;
      }
      abandon();
      popup.close();
      reject(error);
    };
    const deadline = setTimeout(() => finish(new Error('the sign-in timed out')), timeout);
    signal?.addEventListener('abort', cancel);
    if (signal?.aborted) {
      cancel();
      return;
    }
    stop = start(
      (token) => finish(null, token),
      (error) => finish(error)
    );
  });
}

async function prepare(open, options, address) {
  const popup = open('about:blank');
  if (!popup) throw new Error('the browser blocked the sign-in window');
  try {
    const config = await options();
    if (!config) throw new Error('this account has no sign-in');
    popup.location.href = await address(config);
  } catch (error) {
    popup.close();
    throw error;
  }
  return popup;
}

function viaRelay({ open, origin, listen, timeout }) {
  return async (_providerId, options, signal) => {
    const value = nonce();
    const popup = await prepare(open, options, (config) => relayUrl(config, origin, value));
    return waiting({
      popup,
      signal,
      timeout,
      start: (ok, fail) => {
        const channel = listen(CHANNEL);
        channel.onmessage = ({ data }) => {
          if (data?.type !== 'oauth-callback' || data.nonce !== value) return;
          let token;
          try {
            token = tokenFrom(data.redirectUrl, value);
          } catch (error) {
            fail(error);
            return;
          }
          ok(token);
        };
        return () => channel.close();
      },
    });
  };
}

function viaProxy({ proxy, open, fetcher, every, timeout }) {
  return async (_providerId, options, signal) => {
    if (!proxy) throw new Error(NEEDS_PROXY);
    const value = nonce();
    const headers = { 'X-Bridge-Token': proxy.key };
    const popup = await prepare(open, options, async (config) => {
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
      return authorizeUrl(config, Number(new URL(proxy.url).port), value);
    });
    return waiting({
      popup,
      signal,
      timeout,
      abandon: () =>
        fetcher(`${proxy.url}/api/oauth-state?nonce=${value}`, { method: 'DELETE', headers }).catch(
          () => {}
        ),
      start: (ok, fail) => {
        let stopped = false;
        let timer;
        const poll = async () => {
          let token;
          try {
            const response = await fetcher(`${proxy.url}/api/oauth-result?nonce=${value}`, {
              headers,
            });
            if (stopped) return;
            if (response.status === 204) {
              timer = setTimeout(poll, every);
              return;
            }
            if (response.status === 404) throw new Error('the sign-in expired; try again');
            if (!response.ok)
              throw new Error(`slicc-node refused the sign-in (${response.status})`);
            token = tokenFrom((await response.json()).redirectUrl, value);
          } catch (error) {
            fail(error);
            return;
          }
          ok(token);
        };
        timer = setTimeout(poll, every);
        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      },
    });
  };
}

export function signIn({
  network,
  open = (url) => window.open(url, 'slicc-sign-in', 'popup,width=520,height=720'),
  fetch: fetcher = (input, init) => globalThis.fetch(input, init),
  every = 1000,
  timeout = SIGN_IN_TIMEOUT,
  extension = globalThis.sliccExtension,
  origin = globalThis.location?.origin,
  force,
  listen = (name) => new BroadcastChannel(name),
}) {
  const relay = viaRelay({ open, origin, listen, timeout });
  const proxy = network?.kind === 'local-proxy' ? network.proxy : null;
  const direct = extension?.signIn
    ? async (_providerId, options, signal) => {
        const config = await options();
        if (!config) throw new Error('this account has no sign-in');
        return abortable(extension.signIn(config), signal);
      }
    : viaProxy({ proxy, open, fetcher, every, timeout });
  const forced = () => force ?? globalThis.localStorage?.getItem(FORCE_RELAY) === 'relay';
  return (providerId, options, { signal } = {}) =>
    relayed(origin) || forced()
      ? relay(providerId, options, signal)
      : direct(providerId, options, signal);
}
