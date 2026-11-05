const root = document.documentElement;
if (root) root.dataset.sliccHarnessExtension = chrome.runtime.id;
const wanted = new URLSearchParams(location.search).has('slicc-extension-frame');
if (wanted && window === window.top) {
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('frame.html');
  frame.dataset.sliccHarnessExtension = chrome.runtime.id;
  frame.hidden = true;
  const attach = () => (document.body ?? document.documentElement).append(frame);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  } else {
    attach();
  }
}
