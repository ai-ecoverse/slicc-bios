const { port } = new SharedWorker(new URL('../kernel.js', import.meta.url), 'slicc-kernel');
const units = ['B', 'kB', 'MB', 'GB'];

function size(bytes) {
  const exponent = Math.min(3, Math.floor(Math.log10(Math.max(bytes, 1)) / 3));
  return `${Number((bytes / 1000 ** exponent).toFixed(1))}${units[exponent]}`;
}

port.onmessage = ({ data: { result } }) => {
  const items = result.map((file) => {
    const item = document.createElement('li');
    const bytes = document.createElement('span');
    bytes.textContent = size(file.size);
    item.append(file.path, bytes);
    return item;
  });
  document.getElementById('files').replaceChildren(...items);
};
port.postMessage({ id: 1, op: 'list' });

const bash = await WebAssembly.compileStreaming(
  fetch('../node_modules/@ai-ecoverse/wasm-bash/bin/bash.wasm')
);
const exports = WebAssembly.Module.exports(bash).length;
document.getElementById('bash').textContent = `bash.wasm compiled from OPFS: ${exports} exports`;
