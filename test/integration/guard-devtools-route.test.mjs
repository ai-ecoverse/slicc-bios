import assert from 'node:assert/strict';
import test from 'node:test';
import { browserHook } from '../../src/seed/cdp.js';
import { DEBUGGER_ROUTE_UPDATE } from '../../src/seed/debugger.js';

for (const [runtime, linked] of [
  [undefined, false],
  ['devtools', false],
  ['devtools', true],
])
  test(`an offered DevTools browser opens its own unattested route (${runtime ?? 'default'}, linked=${linked})`, {
    timeout: 5000,
  }, async () => {
    const saved = new Map(
      ['sliccExtension', 'crestDevTools', 'WebSocket'].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ])
    );
    const sent = [];
    const opened = [];
    class Socket {
      constructor(url) {
        opened.push(url);
        queueMicrotask(() => this.onopen());
      }
      send(text) {
        const command = JSON.parse(text);
        sent.push(command);
        const frame = {
          id: 'ordinary',
          loaderId: 'loader',
          url: 'https://ordinary.invalid/page',
          securityOrigin: 'https://ordinary.invalid',
        };
        const result =
          command.method === 'Target.getTargetInfo'
            ? { targetInfo: { targetId: 'ordinary', type: 'page', url: frame.url } }
            : command.method === 'Target.attachToTarget'
              ? { sessionId: command.id >= 2 ** 30 ? 'guard-ordinary' : 'client-ordinary' }
              : command.method === 'Page.getFrameTree'
                ? { frameTree: { frame } }
                : command.method === 'DOM.getDocument'
                  ? { root: { nodeId: 1, nodeName: '#document', children: [] } }
                  : command.method === 'Runtime.evaluate'
                    ? { result: { value: frame.url } }
                    : {};
        queueMicrotask(() =>
          this.onmessage?.({
            data: JSON.stringify({
              id: command.id,
              ...(command.sessionId ? { sessionId: command.sessionId } : {}),
              result,
            }),
          })
        );
      }
      close() {}
    }
    try {
      Object.defineProperty(globalThis, 'sliccExtension', { configurable: true, value: undefined });
      Object.defineProperty(globalThis, 'crestDevTools', {
        configurable: true,
        value: { webSocketDebuggerUrl: 'ws://devtools.invalid/devtools/browser/owned' },
      });
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
      const links = linked
        ? () => ({
            links: new Map([
              [
                'node',
                {
                  label: 'linked',
                  peer: { version: '1.55.99' },
                  exit: { browsers: () => [{ id: 'chrome', seven: true }] },
                },
              ],
            ]),
          })
        : undefined;
      const hook = browserHook(undefined, links, 'https://protected.invalid');
      const connection = await hook({ runtime });
      assert.deepEqual(opened, ['ws://devtools.invalid/devtools/browser/owned']);
      assert.equal(sent[0].method, 'Slicc.action');
      const ask = async (id, method, params, sessionId) => {
        const reply = Promise.withResolvers();
        connection.onmessage = (text) => {
          const answer = JSON.parse(text);
          if (answer.id === id) reply.resolve(answer);
        };
        connection.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
        return reply.promise;
      };
      const attached = await ask(42, 'Target.attachToTarget', {
        targetId: 'ordinary',
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      assert.equal(attached.result.sessionId, 'client-ordinary');
      let id = 43;
      for (const [method, params] of [
        ['Debugger.enable', {}],
        ['Debugger.disable', {}],
        ['Debugger.resume', {}],
        ['Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' }],
        ['Debugger.removeBreakpoint', { breakpointId: 'owned' }],
      ])
        assert.equal(
          (await ask(id++, method, params, attached.result.sessionId)).error.message,
          DEBUGGER_ROUTE_UPDATE
        );
      assert.equal(
        sent.some(({ method }) => method.startsWith('Debugger.')),
        false
      );
      connection.close();
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  });
