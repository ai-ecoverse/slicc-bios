import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { devtools, launch } from './chrome.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let serial = 0;
const server = createServer((request, response) => {
  const mark = ++serial;
  const slow = request.url.startsWith('/slow');
  const send = () => {
    response.writeHead(200, {
      'content-type': 'text/html',
      'cache-control': 'no-store',
    });
    response.end(`<!doctype html><title>${request.url}</title><p id="mark">${mark}</p>`);
  };
  if (slow) setTimeout(send, 15000);
  else send();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const base = `http://ordinary.example.test:${server.address().port}`;
const other = `http://other.example.test:${server.address().port}`;
const chrome = await launch({
  tools: false,
  args: ['--host-resolver-rules=MAP *.example.test 127.0.0.1'],
});
after(() => chrome.close());
const { browser } = await devtools(chrome);
const log = (label, value) => console.log(`PROBE ${label} ${JSON.stringify(value)}`);

async function client(name) {
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map();
  const events = [];
  let next = 0;
  let order = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    message.order = ++order;
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else
      events.push({
        order: message.order,
        method: message.method,
        sessionId: message.sessionId,
        params: message.params,
      });
  };
  const send = (method, params = {}, sessionId, ms = 5000) =>
    new Promise((resolve) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ timeout: true });
      }, ms);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(message);
      });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        })
      );
    });
  const attach = async (targetId) =>
    (await send('Target.attachToTarget', { targetId, flatten: true })).result?.sessionId;
  return { name, send, attach, events, close: () => socket.close() };
}

const brief = (method, answer) => {
  if (answer.timeout) return 'TIMEOUT';
  if (answer.error) return { error: answer.error.message };
  const r = answer.result ?? {};
  if (method === 'Page.getFrameTree')
    return {
      url: r.frameTree?.frame?.url,
      loaderId: r.frameTree?.frame?.loaderId,
    };
  if (method === 'Page.getResourceTree')
    return {
      url: r.frameTree?.frame?.url,
      loaderId: r.frameTree?.frame?.loaderId,
    };
  if (method === 'Page.getNavigationHistory')
    return {
      currentIndex: r.currentIndex,
      entries: r.entries?.map((e) => [e.id, e.url]),
    };
  if (method === 'Target.getTargetInfo')
    return { url: r.targetInfo?.url, attached: r.targetInfo?.attached };
  if (method === 'Runtime.evaluate') return { value: r.result?.value };
  return 'answered';
};

const evts = (c, sessionId) =>
  c.events
    .filter((e) => e.sessionId === sessionId || e.sessionId === undefined)
    .map((e) => [
      e.order,
      e.method,
      e.params?.frame?.loaderId ?? e.params?.loaderId ?? '',
      e.params?.url ?? e.params?.frame?.url ?? e.params?.targetInfo?.url ?? '',
      e.params?.navigationType ?? '',
    ])
    .filter(([, m]) => /^(Page|Target)\./.test(m));

async function mark(targetId) {
  const c = await client('reader');
  try {
    const s = await c.attach(targetId);
    const a = await c.send(
      'Runtime.evaluate',
      {
        expression: 'document.getElementById("mark")?.textContent',
        returnByValue: true,
      },
      s
    );
    const t = await c.send('Page.getFrameTree', {}, s);
    return {
      mark: a.result?.result?.value ?? a,
      loaderId: t.result?.frameTree?.frame?.loaderId,
    };
  } finally {
    c.close();
  }
}

async function freeze(targetId) {
  const a = await client('opener');
  const s = await a.attach(targetId);
  await a.send('Page.enable', {}, s);
  const tree = await a.send('Page.getFrameTree', {}, s);
  await a.send('Runtime.evaluate', { expression: 'setTimeout(() => alert("held"), 50), 1' }, s);
  await pause(800);
  return { a, recorded: tree.result?.frameTree?.frame?.loaderId };
}

const READS = [
  'Page.getFrameTree',
  'Page.getResourceTree',
  'Page.getNavigationHistory',
  'Runtime.evaluate',
];

async function survey(c, targetId, s) {
  const setup = ['Fetch.enable', 'Network.enable', 'Page.enable'].map((m) => c.send(m, {}, s));
  const reads = READS.map((m) =>
    c.send(m, m === 'Runtime.evaluate' ? { expression: '1', returnByValue: true } : {}, s)
  );
  const info = c.send('Target.getTargetInfo', { targetId });
  const out = {};
  const all = await Promise.all([...setup, ...reads, info]);
  ['Fetch.enable', 'Network.enable', 'Page.enable', ...READS, 'Target.getTargetInfo'].forEach(
    (m, i) => {
      out[m] = brief(m, all[i]);
    }
  );
  return out;
}

test('probe: commands on a frozen tab, and a loaderId-pinned reload', {
  timeout: 300000,
}, async () => {
  log('browser', (await chrome.cdp.send('Browser.getVersion')).product);
  const targetId = (await chrome.cdp.send('Target.createTarget', { url: `${base}/form` })).targetId;
  await pause(1500);
  log('before', await mark(targetId));
  const { a, recorded } = await freeze(targetId);
  log('recorded-before-freeze', recorded);
  const b = await client('fresh');
  const s = await b.attach(targetId);
  log('fresh-session', Boolean(s));
  log('survey-frozen', await survey(b, targetId, s));
  log('events-on-fresh-before-reload', evts(b, s));
  const bogus = await b.send('Page.reload', { loaderId: '0123456789ABCDEF0123456789ABCDEF' }, s);
  log('reload-bogus-loader', brief('Page.reload', bogus));
  const cut = b.events.length;
  const pinned = await b.send('Page.reload', { loaderId: recorded }, s);
  log('reload-recorded-loader', {
    answer: brief('Page.reload', pinned),
    answerOrder: pinned.order,
  });
  await pause(3000);
  log('events-on-fresh-after-pinned-reload', evts({ events: b.events.slice(cut) }, s));
  log('after-pinned-reload', await mark(targetId));
  log('opener-events', evts(a, undefined).slice(-12));
  a.close();
  b.close();

  const t2 = (await chrome.cdp.send('Target.createTarget', { url: `${base}/two` })).targetId;
  await pause(1500);
  const f2 = await freeze(t2);
  const c2 = await client('pending');
  const s2 = await c2.attach(t2);
  await Promise.all(['Fetch.enable', 'Page.enable'].map((m) => c2.send(m, {}, s2, 1000)));
  const nav = c2.send('Page.navigate', { url: `${other}/slow` }, s2, 3000);
  await pause(1000);
  log('pending-navigate-answer', brief('Page.navigate', await nav));
  log('pending-survey', await survey(c2, t2, s2));
  log('pending-events', evts(c2, s2));
  const r2 = await c2.send('Page.reload', {}, s2);
  log('pending-reload', {
    answer: brief('Page.reload', r2),
    order: r2.order,
  });
  await pause(2000);
  log('pending-events-after-reload', evts(c2, s2).slice(-8));
  log('pending-after-reload', await mark(t2));
  f2.a.close();
  c2.close();

  const t3 = (
    await chrome.cdp.send('Target.createTarget', {
      url: `${base}/slow-first`,
    })
  ).targetId;
  await pause(16500);
  const o3 = await client('nav3');
  const s3o = await o3.attach(t3);
  await o3.send('Page.navigate', { url: `${other}/committed` }, s3o);
  await pause(1500);
  o3.close();
  const f3 = await freeze(t3);
  const c3 = await client('history');
  const s3 = await c3.attach(t3);
  await Promise.all(['Fetch.enable', 'Page.enable'].map((m) => c3.send(m, {}, s3, 1000)));
  const h = await c3.send('Page.getNavigationHistory', {}, s3);
  log('history-before-back', brief('Page.getNavigationHistory', h));
  const first = h.result?.entries?.[0]?.id;
  const back = c3.send('Page.navigateToHistoryEntry', { entryId: first }, s3, 3000);
  await pause(1000);
  log('back-answer', brief('Page.navigateToHistoryEntry', await back));
  log('history-survey', await survey(c3, t3, s3));
  log('history-events', evts(c3, s3));
  f3.a.close();
  c3.close();
});
