import { kernel } from './connect.js';

const units = ['B', 'kB', 'MB', 'GB'];

function size(bytes) {
  const exponent = Math.min(3, Math.floor(Math.log10(Math.max(bytes, 1)) / 3));
  return `${Number((bytes / 1000 ** exponent).toFixed(1))}${units[exponent]}`;
}

kernel('list').then((files) => {
  const items = files.map((file) => {
    const item = document.createElement('li');
    const bytes = document.createElement('span');
    bytes.textContent = size(file.size);
    item.append(file.path, bytes);
    return item;
  });
  document.getElementById('files').replaceChildren(...items);
});

const bash = await WebAssembly.compileStreaming(fetch('../bin/bash.wasm'));
const exports = WebAssembly.Module.exports(bash).length;
document.getElementById('bash').textContent = `bash.wasm compiled from OPFS: ${exports} exports`;
