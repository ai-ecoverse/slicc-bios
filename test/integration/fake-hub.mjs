import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

function bootstraps(hub) {
  const all = new Map();
  let made = 0;
  const status = (b) => ({
    controllerId: b.controllerId,
    bootstrapId: b.bootstrapId,
    attempt: 1,
    state: b.state,
    cursor: b.events.length,
    maxRetries: 0,
    retriesRemaining: 0,
    retryAfterMs: null,
    failure: b.failure,
  });
  const leader = (token) => hub.sockets.findLast((s) => s.path.startsWith(`/controller/c${token}`));
  hub.attaches = [];
  return {
    fromLeader(message) {
      const b = all.get(message.bootstrapId);
      if (!b) return;
      if (message.type === 'bootstrap.offer') {
        b.state = 'offered';
        b.events.push({ type: 'bootstrap.offer', offer: message.offer });
      } else if (message.type === 'bootstrap.ice_candidate') {
        b.events.push({ type: 'bootstrap.ice_candidate', candidate: message.candidate });
      } else if (message.type === 'bootstrap.failed') {
        b.state = 'failed';
        b.failure = { code: message.code, message: message.message, retryable: false };
      }
    },
    follow(token, body) {
      if (Number(token) < 1 || Number(token) > hub.trays)
        return {
          code: 'INVALID_JOIN_CAPABILITY',
          error: 'The tray hub knows no such join capability.',
        };
      const tray = { trayId: `t${token}`, controllerId: body.controllerId, role: 'follower' };
      const socket = leader(token);
      if (!body.action) {
        hub.attaches.push(body);
        if (socket?.socket.readyState !== 1) {
          return {
            ...tray,
            result: { action: 'wait', code: 'LEADER_NOT_CONNECTED', retryAfterMs: 200 },
          };
        }
        made += 1;
        const b = {
          controllerId: body.controllerId,
          bootstrapId: `fb${made}`,
          state: 'pending',
          events: [],
          failure: null,
          socket,
        };
        all.set(b.bootstrapId, b);
        socket.socket.send(
          JSON.stringify({
            type: 'follower.join_requested',
            trayId: tray.trayId,
            controllerId: b.controllerId,
            runtime: body.runtime,
            bootstrapId: b.bootstrapId,
            attempt: 1,
            iceServers: [],
          })
        );
        return {
          ...tray,
          result: { action: 'signal', code: 'LEADER_CONNECTED', bootstrap: status(b) },
        };
      }
      const b = all.get(body.bootstrapId);
      if (!b) return { code: 'BOOTSTRAP_NOT_FOUND', error: 'no such bootstrap' };
      const to = (message) =>
        b.socket.socket.send(
          JSON.stringify({
            ...message,
            trayId: tray.trayId,
            controllerId: b.controllerId,
            bootstrapId: b.bootstrapId,
          })
        );
      if (body.action === 'answer') {
        if (b.state !== 'failed') b.state = 'connected';
        to({ type: 'bootstrap.answer', answer: body.answer });
      } else if (body.action === 'ice-candidate') {
        to({ type: 'bootstrap.ice_candidate', candidate: body.candidate });
      }
      const cursor = body.cursor ?? 0;
      const events = b.events
        .map((event, i) => ({ ...event, sequence: i + 1 }))
        .filter((event) => event.sequence > cursor);
      return { ...tray, bootstrap: status(b), events: body.action === 'poll' ? events : [] };
    },
  };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    return {};
  }
}

export function startHub() {
  const hub = { trays: 0, sockets: [], fromLeader: [], waiters: [] };
  const followers = bootstraps(hub);
  const server = createServer(async (request, response) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      'content-type': 'application/json',
    };
    if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();
    const url = new URL(request.url, hub.url);
    const joining = /^\/join\/j(\d+)$/.exec(url.pathname);
    if (joining) {
      const answer = followers.follow(joining[1], await body(request));
      return response.writeHead(answer.role ? 200 : 404, cors).end(JSON.stringify(answer));
    }
    if (url.pathname === '/tray') {
      hub.trays += 1;
      const n = hub.trays;
      return response.writeHead(201, cors).end(
        JSON.stringify({
          trayId: `t${n}`,
          capabilities: {
            join: { url: `${hub.url}/join/j${n}` },
            controller: { url: `${hub.url}/controller/c${n}` },
            webhook: { url: `${hub.url}/webhook/w${n}` },
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
      followers.fromLeader(message);
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

export async function leader(hubUrl) {
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
  const post = async (url, body) =>
    (
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
  const tray = await post(`${hubUrl}/tray`, {});
  const claim = await post(tray.capabilities.controller.url, {
    controllerId: 'fake-leader',
    runtime: 'slicc-seven/1',
  });
  const socket = new WebSocket(claim.websocket.url);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  const state = {
    joinUrl: tray.capabilities.join.url,
    runtimes: [],
    hello: null,
    opens: [],
    resets: [],
  };
  const waiting = new Map();
  let next = 1;
  let pc = null;
  let control = null;
  const serve = (channel) => {
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') {
        state.hello = JSON.parse(data);
        return;
      }
      const bytes = new Uint8Array(data);
      const id = new DataView(bytes.buffer).getUint32(1);
      const payload = decoder.decode(bytes.subarray(5));
      if (bytes[0] === 1) {
        const meta = JSON.parse(payload);
        state.opens.push(meta);
        channel.send(
          frame(2, id, JSON.stringify(meta.op === 'abort' ? { aborted: false } : { head: 'h0' }))
        );
        if (meta.op === 'abort') channel.send(frame(4, id));
      } else if (bytes[0] === 2 || bytes[0] === 5) {
        if (bytes[0] === 5 && id % 2 === 0) state.resets.push(payload);
        waiting.get(id)?.(bytes[0] === 2 ? 'opened' : payload);
      }
    });
  };
  const handle = async (message) => {
    const ids = { controllerId: message.controllerId, bootstrapId: message.bootstrapId };
    if (message.type === 'follower.join_requested') {
      pc?.close();
      pc = new RTCPeerConnection();
      state.runtimes.push(message.runtime);
      pc.addEventListener('icecandidate', ({ candidate }) => {
        if (candidate)
          socket.send(
            JSON.stringify({
              type: 'bootstrap.ice_candidate',
              ...ids,
              candidate: candidate.toJSON(),
            })
          );
      });
      pc.addEventListener('datachannel', ({ channel }) => serve(channel));
      control = pc.createDataChannel('slicc.link.v1', { ordered: true });
      serve(control);
      control.addEventListener('open', () =>
        control.send(
          JSON.stringify({
            v: 1,
            role: 'page',
            name: 'a fake leader',
            mode: 'remote',
            caps: ['agent'],
          })
        )
      );
      await pc.setLocalDescription(await pc.createOffer());
      socket.send(
        JSON.stringify({
          type: 'bootstrap.offer',
          ...ids,
          offer: { type: 'offer', sdp: pc.localDescription.sdp },
        })
      );
    } else if (message.type === 'bootstrap.answer') {
      await pc.setRemoteDescription(message.answer);
    } else if (message.type === 'bootstrap.ice_candidate') {
      await pc.addIceCandidate(message.candidate).catch(() => {});
    }
  };
  let queue = Promise.resolve();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    queue = queue.then(() => handle(message)).catch(() => {});
  });
  state.open = (meta) =>
    new Promise((resolve) => {
      const id = next;
      next += 2;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(`no answer to OPEN ${JSON.stringify(meta)} within 10 s`);
      }, 10000);
      waiting.set(id, (answer) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(answer);
      });
      control.send(frame(1, id, JSON.stringify(meta)));
    });
  globalThis.fakeLeader = state;
  return state.joinUrl;
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
