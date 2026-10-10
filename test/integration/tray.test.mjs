import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { boot, ready, run } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

function startHub() {
  const hub = { trays: 0, sockets: [], fromLeader: [], waiters: [] };
  const server = createServer(async (request, response) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      'content-type': 'application/json',
    };
    if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();
    const url = new URL(request.url, hub.url);
    if (url.pathname === '/tray') {
      hub.trays += 1;
      const n = hub.trays;
      return response.writeHead(201, cors).end(
        JSON.stringify({
          trayId: `t${n}`,
          capabilities: {
            join: { url: `${hub.url}/join/j${n}` },
            controller: { url: `${hub.url}/controller/c${n}` },
          },
        })
      );
    }
    response.writeHead(200, cors).end(
      JSON.stringify({
        role: 'leader',
        leaderKey: 'lk',
        websocket: { url: `${hub.url.replace('http', 'ws')}${url.pathname}?leaderKey=lk` },
      })
    );
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, request) => {
    hub.sockets.push({ socket, path: request.url });
    socket.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.type === 'ping') return;
      hub.fromLeader.push(message);
      for (const wake of hub.waiters.splice(0)) wake();
    });
    socket.send(JSON.stringify({ type: 'leader.connected', trayId: 't', controllerId: 'leader' }));
  });
  hub.send = (message) => hub.sockets.at(-1).socket.send(JSON.stringify(message));
  hub.next = async (type) => {
    for (;;) {
      const found = hub.fromLeader.findIndex((m) => m.type === type);
      if (found >= 0) return hub.fromLeader.splice(found, 1)[0];
      await new Promise((resolve) => hub.waiters.push(resolve));
    }
  };
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      hub.url = `http://127.0.0.1:${server.address().port}`;
      hub.close = () => {
        sockets.close();
        server.close();
      };
      resolve(hub);
    })
  );
}

async function follower() {
  const certificate = await RTCPeerConnection.generateCertificate({
    name: 'ECDSA',
    namedCurve: 'P-256',
  });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const frame = (type, id, payload = '') => {
    const bytes = encoder.encode(payload);
    const out = new Uint8Array(5 + bytes.length);
    out[0] = type;
    new DataView(out.buffer).setUint32(1, id);
    out.set(bytes, 5);
    return out;
  };
  const log = (globalThis.followerLog = []);
  let pc = null;
  const serve = ({ channel }) => {
    channel.binaryType = 'arraybuffer';
    channel.onmessage = ({ data }) => {
      if (typeof data === 'string') {
        log.push(JSON.parse(data));
        channel.send(
          JSON.stringify({
            v: 1,
            role: 'node',
            name: 'slicc on far',
            host: 'far',
            mode: 'remote',
            caps: ['net', 'join'],
            routes: { prefixes: [], exit: true },
          })
        );
        return;
      }
      const bytes = new Uint8Array(data);
      const id = new DataView(bytes.buffer).getUint32(1);
      if (bytes[0] !== 1) return;
      const meta = JSON.parse(decoder.decode(bytes.subarray(5)));
      log.push(meta);
      if (meta.kind === 'join' || meta.kind === 'unlink') {
        channel.send(frame(2, id, '{}'));
        channel.send(frame(4, id));
      } else if (meta.kind === 'tcp') {
        channel.send(
          frame(
            2,
            id,
            JSON.stringify({ localAddr: '10.1.1.1:1', remoteAddr: `${meta.host}:${meta.port}` })
          )
        );
        channel.send(frame(3, id, 'HTTP/1.0 200 OK\r\n\r\nfrom far\n'));
        channel.send(frame(4, id));
      }
    };
  };
  globalThis.followerAccept = async (sdp) => {
    pc = new RTCPeerConnection({ certificates: [certificate] });
    pc.ondatachannel = serve;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== 'complete') {
      await new Promise((resolve) =>
        pc.addEventListener(
          'icegatheringstatechange',
          () => pc.iceGatheringState === 'complete' && resolve()
        )
      );
    }
    return pc.localDescription.sdp;
  };
  globalThis.followerCandidate = (candidate) => pc?.addIceCandidate(candidate).catch(() => {});
}

const model = (page, fn, arg) =>
  page.evaluate(
    ([fn, arg]) =>
      new Function('network', 'arg', `return (${fn})(network, arg)`)(
        document.querySelector('slicc-app').model.network,
        arg
      ),
    [fn.toString(), arg]
  );

test('seven leads a tray: a follower joins and links, rotation moves it to a new URL, unlink refuses it after', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page);
  await page.until(() => document.querySelector('slicc-app').model.network.status().links?.joinUrl);
  const links = await model(page, (network) => network.status().links);
  assert.deepEqual(links, {
    joinUrl: `${hub.url}/join/j1`,
    joinCommand: `npx sliccy ${hub.url}/join/j1 follow`,
    devices: [],
    permission: null,
  });
  assert.equal(hub.sockets[0].path, '/controller/c1?leaderKey=lk');

  await page.evaluate(follower);
  hub.send({
    type: 'follower.join_requested',
    trayId: 't1',
    controllerId: 'dev1',
    bootstrapId: 'b1',
    attempt: 1,
    runtime: 'slicc-link/1',
    iceServers: [],
  });
  const offer = await hub.next('bootstrap.offer');
  assert.deepEqual(
    [offer.controllerId, offer.bootstrapId, offer.offer.type],
    ['dev1', 'b1', 'offer']
  );
  const answer = await page.evaluate((sdp) => globalThis.followerAccept(sdp), offer.offer.sdp);
  hub.send({
    type: 'bootstrap.answer',
    trayId: 't1',
    controllerId: 'dev1',
    bootstrapId: 'b1',
    answer: { type: 'answer', sdp: answer },
  });
  const relay = setInterval(() => {
    const found = hub.fromLeader.filter((m) => m.type === 'bootstrap.ice_candidate');
    hub.fromLeader = hub.fromLeader.filter((m) => m.type !== 'bootstrap.ice_candidate');
    for (const m of found)
      page.evaluate((c) => globalThis.followerCandidate(c), m.candidate).catch(() => {});
  }, 50);
  t.after(() => clearInterval(relay));
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((d) => d.state === 'connected')
  );
  const [device] = await model(page, (network) => network.status().links.devices);
  assert.match(device.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    [device.name, device.host, device.mode, device.state, device.exit],
    ['slicc on far', 'far.slicc.internal', 'remote', 'connected', true]
  );
  assert.equal(
    (await page.evaluate(() => globalThis.followerLog[0])).name.startsWith('seven on '),
    true
  );

  await run(
    page,
    "curl -s --noproxy '*' http://far.slicc.internal:8080/ > /home/far.txt; echo $? > /home/far.done"
  );
  await page.until(async () => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return home.getFileHandle('far.done').then(
      async (h) => (await h.getFile()).size > 0,
      () => false
    );
  });
  const far = await page.evaluate(async () => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return (await (await home.getFileHandle('far.txt')).getFile()).text();
  });
  assert.equal(far.trim(), 'from far');

  await model(page, (network) => network.rotateJoinUrl());
  assert.equal(hub.trays, 2);
  assert.deepEqual(
    (await page.evaluate(() => globalThis.followerLog)).filter((m) => m.kind === 'join'),
    [{ kind: 'join', url: `${hub.url}/join/j2` }]
  );
  await page.until(() =>
    document.querySelector('slicc-app').model.network.status().links?.joinUrl?.endsWith('/j2')
  );
  assert.equal(hub.sockets.at(-1).path, '/controller/c2?leaderKey=lk');

  await model(page, (network, id) => network.unlink(id), device.id);
  assert.deepEqual((await page.evaluate(() => globalThis.followerLog)).at(-1), { kind: 'unlink' });
  assert.deepEqual(await model(page, (network) => network.status().links.devices), []);
  hub.send({
    type: 'follower.join_requested',
    trayId: 't2',
    controllerId: 'dev1-again',
    bootstrapId: 'b2',
    attempt: 1,
    runtime: 'slicc-link/1',
  });
  const reoffer = await hub.next('bootstrap.offer');
  const reanswer = await page.evaluate((sdp) => globalThis.followerAccept(sdp), reoffer.offer.sdp);
  hub.send({
    type: 'bootstrap.answer',
    trayId: 't2',
    controllerId: 'dev1-again',
    bootstrapId: 'b2',
    answer: { type: 'answer', sdp: reanswer },
  });
  const refused = await hub.next('bootstrap.failed');
  assert.deepEqual(
    [refused.controllerId, refused.code, refused.retryable],
    ['dev1-again', 'UNLINKED', false]
  );
  await page.evaluate(() => localStorage.removeItem('slicc-os.tray-hub'));
});
