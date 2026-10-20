import { CHANNEL } from './adobe.js';

const GRANT = ['access_token', 'expires_in', 'error', 'error_description'];

export function needed(href) {
  const url = new URL(href);
  const nonce = url.searchParams.get('nonce');
  const fragment = new URLSearchParams(url.hash.slice(1));
  const kept = new URLSearchParams();
  for (const name of GRANT) if (fragment.has(name)) kept.set(name, fragment.get(name));
  const query = nonce === null ? '' : `?${new URLSearchParams({ nonce })}`;
  return { nonce, redirectUrl: `${url.origin}${url.pathname}${query}#${kept}` };
}

export function relay({ location, history, document, close, listen, taken = null }) {
  const url = new URL(taken ?? location.href);
  const { nonce, redirectUrl } = needed(url.href);
  const channel = listen(CHANNEL);
  channel.postMessage({ type: 'oauth-callback', nonce, redirectUrl });
  channel.close();
  history.replaceState(null, '', url.pathname);
  document.getElementById('msg').textContent = 'Signed in. You can close this window.';
  setTimeout(close, 300);
}

export function page() {
  const taken = typeof globalThis.sliccCallback === 'string' ? globalThis.sliccCallback : null;
  delete globalThis.sliccCallback;
  return {
    location,
    history,
    document,
    close: () => window.close(),
    listen: (name) => new BroadcastChannel(name),
    taken,
  };
}

if (globalThis.document?.getElementById('msg')) relay(page());
