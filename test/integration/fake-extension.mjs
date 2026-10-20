import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

export const SHIELD = "slicc: refused: target is on seven's origin";
const shielded = protectedOrigins(catalog.protectedOrigins);
const namesProtected = ({ urlPattern } = {}) => {
  const text = typeof urlPattern === 'string' ? urlPattern : '*';
  if (catalog.protectedOrigins.domains.some((domain) => text.toLowerCase().includes(domain)))
    return true;
  const url = text.replace(/\\(.)/g, '$1').replace(/\*/g, '').replace(/\?/g, 'a');
  return URL.canParse(url) && shielded.url(url);
};

export function extensionOver(browser) {
  return async function fakeExtension(page, { slow = {} } = {}) {
    const socket = new WebSocket(browser);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    const sent = [];
    const shielding = [];
    const deliver = (message) =>
      void page.evaluate((message) => window.cdpIn(message), message).catch(() => false);
    socket.onmessage = ({ data }) => deliver(data);
    await page.expose('cdpOut', (command) => {
      sent.push(command.method);
      if (
        command.method === 'Fetch.enable' &&
        (command.params?.patterns ?? []).some(namesProtected)
      ) {
        shielding.push(command.params.patterns);
        return deliver(JSON.stringify({ id: command.id, error: { message: SHIELD } }));
      }
      const ms = slow[command.method];
      if (ms) setTimeout(() => socket.send(JSON.stringify(command)), ms);
      else socket.send(JSON.stringify(command));
    });
    const bridge = () => {
      const pending = new Map();
      const listeners = new Set();
      let next = 0;
      window.cdpIn = (text) => {
        const message = JSON.parse(text);
        const call = pending.get(message.id);
        if (call) {
          pending.delete(message.id);
          if (message.error) call.reject(new Error(message.error.message));
          else call.resolve(message.result);
        } else if (message.method) {
          for (const listener of listeners) listener(message);
        }
      };
      Object.defineProperty(globalThis, 'sliccExtension', {
        value: Object.freeze({
          fetch: (input, init) => fetch(input, init),
          cdp: Object.freeze({
            send(method, params, sessionId) {
              const id = ++next;
              return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                window.cdpOut(JSON.stringify({ id, method, params, sessionId }));
              });
            },
            on(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          }),
        }),
      });
    };
    await page.init(bridge);
    return { sent, shielding, close: () => socket.close(), install: () => page.evaluate(bridge) };
  };
}
