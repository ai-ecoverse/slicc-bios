import { CHANNEL } from './adobe.js';

export function relay({ location, history, document, close, listen }) {
  const redirectUrl = location.href;
  const url = new URL(redirectUrl);
  const channel = listen(CHANNEL);
  channel.postMessage({
    type: 'oauth-callback',
    nonce: url.searchParams.get('nonce'),
    redirectUrl,
  });
  channel.close();
  history.replaceState(null, '', url.pathname);
  document.getElementById('msg').textContent = 'Signed in. You can close this window.';
  setTimeout(close, 300);
}

export function page() {
  return {
    location,
    history,
    document,
    close: () => window.close(),
    listen: (name) => new BroadcastChannel(name),
  };
}

if (globalThis.document?.getElementById('msg')) relay(page());
