export const PRODUCTION_HOSTS = ['seven.sliccy.ai', 'www.sliccy.ai'];

export const production = (host) => PRODUCTION_HOSTS.includes(host);

export function biosOf({
  controller = globalThis.navigator?.serviceWorker?.controller,
  page = globalThis.location?.href,
} = {}) {
  if (controller?.scriptURL) return new URL('./', controller.scriptURL).href;
  return page ? new URL('/', page).href : new URL('../', import.meta.url).href;
}

export const BIOS = biosOf();

export const sharesOrigin = (bios = biosOf()) => new URL(bios).pathname !== '/';

export const home = (bios = biosOf()) => bios.replace(/\/$/, '');

export function neverCached(target = globalThis) {
  target.addEventListener('unload', () => {});
  target.addEventListener('pageshow', (event) => {
    if (event.persisted) target.location.reload();
  });
}
