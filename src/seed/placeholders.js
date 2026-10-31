export const SEALED = /fnox_proxy_[0-9a-f]{24}/;

function carries(text) {
  let layer = text;
  for (let i = 0; i < 8; i += 1) {
    if (SEALED.test(layer)) return true;
    const next = layer.replace(/%([0-9a-f]{2})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
    if (next === layer) return false;
    layer = next;
  }
  return SEALED.test(layer);
}

export function hasPlaceholder({ url, headers = [], protocols = [] }) {
  if (carries(url) || protocols.some(carries)) return true;
  return headers.some(([name, value]) => {
    if (carries(name.toLowerCase()) || carries(value)) return true;
    const credential = /\bbasic\b(.*)/is.exec(value)?.[1];
    if (credential === undefined) return false;
    const clean = credential
      .replace(/[^A-Za-z0-9+/_-]/g, '')
      .replaceAll('-', '+')
      .replaceAll('_', '/');
    for (let shift = 0; shift < 4; shift += 1) {
      const part = clean.slice(shift);
      const whole = part.length % 4 === 1 ? part.slice(0, -1) : part;
      if (carries(atob(whole))) return true;
    }
    return false;
  });
}
