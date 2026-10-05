const { port } = new SharedWorker(new URL('../kernel.js', import.meta.url), {
  name: 'slicc-kernel',
  extendedLifetime: true,
});
const calls = new Map();
let id = 0;

port.onmessage = ({ data }) => {
  if ('progress' in data) return;
  const call = calls.get(data.id);
  calls.delete(data.id);
  if ('error' in data) call.reject(new Error(data.error));
  else call.resolve(data.result);
};

export function kernel(op, args) {
  return new Promise((resolve, reject) => {
    calls.set(++id, { resolve, reject });
    port.postMessage({ id, op, args });
  });
}
