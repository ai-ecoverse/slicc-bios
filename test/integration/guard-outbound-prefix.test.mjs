import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { protection, redacting } from '../../src/seed/guard.js';
import { flush, guardProtected, ordinary, protocol } from './guard-state-fixture.mjs';

const encoded = (value, layers) => {
  let out = value;
  for (let layer = 0; layer < layers; layer += 1) out = encodeURIComponent(out);
  return out;
};

async function network(t, own) {
  const wire = protocol(t, own === undefined ? undefined : (raw) => guardProtected(raw, own));
  wire.target('outbound-prefix');
  const sessionId = await wire.attach('outbound-prefix');
  await wire.send('Network.enable', {}, sessionId);
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId,
    params: {
      requestId: 'outbound-prefix-request',
      type: 'Document',
      frameId: 'outbound-prefix',
      documentURL: ordinary,
      request: { url: ordinary },
    },
  });
  await flush();
  return { wire, sessionId };
}

for (const host of ['seven.sliccy.ai', 'vault.sliccy.ai']) {
  for (const delimiter of ['%22', '%20', '%3c', '%00', '%09', '%2500', '\\u0022', '&#34;']) {
    for (const layers of [0, 1, 2]) {
      test(`outbound prefix Refresh ${host} ${delimiter} layers ${layers}`, async (t) => {
        const { wire, sessionId } = await network(t);
        const url = `https://${host}/auth/callback?code=outbound-secret%2F%2B${delimiter}outbound-suffix`;
        const refresh = encoded(`0;url=${url}`, layers);
        const mark = wire.delivered.length;
        wire.emit({
          method: 'Network.responseReceivedExtraInfo',
          sessionId,
          params: {
            requestId: 'outbound-prefix-request',
            statusCode: 302,
            headers: { Refresh: refresh },
            headersText: `HTTP/1.1 302 Found\r\nRefresh: ${refresh}\r\nX-Control: keep\r\n`,
          },
        });
        await flush();
        const event = wire.delivered
          .slice(mark)
          .find((message) => message.method === 'Network.responseReceivedExtraInfo');
        assert.ok(event, 'ordinary redirect extra headers remain available');
        assert.equal(event.params.headers.Refresh, `0;url=https://${host}`);
        assert.equal(
          event.params.headersText,
          `HTTP/1.1 302 Found\r\nRefresh: 0;url=https://${host}\r\nX-Control: keep\r\n`
        );
        assert.equal(/outbound-(?:secret|suffix)/.test(JSON.stringify(event.params)), false);
      });
    }
  }
}

const ownAliases = [
  ['http://127.0.0.1:9431', '127.0.0.1:9431'],
  ['http://127.0.0.1:9431', '127.1:9431'],
  ['http://127.0.0.1:9431', '2130706433:9431'],
  ['http://127.0.0.1:9431', '0x7f000001:9431'],
  ['http://[::1]:9433', '[0:0:0:0:0:0:0:1]:9433'],
  ['http://[::1]:9433', '[::0:1]:9433'],
];
const unsafeSpans = [
  ...ownAliases.flatMap(([own, host]) =>
    [';', '%3b'].flatMap((separator) => [
      [
        `own authority ${host} ${separator}`,
        own,
        `0;url=http://${host}${separator}code=outbound-secret/doc%22outbound-suffix`,
      ],
      [
        `own prefix ${host} ${separator}`,
        own,
        `${host}${separator}code=outbound-secret%22https://seven.sliccy.ai/doc`,
      ],
    ])
  ),
  [
    'Unicode authority',
    undefined,
    '0;url=https://vault.sliccy.ai？code=outbound-secret/doc%22outbound-suffix',
  ],
  [
    'Unicode prefix',
    undefined,
    'vault.sliccy.ai？code=outbound-secret%22https://seven.sliccy.ai/doc',
  ],
  ...[';', '%3b'].map((separator) => [
    `catalog prefix ${separator}`,
    undefined,
    `vault.sliccy.ai${separator}code=outbound-secret%22https://seven.sliccy.ai/doc`,
  ]),
];

async function blankRefresh(t, own, value) {
  const { wire, sessionId } = await network(t, own);
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Network.responseReceivedExtraInfo',
    sessionId,
    params: {
      requestId: 'outbound-prefix-request',
      statusCode: 302,
      headers: { Refresh: value },
      headersText: `Refresh: ${value}\r\nX-Control: keep\r\n`,
    },
  });
  await flush();
  const event = wire.delivered
    .slice(mark)
    .find((message) => message.method === 'Network.responseReceivedExtraInfo');
  assert.ok(event, 'ordinary extra headers remain available with ambiguous values cut');
  assert.equal(event.params.headers.Refresh, '');
  assert.equal(event.params.headersText, 'Refresh: \r\nX-Control: keep\r\n');
  assert.equal(/outbound-(?:secret|suffix)/.test(JSON.stringify(event.params)), false);
}

for (const [shape, own, value] of unsafeSpans) {
  for (const layers of [0, 1, 2]) {
    test(`outbound prefix unsafe ${shape} layers ${layers}`, async (t) => {
      await blankRefresh(t, own, encoded(value, layers));
    });
  }
}

const defaultOrigins = [
  'http://127.0.0.1',
  'http://127.0.0.1:80',
  'https://127.0.0.1',
  'http://localhost',
  'https://localhost',
];
const defaultSpellings = ['2130706433', '0x7f000001', '017700000001', 'localhost'];
const separators = [
  ...['?', '#', ';', '&', ','].flatMap((separator) => {
    const percent = `%${separator.charCodeAt(0).toString(16)}`;
    return [
      [`raw ${separator}`, separator],
      [`percent ${separator}`, percent],
      [`double percent ${separator}`, percent.replace('%', '%25')],
    ];
  }),
  ['entity question', '&#63;'],
  ['Unicode escape question', '\\u003f'],
];

for (const own of defaultOrigins) {
  for (const host of defaultSpellings) {
    for (const [shape, separator] of separators) {
      test(`outbound prefix non-Refresh ${own} ${host} ${shape}`, async (t) => {
        await blankRefresh(
          t,
          own,
          `${host}${separator}code=outbound-secret%22https://seven.sliccy.ai/doc`
        );
      });
    }
  }
}

for (const prefix of ['url=', ';URL=', '0;URL=', ' 12 ; UrL = ', '7 url = ', '\t;url =\t']) {
  test(`outbound prefix exact Refresh grammar ${JSON.stringify(prefix)}`, async (t) => {
    const { wire, sessionId } = await network(t);
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Network.responseReceivedExtraInfo',
      sessionId,
      params: {
        requestId: 'outbound-prefix-request',
        statusCode: 302,
        headers: {
          Refresh: encoded(
            `${prefix}https://seven.sliccy.ai/doc?code=outbound-secret%22outbound-suffix`,
            1
          ),
        },
      },
    });
    await flush();
    const event = wire.delivered
      .slice(mark)
      .find((message) => message.method === 'Network.responseReceivedExtraInfo');
    assert.ok(event);
    assert.equal(event.params.headers.Refresh, `${prefix}https://seven.sliccy.ai`);
    assert.equal(/outbound-(?:secret|suffix)/.test(JSON.stringify(event.params)), false);
  });
}

for (const host of ['seven.sliccy.ai', 'vault.sliccy.ai']) {
  test(`outbound prefix caller-owned redirect normalises to the exact safe URL ${host}`, async (t) => {
    const { wire, sessionId } = await network(t);
    const url = `https://${host}/doc?outbound-secret=fixture#outbound-fragment`;
    const asked = `https://ordinary.invalid/redirect?to=${encodeURIComponent(url)}`;
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId,
      params: {
        requestId: 'outbound-caller',
        type: 'Document',
        frameId: 'outbound-prefix',
        documentURL: ordinary,
        request: { url: asked },
      },
    });
    await flush();
    const event = wire.delivered
      .slice(mark)
      .find((message) => message.method === 'Network.requestWillBeSent');
    assert.ok(event, 'the caller-owned ordinary request remains visible');
    const scrubbedAsked = redacting(protection())({ url: asked }).params.url;
    assert.equal(scrubbedAsked, `https://ordinary.invalid/redirect?to=https://${host}`);
    assert.equal(event.params.request.url, scrubbedAsked);
    assert.equal(/outbound-(?:secret|fragment)/.test(JSON.stringify(event.params)), false);
    const ownOnly = JSON.stringify(event).replaceAll(asked, '').replaceAll(scrubbedAsked, '');
    assert.equal(ownOnly.includes(host), false);
    const other = JSON.stringify({ event, elsewhere: `https://${host}` })
      .replaceAll(asked, '')
      .replaceAll(scrubbedAsked, '');
    assert.equal(
      other.includes(host),
      true,
      'a protected host anywhere else still fails exclusion'
    );
  });
}

test('outbound prefix decode-introduced suffixes never restore another URL', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('outbound-prefix-suffix');
  entry.info.title =
    '0;url=https://vault.sliccy.ai/doc?code=outbound-secret%22https://ordinary.example/outbound-suffix';
  const reply = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.targetInfo.title, '0;url=https://vault.sliccy.ai');
});

test('outbound prefix ordinary candidates before a protected span stay bounded', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('outbound-prefix-bound');
  const prefix = 'https://ordinary.example/control,'.repeat(20000);
  entry.info.title = `${prefix}0;url=https://vault.sliccy.ai/doc?code=outbound-secret%22outbound-suffix`;
  const began = performance.now();
  const reply = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
  assert.equal(reply.error, undefined);
  assert.ok(performance.now() - began < 2000, 'ordinary candidates finish within 2000 ms');
  assert.equal(reply.result.targetInfo.title, 'https://ordinary.example');
  assert.equal(/outbound-(?:secret|suffix)/.test(reply.result.targetInfo.title), false);
});
