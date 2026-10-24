import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const chrome = await launch();
after(() => chrome.close());

const current = await readFile(new URL('../../src/sw.js', import.meta.url), 'utf8');
const SIZE = 64 * 1024 * 1024;
let bump = 0;
let served = current;

const once = (source, from, to) => {
  const parts = source.split(from);
  if (parts.length !== 2) throw new Error(`sw.js marker missing: ${from.slice(0, 48)}`);
  return parts[0] + to + parts[1];
};

function instrument(source) {
  const tracked = `const fetching = new Set();
function tracked(event, promise) {
  const { request, clientId } = event;
  const ticket = { url: request.url, client: clientId || event.resultingClientId || null };
  fetching.add(ticket);
  return promise.finally(() => fetching.delete(ticket));
}
`;
  const listed = `self.addEventListener('message', (event) => {
  if (event.data?.streams === 'all' && event.source) {
    const { source } = event;
    event.waitUntil(
      prune().then(async () => {
        const clients = await self.clients.matchAll({ type: 'all', includeUncontrolled: true });
        const known = new Map(clients.map((client) => [client.id, client]));
        const describe = async (id, url) => {
          const found = id ? (known.get(id) ?? (await self.clients.get(id))) : null;
          return { url, type: found?.type ?? null, client: found?.url ?? null };
        };
        const order = (a, b) =>
          String(a.url).localeCompare(String(b.url)) ||
          String(a.type).localeCompare(String(b.type)) ||
          String(a.client).localeCompare(String(b.client));
        const pending = [...fetching];
        const bodies = [...streaming];
        const inflight = await Promise.all(pending.map((ticket) => describe(ticket.client, ticket.url)));
        const open = await Promise.all(bodies.map((item) => describe(item.client, item.url)));
        source.postMessage({
          wide: true,
          fetches: pending.length,
          inflight: inflight.sort(order),
          open: open.sort(order),
        });
      })
    );
    return;
  }
  if (event.data?.streams !== 'mine' || !event.source) return;`;
  return once(
    once(
      once(
        once(
          source,
          "self.addEventListener('fetch', (event) => {\n",
          `${tracked}self.addEventListener('fetch', (event) => {\n`
        ),
        `    event.respondWith(
      answer(
        request,
        (asked, controller) => kernel(asked, controller, port, clientId),
        \` from kernel port \${port}\`
      )
    );`,
        `    event.respondWith(
      tracked(
        event,
        answer(
          request,
          (asked, controller) => kernel(asked, controller, port, clientId),
          \` from kernel port \${port}\`
        )
      )
    );`
      ),
      '    event.respondWith(answer(request, (asked, controller) => serve(asked, controller, client)));',
      '    event.respondWith(tracked(event, answer(request, (asked, controller) => serve(asked, controller, client))));'
    ),
    `self.addEventListener('message', (event) => {
  if (event.data?.streams !== 'mine' || !event.source) return;`,
    listed
  );
}

const deep = (selector) => {
  const walk = (root) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && walk(element.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  return walk(document);
};

function bumpWorker() {
  bump += 1;
  chrome.overrides.set('/sw.js', served.replace('const own = ', `const own =${' '.repeat(bump)} `));
}

const settled = (page) =>
  page.within(5 * 60 * 1000, () => document.querySelector('slicc-app').model.updates.ready());

const hold = (page) =>
  page.evaluate(async () => {
    const reader = (await fetch('/os/held.bin?token=<b>s3cret</b>#frag')).body.getReader();
    await reader.read();
    window.heldReader = reader;
  });

const update = (page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
    return (registration.installing ?? registration.waiting)?.state ?? null;
  });

const waitingNotice = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .find((notice) => notice.id.startsWith('sw-waiting:'))
  );

const workers = (page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      active: registration.active?.state ?? null,
      waiting: registration.waiting?.state ?? null,
      installing: registration.installing?.state ?? null,
    };
  });

const snapshot = (page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const controller = navigator.serviceWorker.controller;
    const open = await new Promise((resolve) => {
      if (!controller) {
        resolve(null);
        return;
      }
      let timer;
      const listen = (event) => {
        if (!Array.isArray(event.data?.streams)) return;
        navigator.serviceWorker.removeEventListener('message', listen);
        clearTimeout(timer);
        resolve(event.data.streams.map(({ url }) => url));
      };
      timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('message', listen);
        resolve(null);
      }, 2000);
      navigator.serviceWorker.addEventListener('message', listen);
      controller.postMessage({ streams: 'mine' });
    });
    return {
      waiting: registration?.waiting?.state ?? null,
      installing: registration?.installing?.state ?? null,
      open,
    };
  });

const wide = (page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const controller = navigator.serviceWorker.controller;
    const detail = await new Promise((resolve) => {
      if (!controller) {
        resolve(null);
        return;
      }
      let timer;
      const listen = (event) => {
        if (event.data?.wide !== true) return;
        navigator.serviceWorker.removeEventListener('message', listen);
        clearTimeout(timer);
        resolve({
          fetches: event.data.fetches,
          inflight: event.data.inflight,
          open: event.data.open,
        });
      };
      timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('message', listen);
        resolve(null);
      }, 2000);
      navigator.serviceWorker.addEventListener('message', listen);
      controller.postMessage({ streams: 'all' });
    });
    return {
      waiting: registration?.waiting?.state ?? null,
      installing: registration?.installing?.state ?? null,
      fetches: detail?.fetches ?? null,
      inflight: detail?.inflight ?? null,
      open: detail?.open ?? null,
    };
  });

const until = async (page, ms, ready) => {
  const deadline = Date.now() + ms;
  let state = await snapshot(page);
  while (!ready(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    state = await snapshot(page);
  }
  return state;
};

test('while the tab holds a half-read download from the old worker, it says seven updated and names the download, and Reload reloads the tab (#710)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await settled(page);
  chrome.overrides.set('/os/held.bin', Buffer.alloc(SIZE, 7));
  await hold(page);
  bumpWorker();
  assert.ok(await update(page));
  const notice = await page.within(30000, () =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .find((notice) => notice.id.startsWith('sw-waiting:'))
  );
  assert.deepEqual(
    { title: notice.title, body: notice.body, actions: notice.actions },
    {
      title: 'Seven updated',
      body: 'This tab is still loading /os/held.bin with the old version. Reload to apply the update; that load stops.',
      actions: [{ id: 'reload', label: 'Reload' }],
    }
  );
  assert.deepEqual(await workers(page), {
    active: 'activated',
    waiting: 'installed',
    installing: null,
  });
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.within(30000, new Function(`return !!(${deep})('[data-notice^="sw-waiting:"]')`));
  assert.deepEqual(
    await page.evaluate(
      new Function(
        `const p = (${deep})('[data-notice^="sw-waiting:"] p'); return [p.textContent, p.children.length];`
      )
    ),
    [notice.body, 0],
    'the notice names the stream by its path as plain text, without its query or fragment'
  );
  await shoot(page, 'sw-waiting', { show: 'chat', target: '[data-notice^="sw-waiting:"]' });
  await page.evaluate(
    new Function(`(${deep})('[data-notice^="sw-waiting:"] [data-action="reload"]').click()`)
  );
  await page.until(() => !window.heldReader && location.pathname === '/os/');
  assert.deepEqual(page.errors, []);
});

test('when another seven tab holds the download, the owner names that tab instead, and it stops naming that tab once the tab closes (#710)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await settled(page);
  const second = await page.tab();
  await boot(second);
  chrome.overrides.set('/os/held.bin', Buffer.alloc(SIZE, 7));
  await hold(second);
  bumpWorker();
  assert.ok(await update(page));
  const notice = await page.within(30000, () =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .find((notice) => notice.id.startsWith('sw-waiting:') && notice.body.startsWith('Another'))
  );
  assert.deepEqual(
    { body: notice.body, actions: notice.actions },
    {
      body: 'Another seven tab is still loading /os/held.bin with the old version. Close or reload that tab to apply the update.',
      actions: [],
    }
  );
  assert.equal(
    await second.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.notices.list()
        .some((notice) => notice.id.startsWith('sw-waiting:'))
    ),
    false
  );
  assert.deepEqual(second.errors, []);
  await second.close();
  await page.within(15000, async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const notice = document
      .querySelector('slicc-app')
      .model.notices.list()
      .find((notice) => notice.id.startsWith('sw-waiting:'));
    return !registration.waiting || notice?.body === 'Reload to apply the update.';
  });
  assert.deepEqual(page.errors, []);
});

test('an ordinary update shows no notice: the updated worker activates before any notice could show, and nothing said seven updated (#710)', async (t) => {
  const page = await chrome.page(t);
  served = instrument(current);
  chrome.overrides.set('/sw.js', served);
  try {
    await boot(page);
    await settled(page);
    const quiet = await until(page, 45000, (state) => state.open?.length === 0);
    assert.deepEqual(quiet.open, []);
    await page.evaluate(() => {
      window.noticed = [];
      document
        .querySelector('slicc-app')
        .model.notices.on('notices', (list) => window.noticed.push(...list.map(({ id }) => id)));
    });
    bumpWorker();
    assert.ok(await update(page));
    await until(page, 45000, (state) => !state.waiting && !state.installing);
    const detail = await wide(page);
    assert.deepEqual(
      {
        waiting: detail.waiting,
        installing: detail.installing,
        fetches: detail.fetches,
        inflight: detail.inflight,
        open: detail.open,
      },
      {
        waiting: null,
        installing: null,
        fetches: detail.fetches,
        inflight: detail.inflight,
        open: detail.open,
      }
    );
    assert.deepEqual(
      await page.evaluate(() => window.noticed.filter((id) => id.startsWith('sw-waiting:'))),
      []
    );
    assert.deepEqual(page.errors, []);
  } finally {
    served = current;
  }
});
