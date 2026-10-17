export function extensionOver(browser) {
  return async function fakeExtension(page) {
    const socket = new WebSocket(browser);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    const sent = [];
    socket.onmessage = ({ data }) =>
      void page.evaluate((message) => window.cdpIn(message), data).catch(() => false);
    await page.expose('cdpOut', (command) => {
      sent.push(command.method);
      socket.send(JSON.stringify(command));
    });
    await page.init(() => {
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
    });
    return { sent, close: () => socket.close() };
  };
}
