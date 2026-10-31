import { readFile } from 'node:fs/promises';

const CAP = 1024;
const PROTECTED =
  'slicc: refused: seven’s own pages and the vault are out of reach of browser automation';
const ORIGIN = "slicc: refused: target is on seven's origin";

export function recoveryBridge(connection, side) {
  const state = (globalThis.sliccRecoveryEvidence ??= { next: 0, channels: 0, rows: [] });
  const channel = side === 'extension' ? ++state.channels : state.channels;
  const methods = new Map();
  const selected = new Set([
    'Target.getTargets',
    'Target.getTargetInfo',
    'Target.attachToTarget',
    'Target.detachFromTarget',
    'Target.targetInfoChanged',
    'Target.detachedFromTarget',
    'Page.getFrameTree',
    'Page.enable',
    'Page.navigate',
    'Page.frameNavigated',
    'Page.frameStartedNavigating',
    'Page.loadEventFired',
    'Network.loadingFailed',
  ]);
  const record = (direction, text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (direction === 'send') methods.set(message.id, message.method);
    const method = message.method ?? methods.get(message.id);
    if (direction === 'receive' && message.id !== undefined) methods.delete(message.id);
    if (!selected.has(method) && !message.error) return;
    const params = message.params ?? {};
    const result = message.result ?? {};
    const info = result.targetInfo ?? params.targetInfo;
    const frame = result.frameTree?.frame ?? params.frame;
    const seq = state.next++;
    state.rows[seq % 1024] = {
      seq,
      at: Date.now(),
      side,
      channel,
      direction,
      id: message.id,
      method,
      sessionId: message.sessionId,
      targetId: params.targetId ?? info?.targetId,
      type: info?.type,
      url: params.url ?? info?.url,
      frame: frame && {
        id: frame.id,
        parentId: frame.parentId,
        loaderId: frame.loaderId,
        url: frame.url,
        securityOrigin: frame.securityOrigin,
        unreachableUrl: frame.unreachableUrl,
      },
      targets: Array.isArray(result.targetInfos)
        ? result.targetInfos.map((target) => ({
            targetId: target.targetId,
            type: target.type,
            url: target.url,
            active: target.active,
          }))
        : undefined,
      attached: result.sessionId,
      frameId: result.frameId,
      loaderId: result.loaderId,
      errorText: result.errorText ?? params.errorText,
      isDownload: result.isDownload,
      error: message.error && { code: message.error.code, message: message.error.message },
    };
  };
  const closed = (direction) => {
    const seq = state.next++;
    state.rows[seq % 1024] = { seq, at: Date.now(), side, channel, direction };
  };
  const outer = {
    onmessage: null,
    onclose: null,
    send(text) {
      record('send', text);
      connection.send(text);
    },
    close() {
      closed('close');
      connection.close();
    },
  };
  connection.onmessage = (text) => {
    record('receive', text);
    outer.onmessage?.(text);
  };
  connection.onclose = (...args) => {
    closed('closed');
    outer.onclose?.(...args);
  };
  return outer;
}

export function recoveryUrl(value) {
  if (typeof value !== 'string' || !value) return value;
  try {
    const url = new URL(value);
    if (url.origin === 'null') return `${url.protocol}//`;
    return `${url.origin}${/^\/recovery-(seed|hop|destination)\.html$|^\/vault$/.test(url.pathname) ? url.pathname : ''}`;
  } catch {
    return 'opaque';
  }
}

function reason(message) {
  if (message === PROTECTED) return 'bios-protected';
  if (message === ORIGIN) return 'origin-refusal';
  if (message?.startsWith('slicc: refused:')) return 'other-refusal';
  return message ? 'other-error' : undefined;
}

function clean(row) {
  return {
    ...row,
    url: recoveryUrl(row.url),
    frame: row.frame && {
      ...row.frame,
      url: recoveryUrl(row.frame.url),
      securityOrigin: recoveryUrl(row.frame.securityOrigin),
      unreachableUrl: recoveryUrl(row.frame.unreachableUrl),
    },
    targets: row.targets?.map((target) => ({ ...target, url: recoveryUrl(target.url) })),
    errorText: row.errorText
      ? /^net::ERR_[A-Z_]+$/.test(row.errorText)
        ? row.errorText
        : 'navigation-error'
      : undefined,
    error: row.error && { code: row.error.code, reason: reason(row.error.message) },
  };
}

export function recoveryBranch(rows) {
  const recovery = rows.filter((row) => row.side === 'cli' && row.channel === 4);
  const replies = recovery.filter((row) => row.direction === 'receive' && row.id !== undefined);
  const info = replies.find((row) => row.method === 'Target.getTargetInfo');
  const navigation = replies.find((row) => row.method === 'Page.navigate');
  const normal = recovery.some(
    (row) => row.direction === 'send' && row.method === 'Target.getTargets'
  );
  const tree = replies.find((row) => row.method === 'Page.getFrameTree');
  const failed = replies.find(
    (row) => row.error && !(row.method === 'Page.getFrameTree' && row.error.message === PROTECTED)
  );
  if (!recovery.length) return { branch: 'recovery connection not observed' };
  let branch;
  if (navigation?.frameId && navigation.loaderId && !navigation.errorText && !navigation.isDownload)
    branch = 'after accepted navigation reply';
  else if (failed?.method === 'Target.getTargetInfo') branch = 'before navigation-away operation';
  else if (normal) branch = 'normal goto after navigation-away eligibility declined';
  else if (failed) branch = `refused ${failed.method}`;
  else if (tree && !recovery.some((row) => row.method === 'Page.enable'))
    branch = 'navigation-away frame-tree precondition';
  else if (info && !recovery.some((row) => row.method === 'Page.navigate'))
    branch = 'navigation-away eligibility or pre-navigation proof';
  else branch = 'navigation reply or later proof';
  if (!failed)
    return { branch, layer: 'CLI decision or later proof', targetInfo: info && clean(info) };
  const forwarded = rows.find(
    (row) =>
      row.side === 'extension' &&
      row.channel === failed.channel &&
      row.direction === 'send' &&
      row.id === failed.id &&
      row.method === failed.method
  );
  const backend = rows.find(
    (row) =>
      row.side === 'extension' &&
      row.channel === failed.channel &&
      row.direction === 'receive' &&
      row.id === failed.id
  );
  const request = recovery.find((row) => row.direction === 'send' && row.id === failed.id);
  const proofRefusals = rows
    .filter(
      (row) =>
        row.side === 'extension' &&
        row.channel === failed.channel &&
        row.direction === 'receive' &&
        row.error &&
        row.seq >= (request?.seq ?? 0) &&
        row.seq <= failed.seq
    )
    .map(clean);
  return {
    branch,
    layer: backend?.error
      ? 'extension reply'
      : forwarded
        ? 'BIOS answer check'
        : 'BIOS preflight check',
    proofRefusals,
    refusal: clean(failed),
    extensionReply: backend && clean(backend),
    targetInfo: info && clean(info),
  };
}

export async function recoveryEvidence(real, page) {
  const raw = [];
  const workers = new Set();
  const stop = real.cdp.on(({ method, params = {} }) => {
    if (raw.length >= 64) return;
    const info = params.targetInfo;
    if (info?.type === 'service_worker' && info.url?.startsWith('chrome-extension:')) {
      workers.add(info.targetId);
      raw.push({ at: Date.now(), method, targetId: info.targetId, type: info.type });
    }
    if (method === 'Target.targetDestroyed' && workers.has(params.targetId))
      raw.push({ at: Date.now(), method, targetId: params.targetId });
    if (method === 'Page.frameNavigated' && !params.frame?.parentId)
      raw.push({ at: Date.now(), method, frame: params.frame });
    if (method === 'Network.loadingFailed' && params.type === 'Document')
      raw.push({ at: Date.now(), method, errorText: params.errorText });
  });
  const source = await readFile(new URL('../../src/seed/cdp.js', import.meta.url), 'utf8');
  const marker =
    'return observe(guardProtected(await open(), own, browser ? tabs.get(browser) : undefined));';
  const installed = source.split(marker).length === 2;
  if (installed)
    real.overrides.set(
      '/seed/cdp.js',
      source.replace(
        marker,
        `return observe((${recoveryBridge.toString()})(guardProtected((${recoveryBridge.toString()})(await open(), 'extension'), own, browser ? tabs.get(browser) : undefined), 'cli'));`
      )
    );
  return {
    stop,
    async report(scenario) {
      stop();
      const state = await page.evaluate(() => {
        const state = globalThis.sliccRecoveryEvidence;
        const cdp = (document.querySelector('slicc-app')?.model?.updates?.packages?.() ?? []).find(
          (row) => row.package === '@ai-ecoverse/slicc-cdp'
        );
        return {
          next: state?.next,
          channels: state?.channels,
          rows: state?.rows ?? [],
          reportedCdpVersion: cdp?.version,
        };
      });
      const rows = (state?.rows ?? []).sort((a, b) => a.seq - b.seq);
      const report = {
        scenario,
        observedAt: Date.now(),
        installed,
        channels: state?.channels,
        reportedCdpVersion: state?.reportedCdpVersion,
        truncated: (state?.next ?? 0) > CAP,
        summary: recoveryBranch(rows),
        rawCapped: raw.length === 64,
        raw: raw.map((row) =>
          clean({
            ...row,
            frame: row.frame && {
              id: row.frame.id,
              loaderId: row.frame.loaderId,
              url: row.frame.url,
              securityOrigin: row.frame.securityOrigin,
              unreachableUrl: row.frame.unreachableUrl,
            },
          })
        ),
        rows: rows.map(clean),
      };
      const { targetInfos } = await real.cdp.send('Target.getTargets');
      report.targetsAfterFailure = targetInfos
        .filter((target) => target.type === 'page' || target.type === 'service_worker')
        .map((target) => ({
          targetId: target.targetId,
          type: target.type,
          url: recoveryUrl(target.url),
        }));
      return report;
    },
  };
}
