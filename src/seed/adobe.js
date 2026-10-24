import { IMS_TOKEN } from './vault.js';

const imsHosts = {
  prod: 'https://ims-na1.adobelogin.com',
  stg1: 'https://ims-na1-stg1.adobelogin.com',
};
export const RELAY = 'https://www.sliccy.ai/auth/callback';
export const CALLBACK = '/auth/callback';
export const CLIENTS_KEY = 'slicc-os.sign-in-clients';

export function storedClients(storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage?.getItem(CLIENTS_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export const SEVEN_CLIENT = 'experience-catalyst-prod';
export const SIGN_IN_CLIENTS = new Set([SEVEN_CLIENT, ...storedClients()]);

export function rememberClient(id) {
  if (!id || SIGN_IN_CLIENTS.has(id)) return;
  SIGN_IN_CLIENTS.add(id);
  try {
    globalThis.localStorage?.setItem(CLIENTS_KEY, JSON.stringify([...SIGN_IN_CLIENTS]));
  } catch {}
}
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
  rememberClient(clientId);
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

export const OPENER_CHANNEL = 'slicc-oauth-relay';

export function openerUrl(config, value) {
  return authorize(config, { source: 'opener', nonce: value });
}

const SLICCY = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sliccy\.ai$/;
export const CHANNEL = 'slicc-sign-in';
export const FORCE_RELAY = 'slicc-os.sign-in';

export function relayed(origin) {
  return SLICCY.test(origin ?? '') && origin !== 'https://www.sliccy.ai';
}

export function tokenFrom(redirectUrl, expected) {
  return grantFrom(redirectUrl, expected).token;
}

export function grantFrom(redirectUrl, expected) {
  const url = new URL(redirectUrl);
  if (url.searchParams.get('nonce') !== expected)
    throw new Error('the sign-in answered for another request');
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get('access_token');
  if (!token)
    throw new Error(
      fragment.get('error_description') ?? fragment.get('error') ?? 'Adobe sent no token'
    );
  const expiresIn = Number(fragment.get('expires_in'));
  return Number.isFinite(expiresIn) && expiresIn > 0 ? { token, expiresIn } : { token };
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

async function prepare(open, options, address, signal) {
  if (signal?.aborted) throw cancelled();
  const popup = open('about:blank');
  if (!popup) throw new Error('the browser blocked the sign-in window');
  try {
    const config = await abortable(Promise.resolve(options()), signal);
    if (!config) throw new Error('this account has no sign-in');
    popup.location.href = await abortable(Promise.resolve(address(config)), signal);
  } catch (error) {
    popup.close();
    throw error;
  }
  return popup;
}

function viaRelay({
  open,
  origin,
  listen,
  timeout,
  address = (config, value) => relayUrl(config, origin, value),
  channel: name = CHANNEL,
}) {
  return async (_providerId, options, signal) => {
    const value = nonce();
    const popup = await prepare(open, options, (config) => address(config, value), signal);
    return waiting({
      popup,
      signal,
      timeout,
      start: (ok, fail) => {
        const channel = listen(name);
        channel.onmessage = ({ data }) => {
          if (data?.type !== 'oauth-callback' || data.nonce !== value) return;
          let token;
          try {
            token = grantFrom(data.redirectUrl, value);
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
    const abandon = () =>
      fetcher(`${proxy.url}/api/oauth-state?nonce=${value}`, { method: 'DELETE', headers }).catch(
        () => {}
      );
    let registering = null;
    const register = (config) => {
      registering = fetcher(`${proxy.url}/api/oauth-state`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: value }),
      });
      return registering.then((registered) => {
        if (!registered.ok) {
          throw new Error(
            `slicc-node refused the sign-in (${registered.status}); update it with npx @ai-ecoverse/slicc-node@latest`
          );
        }
        return authorizeUrl(config, Number(new URL(proxy.url).port), value);
      });
    };
    const popup = await prepare(open, options, register, signal).catch((error) => {
      if (error?.name === 'AbortError') registering?.then(abandon, () => {});
      throw error;
    });
    return waiting({
      popup,
      signal,
      timeout,
      abandon,
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
            token = grantFrom((await response.json()).redirectUrl, value);
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
  shared = false,
  listen = (name) => new BroadcastChannel(name),
}) {
  const relay = shared
    ? viaRelay({ open, listen, timeout, address: openerUrl, channel: OPENER_CHANNEL })
    : viaRelay({ open, origin, listen, timeout });
  const proxy = network?.kind === 'local-proxy' ? network.proxy : null;
  const direct = extension?.signIn
    ? async (_providerId, options, signal) => {
        if (signal?.aborted) throw cancelled();
        const config = await abortable(Promise.resolve(options()), signal);
        if (!config) throw new Error('this account has no sign-in');
        rememberClient(config?.clientId);
        const token = await abortable(extension.signIn(config), signal);
        return typeof token === 'string' ? { token } : token;
      }
    : viaProxy({ proxy, open, fetcher, every, timeout });
  const forced = () => force ?? globalThis.localStorage?.getItem(FORCE_RELAY) === 'relay';
  const grant = (providerId, options, { signal } = {}) =>
    shared || relayed(origin) || forced()
      ? relay(providerId, options, signal)
      : direct(providerId, options, signal);
  const login = (providerId, options, context) =>
    grant(providerId, options, context).then((got) => got.token);
  login.grant = grant;
  if (globalThis.sliccLoginDebug === true) globalThis.sliccLogin = login;
  return login;
}

export function sealedLogin(login, { vault, takes, now = Date.now }) {
  return (providerId, options, context) => {
    if (providerId !== 'adobe' || !takes()) return login(providerId, options, context);
    return login.grant(providerId, options, context).then(async ({ token, expiresIn }) => {
      await vault.seal({
        kind: 'model',
        provider: 'adobe',
        name: IMS_TOKEN,
        value: token,
        source: 'oauth:adobe',
        ...(expiresIn ? { expiresAt: now() + expiresIn * 1000 } : {}),
      });
      return { sealed: true };
    });
  };
}
