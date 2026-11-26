import { fields, refusal } from './lease-wire.js';

export const id = (s) => typeof s === 'string' && /^[\w-]{1,128}$/.test(s);
export const shape = (obj, keys) =>
  obj &&
  typeof obj === 'object' &&
  !Array.isArray(obj) &&
  Object.keys(obj).every((k) => keys.includes(k));
export const fail = (reason) => {
  throw refusal(reason);
};

function https(s, narrow = false) {
  if (
    typeof s !== 'string' ||
    s.length > 2048 ||
    new TextEncoder().encode(s).length > 2048 ||
    /[\s\\*\p{C}]|%(?![\da-f]{2})/iu.test(s) ||
    !s.startsWith('https://')
  )
    fail('E_UNSUPPORTED');
  const u = URL.parse(s);
  if (
    !u ||
    u.href.length > 2048 ||
    u.username ||
    u.password ||
    (narrow && /%(?:2f|5c|2e|25)/i.test(s.split(/[?#]/)[0]))
  )
    fail('E_UNSUPPORTED');
  return u;
}

function rule(value) {
  if (!shape(value, ['kind', 'url'])) fail('E_UNSUPPORTED');
  const { kind, url } = value;
  const u = https(url, kind !== 'origin');
  if (kind === 'origin' && url === u.origin) return { kind, url: u.origin };
  if (kind === 'exact' && url === u.href) return { kind, url };
  fail('E_UNSUPPORTED');
}

const same = (a, b) => a.kind === b.kind && a.url === b.url;
const inside = (r, u) => (r.kind === 'origin' ? r.url === u.origin : r.url === u.href);

export function proposal(p, parent) {
  if (
    !shape(p, parent ? ['lease', 'allow', 'reason'] : ['allow', 'ttlSeconds', 'reason']) ||
    !Array.isArray(p.allow) ||
    p.allow.length !== 1
  )
    fail('E_UNSUPPORTED');
  const r = rule(p.allow[0]);
  if (
    r.kind !== (parent ? 'exact' : 'origin') ||
    parent?.allow.some((old) => inside(old, new URL(r.url)))
  )
    fail('E_UNSUPPORTED');
  const { reason, ttlSeconds } = p;
  if (
    reason !== undefined &&
    (typeof reason !== 'string' ||
      new TextEncoder().encode(reason).length > 256 ||
      /\p{C}/u.test(reason))
  )
    fail('E_UNSUPPORTED');
  if (!parent && (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400))
    fail('E_UNSUPPORTED');
  return {
    mode: 'request',
    allow: [r],
    ...(parent ? { parent: parent.jti } : { ttlSeconds }),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function grantFor(jwt, jkt, offer, parent, now) {
  const { cnf, jti, exp, iss, aud, browser_session, allow } = fields(jwt);
  if (
    cnf?.jkt !== jkt ||
    !id(jti) ||
    !Number.isSafeInteger(exp) ||
    ![iss, aud, browser_session].every((s) => typeof s === 'string' && s.length > 0) ||
    !Array.isArray(allow)
  )
    fail('E_UNAVAILABLE');
  if (exp <= now / 1000) fail('E_EXPIRED');
  const rules = allow.map(rule);
  if (parent) {
    const approved = [...parent.allow, ...offer.allow];
    if (
      parent.jti !== offer.parent ||
      parent.jti === jti ||
      parent.exp !== exp ||
      parent.iss !== iss ||
      parent.aud !== aud ||
      parent.browser_session !== browser_session ||
      approved.length !== rules.length ||
      !approved.every((r) => rules.some((a) => same(a, r)))
    )
      fail('E_UNAVAILABLE');
  } else if (
    exp > Math.floor(now / 1000) + offer.ttlSeconds ||
    rules.length !== 1 ||
    !inside(offer.allow[0], new URL(rules[0].url))
  )
    fail('E_UNAVAILABLE');
  return { jwt, exp, jti, iss, aud, browser_session, allow: rules };
}

export function actionFor(op, args, grant) {
  if (op === 'goto' && shape(args, ['url'])) {
    const u = https(args.url);
    if (!grant.allow.some((r) => inside(r, u))) fail('E_SCOPE');
    return { url: u.href };
  }
  if (op === 'snapshot' && shape(args, [])) return {};
  fail('E_UNSUPPORTED');
}
