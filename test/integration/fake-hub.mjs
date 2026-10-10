import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export function startHub() {
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

export async function follower() {
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
  globalThis.followerClose = () => pc?.close();
  globalThis.followerCandidate = (candidate) => pc?.addIceCandidate(candidate).catch(() => {});
}

export const model = (page, fn, arg) =>
  page.evaluate(
    ([fn, arg]) =>
      new Function('network', 'arg', `return (${fn})(network, arg)`)(
        document.querySelector('slicc-app').model.network,
        arg
      ),
    [fn.toString(), arg]
  );
