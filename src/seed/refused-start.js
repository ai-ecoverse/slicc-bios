import { OLDER } from './durable.js';

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
  refusedFor = refused?.plain === OLDER ? key : null;
}

export function wasRefused() {
  return refusedLast;
}

export function skipRefusedStart(changed, key, auto = false) {
  if (!auto || changed || !refusedFor) return false;
  return sameStart(refusedFor, key);
}

export function offerChatOptions(auto = false) {
  return { auto: Boolean(auto) };
}

export function shareRun(run) {
  let current = null;
  let again = false;
  const share = (...args) => {
    if (current !== null) {
      again = true;
      return current;
    }
    current = (async () => {
      try {
        return await run(...args);
      } finally {
        current = null;
        if (again) {
          again = false;
          void share(...args);
        }
      }
    })();
    return current;
  };
  return share;
}
