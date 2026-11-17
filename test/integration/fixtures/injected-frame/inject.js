document.documentElement.dataset.extensionFixture = chrome.runtime.id;
const autofill = chrome.runtime.getURL('frame.html');
document.addEventListener('focusin', ({ target }) => {
  if (!(target instanceof HTMLInputElement)) return;
  const shown = [...document.querySelectorAll('iframe')].find((frame) => frame.src === autofill);
  if (target.autocomplete !== 'username' && target.type !== 'email') return shown?.remove();
  if (shown) return;
  const frame = document.createElement('iframe');
  frame.src = autofill;
  document.body.append(frame);
});
