globalThis.foreignWorld = { id: chrome.runtime.id, ping: () => 'EXTENSION-WORLD' };
document.addEventListener('click', () => {
  globalThis.foreignWorld.clicked = true;
});
