export const DIAG_ROWS = new Set(['C3.tab-iframe-leak']);

export function installGuardTrace() {
  if (globalThis.sliccDiagAttach) return;
  globalThis.sliccDiagRows = new Set();
  globalThis.sliccDiagTraces = new Map();
  const ids = /\b([0-9A-F]{8})[0-9A-F]{24}\b/g;
  const short = (value, cap = 300) => {
    try {
      const text = JSON.stringify(value, (_key, item) => {
        if (item instanceof Map) return { map: [...item].slice(0, 40) };
        if (item instanceof Set) return { set: [...item].slice(0, 60) };
        if (item instanceof Promise) return 'promise';
        if (typeof item === 'function') return undefined;
        if (typeof item === 'string' && item.length > 160) return `${item.slice(0, 160)}...`;
        return item;
      })?.replace(ids, '$1');
      return text && text.length > cap ? `${text.slice(0, cap)}...` : text;
    } catch (error) {
      return `unserializable ${error.message}`;
    }
  };
  const info = (targetInfo) =>
    targetInfo && {
      id: targetInfo.targetId,
      type: targetInfo.type,
      url: String(targetInfo.url ?? '').slice(0, 120),
      parentId: targetInfo.parentId,
      openerId: targetInfo.openerId,
      openerFrameId: targetInfo.openerFrameId,
      canAccessOpener: targetInfo.canAccessOpener,
      attached: targetInfo.attached,
      ctx: targetInfo.browserContextId,
    };
  const summary = (message) => {
    const params = message.params ?? {};
    return {
      id: message.id,
      m: message.method,
      s: message.sessionId,
      ...(params.targetInfo ? { ti: info(params.targetInfo) } : {}),
      ...(params.sessionId ? { child: params.sessionId } : {}),
      ...(params.targetId ? { tid: params.targetId } : {}),
      ...(params.waitingForDebugger !== undefined ? { wait: params.waitingForDebugger } : {}),
      ...(params.frame
        ? {
            frame: {
              id: params.frame.id,
              parentId: params.frame.parentId,
              url: String(params.frame.url ?? '').slice(0, 100),
            },
          }
        : {}),
      ...(params.frameId ? { frameId: params.frameId, parentFrameId: params.parentFrameId } : {}),
      ...(message.error ? { err: message.error.message } : {}),
      ...(message.result !== undefined ? { r: short(message.result, 400) } : {}),
    };
  };
  const STACKED = new Set([
    'refuse',
    'uncertainProof',
    'cut',
    'cutTarget',
    'retireProof',
    'quarantine',
  ]);
  const STATED = new Set(['refuse']);
  const METHODS = [
    'proveContent',
    'admitContent',
    'refuseUnsafeContent',
    'check',
    'precheck',
    'pageCheck',
    'locked',
    'placed',
    'reread',
    'extensionGate',
    'recover',
    'frameRefused',
    'inspect',
    'verify',
    'watch',
    'proofTree',
    'provePlacement',
    'uncertainProof',
    'completeProof',
    'retireProof',
    'cut',
    'cutTarget',
    'refuse',
    'receiveAttachment',
    'tabAttached',
    'targetEvent',
    'skippedAttachment',
    'privateAttachment',
    'placePrivateFrames',
    'current',
    'target',
    'createdTargetInfo',
    'createdReady',
    'createdOwner',
    'proofInfo',
    'treeEstimate',
    'touch',
    'arm',
    'surface',
    'confirmed',
    'observing',
    'recheck',
    'notePageUnderTab',
    'attachmentShown',
    'resumeArmed',
    'pausedTab',
    'shownTarget',
    'decide',
    'attachDecided',
    'create',
    'tabCommand',
    'heldTab',
    'ordinaryTab',
    'targetHint',
    'receiveHint',
    'quarantine',
    'pass',
    'sendChecked',
    'attachmentProof',
    'placedTarget',
    'retainedBlank',
    'opener',
    'openerInfo',
    'crossOpener',
    'surfaceOpener',
    'prelude',
    'cutWorker',
    'receiveFrame',
    'focusCreated',
    'emulatedAutoAttach',
    'answer',
    'targetAnswer',
    'reachTarget',
    'reaching',
    'guarding',
    'stranded',
    'heldAncestry',
    'frameAncestry',
    'place',
    'placeOne',
    'refresh',
    'renew',
    'lost',
    'blank',
    'named',
    'pendingTarget',
    'forgetTab',
    'rememberTab',
    'discardPending',
    'refusePending',
    'hidden',
  ];
  globalThis.sliccDiagAttach = (guard, tag) => {
    const started = performance.now();
    const log = [];
    const entry = { tag, route: guard.route, log, started: Date.now() };
    globalThis.sliccDiagTraces.set(tag, entry);
    const push = (record) => {
      if (log.length < 15000) log.push({ t: Math.round(performance.now() - started), ...record });
      else entry.dropped = (entry.dropped ?? 0) + 1;
    };
    const stack = () =>
      String(new Error().stack ?? '')
        .split('\n')
        .filter((line) => line.includes('guard.js'))
        .slice(0, 8)
        .map((line) =>
          line
            .trim()
            .replace(/^at /, '')
            .replace(/(?:https?|file):\/\/[^ )]*\/([a-z-]+\.js)/, '$1')
        )
        .join(' < ');
    const state = () => {
      const g = guard;
      const cut = (id) => (typeof id === 'string' ? id.replace(ids, '$1') : id);
      return short(
        {
          proofNeeded: [...g.proofNeeded],
          failedProof: [...g.failedProof],
          estimated: [...g.estimated],
          proofEpoch: Object.fromEntries(g.proofEpoch),
          frameRoots: Object.fromEntries(g.frameRoots),
          retired: [...g.retiredTargets],
          pendingAttachments: [...g.pendingAttachments].map((nav) => cut(nav.targetId)),
          sessions: [...g.sessions].map(([id, known]) => [
            id,
            known?.targetId,
            known?.parent,
            [
              g.shown.has(id) && 'shown',
              g.blocked.has(id) && 'blocked',
              g.gone.has(id) && 'gone',
              g.watching.has(id) && 'watching',
              g.privateSessions.has(id) && 'private',
              g.quarantined.has(id) && 'quarantined',
              g.tabSessions.has(id) && 'tab',
              g.pausedSessions.has(id) && 'paused',
            ].filter(Boolean),
          ]),
          targets: [...g.targets].map(([id, known]) => [
            id,
            known?.type,
            String(known?.url ?? '').slice(0, 90),
            known?.parentId,
            known?.openerId,
            known?.guarded,
            known?.browserContextId,
          ]),
          navs: [...g.navs].map(([id, nav]) => [
            id,
            nav.session,
            {
              created: nav.created,
              done: nav.done,
              failed: nav.failed,
              admitted: nav.admitted,
              retired: nav.retired,
              held: nav.held,
              cause: nav.cause,
            },
          ]),
          tabPages: [...g.tabPages].map(([tab, page]) => [tab, page?.targetId, page?.session]),
          tabTargets: [...g.tabTargets],
          scopes: [...g.scopes].map(([id, scope]) => [
            id,
            scope.sessionId,
            scope.parent,
            scope.root,
            scope.privatePlaced,
            scope.remoteOwners?.size,
          ]),
          placing: [...g.placing.keys()],
          parents: [...g.parents].slice(0, 40),
          decided: [...g.decided],
          autoAttachments: [...g.autoAttachments.keys()],
          hints: [...g.hints.keys()],
        },
        12000
      );
    };
    entry.state = state;
    for (const name of METHODS) {
      const original = guard[name];
      if (typeof original !== 'function') continue;
      guard[name] = function (...args) {
        const record = { k: 'fn', fn: name, a: short(args) };
        if (STACKED.has(name)) record.at = stack();
        if (STATED.has(name)) record.state = state();
        push(record);
        let result;
        try {
          result = original.apply(this, args);
        } catch (error) {
          record.threw = String(error?.message ?? error);
          throw error;
        }
        if (result && typeof result.then === 'function') {
          const begun = performance.now();
          result.then(
            (value) => {
              push({
                k: 'ret',
                fn: name,
                ref: record.t,
                ms: Math.round(performance.now() - begun),
                v: short(value, 200),
                a: record.a.slice(0, 120),
              });
            },
            (error) => {
              push({ k: 'ret', fn: name, ref: record.t, threw: String(error?.message ?? error) });
            }
          );
        } else record.v = short(result, 200);
        return result;
      };
    }
    if (typeof guard.privateFrames === 'function') {
      const hook = guard.privateFrames;
      guard.privateFrames = (...args) => {
        push({ k: 'frames', a: short(args) });
        const result = hook(...args);
        Promise.resolve(result).then(
          (value) => push({ k: 'frames-ret', v: short(value, 1200) }),
          (error) => push({ k: 'frames-ret', threw: String(error?.message ?? error) })
        );
        return result;
      };
    }
    const received = guard.received;
    guard.received = function (text) {
      try {
        push({ k: 'in', ...summary(JSON.parse(text)) });
      } catch {}
      return received.call(this, text);
    };
    const connection = guard.connection;
    const send = connection.send.bind(connection);
    connection.send = (text) => {
      try {
        const message = JSON.parse(text);
        push({
          k: 'out',
          id: message.id,
          m: message.method,
          s: message.sessionId,
          p: short(message.params, 200),
        });
      } catch {}
      return send(text);
    };
    const guarded = guard.guarded;
    let clientSend;
    let clientSink;
    Object.defineProperty(guarded, 'send', {
      configurable: true,
      get: () => clientSend,
      set: (fn) => {
        clientSend = (text) => {
          try {
            const message = JSON.parse(text);
            push({
              k: 'client',
              id: message.id,
              m: message.method,
              s: message.sessionId,
              p: short(message.params, 300),
            });
          } catch {}
          return fn(text);
        };
      },
    });
    Object.defineProperty(guarded, 'onmessage', {
      configurable: true,
      get: () => clientSink,
      set: (fn) => {
        clientSink =
          typeof fn === 'function'
            ? (text) => {
                try {
                  push({ k: 'toClient', ...summary(JSON.parse(text)) });
                } catch {}
                return fn(text);
              }
            : fn;
      },
    });
  };
}

export function takeGuardTrace(tag) {
  const entry = globalThis.sliccDiagTraces?.get(tag);
  if (!entry) return null;
  globalThis.sliccDiagTraces.delete(tag);
  let final = null;
  try {
    final = entry.state();
  } catch (error) {
    final = `unavailable ${error.message}`;
  }
  return {
    tag,
    route: entry.route,
    started: entry.started,
    dropped: entry.dropped ?? 0,
    log: entry.log,
    final,
  };
}
