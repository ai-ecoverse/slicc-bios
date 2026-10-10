import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, run } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZha2Ugbm9kZSBob3N0IGtleSBmb3IgdGVzdHM=';

function fakeNode(key) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const frame = (type, id, payload = new Uint8Array(0)) => {
    const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
    const out = new Uint8Array(5 + bytes.length);
    out[0] = type;
    new DataView(out.buffer).setUint32(1, id);
    out.set(bytes, 5);
    return out;
  };
  const log = (globalThis.fakeNodeLog = []);
  const pc = new RTCPeerConnection();
  const answer = (channel, id, meta) => {
    log.push(meta);
    if (meta.kind === 'resolve') {
      const addresses = meta.name === 'far.example' ? ['203.0.113.7'] : [];
      channel.send(frame(2, id, JSON.stringify({ addresses, ttl: 30 })));
      channel.send(frame(4, id));
      return null;
    }
    channel.send(
      frame(
        2,
        id,
        JSON.stringify({ localAddr: '10.9.8.7:4000', remoteAddr: `${meta.host}:${meta.port}` })
      )
    );
    const received = [];
    return (type, payload) => {
      if (type === 3) {
        received.push(...payload);
        const credit = new Uint8Array(4);
        new DataView(credit.buffer).setUint32(0, payload.length);
        channel.send(frame(6, id, credit));
      }
      const text = decoder.decode(new Uint8Array(received));
      const reply = (body) => {
        channel.send(frame(3, id, body));
        channel.send(frame(4, id));
      };
      if (meta.kind === 'tcp' && type === 3 && text.includes('\r\n\r\n')) {
        reply(
          `HTTP/1.0 200 OK\r\ncontent-type: text/plain\r\n\r\nraw ${meta.host}:${meta.port} ${text.split(' ')[1]}\n`
        );
      }
      if (meta.kind === 'http' && type === 4) {
        const size = new DataView(new Uint8Array(received).buffer).getUint32(0);
        const head = JSON.parse(decoder.decode(new Uint8Array(received.slice(4, 4 + size))));
        const body = encoder.encode(`http ${head.method} ${head.url}\n`);
        const top = encoder.encode(
          JSON.stringify({
            status: 200,
            statusText: 'OK',
            headers: [['content-type', 'text/plain']],
            url: head.url,
          })
        );
        const out = new Uint8Array(4 + top.length + body.length);
        new DataView(out.buffer).setUint32(0, top.length);
        out.set(top, 4);
        out.set(body, 4 + top.length);
        reply(out);
      }
    };
  };
  const serve = (channel) => {
    channel.binaryType = 'arraybuffer';
    const streams = new Map();
    channel.onmessage = ({ data }) => {
      if (typeof data === 'string') {
        log.push(JSON.parse(data));
        channel.send(
          JSON.stringify({
            v: 1,
            role: 'node',
            name: 'fake node',
            host: 'Fake-Node',
            mode: 'local',
            caps: ['net', 'http', 'ssh'],
            routes: { prefixes: [], exit: true },
            sshHostKey: key,
          })
        );
        return;
      }
      const bytes = new Uint8Array(data);
      const id = new DataView(bytes.buffer).getUint32(1);
      const payload = bytes.subarray(5);
      if (bytes[0] === 1) streams.set(id, answer(channel, id, JSON.parse(decoder.decode(payload))));
      else streams.get(id)?.(bytes[0], payload.slice());
    };
  };
  pc.ondatachannel = ({ channel }) => serve(channel);
  const nonce = 'test-nonce';
  pc.onicecandidate = ({ candidate }) =>
    globalThis.sliccLinkReceive(
      JSON.stringify({ t: 'candidate', nonce, candidate: candidate?.toJSON() ?? null })
    );
  globalThis.sliccLinkSend = async (text) => {
    const message = JSON.parse(text);
    if (message.nonce !== nonce) return;
    if (message.t === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      globalThis.sliccLinkReceive(
        JSON.stringify({ t: 'answer', nonce, sdp: pc.localDescription.sdp })
      );
    } else if (message.t === 'candidate' && message.candidate) {
      await pc.addIceCandidate(message.candidate).catch(() => {});
    }
  };
  globalThis.sliccLinkReceive(JSON.stringify({ t: 'hello', v: 1, nonce }));
}

const kernelFile = (page, name) =>
  page.evaluate(async (name) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    const parts = name.split('/');
    let dir = home;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
  }, name);

async function shell(page, command, name) {
  await run(page, `${command} > /home/${name}.txt 2>&1; echo $? > /home/${name}.done`);
  await page.until(async (name) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return home.getFileHandle(`${name}.done`).then(
      async (handle) => (await handle.getFile()).size > 0,
      () => false
    );
  }, name);
  return {
    code: (await kernelFile(page, `${name}.done`)).trim(),
    out: (await kernelFile(page, `${name}.txt`)).trim(),
  };
}

test('a linked node over real WebRTC: its name, raw TCP and HTTP to its loopback, and its host key', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  await page.evaluate(fakeNode, KEY);
  await page.until(() => globalThis.fakeNodeLog?.some((m) => m.role === 'page'));
  const hello = await page.evaluate(() => globalThis.fakeNodeLog.find((m) => m.role === 'page'));
  assert.deepEqual(hello, { v: 1, role: 'page', name: 'seven', mode: 'local', caps: [] });
  await page.until(async () => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    const ssh = await home.getDirectoryHandle('.ssh').catch(() => null);
    return Boolean(await ssh?.getFileHandle('known_hosts').catch(() => null));
  });
  assert.equal(
    await kernelFile(page, '.ssh/known_hosts'),
    `fake-node.slicc.internal,198.18.57.11 ${KEY}\n`
  );

  const raw = await shell(
    page,
    "curl -s --noproxy '*' http://fake-node.slicc.internal:8080/raw",
    'link-raw'
  );
  assert.deepEqual(raw, { code: '0', out: 'raw 127.0.0.1:8080 /raw' });
  const http = await shell(page, 'curl -s http://fake-node.slicc.internal:8081/x', 'link-http');
  assert.deepEqual(http, { code: '0', out: 'http GET http://127.0.0.1:8081/x' });
  const kinds = await page.evaluate(() =>
    globalThis.fakeNodeLog.filter((m) => m.kind).map((m) => m.kind)
  );
  assert.ok(kinds.includes('tcp'), JSON.stringify(kinds));
  assert.ok(kinds.includes('http'), JSON.stringify(kinds));
  const far = await shell(
    page,
    "curl -s --noproxy '*' --max-time 5 http://far.example/",
    'link-far'
  );
  assert.notEqual(far.code, '0');
  assert.equal(
    await page.evaluate(() =>
      globalThis.fakeNodeLog.some((m) => m.kind === 'resolve' || m.host === '203.0.113.7')
    ),
    false
  );
  await page.reload();
  await ready(page);
});
