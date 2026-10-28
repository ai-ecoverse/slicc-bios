import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureServer } from '@ai-ecoverse/slicc-browsers/fixture';
import { run, summary } from '@ai-ecoverse/slicc-browsers/guard-runner';
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { boot } from './bios.mjs';
import { devtools, launch } from './chrome.mjs';
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
    inboundDelay: true,
    forwardAudit: true,
  },
  link: {
    autoAttach: true,
    browserSession: true,
    browserContexts: true,
    chromeUrlsAttach: true,
    extensionWorld: true,
  },
};

function noteUrl(flags, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  const host = url.hostname;
  if (host === 'sliccy.ai' || host.endsWith('.sliccy.ai')) flags.protectedObserved = true;
  if (host.endsWith('.example.test') && url.pathname.includes('/bfcache'))
    flags.ordinaryObserved = true;
}

function noteMessage(flags, value) {
  if (typeof value === 'string') {
    if (value.startsWith('http://') || value.startsWith('https://')) noteUrl(flags, value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const item of Object.values(value)) noteMessage(flags, item);
}

function matchForwards(forwards, probes) {
  const used = new Set();
  return {
    complete: true,
    probes: (probes ?? []).map((probe) => {
      const want = JSON.stringify(probe.params ?? {});
      const index = forwards.findIndex(
        (forward, at) =>
          !used.has(at) &&
          forward.method === probe.method &&
          JSON.stringify(forward.params ?? {}) === want &&
          forward.at >= probe.sentAt - 1000
      );
      if (index >= 0) used.add(index);
      return { id: probe.id, forwarded: index >= 0 };
    }),
  };
}

const browserAt = () =>
  launch({
    tools: false,
    extensions: [fileURLToPath(new URL('./fixtures/foreign-world', import.meta.url))],
    args: [
      '--host-resolver-rules=MAP *.sliccy.ai 127.0.0.1, MAP sliccy.ai 127.0.0.1, MAP *.example.test 127.0.0.1',
    ],
  });
const chrome = await browserAt();
after(async () => {
  chrome.close();
  await fixture.close();
});
const { port, browser } = await devtools(chrome);

async function tabsBrowser(t, path) {
  if (path !== 'link') return { port, browser };
  const other = await browserAt();
  t.after(() => other.close());
  return devtools(other);
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
  const forwards = [];
  const flags = { protectedObserved: false, ordinaryObserved: false };
  let gate = null;
  let next = 0;
  const dispatch = (text, message) => {
    messages.push(text);
    const call = message.id === undefined ? undefined : pending.get(message.id);
    if (!call) return push(message);
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(cdpError(message.error));
    else call.resolve(message.result);
  };
  socket.onmessage = ({ data }) => {
    const text = String(data);
    const message = JSON.parse(text);
    noteMessage(flags, message);
    if (gate && message.sessionId === gate.sessionId) {
      if (gate.first === undefined) gate.first = Date.now();
      gate.held.push({ text, message });
      return;
    }
    dispatch(text, message);
  };
  const write = socket.send.bind(socket);
  socket.send = (text) => {
    const message = JSON.parse(text);
    if (message.method) {
      forwards.push({
        method: message.method,
        params: message.params,
        at: Date.now(),
      });
    }
    return write(text);
  };
  const releaseGate = async (ms) => {
    const current = gate;
    gate = null;
    const delayedEvents = current?.held.length ?? 0;
    const firstDelayedAt = current?.first ?? Date.now();
    const wait = current?.first === undefined ? 0 : Math.max(0, current.first + ms - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    for (const item of current?.held ?? []) dispatch(item.text, item.message);
    return { delayedEvents, firstDelayedAt, releasedAt: Date.now() };
  };
  return {
    events,
    messages,
    waitEvent,
    forwards,
    flags,
    armGate(sessionId) {
      forwards.length = 0;
      const seen = {
        protectedObserved: flags.protectedObserved,
        ordinaryObserved: flags.ordinaryObserved,
      };
      setTimeout(() => {
        if (!gate) gate = { sessionId, held: [], first: undefined };
      }, 0);
      return seen;
    },
    releaseGate,
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
  const setup = async () => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const hosts = {
      extension: async () => extensionConnection(globalThis.sliccExtension.cdp),
      link: async () => {
        const [linked] = globalThis.sliccLinkedBrowsers();
        if (!linked) throw new Error('no linked browser');
        return linked.open();
      },
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
    const remember = (flags, value) => {
      if (typeof value === 'string') {
        if (!value.startsWith('http://') && !value.startsWith('https://')) return;
        try {
          const url = new URL(value);
          const host = url.hostname;
          if (host === 'sliccy.ai' || host.endsWith('.sliccy.ai')) flags.protectedObserved = true;
          if (host.endsWith('.example.test') && url.pathname.includes('/bfcache'))
            flags.ordinaryObserved = true;
        } catch {
          return;
        }
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const item of Object.values(value)) remember(flags, item);
    };
    const gateWrap = (raw) => {
      const flags = { protectedObserved: false, ordinaryObserved: false };
      const forwards = [];
      let sink = null;
      let hold = null;
      raw.onmessage = (text) => {
        try {
          remember(flags, JSON.parse(text));
        } catch {
          return;
        }
        if (hold) {
          if (hold.first === undefined) hold.first = Date.now();
          hold.texts.push(text);
          return;
        }
        sink?.(text);
      };
      return {
        set onmessage(fn) {
          sink = fn;
        },
        get onmessage() {
          return sink;
        },
        set onclose(fn) {
          raw.onclose = fn;
        },
        get onclose() {
          return raw.onclose;
        },
        send(text) {
          try {
            const message = JSON.parse(text);
            if (message.method) {
              forwards.push({ method: message.method, params: message.params, at: Date.now() });
            }
          } catch {
            return raw.send(text);
          }
          return raw.send(text);
        },
        close() {
          return raw.close();
        },
        arm() {
          forwards.length = 0;
          const seen = {
            protectedObserved: flags.protectedObserved,
            ordinaryObserved: flags.ordinaryObserved,
          };
          setTimeout(() => {
            if (!hold) hold = { texts: [], first: undefined };
          }, 0);
          return seen;
        },
        async release(ms) {
          const current = hold;
          hold = null;
          const delayedEvents = current?.texts.length ?? 0;
          const firstDelayedAt = current?.first ?? Date.now();
          const wait =
            current?.first === undefined ? 0 : Math.max(0, current.first + ms - Date.now());
          if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
          for (const text of current?.texts ?? []) sink?.(text);
          return { delayedEvents, firstDelayedAt, releasedAt: Date.now() };
        },
        audit(probes) {
          const used = new Set();
          return {
            complete: true,
            probes: (probes ?? []).map((probe) => {
              const want = JSON.stringify(probe.params ?? {});
              const index = forwards.findIndex(
                (forward, at) =>
                  !used.has(at) &&
                  forward.method === probe.method &&
                  JSON.stringify(forward.params ?? {}) === want &&
                  forward.at >= probe.sentAt - 1000
              );
              if (index >= 0) used.add(index);
              return { id: probe.id, forwarded: index >= 0 };
            }),
          };
        },
      };
    };
    const guards = new Map();
    window.guards = {
      async open(row, own, path, lag) {
        const gated = gateWrap(lagged(await hosts[path](), lag));
        const connection = guardProtected(gated, [location.origin, own]);
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
        guards.set(row, { connection, pending, gated, next: () => ++next });
      },
      arm(row) {
        return (
          guards.get(row)?.gated.arm() ?? { protectedObserved: false, ordinaryObserved: false }
        );
      },
      release(row, ms) {
        return guards.get(row)?.gated.release(ms);
      },
      audit(row, probes) {
        return guards.get(row)?.gated.audit(probes) ?? { complete: false, probes: [] };
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
    await seven.evaluate(setup);
  };
  await ensure();
  let count = 0;
  const unguarded = await unguardedClient(tabs.browser);
  t.after(() => unguarded.close());
  const clientFactory =
    (path) =>
    async ({ detachDelay }) => {
      count += 1;
      const row = count;
      const { events, push, waitEvent } = eventsOf();
      const messages = [];
      rows.set(row, { push, messages });
      await ensure();
      await seven.evaluate(
        ([row, own, path, lag]) => window.guards.open(row, own, path, lag),
        [row, targets.own, path, detachDelay]
      );
      const client = {
        transport: path,
        events,
        messages,
        waitEvent,
        async inboundDelay({ targetId, sessionId, ms, side, gate }) {
          const seen =
            side === 'control'
              ? unguarded.armGate(sessionId)
              : await seven.evaluate((row) => window.guards.arm(row), row);
          return {
            targetId,
            sessionId,
            ms,
            gate: gate === true,
            protectedObserved: seen?.protectedObserved === true,
            ordinaryObserved: seen?.ordinaryObserved === true,
            release: () =>
              side === 'control'
                ? unguarded.releaseGate(ms)
                : seven.evaluate(([id, wait]) => window.guards.release(id, wait), [row, ms]),
            audit: ({ probes }) => {
              const list = (probes ?? []).map(({ id, method, params, sentAt }) => ({
                id,
                method,
                params,
                sentAt,
              }));
              return side === 'control'
                ? matchForwards(unguarded.forwards, list)
                : seven.evaluate(([id, items]) => window.guards.audit(id, items), [row, list]);
            },
          };
        },
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
  return clientFactory;
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
      const clientFactory = await guardHost(t, path);
      for (const target of chosen.targets) {
        trace('run', path, target, variant);
        const execution = await run(subset(target), {
          clientFactory: clientFactory(path),
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
              row.live,
              row.why ?? '',
              JSON.stringify(row.incomplete ?? [])
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
      const failed = results.filter((row) => row.variant === variant && failing(row));
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
