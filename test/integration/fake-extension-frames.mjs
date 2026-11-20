import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

const UNSETTLED = 'slicc: refused: unsettled frame list';
export const ERROR_PROTECTED_FROM = '7.15.0';
const SIGN_IN_MARKERS = ['redirect_uri=', 'client_id=', '/auth/callback'];
const DECODE_ROUNDS = 8;

export const sendsErrorProtected = (version) => {
  const have = String(version ?? '')
    .split('.')
    .map(Number);
  const want = ERROR_PROTECTED_FROM.split('.').map(Number);
  for (let index = 0; index < want.length; index++) {
    if (!Number.isSafeInteger(have[index])) return false;
    if (have[index] !== want[index]) return have[index] > want[index];
  }
  return true;
};

function signInMarked(text) {
  let current = text;
  for (let round = 0; ; round += 1) {
    const lower = current.toLowerCase();
    if (SIGN_IN_MARKERS.some((marker) => lower.includes(marker))) return true;
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (next === current) return false;
    if (round === DECODE_ROUNDS) return true;
    current = next;
  }
}

function errorUrlProtected(text, is) {
  if (typeof text !== 'string' || /[\s\\\u0000-\u001f\u007f]/.test(text) || !URL.canParse(text))
    return true;
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    return true;
  if (is.url(text)) return true;
  return signInMarked(text) || signInMarked(url.href);
}
const WAIT = 2000;
let revision = 0;
let diagnosed = 0;

function diag(line) {
  if (diagnosed >= 60) return;
  diagnosed += 1;
  process.stdout.write(`DIAG-FRAMES ${line.slice(0, 2000)}\n`);
}

function connect(browser) {
  const socket = new WebSocket(browser);
  const pending = new Map();
  let next = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  };
  const opened = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      next += 1;
      pending.set(next, { resolve, reject });
      socket.send(
        JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) })
      );
    });
  return { opened, send, close: () => socket.close() };
}

const walk = (node) => [node.frame, ...(node.childFrames ?? []).flatMap(walk)];

function kindOf(frame, is) {
  const url = frame.url;
  if (frame.errorOccurred || url?.startsWith('chrome-error:')) return 'error';
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || !URL.canParse(url)) return 'unknown';
  if (is.url(url)) return 'protected';
  return 'ordinary';
}

async function snapshot(cdp, targetId, errors) {
  const refuse = (why) => {
    const error = new Error(UNSETTLED);
    error.why = why;
    throw error;
  };
  const { targetInfos } = await cdp.send('Target.getTargets');
  const byId = new Map(targetInfos.map((info) => [info.targetId, info]));
  if (byId.get(targetId)?.type !== 'page') refuse('target is not a page');
  const under = (info) => {
    const seen = new Set();
    for (let id = info.parentId; id && !seen.has(id); id = byId.get(id)?.parentId) {
      if (id === targetId) return true;
      seen.add(id);
    }
    return false;
  };
  const entries = targetInfos.filter((info) => info.type === 'iframe' && under(info));
  const attach = async (id) =>
    (await cdp.send('Target.attachToTarget', { targetId: id, flatten: true })).sessionId;
  const top = await attach(targetId);
  const tree = (await cdp.send('Page.getFrameTree', {}, top)).frameTree;
  const local = walk(tree);
  const remoteOwners = [];
  const remote = [];
  for (const info of entries) {
    const owner = await cdp.send('DOM.getFrameOwner', { frameId: info.targetId }, top);
    if (!Number.isSafeInteger(owner?.backendNodeId) || owner.backendNodeId <= 0)
      refuse('DOM.getFrameOwner gave no backend node');
    remoteOwners.push({ frameId: info.targetId, backendNodeId: owner.backendNodeId });
    const session = await attach(info.targetId);
    remote.push(
      ...walk((await cdp.send('Page.getFrameTree', {}, session)).frameTree).map((frame) => ({
        ...frame,
        parentId: frame.parentId ?? (info.parentId === targetId ? tree.frame.id : info.parentId),
      }))
    );
  }
  if (new Set(remoteOwners.map((owner) => owner.backendNodeId)).size !== remoteOwners.length)
    refuse('two owners share a backend node');
  const all = [...local, ...remote];
  const numbers = new Map(all.map((frame, index) => [frame.id, index]));
  if (numbers.size !== all.length) refuse('frame ids repeat');
  const frames = all.map((frame) => ({
    frameId: numbers.get(frame.id),
    parentFrameId: frame.parentId === undefined ? -1 : (numbers.get(frame.parentId) ?? -2),
    documentId: frame.loaderId,
    url: frame.url,
    failed: frame.unreachableUrl,
    errorOccurred: Boolean(frame.unreachableUrl),
    documentLifecycle: 'active',
  }));
  const root = frames.find((frame) => frame.frameId === 0);
  if (
    root?.parentFrameId !== -1 ||
    !root.documentId ||
    frames.some(
      (frame) =>
        !frame.documentId ||
        typeof frame.url !== 'string' ||
        !frame.url ||
        (frame.errorOccurred === true && (!errors || frame.frameId === 0)) ||
        frame.parentFrameId === -2
    )
  )
    refuse('a frame has no document, no URL, an error or no parent');
  const localFrames = local.map((frame) => frame.id);
  if (
    remoteOwners.some((owner) => localFrames.includes(owner.frameId)) ||
    localFrames.length + remoteOwners.length !== frames.length
  )
    refuse('local and remote frames do not add up to all frames');
  revision += 1;
  return {
    revision,
    rootFrameId: tree.frame.id,
    rootLoaderId: tree.frame.loaderId,
    frames,
    localFrames,
    remoteOwners,
  };
}

function reply(snap, is, errors) {
  const kinds = snap.frames.map((frame) => kindOf(frame, is));
  const taint = snap.frames.some(
    (frame, index) => kinds[index] === 'error' && errorUrlProtected(frame.failed, is)
  );
  const errorProtected = snap.frames.map(
    (frame, index) => kinds[index] === 'error' && (taint || errorUrlProtected(frame.failed, is))
  );
  const ordinary = kinds.every(
    (kind, index) =>
      kind === 'ordinary' || (errors && kind === 'error' && errorProtected[index] === false)
  );
  return {
    version: 2,
    revision: snap.revision,
    ...(ordinary ? { rootFrameId: snap.rootFrameId } : {}),
    rootLoaderId: snap.rootLoaderId,
    frames: snap.frames.map((frame, index) => ({
      ...(ordinary ? { frameId: frame.frameId, parentFrameId: frame.parentFrameId } : {}),
      kind: kinds[index],
      ...(errors && kinds[index] === 'error' ? { errorProtected: errorProtected[index] } : {}),
    })),
    localFrames: ordinary ? [...snap.localFrames] : [],
    remoteOwners: ordinary
      ? snap.remoteOwners.map(({ frameId, backendNodeId }) => ({ frameId, backendNodeId }))
      : [],
  };
}

export async function extensionFrames(browser, targetId, own, version) {
  const errors = sendsErrorProtected(version);
  const is = protectedOrigins(catalog.protectedOrigins, own ? [own] : []);
  const cdp = connect(browser);
  let timer;
  try {
    await cdp.opened;
    const snap = await Promise.race([
      snapshot(cdp, targetId, errors),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(UNSETTLED);
          error.why = `no list within ${WAIT} ms`;
          reject(error);
        }, WAIT);
      }),
    ]);
    const result = reply(snap, is, errors);
    const checks = {
      version: result.version === 2,
      revision: Number.isSafeInteger(result.revision),
      allOrdinary: result.frames.every((frame) => frame.kind === 'ordinary'),
      root: result.frames.find((frame) => frame.frameId === 0)?.parentFrameId === -1,
      rootFrameId: result.rootFrameId,
      rootLoaderId: result.rootLoaderId,
      counts: `${result.localFrames.length} local + ${result.remoteOwners.length} remote = ${result.frames.length} frames`,
    };
    diag(`reply ${targetId} ${JSON.stringify({ checks, result })}`);
    return { result };
  } catch (error) {
    diag(`refused ${targetId} ${String(error?.message ?? error)} at ${error?.why ?? 'unknown'}`);
    return { error: UNSETTLED };
  } finally {
    clearTimeout(timer);
    cdp.close();
  }
}
