const POLL_MS = 100;
const HISTORY_WAIT = 5000;
const ANSWER_MS = 1000;

export function cutErrorPageSessions(guard, targetId) {
  for (const [sessionId, entry] of guard.sessions) {
    if (entry?.targetId !== targetId) continue;
    if (!guard.shown.has(sessionId) && !guard.quarantined.has(sessionId)) continue;
    guard.cut(sessionId);
  }
}

export function liveErrorPageProof(guard, targetId) {
  if (!targetId) return false;
  const record = guard.errorPageProofs.get(targetId);
  if (!record) return false;
  if (guard.navs.get(targetId) !== record.nav) return false;
  if (guard.revisions.get(targetId) !== record.revision) return false;
  if (
    record.loader &&
    (!record.frameId || guard.frameLoaders.get(record.frameId) !== record.loader)
  )
    return false;
  return guard.errorPageByProof(targetId);
}

export function setErrorPageProof(guard, targetId, record) {
  if (!targetId || !record) return;
  guard.errorPageProofs.set(targetId, record);
}

export function clearErrorPageProof(guard, targetId) {
  if (!targetId) return false;
  return guard.errorPageProofs.delete(targetId);
}

export function revokeErrorPageProof(guard, targetId) {
  const had = Boolean(targetId && guard.errorPageProofs.has(targetId));
  clearErrorPageProof(guard, targetId);
  if (had) cutErrorPageSessions(guard, targetId);
  return had;
}

export async function recoverRuntimeErrorPage(guard, message) {
  const targetId = guard.sessions.get(message.sessionId)?.targetId;
  const proof = await guard.stranded(targetId);
  if (!proof) {
    clearErrorPageProof(guard, targetId);
    return true;
  }
  guard.recoveries.set(message, proof);
  return false;
}

export async function waitErrorPageProof(guard, targetId, limit = HISTORY_WAIT) {
  if (guard.errorPageByProof(targetId)) return true;
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await guard.proofSignal(targetId, Math.min(POLL_MS, left));
    if (guard.errorPageByProof(targetId)) return true;
    const answer = await guard.within(
      guard.call('Target.getTargetInfo', { targetId }),
      Math.min(ANSWER_MS, Math.max(0, deadline - Date.now()))
    );
    const info = answer?.result?.targetInfo;
    if (info?.targetId === targetId) guard.learn(info);
    if (guard.errorPageByProof(targetId)) return true;
    const nav = guard.navs.get(targetId);
    if (!nav?.session) continue;
    const tree = await guard.within(
      guard.call('Page.getFrameTree', {}, nav.session),
      Math.min(ANSWER_MS, Math.max(0, deadline - Date.now()))
    );
    if (!tree || tree.error) continue;
    const frameTree = tree.result?.frameTree;
    const frame = guard.errorPageRoot(frameTree);
    if (frame && guard.errorPageInfoMatches(frame, guard.targets.get(targetId)))
      return guard.bindErrorPageFrame(targetId, frame, frameTree, nav.session, nav);
  }
  return guard.errorPageByProof(targetId);
}

export async function treeErrorPageProof(guard, targetId, nav = guard.navs.get(targetId)) {
  if (!nav?.session) return false;
  const tree = await guard.within(guard.call('Page.getFrameTree', {}, nav.session), ANSWER_MS);
  return Boolean(tree && !tree.error && guard.errorPageByProof(targetId, tree.result?.frameTree));
}

export async function attachmentProofFor(guard, sessionId, targetId, raw, guarded, recoverable) {
  const proof = await guard.attachmentProofOnce(sessionId, targetId, raw, guarded, recoverable);
  if (proof || !recoverable || !guarded) return proof;
  if (!guard.navs.get(targetId)?.session) {
    guard.touch(targetId);
    await guard.navs.get(targetId)?.ready;
  }
  if (!(await guard.freshErrorPageTree(targetId))) return null;
  return await guard.attachmentProofOnce(sessionId, targetId, raw, guarded, recoverable);
}
