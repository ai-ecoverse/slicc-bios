const MODES = new Set(['follow', 'manual', 'error']);
const STATUSES = new Set([301, 302, 303, 307, 308]);

export function redirectMode(request, fallback = 'follow') {
  const mode = request.redirect === undefined ? fallback : request.redirect;
  if (!MODES.has(mode)) throw new TypeError('invalid request redirect policy');
  return mode;
}

export function manualRedirects(request, fallback = false) {
  return redirectMode(request, fallback ? 'manual' : 'follow') !== 'follow';
}

function sameUrl(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = '';
    right.hash = '';
    return left.href === right.href;
  } catch {
    return false;
  }
}

function location(headers) {
  if (Array.isArray(headers)) return headers.some(([name]) => name.toLowerCase() === 'location');
  return headers?.has?.('location') === true;
}

export async function checkRedirect(request, response) {
  const mode = redirectMode(request);
  if (mode === 'follow') return response;
  const followed =
    response.redirected === true ||
    response.redirects?.length > 0 ||
    (response.url && !sameUrl(response.url, request.url));
  const opaque = response.opaqueRedirect === true || response.type === 'opaqueredirect';
  const refused =
    followed ||
    opaque ||
    (mode === 'error' && STATUSES.has(response.status) && location(response.headers));
  if (!refused) return response;
  await Promise.resolve(response.cancel?.()).catch(() => {});
  throw Object.assign(new TypeError('request redirected; not followed'), {
    code: 'EACCES',
    status: 502,
  });
}
