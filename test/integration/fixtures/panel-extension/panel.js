globalThis.said = [];
addEventListener('message', (event) => {
  if (event.data?.type === 'slicc-seven-panel') said.push({ origin: event.origin, ...event.data });
});
addEventListener('DOMContentLoaded', () => {
  const frame = document.getElementById('seven');
  frame.addEventListener('load', () => {
    globalThis.loaded = true;
  });
  frame.src = new URLSearchParams(location.search).get('src');
});
