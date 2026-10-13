export const REFUSED =
  'Seven didn’t load its own code: one of its files changed after seven installed it, or is missing. Reloading goes through the BIOS, which puts seven’s files back.';

export function refused(doc = document, go = (url) => location.replace(url)) {
  const box = doc.createElement('main');
  box.dataset.refused = '';
  const title = doc.createElement('h1');
  title.textContent = 'Seven couldn’t start';
  const text = doc.createElement('p');
  text.textContent = REFUSED;
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Reload';
  button.addEventListener('click', () => go(`/${doc.location?.hash ?? ''}`));
  box.append(title, text, button);
  doc.body.replaceChildren(box);
  return box;
}

export async function start({
  follow = () => import('./follow.js'),
  follower = () => import('./follower.js'),
  os = () => import('./os.js'),
  fail = refused,
} = {}) {
  try {
    const { takeFollow } = await follow();
    await (takeFollow() ? follower() : os());
  } catch (error) {
    console.error(error);
    fail();
  }
}

await start();
