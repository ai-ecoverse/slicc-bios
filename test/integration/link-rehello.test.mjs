import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, run } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

function recordPeers() {
  const Native = globalThis.RTCPeerConnection;
  globalThis.NativePeer = Native;
  globalThis.sevenPeers = [];
  globalThis.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      globalThis.sevenPeers.push(this);
    }
  };
}

function fakeNodes() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const frame = (type, id, payload) => {
    const bytes = encoder.encode(payload);
    const out = new Uint8Array(5 + bytes.length);
    out[0] = type;
    new DataView(out.buffer).setUint32(1, id);
    out.set(bytes, 5);
    return out;
  };
  const peers = new Map();
  const sent = [];
  globalThis.fakeSent = sent;
  globalThis.sliccLinkSend = async (text) => {
    const message = JSON.parse(text);
    sent.push([message.nonce, message.t]);
    const peer = peers.get(message.nonce);
    if (!peer) return;
    if (message.t === 'offer') {
      peer.offers += 1;
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      globalThis.sliccLinkReceive(
        JSON.stringify({ t: 'answer', nonce: message.nonce, sdp: peer.pc.localDescription.sdp })
      );
    } else if (message.t === 'candidate' && message.candidate) {
      await peer.pc.addIceCandidate(message.candidate).catch(() => {});
    }
  };
  const serve = (peer, channel) => {
    channel.binaryType = 'arraybuffer';
    if (channel.label === 'slicc.link.v1') {
      peer.control = channel;
      channel.onclose = () => {
        peer.closed = true;
      };
    }
    channel.onmessage = ({ data }) => {
      if (typeof data === 'string') {
        peer.hello = JSON.parse(data);
        channel.send(
          JSON.stringify({
            v: 1,
            role: 'node',
            name: 'fake node',
            host: peer.host,
            mode: 'local',
            caps: ['net', 'http'],
            routes: { prefixes: [], exit: true },
          })
        );
        return;
      }
      const bytes = new Uint8Array(data);
      const id = new DataView(bytes.buffer).getUint32(1);
      if (bytes[0] !== 1) return;
      const meta = JSON.parse(decoder.decode(bytes.subarray(5)));
      channel.send(
        frame(2, id, JSON.stringify({ localAddr: '10.9.8.7:4000', remoteAddr: '127.0.0.1:80' }))
      );
      if (meta.kind !== 'tcp') return;
      let text = '';
      channel.addEventListener('message', ({ data: more }) => {
        if (typeof more === 'string') return;
        const next = new Uint8Array(more);
        if (new DataView(next.buffer).getUint32(1) !== id || next[0] !== 3) return;
        text += decoder.decode(next.subarray(5));
        if (!text.includes('\r\n\r\n')) return;
        channel.send(frame(3, id, `HTTP/1.0 200 OK\r\n\r\nraw ${peer.nonce}\n`));
        channel.send(frame(4, id, ''));
      });
    };
  };
  globalThis.fakeLink = (nonce, node, host = 'Fake-Node') => {
    const pc = new globalThis.NativePeer();
    const peer = { nonce, node, host, pc, offers: 0, hello: null, control: null, closed: false };
    peers.set(nonce, peer);
    pc.ondatachannel = ({ channel }) => serve(peer, channel);
    pc.onicecandidate = ({ candidate }) =>
      globalThis.sliccLinkReceive(
        JSON.stringify({ t: 'candidate', nonce, candidate: candidate?.toJSON() ?? null })
      );
    globalThis.sliccLinkReceive(JSON.stringify({ t: 'hello', v: 1, nonce, node }));
  };
  globalThis.fakePeer = (nonce) => {
    const peer = peers.get(nonce);
    return { offers: peer.offers, hello: Boolean(peer.hello), closed: peer.closed };
  };
  globalThis.fakeDrop = (nonce) => peers.get(nonce).pc.close();
}

const rows = (page) =>
  page.evaluate(() =>
    (document.querySelector('slicc-app').model.network.status().links?.devices ?? [])
      .map((d) => [d.id, d.host, d.address, d.state])
      .sort()
  );

const kernelFile = (page, name) =>
  page.evaluate(async (name) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return (await (await home.getFileHandle(name)).getFile()).text();
  }, name);

async function curl(page, host, name) {
  await run(
    page,
    `curl -s --noproxy '*' --max-time 10 http://${host}:8080/ > /home/${name}.txt 2>&1; echo $? > /home/${name}.done`
  );
  await page.until(async (name) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return home.getFileHandle(`${name}.done`).then(
      async (handle) => (await handle.getFile()).size > 0,
      () => false
    );
  }, name);
  return `${(await kernelFile(page, `${name}.done`)).trim()} ${(await kernelFile(page, `${name}.txt`)).trim()}`;
}

async function linked(page, nonce, want) {
  await page.until((nonce) => globalThis.fakePeer(nonce).hello, nonce);
  await page
    .until(
      (want) =>
        JSON.stringify(
          (document.querySelector('slicc-app').model.network.status().links?.devices ?? [])
            .map((d) => [d.id, d.host, d.address, d.state])
            .sort()
        ) === JSON.stringify(want),
      want
    )
    .catch(async (error) => {
      throw new Error(`${error.message}\nrows ${JSON.stringify(await rows(page))}`);
    });
  assert.deepEqual(await rows(page), want);
}

async function oldNonceIgnored(page, old, current) {
  await page.evaluate((old) => {
    globalThis.sliccLinkReceive(JSON.stringify({ t: 'answer', nonce: old, sdp: 'v=0\r\n' }));
    globalThis.sliccLinkReceive(
      JSON.stringify({
        t: 'candidate',
        nonce: old,
        candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0' },
      })
    );
    globalThis.sliccLinkReceive(JSON.stringify({ t: 'bye', nonce: old, reason: 'stale' }));
  }, old);
  const reply = await curl(page, 'fake-node.slicc.internal', `curl-${current}`);
  assert.equal(reply, `0 raw ${current}`);
  assert.deepEqual(await page.evaluate((current) => globalThis.fakePeer(current), current), {
    offers: 1,
    hello: true,
    closed: false,
  });
  const late = await page.evaluate((current) => {
    const sent = globalThis.fakeSent;
    return sent.slice(sent.findIndex(([nonce]) => nonce === current));
  }, current);
  assert.ok(
    late.every(([nonce]) => nonce !== old),
    `seven sent under the old nonce: ${JSON.stringify(late)}`
  );
}

async function stays(page) {
  await page.until(
    () => !document.querySelector('slicc-app').model.network.status().links?.devices.length
  );
  const count = () =>
    page.evaluate(() => [
      globalThis.sevenPeers.length,
      globalThis.fakeSent.filter(([, t]) => t === 'offer').length,
    ]);
  const before = await count();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.deepEqual(await count(), before, 'seven made a peer connection or offer of its own');
}

test('a local link that fails, or goes stale, is replaced by a new hello from the same node: seven offers again, the name and address stay, and the old nonce is ignored', async (t) => {
  const page = await chrome.page(t);
  await page.init(recordPeers);
  await boot(page);
  await ready(page);
  await page.evaluate(fakeNodes);
  const one = [['local:proc-a', 'fake-node.slicc.internal', '198.18.57.11', 'connected']];

  await page.evaluate(() => globalThis.fakeLink('n1', 'proc-a'));
  await linked(page, 'n1', one);
  assert.equal(await curl(page, 'fake-node.slicc.internal', 'curl-n1'), '0 raw n1');

  await page.evaluate(() => {
    const pc = globalThis.sevenPeers.at(-1);
    Object.defineProperty(pc, 'connectionState', { get: () => 'failed' });
    pc.dispatchEvent(new Event('connectionstatechange'));
  });
  await page.until(() => globalThis.fakePeer('n1').closed);
  await stays(page);
  await page.evaluate(() => globalThis.fakeLink('n2', 'proc-a'));
  await linked(page, 'n2', one);
  await oldNonceIgnored(page, 'n1', 'n2');

  await page.evaluate(() => globalThis.fakeDrop('n2'));
  await stays(page);
  await page.evaluate(() => globalThis.fakeLink('n3', 'proc-a'));
  await linked(page, 'n3', one);
  await oldNonceIgnored(page, 'n2', 'n3');

  const two = [
    ...one,
    ['local:proc-b', 'fake-node-2.slicc.internal', '198.18.57.12', 'connected'],
  ].sort();
  await page.evaluate(() => globalThis.fakeLink('b1', 'proc-b'));
  await linked(page, 'b1', two);

  await page.evaluate(() => globalThis.fakeLink('n4', 'proc-a'));
  await page.until(() => globalThis.fakePeer('n3').closed);
  await linked(page, 'n4', two);
  await oldNonceIgnored(page, 'n3', 'n4');
  assert.equal(await curl(page, 'fake-node-2.slicc.internal', 'curl-b1'), '0 raw b1');
  assert.deepEqual(
    await page.evaluate(() =>
      [...new Set(globalThis.fakeSent.filter(([, t]) => t === 'offer').map(([n]) => n))].sort()
    ),
    ['b1', 'n1', 'n2', 'n3', 'n4']
  );
  assert.equal(await page.evaluate(() => globalThis.sevenPeers.length), 5);
});
