import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureServer } from '@ai-ecoverse/slicc-browsers/fixture';
import { run, summary } from '@ai-ecoverse/slicc-browsers/guard-runner';
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { startProxy } from '@ai-ecoverse/slicc-node';
import { boot } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { ALL_TARGETS, groupTargets } from './guard-groups.mjs';
import { known as knownRow, listedWrong, stale } from './guard-known.mjs';

const exposure = { listed: false, sample: null };
const known = (row) => knownRow(row, exposure);

import { linkNode } from './linked-node.mjs';

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
  extension: {
    autoAttach: true,
    browserSession: false,
    browserContexts: true,
    chromeUrlsAttach: false,
    discovery: false,
    extensionWorld: true,
  },
  proxy: {
    autoAttach: true,
    browserSession: true,
    browserContexts: true,
    chromeUrlsAttach: true,
    discovery: true,
    extensionWorld: true,
  },
  link: {
    autoAttach: true,
    browserSession: true,
    browserContexts: true,
    chromeUrlsAttach: true,
    extensionWorld: true,
  },
};

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const browserAt = (port) =>
  launch({
    extensions: [fileURLToPath(new URL('./fixtures/foreign-world', import.meta.url))],
    args: [
      `--remote-debugging-port=${port}`,
      '--host-resolver-rules=MAP *.sliccy.ai 127.0.0.1, MAP sliccy.ai 127.0.0.1, MAP *.example.test 127.0.0.1',
    ],
  });
const port = await freePort();
const chrome = await browserAt(port);
after(async () => {
  chrome.close();
  await fixture.close();
});
const browser = await debuggerUrl(port);

async function tabsBrowser(t, path) {
  if (path !== 'link') return { port, browser };
  const own = await freePort();
  const other = await browserAt(own);
  t.after(() => other.close());
  return { port: own, browser: await debuggerUrl(own) };
}

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

async function unguardedClient(browser) {
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map();
  const { events, push, waitEvent } = eventsOf();
  const messages = [];
  let next = 0;
  socket.onmessage = ({ data }) => {
    messages.push(String(data));
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
    messages,
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

export async function guardHost(t, path) {
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
  await seven.expose('guardTransport', ([row, message]) =>
    rows.get(row)?.transportEvents.push(message)
  );
  await seven.expose('guardRaw', ([row, text]) => {
    if (!exposure.listed && listedWrong(text)) {
      exposure.listed = true;
      exposure.sample = text.slice(0, 400);
    }
    rows.get(row)?.messages.push(text);
  });
  await seven.init(() => {
    globalThis.sliccKernelDebug = true;
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
  const tabs = await tabsBrowser(t, path);
  if (path === 'link') trace('link', (await linkNode(t, seven, tabs.port)).join(' '));
  const setup = async (proxy) => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection, proxyHost } = await import(new URL('cdp.js', location.href).href);
    const hosts = {
      extension: async () => extensionConnection(globalThis.sliccExtension.cdp),
      proxy: proxyHost(proxy),
      link: async () => {
        const [linked] = globalThis.sliccLinkedBrowsers();
        if (!linked) throw new Error('no linked browser');
        return linked.open();
      },
    };
    const lagged = (connection, lag, paintDelay, row) => {
      const send = connection.send.bind(connection);
      const shots = new Set();
      const relay = { onmessage: null, onclose: null, close: () => connection.close() };
      connection.onmessage = (text) => {
        const message = JSON.parse(text);
        if (message.method === 'Target.attachedToTarget')
          void window.guardTransport(
            JSON.stringify([
              row,
              {
                direction: 'in',
                method: message.method,
                parent: message.sessionId,
                sessionId: message.params.sessionId,
                targetInfo: message.params.targetInfo,
                waitingForDebugger: message.params.waitingForDebugger,
              },
            ])
          );
        if (shots.delete(message.id)) setTimeout(() => relay.onmessage?.(text), paintDelay);
        else relay.onmessage?.(text);
      };
      connection.onclose = (why) => relay.onclose?.(why);
      relay.send = (text) => {
        const message = JSON.parse(text);
        if (message.method === 'Runtime.runIfWaitingForDebugger')
          void window.guardTransport(
            JSON.stringify([
              row,
              {
                direction: 'out',
                method: message.method,
                sessionId: message.sessionId,
              },
            ])
          );
        if (paintDelay && message.method === 'Page.captureScreenshot') shots.add(message.id);
        if (lag && message.method === 'Target.detachFromTarget') setTimeout(() => send(text), lag);
        else send(text);
      };
      return relay;
    };
    const guards = new Map();
    window.guards = {
      async open(row, own, path, lag, paintDelay) {
        const connection = guardProtected(
          lagged(await hosts[path](), lag, paintDelay, row),
          [location.origin, own].flat()
        );
        const pending = new Map();
        let next = 0;
        connection.onmessage = (text) => {
          void window.guardRaw(JSON.stringify([row, text]));
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
  const unguarded = await unguardedClient(tabs.browser);
  t.after(() => unguarded.close());
  const clientFactory =
    (path) =>
    async ({ detachDelay, paintDelay, own = targets.own }) => {
      count += 1;
      const row = count;
      const { events, push, waitEvent } = eventsOf();
      const messages = [];
      const transportEvents = [];
      rows.set(row, { push, messages, transportEvents });
      await ensure();
      await seven.evaluate(
        ([row, own, path, lag, paintDelay]) => window.guards.open(row, own, path, lag, paintDelay),
        [row, own, path, detachDelay, paintDelay]
      );
      const client = {
        transport: path,
        transportEvents,
        events,
        messages,
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
  return { clientFactory, vault: chrome.vault.origin };
}

export const trace = (...parts) =>
  process.env.GUARD_TRACE && process.stderr.write(`guard-set ${Date.now()} ${parts.join(' ')}\n`);
const only = (list) => (list ? list.split(',') : null);
const failing = (row) =>
  (row.control === 'fail' || row.guarded === 'fail' || row.live === 'fail') && !known(row);
const SHA = process.env.GUARD_SHA ?? process.env.GITHUB_SHA;
export const ROW_MS = 3 * 60 * 1000;
export const SCALE = { lagging: 3 };

export function shared(path, { variants, except = [], group } = {}) {
  const grouped = group ? groupTargets(group) : ALL_TARGETS;
  const chosen = {
    targets: only(process.env.GUARD_TARGETS) ?? grouped,
    variants:
      only(process.env.GUARD_VARIANTS) ??
      (variants ?? Object.keys(set.variants)).filter((variant) => !except.includes(variant)),
  };
  const where = group ? `, ${group === 'rest' ? 'the other targets' : `target ${group}`}` : '';
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
    test(`the shared guard vectors (@ai-ecoverse/slicc-browsers@${set.setVersion}) against bios's guard on the ${path} path, ${variant} detach${where}`, {
      timeout: 60 * 60 * 1000,
    }, async (t) => {
      const { clientFactory } = await guardHost(t, path);
      for (const target of chosen.targets) {
        trace('run', path, target, variant);
        let current;
        let transportEvents;
        const evidence = new Map();
        const execution = await run(subset(target), {
          clientFactory: async (configuration) => {
            const made = await clientFactory(path)(configuration);
            transportEvents = made.client.transportEvents;
            return made;
          },
          rowTimeoutMs: ROW_MS,
          settleScale: SCALE[variant] ?? 1,
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
          onStart: (row) => {
            current = row;
          },
          debug: (data) => {
            if (process.env.GUARD_TRACE)
              trace('debug', JSON.stringify(data).slice(0, Number(process.env.GUARD_TRACE) || 300));
            if (
              data.side !== 'guarded' ||
              !data.calls ||
              !['C8.iframe-error', 'C4.static-cross-site'].includes(current?.id)
            )
              return;
            const snapshot = data.calls.snapshot;
            evidence.set(current.id, {
              transportEvents,
              frameTree: data.calls.frameTree,
              snapshot: snapshot && {
                ok: snapshot.ok,
                error: snapshot.error,
                nodeName: snapshot.result?.root?.nodeName,
              },
              events: data.events
                .filter((event) =>
                  [
                    'Page.frameAttached',
                    'Page.frameNavigated',
                    'Page.frameDetached',
                    'Network.loadingFailed',
                    'Target.attachedToTarget',
                    'Target.detachedFromTarget',
                  ].includes(event.method)
                )
                .map((event) => ({
                  method: event.method,
                  sessionId: event.sessionId,
                  frame: event.params.frame,
                  frameId: event.params.frameId,
                  reason: event.params.reason,
                  errorText: event.params.errorText,
                  targetInfo: event.params.targetInfo,
                  waitingForDebugger: event.params.waitingForDebugger,
                })),
            });
          },
        });
        results.push(...execution.results);
        for (const row of execution.results.filter(
          (row) => failing(row) || row.id === 'C4.static-cross-site'
        )) {
          if (evidence.has(row.id))
            process.stdout.write(
              `GUARD-FRAMES ${path} ${row.id} ${target} ${variant} ${JSON.stringify({ ...evidence.get(row.id), observations: row.observations })}\n`
            );
        }
      }
      const failed = results.filter((row) => row.variant === variant && failing(row));
      for (const row of failed)
        process.stdout.write(
          `GUARD-OBSERVATIONS ${path} ${row.id} ${row.target} ${variant} ${JSON.stringify(row.observations)}\n`
        );
      assert.deepEqual(
        failed.map(({ id, target, control, guarded, live, why, errors }) => ({
          id,
          target,
          control,
          guarded,
          live,
          why,
          errors,
        })),
        [],
        'no row fails on any leg'
      );
    });
  }
  const scope =
    process.env.GUARD_VARIANTS || variants || except.length
      ? `, ${chosen.variants.join(' and ')} detach`
      : '';
  const covered = {
    ...set,
    vectors: set.vectors
      .filter((vector) => vector.targets.some((target) => grouped.includes(target)))
      .map((vector) => ({
        ...vector,
        targets: vector.targets.filter((target) => grouped.includes(target)),
      })),
  };
  test(`the shared set is complete on the ${path} path${scope}${where}: no row missing, none skipped for a missing observer`, async () => {
    const report = summary({ set: covered, results, guard: `slicc-bios/${path}`, sha: SHA });
    const informed = results.filter((row) => row.ran || row.notes);
    const skips = {};
    for (const row of results) {
      if (row.control === 'skip' || row.guarded === 'skip') {
        skips[row.reason] = [
          ...(skips[row.reason] ?? []),
          `${row.id}@${row.target}/${row.variant}`,
        ];
      }
    }
    const held = results.filter(
      (row) =>
        (row.control === 'fail' || row.guarded === 'fail' || row.live === 'fail') && known(row)
    );
    const lines = [
      report.line,
      ...(exposure.listed
        ? [`GUARD-LISTED a target list showed more than an origin: ${exposure.sample}`]
        : []),
      ...held.map(
        (row) =>
          `GUARD-KNOWN ${known(row)} ${row.id}@${row.target}/${row.variant}: ${row.live === 'fail' ? 'not live' : row.why}`
      ),
      `${path}: ${results.length} rows, ${JSON.stringify(report.counts)}`,
      ...Object.entries(skips).map(
        ([reason, rows]) => `skip ${reason} (${rows.length}): ${rows.join(' ')}`
      ),
      ...informed.map(
        (row) =>
          `informational ${row.id}@${row.target}/${row.variant}: ${JSON.stringify({ ran: row.ran, notes: row.notes })}`
      ),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    if (process.env.GUARD_REPORT)
      await writeFile(
        process.env.GUARD_REPORT,
        JSON.stringify({ report, results, lines }, null, 2)
      );
    if (process.env.GUARD_IDS || process.env.GUARD_TARGETS) return;
    assert.deepEqual(
      chosen.variants.filter((variant) => !Object.hasOwn(set.variants, variant)),
      [],
      'every chosen variant is in the set'
    );
    assert.deepEqual(
      [...new Set(results.map((row) => row.variant))].sort(),
      [...chosen.variants].sort(),
      'every chosen variant ran'
    );
    assert.equal(exposure.sample, null, 'no target info the client saw showed more than an origin');
    assert.deepEqual(stale(results), [], 'a known row that passes comes off the known list');
    assert.deepEqual(report.missing, []);
    assert.equal(report.observerSkipped, 0);
    assert.equal(results.filter(failing).length, 0, report.line);
    assert.match(
      report.line,
      held.length ? /^GUARD-(?:PASS|FAIL) / : /^GUARD-PASS /,
      'the runner prints a passing verdict for the whole set, or fails only on #748'
    );
  });
}
