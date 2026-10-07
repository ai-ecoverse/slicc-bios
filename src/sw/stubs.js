const shims = {
  crypto: {
    randomUUID: 'globalThis.crypto.randomUUID.bind(globalThis.crypto)',
    getRandomValues: 'globalThis.crypto.getRandomValues.bind(globalThis.crypto)',
    webcrypto: 'globalThis.crypto',
    subtle: 'globalThis.crypto.subtle',
  },
  url: {
    URL: 'globalThis.URL',
    URLSearchParams: 'globalThis.URLSearchParams',
  },
};

import { reserved } from './transform.js';

const identifier = /^[A-Za-z_$][\w$]*$/;

export function nodeStub(name, wanted = []) {
  const known = shims[name] ?? {};
  const names = [...new Set([...Object.keys(known), ...wanted])].filter(
    (item) => identifier.test(item) && !reserved.has(item)
  );
  const lines = [
    `function __slicc_missing(member) { return function () { throw new Error(\`node:${name}\${member ? '.' + member : ''} is not available in the browser\`); }; }`,
    ...names.map(
      (item) =>
        `export const ${item} = ${known[item] ?? `__slicc_missing(${JSON.stringify(item)})`};`
    ),
    `export default new Proxy(__slicc_missing(''), { get: (target, member) => ({ ${names.join(', ')} })[member] ?? __slicc_missing(String(member)) });`,
  ];
  return lines.join('\n');
}
