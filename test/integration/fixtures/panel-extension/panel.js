globalThis.said = [];
addEventListener('message', (event) => {
  if (event.data?.type === 'slicc-seven-panel') said.push({ origin: event.origin, ...event.data });
});
addEventListener('DOMContentLoaded', () => {
  document.getElementById('seven').src = new URLSearchParams(location.search).get('src');
});
