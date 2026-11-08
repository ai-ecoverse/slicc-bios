import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { boot, ready, run, shows } from './bios.mjs';
import { devtools as boundPort, debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';
import { model, startHub } from './fake-hub.mjs';
import { linkNode } from './linked-node.mjs';

const NO_GRANT =
  "EACCES: browser control from this device is off; turn on Browser for it in seven's Linked devices";
const SWITCHED_OFF = "EACCES: browser control from linked devices is off in seven's settings";
const REVOKED = 'EACCES: the owner took this access back';
const STOPPED = 'ECONNRESET: stopped in seven';

const stand = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pages = {
    '/plain': '<!doctype html><title>PLAIN-MARK</title><h1>Plain</h1>',
    '/vault': '<!doctype html><title>VAULT-MARK</title><h1>VAULT-BODY-MARK</h1>',
  };
  res.writeHead(pages[url.pathname] ? 200 : 404, { 'content-type': 'text/html' });
  res.end(pages[url.pathname] ?? 'missing');
});
await new Promise((resolve) => stand.listen(0, '127.0.0.1', resolve));
const standPort = stand.address().port;
const PLAIN = `http://localhost:${standPort}/plain`;
const VAULT = `http://vault.sliccy.ai:${standPort}/vault`;
const chrome = await launch({ args: ['--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1'] });
const { port } = await boundPort(chrome);
const browserUrl = await debuggerUrl(port);
const fakeExtension = extensionOver(browserUrl);
const direct = new WebSocket(browserUrl);
await new Promise((resolve, reject) => {
  direct.onopen = resolve;
  direct.onerror = reject;
});
const answers = new Map();
let calls = 0;
direct.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  answers.get(message.id)?.(message);
  answers.delete(message.id);
};
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    calls += 1;
    answers.set(calls, (message) =>
      message.error ? reject(new Error(message.error.message)) : resolve(message.result)
    );
    direct.send(JSON.stringify({ id: calls, method, params }));
  });
after(() => {
  direct.close();
  chrome.close();
  stand.close();
});

async function cdpNode({ key, name, mode, kind = 'cli', hello = {} }) {
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
  const u32 = (n) => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n);
    return out;
  };
  const certificate =
    mode === 'local'
      ? null
      : await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
  const node = { hello: null, streams: new Map(), next: 2, credit: true, pc: null, asked: [] };
  node.fingerprint = certificate
    ?.getFingerprints()
    .find((item) => item.algorithm === 'sha-256')
    ?.value.replaceAll(':', '')
    .toLowerCase();
  globalThis.cdpNodes ??= {};
  globalThis.cdpNodes[key] = node;
  const serve = (channel) => {
    channel.binaryType = 'arraybuffer';
    channel.onmessage = ({ data }) => {
      if (typeof data === 'string') {
        node.hello = JSON.parse(data);
        channel.send(
          JSON.stringify({
            v: 1,
            role: 'node',
            name,
            host: key,
            mode: mode === 'paired' ? 'local' : mode,
            caps: [],
            ...(kind === 'seven' ? { kind: 'seven' } : {}),
            ...hello,
          })
        );
        return;
      }
      const bytes = new Uint8Array(data);
      if (bytes[0] === 1) node.asked.push(JSON.parse(new TextDecoder().decode(bytes.slice(5))));
      node.streams.get(new DataView(bytes.buffer).getUint32(1))?.receive(bytes[0], bytes.slice(5));
    };
  };
  const peer = () => {
    node.pc = new RTCPeerConnection(certificate ? { certificates: [certificate] } : {});
    node.pc.ondatachannel = ({ channel }) => serve(channel);
    return node.pc;
  };
  node.open = async (meta = { kind: 'cdp' }) => {
    const id = node.next;
    node.next += 2;
    const channel = node.pc.createDataChannel('slicc.link.v1.stream', { ordered: true });
    serve(channel);
    await new Promise((resolve) => {
      channel.onopen = resolve;
    });
    const s = { id, channel, opened: null, reset: null, ended: false, waiters: [], calls: 0 };
    s.pending = new Uint8Array(0);
    s.messages = [];
    s.receive = (type, payload) => {
      if (type === 2) s.opened = JSON.parse(decoder.decode(payload) || '{}');
      else if (type === 5) s.reset = decoder.decode(payload);
      else if (type === 4) s.ended = true;
      else if (type === 3) {
        if (node.credit) channel.send(frame(6, id, u32(payload.length)));
        const merged = new Uint8Array(s.pending.length + payload.length);
        merged.set(s.pending);
        merged.set(payload, s.pending.length);
        s.pending = merged;
        for (;;) {
          if (s.pending.length < 4) break;
          const n = new DataView(s.pending.buffer, s.pending.byteOffset).getUint32(0);
          if (s.pending.length < 4 + n) break;
          s.messages.push(JSON.parse(decoder.decode(s.pending.subarray(4, 4 + n))));
          s.pending = s.pending.slice(4 + n);
        }
      }
      for (const wake of s.waiters.splice(0)) wake();
    };
    node.streams.set(id, s);
    channel.send(frame(1, id, JSON.stringify(meta)));
    return id;
  };
  node.wait = (id, check, ms = 30000) =>
    new Promise((resolve, reject) => {
      const s = node.streams.get(id);
      const timer = setTimeout(() => {
        const { opened, reset, ended } = s;
        reject(new Error(`stream ${id}: ${JSON.stringify({ opened, reset, ended })}`));
      }, ms);
      const look = () => {
        const found = check(s);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        } else s.waiters.push(look);
      };
      look();
    });
  node.answer = (id) =>
    node.wait(id, (s) => (s.opened || s.reset) && { opened: s.opened, reset: s.reset });
  node.gone = (id) => node.wait(id, (s) => s.reset);
  node.ended = (id) => node.wait(id, (s) => s.ended);
  node.data = (id, bytes) => node.streams.get(id).channel.send(frame(3, id, bytes));
  node.send = (id, message) => {
    const body = encoder.encode(JSON.stringify(message));
    const out = new Uint8Array(4 + body.length);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set(body, 4);
    node.data(id, out);
  };
  node.call = (id, method, params = {}, sessionId) => {
    const s = node.streams.get(id);
    s.calls += 1;
    const call = s.calls;
    node.send(id, { id: call, method, params, ...(sessionId ? { sessionId } : {}) });
    return node.wait(id, (state) => state.messages.find((m) => m.id === call));
  };
  node.end = (id) => node.streams.get(id).channel.send(frame(4, id));
  node.accept = async (sdp) => {
    const pc = peer();
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== 'complete')
      await new Promise((resolve) =>
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') resolve();
        })
      );
    return pc.localDescription.sdp;
  };
  node.candidate = (candidate) => node.pc?.addIceCandidate(candidate).catch(() => {});
  if (mode !== 'local') return;
  const pc = peer();
  const nonce = `${key}-nonce`;
  pc.onicecandidate = ({ candidate }) =>
    globalThis.sliccLinkReceive(
      JSON.stringify({ t: 'candidate', nonce, candidate: candidate?.toJSON() ?? null })
    );
  globalThis.cdpSignals ??= new Map();
  globalThis.sliccLinkSend = (text) => {
    const message = JSON.parse(text);
    globalThis.cdpSignals.get(message.nonce)?.(message);
  };
  globalThis.cdpSignals.set(nonce, async (message) => {
    if (message.t === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      globalThis.sliccLinkReceive(
        JSON.stringify({ t: 'answer', nonce, sdp: pc.localDescription.sdp })
      );
    } else if (message.t === 'candidate' && message.candidate) {
      await pc.addIceCandidate(message.candidate).catch(() => {});
    }
  });
  globalThis.sliccLinkReceive(JSON.stringify({ t: 'hello', v: 1, nonce, node: key }));
}

const on = (page, key, method, ...args) =>
  page.evaluate(
    ([key, method, args]) => globalThis.cdpNodes[key][method](...args),
    [key, method, args]
  );

const items = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.live.items()
      .filter((item) => item.kind === 'cdp')
      .map(({ id, kind, label, what, asker, action }) => ({ id, kind, label, what, asker, action }))
  );

async function awaitState(what, look, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const seen = await look();
    if (seen.ok) return seen;
    if (Date.now() >= end) assert.fail(`waited ${ms} ms for ${what}; saw ${JSON.stringify(seen)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function holds(what, look, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const seen = await look();
    if (!seen.ok)
      assert.fail(
        `${what} stopped holding after ${Date.now() - start} ms; saw ${JSON.stringify(seen)}`
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const setSwitch = (page, value) =>
  page.evaluate(
    (value) => document.querySelector('slicc-app').model.switches.set('remote-browser', value),
    value
  );

async function join(page, hub, { key, name, controllerId, runtime, hello = {} }) {
  await page.evaluate(cdpNode, {
    key,
    name,
    mode: 'remote',
    hello,
    kind: runtime === 'slicc-seven/1' ? 'seven' : 'cli',
  });
  hub.send({
    type: 'follower.join_requested',
    trayId: 't1',
    controllerId,
    bootstrapId: `b-${controllerId}`,
    attempt: 1,
    runtime,
    iceServers: [],
  });
  const offer = await hub.next('bootstrap.offer');
  const sdp = await on(page, key, 'accept', offer.offer.sdp);
  hub.send({
    type: 'bootstrap.answer',
    trayId: 't1',
    controllerId,
    bootstrapId: `b-${controllerId}`,
    answer: { type: 'answer', sdp },
  });
  await page.within(60000, (key) => globalThis.cdpNodes[key].hello !== null, key);
  return page.evaluate(
    (name) =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links.devices.find((item) => item.name === name && item.state === 'connected')?.id,
    name
  );
}

test('a local CLI link drives an ordinary tab over a cdp stream, through the guard that keeps seven and the vault out', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  await ready(page);
  const own = new URL(chrome.url).origin;
  const { targetId: vaultTab } = await cdp('Target.createTarget', { url: VAULT });
  t.after(() => cdp('Target.closeTarget', { targetId: vaultTab }).catch(() => {}));
  await cdp('Storage.setCookies', {
    cookies: [
      { name: 'vaultc', value: 'VAULT-COOKIE', url: `http://vault.sliccy.ai:${standPort}/` },
      { name: 'plainc', value: 'PLAIN-COOKIE', url: `http://localhost:${standPort}/` },
    ],
  });
  const { targetInfos } = await cdp('Target.getTargets');
  const sevenTab = targetInfos.find((info) => info.type === 'page' && info.url.startsWith(own));

  await page.evaluate(cdpNode, { key: 'near', name: 'slicc on near', mode: 'local' });
  await page.within(60000, () => globalThis.cdpNodes.near.hello !== null);
  const hello = await page.evaluate(() => globalThis.cdpNodes.near.hello);
  assert.ok(hello.caps.includes('cdp-in'), JSON.stringify(hello.caps));

  const id = await on(page, 'near', 'open');
  const { opened, reset } = await on(page, 'near', 'answer', id);
  assert.equal(reset, null);
  assert.equal(typeof opened.version.product, 'string');
  assert.deepEqual(opened.version.slicc, { route: 'extension' });

  const { result: created } = await on(page, 'near', 'call', id, 'Target.createTarget', {
    url: PLAIN,
  });
  t.after(() => cdp('Target.closeTarget', { targetId: created.targetId }).catch(() => {}));
  const { result: attached } = await on(page, 'near', 'call', id, 'Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;
  const title = await page.within(
    30000,
    async ([id, sessionId]) => {
      const answer = await globalThis.cdpNodes.near.call(
        id,
        'Runtime.evaluate',
        { expression: 'document.title', returnByValue: true },
        sessionId
      );
      return answer.result?.result?.value === 'PLAIN-MARK' && answer.result.result.value;
    },
    [id, sessionId]
  );
  assert.equal(title, 'PLAIN-MARK');

  const own2 = await page.evaluate(async (id) => {
    const node = globalThis.cdpNodes.near;
    node.send(id, { id: -2, method: 'Browser.getVersion' });
    return node.wait(id, (s) => s.messages.find((message) => message.id === -2));
  }, id);
  assert.equal(typeof own2.result.product, 'string');
  assert.deepEqual(own2.result.slicc, { route: 'extension' });

  const { result: listed } = await on(page, 'near', 'call', id, 'Target.getTargets');
  const urls = listed.targetInfos.map((info) => info.url);
  assert.ok(urls.includes(PLAIN), JSON.stringify(urls));
  assert.equal(
    urls.some((url) => url.includes('/vault') || url.includes('/os/')),
    false,
    JSON.stringify(urls)
  );
  for (const targetId of [vaultTab, sevenTab.targetId]) {
    const refused = await on(page, 'near', 'call', id, 'Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    assert.ok(refused.error, JSON.stringify(refused));
  }
  const { result: jar } = await on(page, 'near', 'call', id, 'Storage.getCookies');
  const names = jar.cookies.map((cookie) => cookie.name);
  assert.ok(names.includes('plainc'), JSON.stringify(names));
  assert.equal(names.includes('vaultc'), false);

  const [chip] = await items(page);
  assert.deepEqual(
    { ...chip, id: undefined },
    {
      id: undefined,
      kind: 'cdp',
      label: 'Driving this browser',
      what: '',
      asker: 'SLICC on near',
      action: { label: 'Stop' },
    }
  );

  await on(page, 'near', 'end', id);
  await on(page, 'near', 'ended', id);

  const big = await on(page, 'near', 'open');
  await on(page, 'near', 'answer', big);
  const header = new Uint8Array([4, 0, 0, 1, 0x7b]);
  await page.evaluate(
    ([id, bytes]) => globalThis.cdpNodes.near.data(id, new Uint8Array(bytes)),
    [big, [...header]]
  );
  assert.match(await on(page, 'near', 'gone', big), /^EMSGSIZE/);

  const slow = await on(page, 'near', 'open');
  await on(page, 'near', 'answer', slow);
  const { result: again } = await on(page, 'near', 'call', slow, 'Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true,
  });
  await page.evaluate(
    ([id, sessionId]) => {
      const node = globalThis.cdpNodes.near;
      node.credit = false;
      for (let n = 0; n < 10; n += 1)
        node.send(id, {
          id: 100 + n,
          method: 'Runtime.evaluate',
          params: { expression: "'x'.repeat(8 * 1024 * 1024)", returnByValue: true },
          sessionId,
        });
    },
    [slow, again.sessionId]
  );
  assert.match(await on(page, 'near', 'gone', slow, 120000), /^ENOBUFS/);
  await page.evaluate(() => {
    globalThis.cdpNodes.near.credit = true;
  });

  const cut = await on(page, 'near', 'open');
  await on(page, 'near', 'answer', cut);
  await page.evaluate(
    ([id, bytes]) => globalThis.cdpNodes.near.data(id, new Uint8Array(bytes)),
    [cut, [0, 0, 0, 10, 0x7b, 0x22, 0x69]]
  );
  await on(page, 'near', 'end', cut);
  assert.match(await on(page, 'near', 'gone', cut), /^EPROTO/);

  const sixteen = [];
  for (let n = 0; n < 16; n += 1) {
    const each = await on(page, 'near', 'open');
    assert.equal((await on(page, 'near', 'answer', each)).reset, null);
    sixteen.push(each);
  }
  const extra = await on(page, 'near', 'open');
  assert.deepEqual(await on(page, 'near', 'answer', extra), {
    opened: null,
    reset: 'EMFILE: too many browser connections from this device',
  });
  for (const each of sixteen) await on(page, 'near', 'end', each);
});

test('a remote CLI over the tray needs its Browser grant; the switch, Stop and revoking reset its streams and take the chip at once, and a stream that ends on its own leaves it for 5 s', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const page = await chrome.page(t);
  const slow = {};
  const extension = await fakeExtension(page, { slow });
  t.after(extension.close);
  await boot(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page);
  await page.until(() => document.querySelector('slicc-app').model.network.status().links?.joinUrl);
  const relay = setInterval(() => {
    const found = hub.fromLeader.filter((m) => m.type === 'bootstrap.ice_candidate');
    hub.fromLeader = hub.fromLeader.filter((m) => m.type !== 'bootstrap.ice_candidate');
    for (const m of found) {
      const key = m.controllerId === 'dev-seven' ? 'other' : 'far';
      page
        .evaluate(([key, c]) => globalThis.cdpNodes[key]?.candidate(c), [key, m.candidate])
        .catch(() => {});
    }
  }, 50);
  t.after(() => clearInterval(relay));

  const device = await join(page, hub, {
    key: 'far',
    name: 'slicc on far',
    controllerId: 'dev-far',
    runtime: 'slicc-link/1',
  });
  assert.match(device, /^[0-9a-f]{64}$/);
  const hello = await page.evaluate(() => globalThis.cdpNodes.far.hello);
  assert.ok(hello.caps.includes('cdp-in'), JSON.stringify(hello.caps));
  const row = async () =>
    (await model(page, (network) => network.status().links.devices)).find(
      (item) => item.id === device
    );
  assert.deepEqual((await row()).access, { control: false, browser: false });

  const denied = await on(page, 'far', 'open');
  assert.deepEqual(await on(page, 'far', 'answer', denied), { opened: null, reset: NO_GRANT });
  await setSwitch(page, false);
  const off = await on(page, 'far', 'open');
  assert.deepEqual(await on(page, 'far', 'answer', off), { opened: null, reset: SWITCHED_OFF });
  await setSwitch(page, true);

  await model(page, (network, id) => network.setAccess(id, 'browser', true), device);
  assert.deepEqual((await row()).access, { control: false, browser: true });
  await page.evaluate(() =>
    document.querySelector('slicc-app').shadowRoot.querySelector('[data-network]').click()
  );
  const shown = await page.within(
    30000,
    (id) => {
      const item = document
        .querySelector('slicc-app')
        .dock.content('network')
        ?.shadowRoot?.querySelector(`li[data-device="${id}"]`);
      const toggle = item?.querySelector('[data-action="access-browser"]');
      if (!toggle) return false;
      item.scrollIntoView({ block: 'center' });
      return { label: toggle.textContent.trim(), checked: toggle.checked };
    },
    device
  );
  assert.deepEqual(shown, { label: 'Browser', checked: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      const app = document.querySelector('slicc-app');
      if (app.color !== value) app.toggleColor();
    }, theme);
    await page.until((value) => document.querySelector('slicc-app').color === value, theme);
    await page.screenshot(new URL(`linked-devices-browser-${theme}.png`, page.dir));
  }
  const first = await on(page, 'far', 'open');
  const answered = await on(page, 'far', 'answer', first);
  assert.equal(answered.reset, null);
  assert.deepEqual(answered.opened.version.slicc, { route: 'extension' });
  const version = await on(page, 'far', 'call', first, 'Browser.getVersion');
  assert.equal(typeof version.result.product, 'string');
  const [chip] = await items(page);
  assert.equal(chip.asker, 'SLICC on far');

  await page.evaluate((id) => document.querySelector('slicc-app').model.live.act(id), chip.id);
  assert.equal(await on(page, 'far', 'gone', first), STOPPED);
  assert.deepEqual(await items(page), []);

  const second = await on(page, 'far', 'open');
  await on(page, 'far', 'answer', second);
  const [after] = await items(page);
  assert.equal(after.asker, 'SLICC on far');
  assert.notEqual(after.id, chip.id);
  await model(page, (network, id) => network.setAccess(id, 'browser', false), device);
  assert.equal(await on(page, 'far', 'gone', second), REVOKED);
  assert.deepEqual(await items(page), []);
  await model(page, (network, id) => network.setAccess(id, 'browser', true), device);

  slow['Browser.getVersion'] = 3000;
  const versions = () => extension.sent.filter((method) => method === 'Browser.getVersion').length;
  const before = versions();
  const opening = await on(page, 'far', 'open');
  await awaitState(
    'seven to send the held Browser.getVersion for the opening stream',
    async () => ({
      ok: versions() > before,
      versions: versions(),
      before,
      stream: await page.evaluate((id) => {
        const { opened, reset } = globalThis.cdpNodes.far.streams.get(id);
        return { opened, reset };
      }, opening),
      last: extension.sent.slice(-5),
    })
  );
  await model(page, (network, id) => network.setAccess(id, 'browser', false), device);
  assert.deepEqual(await on(page, 'far', 'answer', opening), { opened: null, reset: REVOKED });
  delete slow['Browser.getVersion'];
  await holds(
    'no chip and no OPENED for the revoked stream while its held version answer arrives',
    async () => {
      const list = await items(page);
      const opened = await page.evaluate(
        (id) => globalThis.cdpNodes.far.streams.get(id).opened,
        opening
      );
      return { ok: list.length === 0 && opened === null, items: list, opened };
    },
    3500
  );
  await model(page, (network, id) => network.setAccess(id, 'browser', true), device);

  const third = await on(page, 'far', 'open');
  await on(page, 'far', 'answer', third);
  assert.equal((await items(page)).length, 1);
  await setSwitch(page, false);
  assert.equal(await on(page, 'far', 'gone', third), SWITCHED_OFF);
  assert.deepEqual(await items(page), []);
  const blocked = await on(page, 'far', 'open');
  assert.equal((await on(page, 'far', 'answer', blocked)).reset, SWITCHED_OFF);
  await setSwitch(page, true);

  const last = await on(page, 'far', 'open');
  await on(page, 'far', 'answer', last);
  assert.equal((await items(page)).length, 1);
  await on(page, 'far', 'end', last);
  await on(page, 'far', 'ended', last);
  const ended = Date.now();
  await holds(
    'the chip lingering for 3 s after the END',
    async () => {
      const list = await items(page);
      return { ok: list.length === 1, items: list, since: Date.now() - ended };
    },
    3000
  );
  await page.within(15000, () =>
    document
      .querySelector('slicc-app')
      .model.live.items()
      .every((item) => item.kind !== 'cdp')
  );
  assert.ok(Date.now() - ended >= 4500, `${Date.now() - ended} ms`);

  const lingering = await on(page, 'far', 'open');
  await on(page, 'far', 'answer', lingering);
  await on(page, 'far', 'end', lingering);
  await on(page, 'far', 'ended', lingering);
  assert.equal((await items(page)).length, 1);
  await model(page, (network, id) => network.setAccess(id, 'browser', false), device);
  assert.deepEqual(await items(page), []);
  await model(page, (network, id) => network.setAccess(id, 'browser', true), device);

  const streaming = await on(page, 'far', 'open');
  await on(page, 'far', 'answer', streaming);
  assert.equal((await items(page)).length, 1);
  await model(page, (network, id) => network.unlink(id), device);
  assert.equal(await on(page, 'far', 'gone', streaming), REVOKED);
  assert.deepEqual(await items(page), []);

  const seven = await join(page, hub, {
    key: 'other',
    name: 'seven elsewhere',
    controllerId: 'dev-seven',
    runtime: 'slicc-seven/1',
  });
  assert.ok(seven);
  const sevenHello = await page.evaluate(() => globalThis.cdpNodes.other.hello);
  assert.equal((sevenHello.caps ?? []).includes('cdp-in'), false, JSON.stringify(sevenHello));
  const refused = await on(page, 'other', 'open');
  assert.match((await on(page, 'other', 'answer', refused)).reset, /^EACCES/);
});

test('a device never reaches another linked computer’s browser: without the extension, a DevTools port or a local seven: true browser, its cdp OPEN is ENOENT, even when a remote link claims seven: true', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page);
  await page.until(() => document.querySelector('slicc-app').model.network.status().links?.joinUrl);
  const relay = setInterval(() => {
    const found = hub.fromLeader.filter((m) => m.type === 'bootstrap.ice_candidate');
    hub.fromLeader = hub.fromLeader.filter((m) => m.type !== 'bootstrap.ice_candidate');
    for (const m of found)
      page.evaluate((c) => globalThis.cdpNodes.liar?.candidate(c), m.candidate).catch(() => {});
  }, 50);
  t.after(() => clearInterval(relay));
  const liar = await join(page, hub, {
    key: 'liar',
    name: 'slicc on liar',
    controllerId: 'dev-liar',
    runtime: 'slicc-link/1',
    hello: {
      caps: ['cdp'],
      version: '1.50.0',
      browsers: [{ id: 'chrome', name: 'Chrome', version: '140', seven: true }],
    },
  });
  assert.ok(liar);
  await page.evaluate(cdpNode, {
    key: 'sharer',
    name: 'slicc on sharer',
    mode: 'local',
    hello: {
      caps: ['cdp'],
      version: '1.50.0',
      browsers: [{ id: 'chrome', name: 'Chrome', version: '140' }],
    },
  });
  const shared = await page.within(60000, () => {
    const rows = document.querySelector('slicc-app').model.network.status().links?.devices ?? [];
    const runtimes = rows.flatMap((row) => (row.browsers ?? []).map((item) => item.runtime));
    return runtimes.length > 1 && runtimes.sort();
  });
  assert.deepEqual(shared, ['liar/chrome', 'sharer/chrome']);
  await page.evaluate(cdpNode, { key: 'asker', name: 'slicc on asker', mode: 'local' });
  await page.within(60000, () => globalThis.cdpNodes.asker.hello !== null);
  const id = await on(page, 'asker', 'open');
  assert.deepEqual(await on(page, 'asker', 'answer', id), {
    opened: null,
    reset:
      'ENOENT: no browser to drive: install slicc-extension, or link a computer with npx sliccy@next',
  });
  assert.deepEqual(await items(page), []);
  const asked = await page.evaluate(() => [
    ...globalThis.cdpNodes.liar.asked,
    ...globalThis.cdpNodes.sharer.asked,
  ]);
  assert.equal(
    asked.some((meta) => meta.kind === 'cdp'),
    false,
    JSON.stringify(asked)
  );
});

async function pairEndpoint(t, page, key) {
  const token = randomBytes(16).toString('base64url');
  const posts = [];
  const server = createServer(async (request, response) => {
    const cors = {
      'access-control-allow-origin': request.headers.origin ?? '*',
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-private-network': 'true',
      vary: 'origin',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      return response.end();
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    posts.push(request.url);
    if (request.url !== '/slicc/v1/pair' || body.token !== token) {
      response.writeHead(403, cors);
      return response.end('{}');
    }
    const answer = await page.evaluate(
      ([key, sdp]) => globalThis.cdpNodes[key].accept(sdp),
      [key, body.offer]
    );
    response.writeHead(200, { ...cors, 'content-type': 'application/json' });
    response.end(JSON.stringify({ answer, name: 'slicc on paired' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: server.address().port, token, posts };
}

test('a computer linked only with slicc open or slicc pair is told to link with the join URL: its cdp and agent OPENs get the paired-only refusals', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  await page.evaluate(cdpNode, { key: 'paired', name: 'slicc on paired', mode: 'paired' });
  const fingerprint = await page.evaluate(() => globalThis.cdpNodes.paired.fingerprint);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  const { port, token, posts } = await pairEndpoint(t, page, 'paired');
  const text = `#slicc-pair=${port}.${token}.${fingerprint}`;
  await model(page, (network, text) => network.pairComputer(text), text);
  await page.within(30000, () => {
    const state = document.querySelector('slicc-app').model.network.status().links?.pairing?.state;
    return state === 'confirm' && state;
  });
  await model(page, (network) => network.confirmPairing());
  await awaitState('the paired node to get seven’s HELLO', async () => {
    const hello = await page.evaluate(() => globalThis.cdpNodes.paired.hello);
    return { ok: hello !== null, hello, posts };
  });
  const hello = await page.evaluate(() => globalThis.cdpNodes.paired.hello);
  assert.ok(hello.caps.includes('cdp-in'), JSON.stringify(hello.caps));
  assert.equal(hello.caps.includes('agent'), false, JSON.stringify(hello.caps));

  const browser = await on(page, 'paired', 'open');
  assert.deepEqual(await on(page, 'paired', 'answer', browser), {
    opened: null,
    reset:
      "EACCES: a computer linked with slicc open or slicc pair can't drive this browser yet; link it with seven's join URL instead",
  });
  const agent = await on(page, 'paired', 'open', { kind: 'agent', op: 'watch' });
  assert.deepEqual(await on(page, 'paired', 'answer', agent), {
    opened: null,
    reset:
      "EACCES: a computer linked with slicc open or slicc pair can't control the agent yet; link it with seven's join URL instead",
  });
  assert.deepEqual(await items(page), []);
});

test('with only a linked slicc browser, the Browser panel lists an agent-driven tab and screenshots it', async (t) => {
  const page = await chrome.page(t);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await boot(page);
  await ready(page);
  await linkNode(t, page, port);
  await page.until(
    () => document.querySelector('slicc-app').model.network.status().browser.via === 'link'
  );
  chrome.overrides.set(
    '/panel-link.html',
    '<!doctype html><title>Panel link</title><h1>Panel through link</h1>'
  );
  const target = new URL('/panel-link.html', chrome.url);
  target.hostname = 'localhost';
  await run(page, `playwright-cli open ${target.href} && echo opened-$?`);
  await shows(page, 'opened-0');
  const tabs = await page
    .within(
      30000,
      (wanted) => {
        const listed = document
          .querySelector('slicc-app')
          .model.browser.list()
          .filter((tab) => tab.url === wanted);
        return listed.length > 0 && listed;
      },
      target.href
    )
    .catch(async (error) => {
      const seen = await page.evaluate(() => ({
        via: document.querySelector('slicc-app').model.network.status().browser,
        tabs: document.querySelector('slicc-app').model.browser.list(),
        owned: sessionStorage.getItem('slicc-os.browser.tabs'),
      }));
      throw new Error(`${error.message}; saw ${JSON.stringify(seen)}`);
    });
  assert.equal(tabs[0].url, target.href, JSON.stringify(tabs));
  const shot = await page
    .evaluate((id) => document.querySelector('slicc-app').model.browser.screenshot(id), tabs[0].id)
    .catch((error) => {
      throw new Error(`screenshot failed: ${error.message}; tab ${JSON.stringify(tabs[0])}`);
    });
  assert.match(shot, /^data:image\/jpeg;base64,\/9j\//, shot.slice(0, 64));
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
});
