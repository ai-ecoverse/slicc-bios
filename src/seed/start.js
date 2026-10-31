export const RETRIED = 'slicc-os.uncontrolled';

export function biosOf(
  controller = globalThis.navigator?.serviceWorker?.controller,
  here = import.meta.url
) {
  return new URL(controller?.scriptURL ? './' : '../', controller?.scriptURL ?? here).href;
}

export async function tripTarget(container = globalThis.navigator?.serviceWorker) {
  const registration = await Promise.resolve(container?.getRegistration?.()).catch(() => null);
  return biosOf(registration?.active ?? registration?.waiting ?? registration?.installing);
}

export const REFUSED =
  'Seven didn’t load its own code: one of its files changed after seven installed it, or is missing. Reloading goes through the BIOS, which puts seven’s files back.';

export const STATUS = new URL('../__slicc/integrity', import.meta.url);

export function stoppedText(path) {
  return `One of seven’s files, ${path}, keeps changing, so seven stopped putting it back and won’t run it. Seven tries again in about 10 minutes. Reload after that.`;
}

export const UNCONTROLLED =
  'Seven’s service worker isn’t running in this page, so seven couldn’t load its code. Reloading goes through the BIOS, which starts it again.';

const LONGEST = 400;

export function filesState(fetcher = fetch) {
  return Promise.resolve()
    .then(() => fetcher(STATUS))
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
}

export function whatFailed(error, intact) {
  const named = error?.name && error?.message ? `${error.name}: ${error.message}` : String(error);
  const lead = intact
    ? 'Seven has no record of a changed file, but it stopped while starting'
    : 'Seven stopped while starting';
  return `${lead}: ${named}`.slice(0, LONGEST);
}

export function explain(error, files, worker = true) {
  if (files?.stopped?.[0]) return stoppedText(files.stopped[0]);
  if (files?.changed?.length) return REFUSED;
  if (!worker) return UNCONTROLLED;
  return whatFailed(error, Boolean(files?.changed));
}

export function refused(doc = document, go = (url) => location.replace(url), why = REFUSED) {
  const box = doc.createElement('main');
  box.dataset.refused = '';
  const title = doc.createElement('h1');
  title.textContent = 'Seven couldn’t start';
  const text = doc.createElement('p');
  text.textContent = why;
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Reload';
  button.addEventListener('click', async () =>
    go(`${await tripTarget()}${doc.location?.hash ?? ''}`)
  );
  box.append(title, text, button);
  doc.body.replaceChildren(box);
  return box;
}

export function droppedPage(doc, names, droppedLine) {
  const box = doc.createElement('main');
  box.dataset.dropped = '';
  const text = doc.createElement('p');
  text.textContent = droppedLine(names);
  box.append(text);
  doc.body.replaceChildren(box);
  return box;
}

export function seatPage(at = location) {
  if (!new URLSearchParams(at.hash.slice(1)).has('seat')) return null;
  return new URL(`join.html${at.hash}`, import.meta.url).href;
}

export function controlled(container = globalThis.navigator?.serviceWorker) {
  return !container || Boolean(container.controller);
}

export function tripped(worker, storage) {
  try {
    const store = storage();
    if (worker()) {
      store.removeItem(RETRIED);
      return false;
    }
    if (store.getItem(RETRIED)) return false;
    store.setItem(RETRIED, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

export async function start({
  seat = seatPage,
  go = (url) => location.replace(url),
  worker = () => controlled(),
  storage = () => sessionStorage,
  at = location,
  target = () => tripTarget(),
  handoff = () => import('./handoff.js'),
  follow = () => import('./follow.js'),
  follower = () => import('./follower.js'),
  os = () => import('./os.js'),
  fail = refused,
  check = filesState,
  doc = globalThis.document,
} = {}) {
  if (tripped(worker, storage)) return go(`${await target()}${at.hash}`);
  let hand;
  try {
    hand = await handoff();
  } catch (error) {
    console.error(error);
    return fail(undefined, undefined, explain(error, await check(), worker()));
  }
  const clear = () => hand.clearHandOff();
  const names = hand.dropped();
  if (names) {
    clear();
    return droppedPage(doc, names, hand.droppedLine);
  }
  const guest = seat();
  if (guest) {
    clear();
    return go(guest);
  }
  try {
    const { takeFollow } = await follow();
    if (takeFollow()) {
      clear();
      await follower();
    } else await os();
  } catch (error) {
    clear();
    console.error(error);
    fail(undefined, undefined, explain(error, await check(), worker()));
  }
}

export function uncached(target = globalThis) {
  target.addEventListener('unload', () => {});
  target.addEventListener('pageshow', (event) => {
    if (event.persisted) target.location.reload();
  });
}

uncached();
await start();
