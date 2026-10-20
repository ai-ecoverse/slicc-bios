import { clearHandOff, dropped, droppedLine } from './handoff.js';
import { BIOS } from './site.js';

export const REFUSED =
  'Seven didn’t load its own code: one of its files changed after seven installed it, or is missing. Reloading goes through the BIOS, which puts seven’s files back.';

export const STATUS = new URL('../__slicc/integrity', import.meta.url);

export function stoppedText(path) {
  return `One of seven’s files, ${path}, keeps changing, so seven stopped putting it back and won’t run it. Seven tries again in about 10 minutes. Reload after that.`;
}

export async function stoppedPath(fetcher = fetch) {
  try {
    const response = await fetcher(STATUS);
    if (!response.ok) return null;
    const { stopped = [] } = await response.json();
    return stopped[0] ?? null;
  } catch {
    return null;
  }
}

export function refused(doc = document, go = (url) => location.replace(url), stopped = null) {
  const box = doc.createElement('main');
  box.dataset.refused = '';
  const title = doc.createElement('h1');
  title.textContent = 'Seven couldn’t start';
  const text = doc.createElement('p');
  text.textContent = stopped ? stoppedText(stopped) : REFUSED;
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Reload';
  button.addEventListener('click', () => go(`${BIOS}${doc.location?.hash ?? ''}`));
  box.append(title, text, button);
  doc.body.replaceChildren(box);
  return box;
}

export function droppedPage(doc, names) {
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

export async function start({
  seat = seatPage,
  go = (url) => location.replace(url),
  follow = () => import('./follow.js'),
  follower = () => import('./follower.js'),
  os = () => import('./os.js'),
  fail = refused,
  check = stoppedPath,
  clear = clearHandOff,
  lost = dropped,
  doc = globalThis.document,
} = {}) {
  const names = lost();
  if (names) {
    clear();
    return droppedPage(doc, names);
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
    fail(undefined, undefined, await check());
  }
}

await start();
