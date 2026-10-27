import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, flush, guardProtected, protocol } from './guard-state-fixture.mjs';

for (const kind of ['call', 'event']) {
  for (let offset = 0; offset < 12; offset += 1) {
    test(`state boundary ${kind} ${offset}`, async (t) => {
      let transitioned = false;
      let id;
      let forwardedAfter = false;
      let publishedAfter = false;
      const wire = protocol(t, (raw, own) => {
        const original = raw.send;
        raw.send = (text) => {
          const message = JSON.parse(text);
          if (message.id === id && transitioned) forwardedAfter = true;
          original(text);
        };
        const guarded = guardProtected(raw, own);
        const wrapper = { send: (text) => guarded.send(text), close: () => guarded.close() };
        Object.defineProperty(wrapper, 'onmessage', {
          set(callback) {
            guarded.onmessage = (text) => {
              const message = JSON.parse(text);
              if (kind === 'event' && message.method === 'Runtime.consoleAPICalled' && transitioned)
                publishedAfter = true;
              callback(text);
            };
          },
        });
        return wrapper;
      });
      wire.target('boundary');
      const session = await wire.attach('boundary');
      await wire.send('Runtime.enable', {}, session);
      wire.hold((message) => message.id < 2 ** 30 && message.method === 'Runtime.evaluate');
      const read =
        kind === 'call'
          ? wire.request('Runtime.evaluate', { expression: '1' }, session)
          : undefined;
      id = read?.id;
      if (kind === 'event')
        wire.emit({
          method: 'Runtime.consoleAPICalled',
          sessionId: session,
          params: { type: 'log', args: [{ type: 'string', value: 'synthetic-boundary' }] },
        });
      let phase = Promise.resolve();
      for (let step = 0; step < offset; step += 1) phase = phase.then(() => {});
      await phase.then(() => {
        transitioned = true;
        wire.emit({
          method: 'Page.frameNavigated',
          sessionId: 'guard-boundary',
          params: { frame: errorFrame('boundary') },
        });
      });
      await flush();
      if (read) {
        const held = wire.held.find((message) => message.id === read.id);
        if (held) wire.release(held);
        const answer = await read.answer;
        assert.match(answer.error?.message ?? '', /^slicc: refused:/);
        assert.equal(answer.result, undefined);
        assert.equal(forwardedAfter, false, 'current state is checked when forwarding');
      } else assert.equal(publishedAfter, false, 'current state is checked when publishing');
    });
  }
}
