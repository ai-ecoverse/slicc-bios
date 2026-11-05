import { skipRefusedStart } from './refused-start.js';

export function offerChatOptions(auto = false) {
  return { auto: Boolean(auto) };
}

export function skipOfferStart(changed, key, { auto = false } = {}) {
  return skipRefusedStart(changed, key, auto);
}
