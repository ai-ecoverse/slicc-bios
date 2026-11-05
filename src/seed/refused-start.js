let refusedLast = false;
let refusedFor = null;

export function sameStart(left, right) {
  return Boolean(
    left &&
      right &&
      left.version === right.version &&
      left.lock === right.lock &&
      left.schema === right.schema
  );
}

export async function startKey({ version, recorded, schema }) {
  return {
    version: typeof version === 'function' ? await version() : version,
    lock: await recorded(),
    schema: await schema(),
  };
}

export function clearRefusal() {
  refusedLast = false;
  refusedFor = null;
}

export function noteRefusal(refused, key = null) {
  refusedLast = Boolean(refused);
  refusedFor = refusedLast ? key : null;
}

export function wasRefused() {
  return refusedLast;
}

export function skipRefusedStart(changed, key) {
  if (changed || !refusedLast) return false;
  return sameStart(refusedFor, key);
}
