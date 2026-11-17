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
  return async function fakeExtension(
    page,
    { slow = {}, version = '7.10.0', refuse = () => undefined } = {}
  ) {
    const socket = new WebSocket(browser);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    const sent = [];
    const shielding = [];
    const attaching = new Map();
    const attached = new Map();
    let own = 2 ** 31 - 2 ** 20;
    const deliver = (message) =>
      void page.evaluate((message) => window.cdpIn(message), message).catch(() => false);
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id >= 2 ** 31 - 2 ** 20) return;
      const targetId = attaching.get(message.id);
      attaching.delete(message.id);
      if (targetId && message.result?.sessionId) {
        const sessions = attached.get(targetId) ?? new Set();
        sessions.add(message.result.sessionId);
        attached.set(targetId, sessions);
      }
      if (message.method === 'Target.detachedFromTarget')
        for (const sessions of attached.values()) sessions.delete(message.params?.sessionId);
      deliver(data);
    };
    await page.expose('cdpOut', (command) => {
      sent.push(command.method);
      const refusal = refuse(command);
      if (refusal) return deliver(JSON.stringify({ id: command.id, error: { message: refusal } }));
      if (command.method === 'Target.attachToTarget')
        attaching.set(command.id, command.params?.targetId);
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
    const bridge = (version) => {
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
          version,
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
    await page.init(`() => (${bridge.toString()})(${JSON.stringify(version)})`);
    return {
      sent,
      shielding,
      detach(targetId) {
        for (const sessionId of attached.get(targetId) ?? []) {
          own += 1;
          socket.send(
            JSON.stringify({ id: own, method: 'Target.detachFromTarget', params: { sessionId } })
          );
        }
      },
      close: () => socket.close(),
      install: () => page.evaluate(bridge, version),
    };
  };
}
