export const TRACED = [
  'received',
  'event',
  'targetEvent',
  'receiveAttachment',
  'notePageUnderTab',
  'skippedAttachment',
  'privateAttachment',
  'cutWorker',
  'tabAttached',
  'pausedTab',
  'resumeArmed',
  'watch',
  'inspect',
  'verify',
  'proofTree',
  'createdTargetInfo',
  'createdReady',
  'createdOwner',
  'proofInfo',
  'treeEstimate',
  'placedTarget',
  'target',
  'lookup',
  'crossOpener',
  'attachmentProof',
  'stranded',
  'retainedBlank',
  'current',
  'freshFrames',
  'blank',
  'named',
  'touch',
  'arm',
  'place',
  'focusCreated',
  'shownTarget',
  'attachmentShown',
  'cut',
  'uncertainProof',
  'completeProof',
  'targetHint',
  'deliver',
  'call',
  'refuse',
];

export function installDiag(pages, methods) {
  const watchPages = new Set(pages);
  const traced = [];
  globalThis.sliccDiagTraced = traced;
  const short = (value, cap = 700) => {
    try {
      const text = JSON.stringify(value, (_key, item) => {
        if (item instanceof Map) return { map: [...item].slice(0, 20) };
        if (item instanceof Set) return { set: [...item].slice(0, 40) };
        if (item instanceof Promise) return 'promise';
        if (typeof item === 'function') return undefined;
        if (typeof item === 'string' && item.length > 200) return `${item.slice(0, 200)}...`;
        return item;
      });
      return text && text.length > cap ? `${text.slice(0, cap)}...` : text;
    } catch (error) {
      return `unserializable ${error.message}`;
    }
  };
  const leaves = (value, out = new Set(), depth = 0) => {
    if (typeof value === 'string') {
      if (value.length <= 64) out.add(value);
      return out;
    }
    if (!value || typeof value !== 'object' || depth > 3 || value instanceof Promise) return out;
    const items = Array.isArray(value) ? value.slice(0, 20) : Object.values(value).slice(0, 30);
    for (const item of items) leaves(item, out, depth + 1);
    return out;
  };
  const watchOf = (guard, entry) => {
    const ids = new Set([...watchPages, ...entry.extra]);
    for (const [frame] of guard.parents) {
      let at = frame;
      for (let n = 0; n < 16 && at; n++) {
        at = guard.parents.get(at);
        if (watchPages.has(at)) {
          ids.add(frame);
          break;
        }
      }
    }
    for (const [sessionId, known] of guard.sessions)
      if (ids.has(known?.targetId)) ids.add(sessionId);
    for (const id of watchPages) {
      const nav = guard.navs.get(id);
      if (nav?.session) ids.add(nav.session);
    }
    for (const [tab, page] of guard.tabPages)
      if (watchPages.has(page?.targetId)) {
        ids.add(tab);
        if (page.session) ids.add(page.session);
      }
    return ids;
  };
  globalThis.sliccDiagWatch = watchOf;
  globalThis.sliccDiagShort = short;
  globalThis.sliccDiagPages = watchPages;
  globalThis.sliccDiagGuardHook = (guard) => {
    const entry = {
      serial: traced.length + 1,
      at: Date.now(),
      guard,
      route: guard.route,
      device: guard.device,
      log: [],
      queue: [],
      extra: new Set(),
      current: null,
    };
    traced.push(entry);
    const push = (list, record) => {
      list.push(record);
      if (list.length > 6000) list.splice(0, list.length - 6000);
    };
    for (const name of methods) {
      const original = guard[name];
      if (typeof original !== 'function') continue;
      if (name === 'received') {
        guard.received = function (text) {
          const raw = String(text);
          let watch;
          try {
            watch = watchOf(guard, entry);
          } catch {
            watch = new Set(watchPages);
          }
          let hit = null;
          for (const id of watch)
            if (raw.includes(id)) {
              hit = id;
              break;
            }
          let summary = null;
          if (hit || raw.length < 20000) {
            try {
              const message = JSON.parse(raw);
              summary = {
                id: message.id,
                method: message.method,
                sessionId: message.sessionId,
                target: message.params?.targetInfo?.targetId ?? message.params?.targetId,
                session: message.params?.sessionId,
              };
              if (
                message.method === 'Target.attachedToTarget' &&
                watchPages.has(message.params?.targetInfo?.targetId)
              ) {
                if (message.sessionId) entry.extra.add(message.sessionId);
                if (message.params?.sessionId) entry.extra.add(message.params.sessionId);
              }
            } catch {}
          }
          if (hit)
            push(entry.log, {
              t: Date.now(),
              fn: 'received',
              hit: [hit],
              args: short(summary),
              ms: 0,
            });
          entry.current = summary;
          try {
            return original.call(this, text);
          } finally {
            entry.current = null;
          }
        };
        continue;
      }
      guard[name] = function (...args) {
        let watch;
        try {
          watch = watchOf(guard, entry);
        } catch {
          watch = new Set(watchPages);
        }
        const found = [...leaves(args)].filter((id) => watch.has(id));
        if (!found.length) return original.apply(this, args);
        const record = { t: Date.now(), fn: name, hit: found.slice(0, 4), args: short(args) };
        push(entry.log, record);
        const result = original.apply(this, args);
        if (result && typeof result.then === 'function')
          result.then(
            (value) => {
              record.ms = Date.now() - record.t;
              record.value = short(value, 500);
            },
            (error) => {
              record.ms = Date.now() - record.t;
              record.threw = String(error?.message ?? error);
            }
          );
        else {
          record.ms = 0;
          record.value = short(result, 300);
        }
        return result;
      };
    }
    const queue = guard.queue;
    guard.queue = function (key, task, failed) {
      let watch;
      try {
        watch = watchOf(guard, entry);
      } catch {
        watch = new Set(watchPages);
      }
      const bare = String(key).replace(/^send:/, '');
      const tabbed = guard.tabSessions.has(bare);
      if (!watch.has(bare) && !tabbed) return queue.call(this, key, task, failed);
      const record = {
        t: Date.now(),
        key,
        tab: tabbed,
        behind: guard.queues.has(key),
        label: entry.current,
      };
      push(entry.queue, record);
      return queue.call(
        this,
        key,
        async (...rest) => {
          record.started = Date.now();
          try {
            return await task(...rest);
          } finally {
            record.ended = Date.now();
          }
        },
        failed
      );
    };
  };
  return true;
}

export function dumpDiag(since, from) {
  const traced = globalThis.sliccDiagTraced ?? [];
  const short = globalThis.sliccDiagShort;
  const watchOf = globalThis.sliccDiagWatch;
  const pages = globalThis.sliccDiagPages ?? new Set();
  const now = Date.now();
  return traced
    .filter((entry) => entry.at >= since)
    .map((entry) => {
      const g = entry.guard;
      const watch = watchOf(g, entry);
      const sessionView = (sid) => {
        const known = g.sessions.get(sid);
        return {
          sid,
          targetId: known?.targetId,
          parent: known?.parent,
          entry: short(known, 300),
          shown: g.shown.has(sid),
          blocked: g.blocked.has(sid),
          gone: g.gone.has(sid),
          quarantined: g.quarantined.has(sid),
          watching: g.watching.has(sid),
          private: g.privateSessions.has(sid),
          navSession: g.navSessions.has(sid),
          tab: g.tabSessions.has(sid),
          paused: g.pausedSessions.has(sid),
          pages: g.pages.has(sid),
          runtimes: g.runtimes.has(sid),
          uncommitted: g.uncommitted.has(sid),
          pendingCommit: g.pendingCommit.has(sid),
          pendingHistory: g.pendingHistory.has(sid),
          settled: short(g.settled.get(sid), 200),
          queuePending: g.queues.has(sid),
          sendQueuePending: g.queues.has(`send:${sid}`),
          autoAttach: short(g.autoAttachments.get(sid), 200),
          tabPage: short(g.tabPages.get(sid), 200),
          internalPending: [...g.internal.values()].filter((answer) => answer.sessionId === sid)
            .length,
        };
      };
      const targetView = (id) => {
        const nav = g.navs.get(id);
        const known = g.targets.get(id);
        return {
          id,
          guardTargetInfo: known && {
            type: known.type,
            url: known.url,
            openerId: known.openerId,
            parentId: known.parentId,
            parentFrameId: known.parentFrameId,
            was: known.was,
            guarded: known.guarded,
            real: known.real,
            ageMs: now - known.at,
            info: short(known.info, 400),
          },
          frameUrl: g.frames.get(id),
          frameParent: g.parents.get(id),
          proofNeeded: g.proofNeeded.has(id),
          failedProof: g.failedProof.has(id),
          retired: g.retiredTargets.has(id),
          proofEpoch: g.proofEpoch.get(id),
          proofCommit: short(g.proofCommits.get(id), 300),
          estimated: g.estimated.has(id),
          errorFrame: g.errorFrames.has(id),
          frameRoot: g.frameRoots.get(id),
          recalled: g.recalled.has(id),
          hint: short(g.hints.get(id), 300),
          tabRecord: short(g.tabs.get(id), 200),
          createdUnset: known ? g.createdUnset(known.info ?? known) : null,
          pendingTarget: g.pendingTarget(id),
          placing: g.placing.has(id),
          nav: nav && {
            session: nav.session,
            done: nav.done,
            failed: nav.failed,
            held: nav.held,
            admitted: nav.admitted,
            retired: nav.retired,
            cause: nav.cause,
            ended: nav.ended,
            taken: nav.taken,
            created: nav.created,
            scrub: Boolean(nav.scrub),
            erred: nav.erred,
            holds: nav.holds,
          },
          pendingAttachments: [...g.pendingAttachments].filter((one) => one.targetId === id).length,
          sessions: [...g.sessions]
            .filter(([, known]) => known?.targetId === id)
            .map(([sid]) => sessionView(sid)),
        };
      };
      const frames = [...watch].filter((id) => g.parents.has(id) && !pages.has(id));
      const fields = {};
      for (const [name, value] of Object.entries(g)) {
        if (!(value instanceof Map || value instanceof Set)) continue;
        const hits = [];
        if (value instanceof Set) {
          for (const item of value)
            if (typeof item === 'string' ? watch.has(item) : watch.has(item?.targetId))
              hits.push(typeof item === 'string' ? item : short(item, 150));
        } else {
          for (const [key, item] of value)
            if (
              (typeof key === 'string' && watch.has(key)) ||
              (item &&
                typeof item === 'object' &&
                !(item instanceof Promise) &&
                (watch.has(item.targetId) || watch.has(item.sessionId)))
            )
              hits.push(`${short(key, 80)} => ${short(item, 150)}`);
        }
        if (hits.length) fields[name] = hits.slice(0, 12);
      }
      const log = entry.log.filter((record) => record.t >= from);
      const stuck = entry.log.filter((record) => record.ms === undefined && !record.threw);
      return {
        serial: entry.serial,
        createdAt: entry.at,
        route: entry.route,
        device: entry.device,
        closed: g.closed,
        watch: [...watch],
        pages: [...pages].map(targetView),
        frames: frames.map(targetView),
        tabs: [...g.tabSessions].map(sessionView),
        fields,
        queueOpen: entry.queue
          .filter((record) => record.ended === undefined)
          .map((record) => ({ ...record, label: short(record.label, 200) })),
        queueDone: entry.queue
          .filter((record) => record.ended !== undefined && record.t >= from)
          .map((record) => ({ ...record, label: short(record.label, 200) })),
        stuck: stuck.map((record) => ({
          t: record.t,
          fn: record.fn,
          hit: record.hit,
          args: record.args,
        })),
        log,
      };
    });
}

export function nodeFrames(since) {
  return (globalThis.sliccDiagNode?.frames ?? []).filter((frame) => frame.t >= since);
}

export function uninstallDiag() {
  globalThis.sliccDiagGuardHook = undefined;
  return true;
}

const text = (value) => {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return `unserializable ${error.message}`;
  }
};

export function frameTreeOrder(frames, pageIds) {
  const out = [];
  for (const pageId of pageIds) {
    for (const attach of frames.filter(
      (frame) =>
        frame.dir === 'in' &&
        frame.method === 'Target.attachedToTarget' &&
        frame.targetInfo?.targetId === pageId
    )) {
      const session = attach.session;
      const conn = attach.conn;
      const asking = new Set(
        frames
          .filter(
            (frame) =>
              frame.conn === conn &&
              frame.dir === 'out' &&
              frame.t >= attach.t &&
              (frame.params ?? '').includes(pageId)
          )
          .map((frame) => frame.id)
      );
      const mine = frames.filter(
        (frame) =>
          frame.conn === conn &&
          frame.t >= attach.t &&
          (frame.sessionId === session ||
            (frame.params ?? '').includes(pageId) ||
            (frame.dir === 'in' && frame.sessionId === undefined && asking.has(frame.id)))
      );
      const asked = mine.find(
        (frame) =>
          frame.dir === 'out' && frame.method === 'Page.getFrameTree' && frame.sessionId === session
      );
      const answer =
        asked &&
        frames.find(
          (frame) =>
            frame.dir === 'in' &&
            frame.conn === conn &&
            frame.id === asked.id &&
            frame.sessionId === session
        );
      const start = mine.find((frame) => frame.dir === 'out')?.t ?? attach.t;
      out.push({
        pageId,
        session,
        envelope: attach.sessionId ?? null,
        conn,
        attachedAt: attach.t,
        firstGetFrameTree: asked
          ? {
              id: asked.id,
              sentMs: asked.t - attach.t,
              replyMs: answer ? answer.t - asked.t : null,
              error: answer?.error ?? null,
              result: answer && !answer.error ? (answer.result ?? answer.resultKeys) : null,
            }
          : null,
        order: mine
          .filter((frame) => frame.t - start <= 1000)
          .map((frame) => [
            frame.t - attach.t,
            frame.dir,
            frame.id ?? null,
            frame.method ?? frame.for ?? null,
            frame.sessionId === session ? 'page-session' : (frame.sessionId ?? 'browser'),
            frame.error?.message ?? null,
            frame.waited ?? null,
          ]),
      });
    }
  }
  return out;
}

export async function diagBegin(page, label, pageIds) {
  const tag = label.replace(/\s+/g, '_');
  const started = Date.now();
  process.stdout.write(`DIAG-START ${tag} ${started} ${text({ pageIds })}\n`);
  await page.evaluate(installDiag, pageIds, TRACED).catch((error) => {
    process.stdout.write(`DIAG-ERROR ${tag} install ${error.message}\n`);
  });
  let last = started;
  const dump = async (mark) => {
    const from = last;
    last = Date.now();
    try {
      const guards = await page.evaluate(dumpDiag, started, from);
      for (const guard of guards) {
        const { log, queueDone, ...state } = guard;
        process.stdout.write(
          `DIAG-GUARD ${tag} ${mark} +${Date.now() - started}ms ${text(state)}\n`
        );
        for (const record of queueDone)
          process.stdout.write(
            `DIAG-GUARD-QUEUE ${tag} ${mark} guard${guard.serial} ${record.t - started} ${text(record)}\n`
          );
        for (const record of log)
          process.stdout.write(
            `DIAG-GUARD-TRACE ${tag} ${mark} guard${guard.serial} ${record.t - started} ${text(record)}\n`
          );
      }
      if (!guards.length) process.stdout.write(`DIAG-GUARD ${tag} ${mark} no guard yet\n`);
    } catch (error) {
      process.stdout.write(`DIAG-ERROR ${tag} dump ${mark} ${error.message}\n`);
    }
  };
  const timers = [3000, 10000, 20000].map((ms) => setTimeout(() => void dump(`${ms / 1000}s`), ms));
  const end = async () => {
    for (const timer of timers) clearTimeout(timer);
    await dump('end');
    try {
      const frames = await page.evaluate(nodeFrames, started);
      for (const frame of frames)
        process.stdout.write(`DIAG-NODE ${tag} ${frame.t - started} ${frame.dir} ${text(frame)}\n`);
      const waits = frames
        .filter((frame) => frame.dir === 'in' && frame.waited !== undefined)
        .filter((frame) => frame.waited >= 500 || frame.for === 'Page.createIsolatedWorld')
        .map((frame) => [frame.conn, frame.id, frame.for, frame.sessionId, frame.waited]);
      process.stdout.write(`DIAG-NODE-WAITS ${tag} ${text(waits)}\n`);
      for (const gft of frameTreeOrder(frames, pageIds))
        process.stdout.write(`DIAG-NODE-GFT ${tag} ${text(gft)}\n`);
    } catch (error) {
      process.stdout.write(`DIAG-ERROR ${tag} node ${error.message}\n`);
    }
    await page.evaluate(uninstallDiag).catch(() => {});
  };
  return { tag, started, end };
}
