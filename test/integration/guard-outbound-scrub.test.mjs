import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import {
  flush,
  guardProtected,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-state-fixture.mjs';

const suffix = '/doc/outbound-path?outbound-query=fixture#outbound-fragment';
const byteEncoded = (text, layers) => {
  let out = [...new TextEncoder().encode(text)]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
  for (let layer = 1; layer < layers; layer += 1) out = out.replaceAll('%', '%25');
  return out;
};
const hosts = [
  'vault.sliccy.ai',
  'seven.sliccy.ai',
  'www.sliccy.ai',
  'tray.sliccy.ai',
  'ntfy.sliccy.ai',
  'catalog-extra.sliccy.ai',
  'sliccy.ai',
];
const shapes = [
  ...[1, 2, 5, 6].map((layers) => [
    `byte encoded ${layers}`,
    byteEncoded(`https://vault.sliccy.ai${suffix}`, layers),
  ]),
  [
    'byte encoded delimiter',
    byteEncoded(
      'https://vault.sliccy.ai/doc?part=outbound-path%20outbound-query#outbound-fragment',
      1
    ),
  ],
  [
    'unschemed encoded delimiter',
    'vault.sliccy.ai/doc?part=outbound-path%20outbound-query#outbound-fragment',
  ],
  ...hosts.flatMap((host) => [
    [`unschemed lower ${host}`, `${host}${suffix}`],
    [`unschemed upper ${host}`, `${host.toUpperCase()}${suffix}`],
    [`unschemed query ${host}`, `${host}?outbound-query=fixture`],
    [`unschemed fragment ${host}`, `${host}#outbound-fragment`],
  ]),
];
const clean = (value) => {
  let text = value;
  for (let layer = 0; layer < 10; layer += 1) {
    const next = decodeURIComponent(text);
    if (next === text) break;
    text = next;
  }
  assert.equal(
    /outbound-(?:path|query|fragment)/i.test(text),
    false,
    'outbound URL is origin-only'
  );
};

for (const method of [
  'Target.targetCreated',
  'Target.targetInfoChanged',
  'Target.attachedToTarget',
  'Target.getTargets',
  'Target.getTargetInfo',
]) {
  for (const [shape, title] of shapes) {
    test(`outbound scrub ${method} ${shape}`, { timeout: 5000 }, async (t) => {
      const wire = protocol(t);
      const entry = wire.target('outbound-target');
      entry.info.title = title;
      await flush();
      let info;
      if (method.startsWith('Target.get')) {
        const reply = await wire.send(method, { targetId: entry.info.targetId });
        assert.equal(reply.error, undefined);
        info = reply.result.targetInfo ?? reply.result.targetInfos[0];
      } else {
        const mark = wire.delivered.length;
        if (method === 'Target.attachedToTarget') wire.attached(entry.info.targetId);
        else wire.emit({ method, params: { targetInfo: entry.info } });
        await flush();
        info = wire.delivered.slice(mark).find((event) => event.method === method)
          ?.params.targetInfo;
      }
      if (
        !method.startsWith('Target.get') &&
        shape.startsWith('byte encoded') &&
        shape !== 'byte encoded 6'
      ) {
        assert.equal(info, undefined, 'normalized protected schemed titles stay suppressed');
        return;
      }
      assert.ok(info, 'ordinary target metadata remains available');
      assert.equal(info.url, ordinary);
      clean(info.title);
    });
  }
}

for (const [shape, value] of shapes) {
  for (const method of [
    'Page.frameNavigated',
    'Runtime.consoleAPICalled',
    'Runtime.exceptionThrown',
  ]) {
    test(`outbound scrub ${method} ${shape}`, { timeout: 5000 }, async (t) => {
      const wire = protocol(t);
      wire.target('outbound-events');
      const sessionId = await wire.attach('outbound-events');
      await wire.send('Page.enable', {}, sessionId);
      await wire.send('Runtime.enable', {}, sessionId);
      const params =
        method === 'Page.frameNavigated'
          ? { frame: { ...plainFrame('outbound-events'), name: value } }
          : method === 'Runtime.consoleAPICalled'
            ? { type: 'log', args: [{ type: 'string', value }], executionContextId: 1 }
            : {
                exceptionDetails: {
                  text: value,
                  exception: { type: 'string', description: value },
                },
              };
      const mark = wire.delivered.length;
      wire.emit({ method, sessionId, params });
      await flush();
      const event = wire.delivered.slice(mark).find((message) => message.method === method);
      assert.ok(event, 'ordinary event remains available');
      clean(JSON.stringify(event.params));
    });
  }
}

for (const method of ['Target.getTargets', 'Target.getTargetInfo']) {
  test(`outbound scrub ${method} retains ordinary URLs beside protected URLs`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('outbound-control');
    const control = 'https://ordinary.example/%2fcontrol?query=%26control#fragment';
    entry.info.title = `see ${control} and vault.sliccy.ai${suffix} now`;
    await flush();
    let info;
    if (method.startsWith('Target.get')) {
      const reply = await wire.send(method, { targetId: entry.info.targetId });
      assert.equal(reply.error, undefined);
      info = reply.result.targetInfo ?? reply.result.targetInfos[0];
    } else {
      const mark = wire.delivered.length;
      wire.emit({ method, params: { targetInfo: entry.info } });
      await flush();
      info = wire.delivered.slice(mark).find((event) => event.method === method)?.params.targetInfo;
    }
    assert.ok(info);
    assert.equal(info.url, ordinary);
    assert.ok(info.title.includes(control), 'ordinary URL is unchanged');
    clean(info.title);
  });
}

test('outbound scrub a large crafted title finishes within its fixed bound', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('outbound-linear');
  const control = 'https://ordinary.example/doc/control?query=control#fragment';
  entry.info.title = `${'https://ordinary.invalid/'.repeat(40000)} ${byteEncoded(`https://vault.sliccy.ai${suffix}`, 5)} ${control}`;
  await flush();
  const began = performance.now();
  const reply = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
  const info = reply.result?.targetInfo;
  assert.equal(reply.error, undefined);
  assert.ok(info);
  assert.ok(performance.now() - began < 2000, 'large title scrubs within 2000 ms');
  assert.ok(info.title.endsWith(control));
  clean(info.title);
});

test('outbound scrub deeply nested percent runs finish within a fixed bound', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('outbound-percent-linear');
  entry.info.title = `%${'25'.repeat(100000)}41 ${byteEncoded(`https://vault.sliccy.ai${suffix}`, 6)}`;
  await flush();
  const began = performance.now();
  const reply = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
  assert.equal(reply.error, undefined);
  assert.ok(performance.now() - began < 2000, 'nested percent runs scrub within 2000 ms');
  assert.equal(reply.result.targetInfo.title, '');
});

test('outbound scrub an unfinished absolute URL is cut to its origin', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('outbound-origin-bound');
  entry.info.title = `https://ordinary.example/${byteEncoded('/outbound-path', 6)}`;
  const reply = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.targetInfo.title, 'https://ordinary.example');
});

test('outbound scrub ordinary target event URLs and titles stay unchanged', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('outbound-unchanged');
  entry.info.title = 'https://ordinary.example/doc/control?query=control#fragment';
  await flush();
  const mark = wire.delivered.length;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  const info = wire.delivered
    .slice(mark)
    .find((event) => event.method === 'Target.targetInfoChanged')?.params.targetInfo;
  assert.deepEqual(info, entry.info);
});

test('outbound scrub console keeps ordinary URLs beside protected URLs', async (t) => {
  const wire = protocol(t);
  wire.target('outbound-console-control');
  const sessionId = await wire.attach('outbound-console-control');
  await wire.send('Runtime.enable', {}, sessionId);
  const control = 'https://ordinary.example/%2fcontrol?query=%26control#fragment';
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Runtime.consoleAPICalled',
    sessionId,
    params: {
      type: 'log',
      args: [{ type: 'string', value: `${control} vault.sliccy.ai${suffix}` }],
    },
  });
  await flush();
  const shown = wire.delivered
    .slice(mark)
    .find((event) => event.method === 'Runtime.consoleAPICalled');
  assert.ok(shown);
  assert.equal(shown.params.args[0].value, `${control} vault.sliccy.ai`);
});

for (const [hostName, host] of [
  ['vault', 'vault.sliccy.ai'],
  ['tray', 'tray.sliccy.ai'],
  ['www controller', 'www.sliccy.ai/controller'],
  ['own origin', new URL(protectedOrigin).host],
]) {
  const tail = `${host}/doc/outbound-path`;
  for (const [shape, value] of [
    ['nested query raw', `https://ordinary.example/?a=https://x.example/#${tail}`],
    ['fragment raw', `https://ordinary.example/#${tail}`],
    ['fragment encoded tail', `https://ordinary.example/#${byteEncoded(tail, 1)}`],
    [
      'nested query encoded tail',
      `https://ordinary.example/?a=https://x.example/#${byteEncoded(tail, 1)}`,
    ],
    [
      'nested query encoded URL',
      `https://ordinary.example/?a=${encodeURIComponent(`https://x.example/#${tail}`)}`,
    ],
  ]) {
    for (const field of ['title', 'url']) {
      test(`outbound scrub targetInfoChanged ${field} ${hostName} ${shape}`, {
        timeout: 5000,
      }, async (t) => {
        const wire = protocol(t);
        const entry = wire.target('outbound-fragment');
        entry.info.title = 'ordinary title';
        await flush();
        const mark = wire.delivered.length;
        wire.emit({
          method: 'Target.targetInfoChanged',
          params: { targetInfo: { ...entry.info, [field]: value } },
        });
        await flush();
        const info = wire.delivered
          .slice(mark)
          .find((event) => event.method === 'Target.targetInfoChanged')?.params.targetInfo;
        assert.ok(info, 'ordinary outer URL metadata remains available');
        clean(info[field]);
        assert.equal(new URL(info[field]).origin, 'https://ordinary.example');
        const other = field === 'title' ? 'url' : 'title';
        assert.equal(info[other], entry.info[other]);
      });
    }
  }
}

for (const own of [
  'http://127.0.0.1:9431',
  'http://localhost:9432',
  'https://protected.invalid',
  'http://[::1]:9433',
]) {
  const host = new URL(own).host;
  for (const [shape, title] of [
    ['raw', `${host}${suffix}`],
    ...[1, 2, 5, 6].map((layers) => [`encoded ${layers}`, byteEncoded(`${host}${suffix}`, layers)]),
  ]) {
    for (const method of [
      'Target.targetInfoChanged',
      'Target.getTargets',
      'Target.getTargetInfo',
      'Page.frameNavigated',
      'Runtime.consoleAPICalled',
    ]) {
      test(`outbound scrub own ${host} ${shape} ${method}`, { timeout: 5000 }, async (t) => {
        const wire = protocol(t, (raw) => guardProtected(raw, own));
        const entry = wire.target('outbound-own');
        entry.info.title = title;
        await flush();
        let info;
        if (method.startsWith('Target.get')) {
          const reply = await wire.send(method, { targetId: entry.info.targetId });
          assert.equal(reply.error, undefined);
          info = reply.result.targetInfo ?? reply.result.targetInfos[0];
        } else if (method.startsWith('Target.')) {
          const mark = wire.delivered.length;
          wire.emit({ method, params: { targetInfo: entry.info } });
          await flush();
          info = wire.delivered.slice(mark).find((event) => event.method === method)
            ?.params.targetInfo;
        } else {
          const sessionId = await wire.attach(entry.info.targetId);
          await wire.send(
            method === 'Page.frameNavigated' ? 'Page.enable' : 'Runtime.enable',
            {},
            sessionId
          );
          const params =
            method === 'Page.frameNavigated'
              ? { frame: { ...plainFrame(entry.info.targetId), name: title } }
              : { type: 'log', args: [{ type: 'string', value: title }] };
          const mark = wire.delivered.length;
          wire.emit({ method, sessionId, params });
          await flush();
          const event = wire.delivered.slice(mark).find((message) => message.method === method);
          assert.ok(event);
          info =
            method === 'Page.frameNavigated'
              ? { url: event.params.frame.url, title: event.params.frame.name }
              : { url: ordinary, title: event.params.args[0].value };
        }
        assert.ok(info);
        assert.equal(info.url, ordinary);
        assert.equal(info.title, shape === 'encoded 6' ? '' : host);
      });
    }
  }
  for (const [shape, control] of [
    ['raw', 'localhost:9555/doc/control?query=control#fragment'],
    ['encoded', byteEncoded('localhost:9555/doc/control?query=control#fragment', 5)],
    ['different host', 'ordinary.invalid:9432/doc/control?query=control#fragment'],
    ['host suffix', 'evillocalhost:9432/doc/control?query=control#fragment'],
  ]) {
    test(`outbound scrub own ${host} leaves ordinary host and port ${shape} unchanged`, async (t) => {
      const wire = protocol(t, (raw) => guardProtected(raw, own));
      const entry = wire.target('outbound-own-control');
      entry.info.title = control;
      const reply = await wire.send('Target.getTargetInfo', { targetId: entry.info.targetId });
      assert.equal(reply.error, undefined);
      assert.equal(reply.result.targetInfo.title, control);
    });
  }
}
