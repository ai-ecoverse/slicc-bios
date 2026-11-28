export const LOADER =
  'Seven couldn’t load its code for this page, so it didn’t open it. Reload goes through the BIOS, which puts seven’s files back.';

export async function biosUrl(container = globalThis.navigator?.serviceWorker) {
  const registration = await Promise.resolve(container?.getRegistration?.()).catch(() => null);
  const worker = registration?.active ?? registration?.waiting ?? registration?.installing;
  return new URL(worker?.scriptURL ? './' : '../', worker?.scriptURL ?? import.meta.url).href;
}

export function uncached(target = globalThis) {
  target.addEventListener('unload', () => {});
  target.addEventListener('pageshow', (event) => {
    if (event.persisted) target.location.reload();
  });
}

export function loaderRefusal(
  doc,
  reload = async () => doc.location.replace(`${await biosUrl()}${doc.location.hash}`)
) {
  const box = doc.createElement('main');
  box.dataset.refused = 'loader';
  const title = doc.createElement('h1');
  title.textContent = 'Seven couldn’t open this page';
  const text = doc.createElement('p');
  text.textContent = LOADER;
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Reload';
  button.addEventListener('click', () => reload());
  box.append(title, text, button);
  doc.body.replaceChildren(box);
  return box;
}

export async function enter(
  app,
  {
    at = globalThis.location,
    doc = globalThis.document,
    host = () => import('./seven-host.js'),
    forget = () => {},
  } = {}
) {
  const failed = async (error) => {
    console.error(error);
    forget();
    const hand = await import('./handoff.js').catch(() => null);
    hand?.forgetHandOffs();
    return loaderRefusal(doc);
  };
  let guard;
  try {
    guard = await host();
  } catch (error) {
    return failed(error);
  }
  if (guard.refusesBoot(at)) {
    forget();
    return guard.notSeven(doc, at.origin);
  }
  try {
    return await app();
  } catch (error) {
    return failed(error);
  }
}
