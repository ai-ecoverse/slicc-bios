import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { fixtureServer } from '@ai-ecoverse/slicc-browsers/fixture';
import { run, summary } from '@ai-ecoverse/slicc-browsers/guard-runner';
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { startProxy } from '@ai-ecoverse/slicc-node';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

export const fixture = await fixtureServer();
const origin = (host) => `http://${host}:${fixture.port}`;
export const targets = {
  ordinary: origin('ordinary.example.test'),
  plain: origin('ordinary.example.test'),
  cross: origin('cross.example.test'),
  seven: origin('seven.sliccy.ai'),
  vault: origin('vault.sliccy.ai'),
  'vault-x': origin('vault-x.sliccy.ai'),
  apex: origin('sliccy.ai'),
  own: origin('client.example.test'),
  client: origin('client.example.test'),
  log: origin('log.example.test'),
};
const PATHS = {
  extension: { autoAttach: true, browserSession: false, browserContexts: true },
  proxy: { autoAttach: true, browserSession: true, browserContexts: true },
};

const port = await new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const chrome = await launch({
  args: [
    `--remote-debugging-port=${port}`,
    '--host-resolver-rules=MAP *.sliccy.ai 127.0.0.1, MAP sliccy.ai 127.0.0.1, MAP *.example.test 127.0.0.1',
  ],
});
after(async () => {
  chrome.close();
  await fixture.close();
});
const browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
  .webSocketDebuggerUrl;

const COMMAND_MS = 20000;

function cdpError(error) {
  const failure = new Error(error.message);
  failure.cdp = error;
  return failure;
}

function eventsOf() {
  const events = [];
  const waiters = new Set();
  const push = (message) => {
    events.push(message);
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  };
  const waitEvent = (predicate, ms) =>
    new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error('event timed out'));
      }, ms);
      waiters.add(waiter);
    });
  return { events, push, waitEvent };
}

async function unguardedClient() {
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map();
  const { events, push, waitEvent } = eventsOf();
  let next = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const call = pending.get(message.id);
    if (!call) return push(message);
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(cdpError(message.error));
    else call.resolve(message.result);
  };
  return {
    events,
    waitEvent,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        next += 1;
        const id = next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} got no answer from Chrome`));
        }, COMMAND_MS);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    close: () => socket.close(),
  };
}

export async function guardHost(t) {
  const proxy = await startProxy({
    port: 0,
    origins: [new URL(chrome.url).origin],
    cdp: `http://127.0.0.1:${port}`,
    kernelPort: null,
    log: () => {},
  });
  t.after(() => proxy.close());
  const seven = await chrome.page(t);
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  t.after(() => socket.close());
  socket.onmessage = ({ data }) =>
    void seven.evaluate((message) => window.cdpIn(message), data).catch(() => false);
  await seven.expose('cdpOut', (command) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(command));
  });
  const rows = new Map();
  await seven.expose('guardEvent', ([row, text]) => rows.get(row)?.push(JSON.parse(text)));
  await seven.init(() => {
    const every = window.setInterval;
    window.setInterval = (callback, ms, ...rest) =>
      ms === 15 * 60 * 1000 ? 0 : every(callback, ms, ...rest);
    const pending = new Map();
    const listeners = new Set();
    let next = 0;
    window.cdpIn = (text) => {
      const message = JSON.parse(text);
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        if (message.error) call.reject(new Error(message.error.message));
        else call.resolve(message.result);
      } else if (message.method) {
        for (const listener of listeners) listener(message);
      }
    };
    Object.defineProperty(globalThis, 'sliccExtension', {
      value: Object.freeze({
        fetch: (input, init) => fetch(input, init),
        cdp: Object.freeze({
          send(method, params, sessionId) {
            const id = ++next;
            return new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              window.cdpOut(JSON.stringify({ id, method, params, sessionId }));
            });
          },
          on(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        }),
      }),
    });
  });
  await boot(seven);
  const setup = async (proxy) => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection, proxyHost } = await import(new URL('cdp.js', location.href).href);
    const hosts = {
      extension: async () => extensionConnection(globalThis.sliccExtension.cdp),
      proxy: proxyHost(proxy),
    };
    const lagged = (connection, lag) => {
      const send = connection.send.bind(connection);
      connection.send = (text) => {
        if (lag && JSON.parse(text).method === 'Target.detachFromTarget') {
          setTimeout(() => send(text), lag);
        } else send(text);
      };
      return connection;
    };
    const guards = new Map();
    window.guards = {
      async open(row, own, path, lag) {
        const connection = guardProtected(lagged(await hosts[path](), lag), [location.origin, own]);
        const pending = new Map();
        let next = 0;
        connection.onmessage = (text) => {
          const message = JSON.parse(text);
          if (message.id === undefined) {
            return void window.guardEvent(JSON.stringify([row, text]));
          }
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        };
        guards.set(row, { connection, pending, next: () => ++next });
      },
      send(row, method, params, sessionId, wait) {
        const guard = guards.get(row);
        if (!guard) return { error: { message: 'the guard for this row is closed' } };
        const id = guard.next();
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            guard.pending.delete(id);
            resolve({ error: { message: `${method} got no answer through the guard` } });
          }, wait);
          guard.pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          guard.connection.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
          );
        });
      },
      close(row) {
        guards.get(row)?.connection.close();
        guards.delete(row);
      },
    };
  };
  const ensure = async () => {
    if (await seven.evaluate(() => Boolean(window.guards))) return;
    trace('install', 'the guard hooks go into seven’s page, again if it reloaded');
    await seven.evaluate(setup, { url: proxy.url, key: proxy.key });
  };
  await ensure();
  let count = 0;
  const unguarded = await unguardedClient();
  t.after(() => unguarded.close());
  const clientFactory =
    (path) =>
    async ({ detachDelay }) => {
      count += 1;
      const row = count;
      const { events, push, waitEvent } = eventsOf();
      rows.set(row, { push });
      await ensure();
      await seven.evaluate(
        ([row, own, path, lag]) => window.guards.open(row, own, path, lag),
        [row, targets.own, path, detachDelay]
      );
      const client = {
        transport: path,
        events,
        waitEvent,
        send: async (method, params = {}, sessionId) => {
          const answer = await seven.evaluate(
            ([row, method, params, sessionId, wait]) =>
              window.guards.send(row, method, params, sessionId ?? undefined, wait),
            [row, method, params, sessionId ?? null, COMMAND_MS]
          );
          if (answer.error) throw cdpError(answer.error);
          return answer.result;
        },
      };
      return {
        client,
        unguarded,
        transportVariant: true,
        close: async () => {
          rows.delete(row);
          await seven.evaluate((row) => window.guards.close(row), row).catch(() => false);
        },
      };
    };
  return { clientFactory };
}

export const trace = (...parts) =>
  process.env.GUARD_TRACE && process.stderr.write(`guard-set ${Date.now()} ${parts.join(' ')}\n`);
const only = (list) => (list ? list.split(',') : null);
const KNOWN = {
  'C4.static-cross-site': {
    paths: ['proxy'],
    targets: null,
    legs: ['control'],
    why: 'the control’s frame is same-site with its page, so its beacon also depends on the page’s refused init script; slicc-browsers 1.7.4 adds that dependsOn',
  },
  'C4.script-cross-site': {
    paths: ['proxy'],
    targets: null,
    legs: ['control'],
    why: 'the control’s frame is same-site with its page, so its beacon also depends on the page’s refused init script; slicc-browsers 1.7.4 adds that dependsOn',
  },
  'C4.static-same-site': {
    paths: ['proxy'],
    targets: ['seven'],
    legs: ['control', 'guarded'],
    why: 'seven target only: bios protects every sliccy.ai host, so no unprotected origin is same-site with seven and ordinary-same-site is left unmapped, yet the runner runs the row (it skips the vault target only). Both legs then never load anything: the guarded leg shows the protected document never served and no frame or target on it, so nothing reached the client',
  },
  'C4.script-same-site': {
    paths: ['proxy'],
    targets: ['seven'],
    legs: ['control', 'guarded'],
    why: 'seven target only: bios protects every sliccy.ai host, so no unprotected origin is same-site with seven and ordinary-same-site is left unmapped, yet the runner runs the row (it skips the vault target only). Both legs then never load anything: the guarded leg shows the protected document never served and no frame or target on it, so nothing reached the client',
  },
  'C3.popup-self-nav': {
    paths: ['proxy'],
    targets: null,
    legs: ['control'],
    why: 'control only, intermittent (proxy, vault and vault-x): the client’s own Page.navigate of the ordinary popup returns ERR_ABORTED against the popup’s first load, and the later href sometimes does not land, so the control’s target document is not served. No exposure: on every run the guarded leg passes, the protected document is never served (fixture log), the client gets no attachedToTarget for it, and no event on any client session names its host',
  },
  'C3.popup-on-redirect-302': {
    paths: ['proxy'],
    targets: null,
    legs: ['control'],
    why: 'control only, intermittent (proxy): a browser-level auto-attach attaches every existing target (other tabs, chrome:// pages), and the children steps run on whichever of them attach in time, so the child refusals land on one leg and not the other. No exposure: the guarded leg never gets an attachedToTarget for the protected popup, and the only events naming its host are the opener’s pre-action beacon and Page.windowOpen, which carry the client’s own hop URL with the target percent-encoded in its query',
  },
  'C3.popup-on-redirect-chain': {
    paths: ['proxy'],
    targets: null,
    legs: ['control'],
    why: 'control only, intermittent (proxy): a browser-level auto-attach attaches every existing target (other tabs, chrome:// pages), and the children steps run on whichever of them attach in time, so the child refusals land on one leg and not the other. No exposure: the guarded leg never gets an attachedToTarget for the protected popup, and the only events naming its host are the opener’s pre-action beacon and Page.windowOpen, which carry the client’s own hop URL with the target percent-encoded in its query',
  },
  'C6.read-cookies': {
    paths: ['extension'],
    targets: null,
    legs: ['control'],
    why: 'slicc-browsers: a page-or-browser step with browserContextId runs on the page session when browserSession is false',
  },
  'C6.write-cookies': {
    paths: ['extension'],
    targets: null,
    legs: ['control'],
    why: 'slicc-browsers: a page-or-browser step with browserContextId runs on the page session when browserSession is false',
  },
  'C6.storage-getCookies': {
    paths: ['extension'],
    targets: null,
    legs: ['control', 'live'],
    why: 'slicc-browsers: a page-or-browser step with browserContextId runs on the page session when browserSession is false',
  },
};
const failing = (row) => row.control === 'fail' || row.guarded === 'fail' || row.live === 'fail';
const known = (row) => {
  const entry = KNOWN[row.id];
  if (!entry?.paths.includes(row.transport)) return null;
  if (entry.targets && !entry.targets.includes(row.target)) return null;
  const legs = ['control', 'guarded', 'live'].filter((leg) => row[leg] === 'fail');
  return legs.every((leg) => entry.legs.includes(leg)) ? entry : null;
};

export function shared(path) {
  const chosen = {
    targets: only(process.env.GUARD_TARGETS) ?? ['seven', 'vault', 'vault-x', 'apex', 'own'],
    variants: only(process.env.GUARD_VARIANTS) ?? Object.keys(set.variants),
  };
  const results = [];
  const subset = (target) => ({
    ...set,
    vectors: set.vectors
      .filter(
        (vector) =>
          vector.targets.includes(target) &&
          (!only(process.env.GUARD_IDS) || only(process.env.GUARD_IDS).includes(vector.id))
      )
      .map((vector) => ({ ...vector, targets: [target] })),
  });
  for (const variant of chosen.variants) {
    test(`the shared guard vectors (@ai-ecoverse/slicc-browsers@${set.setVersion}) against bios's guard on the ${path} path, ${variant} detach`, {
      timeout: 60 * 60 * 1000,
    }, async (t) => {
      const { clientFactory } = await guardHost(t);
      for (const target of chosen.targets) {
        trace('run', path, target, variant);
        const execution = await run(subset(target), {
          clientFactory: clientFactory(path),
          targets,
          capabilities: PATHS[path],
          variant,
          fixture,
          log: (row) =>
            trace(
              'row',
              row.transport,
              row.id,
              row.target,
              row.variant,
              row.control,
              row.guarded,
              row.live
            ),
          debug: process.env.GUARD_TRACE
            ? (data) =>
                trace(
                  'debug',
                  JSON.stringify(data).slice(0, Number(process.env.GUARD_TRACE) || 300)
                )
            : undefined,
        });
        results.push(...execution.results);
      }
      const unknown = results.filter(
        (row) => row.variant === variant && failing(row) && !known(row)
      );
      assert.deepEqual(
        unknown.map(({ id, target, control, guarded, live, why, errors }) => ({
          id,
          target,
          control,
          guarded,
          live,
          why,
          errors,
        })),
        [],
        'every failing row is a known issue named by its vector id'
      );
    });
  }
  test(`the shared set is complete on the ${path} path: no row missing, none skipped for a missing observer`, async () => {
    const report = summary({ set, results, guard: 'slicc-bios', sha: process.env.GUARD_SHA });
    const accepted = results.filter((row) => failing(row) && known(row));
    const skips = {};
    for (const row of results) {
      if (row.control === 'skip' || row.guarded === 'skip') {
        skips[row.reason] = [
          ...(skips[row.reason] ?? []),
          `${row.id}@${row.target}/${row.variant}`,
        ];
      }
    }
    const lines = [
      report.line,
      `${path}: ${results.length} rows, ${JSON.stringify(report.counts)}`,
      ...Object.entries(skips).map(
        ([reason, rows]) => `skip ${reason} (${rows.length}): ${rows.join(' ')}`
      ),
      ...accepted.map(
        (row) => `known ${row.id}@${row.target}/${row.variant}: ${known(row).why} (${row.why})`
      ),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    if (process.env.GUARD_REPORT)
      await writeFile(
        process.env.GUARD_REPORT,
        JSON.stringify({ report, results, lines }, null, 2)
      );
    if (process.env.GUARD_IDS || process.env.GUARD_TARGETS || process.env.GUARD_VARIANTS) return;
    assert.deepEqual(report.missing, []);
    assert.equal(report.observerSkipped, 0);
    assert.equal(results.filter((row) => failing(row) && !known(row)).length, 0, report.line);
  });
}
