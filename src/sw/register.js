import { onSite } from '../seed/seven-rule.js';
import { openIntegrity } from './integrity.js';
import { BROWSERS, releaseLock, UnusableLock } from './lock.js';

export const AFRESH = 'afresh';

async function needsLock(script) {
  try {
    const pin = await releaseLock(script).pin();
    if (pin === null) return false;
    const source = await (await openIntegrity()).source(BROWSERS);
    return Boolean(source && source.integrity !== pin);
  } catch (error) {
    return error instanceof UnusableLock;
  }
}

export async function intercept(container, script, scope) {
  const options = { type: 'module', scope };
  const plain = new URL(script);
  plain.search = '';
  const fresh = new URL(plain);
  fresh.search = AFRESH;
  const known = await container.getRegistration(scope);
  const active = known?.active;
  const newest = known && (known.installing ?? known.waiting ?? known.active);
  const current = newest?.scriptURL === fresh.href ? fresh : plain;
  const next = current === fresh ? plain : fresh;
  const registration = await container.register(current, options);
  if (registration.installing || registration.waiting) return registration;
  try {
    await registration.update();
  } catch (error) {
    console.warn(`bios: ${current.href} didn't update (${error.message}), installing ${next.href}`);
    return container.register(next, options).catch(() => {
      throw error;
    });
  }
  const settled = () =>
    !registration.installing &&
    !registration.waiting &&
    active?.state === 'activated' &&
    registration.active === active;
  if (onSite(current) && settled() && (await needsLock(active.scriptURL)) && settled()) {
    return container.register(next, options);
  }
  return registration;
}
