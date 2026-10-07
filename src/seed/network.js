import { checkLocalProxy } from '@ai-ecoverse/slicc-kernel';

const NAME = {
  extension: 'slicc-extension',
  page: 'the page fetch, limited by CORS',
};

const PROBLEM = {
  blocked: (at) =>
    `local proxy at ${at} is blocked: allow this site to access apps on this device in Chrome's site settings`,
  unreachable: (at, status) =>
    status.permission === 'prompt'
      ? `no answer from the local proxy at ${at}: allow access to apps on this device if Chrome asks, or run npx @ai-ecoverse/slicc-node again`
      : `no local proxy at ${at}: run npx @ai-ecoverse/slicc-node again`,
  refused: (at, status) =>
    `local proxy at ${at} refused this page (${status.error}): open SLICC from the launcher again`,
  incompatible: (at) => `${at} is not a SLICC local proxy`,
};

const RETRY = new Set(['blocked', 'unreachable']);

export function describe({ kind, proxy, status }) {
  if (kind === 'local-proxy') {
    return {
      state: 'ok',
      text: `network: local proxy at ${new URL(proxy.url).host}`,
      retry: false,
    };
  }
  if (!status) {
    const more = kind === 'page' ? ' (run npx @ai-ecoverse/slicc-node for the whole web)' : '';
    return { state: 'ok', text: `network: ${NAME[kind]}${more}`, retry: false };
  }
  const problem = PROBLEM[status.state](new URL(proxy.url).host, status);
  return {
    state: 'failed',
    text: `${problem}; using ${NAME[kind]}`,
    retry: RETRY.has(status.state),
  };
}

export function showNetwork(notice, choice, options = {}) {
  const check = options.check ?? checkLocalProxy;
  const reload = options.reload ?? (() => location.reload());
  const [output, retry] = notice.children;
  const render = (view) => {
    notice.dataset.state = view.state;
    output.value = view.text;
    notice.title = view.text;
    retry.hidden = !view.retry;
    notice.hidden = false;
  };
  render(describe(choice));
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    const status = await check(choice.proxy);
    retry.disabled = false;
    if (status.state !== 'ready') {
      render(describe({ ...choice, status }));
      return;
    }
    location.hash = new URLSearchParams({
      proxy: choice.proxy.url,
      key: choice.proxy.key,
    }).toString();
    reload();
  });
}
