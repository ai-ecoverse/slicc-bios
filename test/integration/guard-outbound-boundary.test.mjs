import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import {
  flush,
  guardProtected,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-state-fixture.mjs';

const byteEncoded = (text, layers = 1) => {
  let out = [...new TextEncoder().encode(text)]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
  for (let layer = 1; layer < layers; layer += 1) out = out.replaceAll('%', '%25');
  return out;
};
const endings = [
  ['path', '/doc/outbound-path?outbound-query=fixture#outbound-fragment'],
  ['query', '?outbound-query=fixture#outbound-fragment'],
  ['fragment', '#outbound-fragment'],
];
const breaks = (host, tail) => [
  ...['%20', '%22', '%3c', '%00', '%09', '%2500'].map((delimiter) => [
    delimiter,
    `${host}${delimiter}${tail}`,
  ]),
  ['fully encoded NUL', byteEncoded(`${host}\u0000${tail}`)],
  ['fully encoded space', byteEncoded(`${host} ${tail}`)],
];
const targetMethods = ['Target.targetInfoChanged', 'Target.getTargets', 'Target.getTargetInfo'];

async function shown(t, method, title, own = protectedOrigin, suppressed = false) {
  const wire = protocol(t, (raw) => guardProtected(raw, own));
  const entry = wire.target('outbound-boundary');
  entry.info.title = title;
  if (method.startsWith('Target.get')) {
    const reply = await wire.send(method, { targetId: entry.info.targetId });
    assert.equal(reply.error, undefined);
    const info = reply.result.targetInfo ?? reply.result.targetInfos[0];
    assert.ok(info);
    assert.equal(info.url, ordinary);
    return info.title;
  }
  let sessionId;
  let params = { targetInfo: entry.info };
  if (!method.startsWith('Target.')) {
    sessionId = await wire.attach(entry.info.targetId);
    await wire.send(
      method === 'Page.frameNavigated' ? 'Page.enable' : 'Runtime.enable',
      {},
      sessionId
    );
    params =
      method === 'Page.frameNavigated'
        ? { frame: { ...plainFrame(entry.info.targetId), name: title } }
        : method === 'Runtime.consoleAPICalled'
          ? { type: 'log', args: [{ type: 'string', value: title }] }
          : {
              exceptionDetails: { text: title, exception: { type: 'string', description: title } },
            };
  }
  await flush();
  const mark = wire.delivered.length;
  wire.emit({ method, params, ...(sessionId ? { sessionId } : {}) });
  await flush();
  const event = wire.delivered.slice(mark).find((message) => message.method === method);
  if (suppressed) {
    assert.equal(event, undefined, 'protected schemed target titles remain suppressed');
    return undefined;
  }
  assert.ok(event, 'ordinary target metadata and events remain available');
  if (method.startsWith('Target.')) {
    assert.equal(event.params.targetInfo.url, ordinary);
    return event.params.targetInfo.title;
  }
  if (method === 'Page.frameNavigated') return event.params.frame.name;
  if (method === 'Runtime.consoleAPICalled') return event.params.args[0].value;
  assert.equal(
    event.params.exceptionDetails.exception.description,
    event.params.exceptionDetails.text
  );
  return event.params.exceptionDetails.text;
}

for (const host of [
  'vault.sliccy.ai',
  'tray.sliccy.ai',
  'www.sliccy.ai',
  new URL(protectedOrigin).host,
]) {
  for (const [ending, tail] of endings) {
    for (const [shape, value] of breaks(host, tail)) {
      for (const method of targetMethods) {
        test(`outbound boundary ${host} ${shape} ${ending} ${method}`, {
          timeout: 5000,
        }, async (t) => {
          assert.equal(await shown(t, method, value), '');
        });
      }
      if (host === 'vault.sliccy.ai') {
        for (const method of [
          'Page.frameNavigated',
          'Runtime.consoleAPICalled',
          'Runtime.exceptionThrown',
        ]) {
          test(`outbound boundary ${shape} ${ending} ${method}`, { timeout: 5000 }, async (t) => {
            assert.equal(await shown(t, method, value), '');
          });
        }
      }
    }
  }
}

for (const [shape, value] of breaks('vault.sliccy.ai', endings[0][1])) {
  test(`outbound boundary ${shape} remains named when a public body is answered`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    wire.target('outbound-boundary-body');
    const sessionId = await wire.attach('outbound-boundary-body');
    const document = await wire.send('DOM.getDocument', { depth: 0 }, sessionId);
    assert.equal(document.error, undefined);
    wire.hold((message) => message.method === 'DOM.getOuterHTML');
    const request = wire.request(
      'DOM.getOuterHTML',
      { nodeId: document.result.root.nodeId },
      sessionId
    );
    await flush();
    const held = wire.held.find((message) => message.method === 'DOM.getOuterHTML');
    assert.ok(held, 'the ordinary body read reached the public protocol');
    wire.release(held, { result: { outerHTML: `<p>${value}</p>` } });
    const reply = await request.answer;
    assert.equal(reply.error?.message, PROTECTED);
    assert.equal(reply.result, undefined);
  });
}

const backslashAuthorities = [
  ['http://127.0.0.1:9431', '127.0.0.1:9431'],
  ['http://127.0.0.1:9431', '127.1:9431'],
  ['http://127.0.0.1:9431', '2130706433:9431'],
  ['http://127.0.0.1:9431', '0x7f000001:9431'],
  ['http://[::1]:9433', '[0:0:0:0:0:0:0:1]:9433'],
  ['http://[::1]:9433', '[::0:1]:9433'],
];
const backslashTails = [
  ['literal path', '\\doc/outbound-path?outbound-query=fixture#outbound-fragment'],
  ['encoded path', '%5c/doc/outbound-path?outbound-query=fixture#outbound-fragment'],
  ['encoded query', '%5c?outbound-query=fixture#outbound-fragment'],
  ['encoded fragment', '%5c#outbound-fragment'],
];
for (const [own, token] of backslashAuthorities) {
  for (const [tailName, tail] of backslashTails) {
    for (const scheme of ['', 'http://']) {
      for (const layers of [0, 1]) {
        const raw = `${scheme}${token}${tail}`;
        const value = layers ? byteEncoded(raw, layers) : raw;
        for (const method of [
          ...targetMethods,
          'Page.frameNavigated',
          'Runtime.consoleAPICalled',
          'Runtime.exceptionThrown',
        ]) {
          test(`outbound backslash ${token} ${tailName} ${scheme || 'unschemed'} layers ${layers} ${method}`, {
            timeout: 5000,
          }, async (t) => {
            const suppressed = Boolean(scheme) && method === 'Target.targetInfoChanged';
            const expected = suppressed ? undefined : `${scheme}${token}`;
            assert.equal(await shown(t, method, value, own, suppressed), expected);
          });
        }
      }
    }
    const otherPort = token.replace(/:\d+$/, ':9555');
    for (const scheme of ['', 'http://']) {
      for (const layers of [0, 1]) {
        const raw = `${scheme}${otherPort}${tail}`;
        const value = layers ? byteEncoded(raw, layers) : raw;
        for (const method of ['Target.getTargetInfo', 'Runtime.consoleAPICalled']) {
          test(`outbound backslash ${token} ${tailName} ordinary port ${scheme || 'unschemed'} layers ${layers} ${method}`, async (t) => {
            assert.equal(await shown(t, method, value, own), value);
          });
        }
      }
    }
  }
  for (const scheme of ['', 'http://']) {
    for (const layers of [2, 5]) {
      const value = byteEncoded(`${scheme}${token}${backslashTails[0][1]}`, layers);
      for (const method of [
        'Target.getTargetInfo',
        'Page.frameNavigated',
        'Runtime.consoleAPICalled',
        'Runtime.exceptionThrown',
      ]) {
        test(`outbound backslash ${token} literal path ${scheme || 'unschemed'} layers ${layers} ${method}`, async (t) => {
          assert.equal(await shown(t, method, value, own), `${scheme}${token}`);
        });
      }
    }
  }
}

for (const value of [
  'ordinary \\doc/path?query=control#fragment',
  'https://ordinary.example\\doc/path?query=control#fragment',
  'https://ordinary.example%5c/doc/path?query=control#fragment',
]) {
  for (const method of [
    'Target.getTargetInfo',
    'Runtime.consoleAPICalled',
    'Runtime.exceptionThrown',
    'Page.frameNavigated',
  ]) {
    test(`outbound backslash ordinary text remains byte-exact ${value} ${method}`, async (t) => {
      assert.equal(await shown(t, method, value), value);
    });
  }
}

const ownIPs = [
  ['http://[::1]:9433', '[0:0:0:0:0:0:0:1]:9433'],
  ['http://[::1]:9433', '[::0:1]:9433'],
  ['http://127.0.0.1:9431', '127.1:9431'],
  ['http://127.0.0.1:9431', '2130706433:9431'],
  ['http://127.0.0.1:9431', '0x7f000001:9431'],
];
for (const [own, token] of ownIPs) {
  for (const [ending, tail] of endings) {
    for (const layers of [0, 1, 2, 5]) {
      const value = layers ? byteEncoded(`${token}${tail}`, layers) : `${token}${tail}`;
      for (const method of [...targetMethods, 'Page.frameNavigated', 'Runtime.consoleAPICalled']) {
        test(`outbound boundary own IP ${token} layers ${layers} ${ending} ${method}`, {
          timeout: 5000,
        }, async (t) => {
          assert.equal(await shown(t, method, value, own), token);
        });
      }
    }
    const otherPort = token.replace(/:\d+$/, ':9555');
    for (const layers of [0, 1, 5]) {
      const control = layers ? byteEncoded(`${otherPort}${tail}`, layers) : `${otherPort}${tail}`;
      test(`outbound boundary own IP ${token} ordinary port layers ${layers} ${ending} stays unchanged`, async (t) => {
        assert.equal(await shown(t, 'Target.getTargetInfo', control, own), control);
      });
    }
  }
}

for (const [shape, control] of [
  ['percent space', 'https://ordinary.example/my%20file.pdf?query=control#fragment'],
  ['escaped space', 'https://ordinary.example/my\\u0020file.pdf?query=control#fragment'],
]) {
  for (const method of [
    'Target.targetInfoChanged',
    'Target.getTargetInfo',
    'Runtime.consoleAPICalled',
  ]) {
    test(`outbound boundary ordinary ${shape} remains byte-exact in ${method}`, async (t) => {
      assert.equal(await shown(t, method, control), control);
    });
  }
  for (const method of ['Target.getTargetInfo', 'Runtime.consoleAPICalled']) {
    test(`outbound boundary ordinary ${shape} remains byte-exact beside a protected run in ${method}`, async (t) => {
      assert.equal(
        await shown(t, method, `${control} vault.sliccy.ai/doc/outbound-path`),
        `${control} vault.sliccy.ai`
      );
    });
  }
}

test('outbound boundary a large authority candidate title stays within its fixed bound', {
  timeout: 5000,
}, async (t) => {
  const control = '127.1:9555/doc/control/';
  const prefix = control.repeat(40000);
  const value = `${prefix} 0x7f000001:9431/doc/outbound-path?outbound-query=fixture#outbound-fragment`;
  const began = performance.now();
  const result = await shown(t, 'Target.getTargetInfo', value, 'http://127.0.0.1:9431');
  assert.ok(performance.now() - began < 2000, 'authority candidates scrub within 2000 ms');
  assert.equal(result, `${prefix} 0x7f000001:9431`);
});
