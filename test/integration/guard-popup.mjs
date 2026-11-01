import assert from 'node:assert/strict';
import { BLANKED, PROTECTED, protection } from '../../src/seed/guard.js';

export async function popupReport(own, guard, popup, answer, origin) {
  const report = {
    afterAttachReply: true,
    observedAt: Date.now(),
    discoveredUrl: popup.url,
    answer,
  };
  const capture = (promise) => promise.catch((error) => ({ error: { message: String(error) } }));
  const attribute = {
    expression: "document.documentElement?.getAttribute('data-k') ?? null",
    returnByValue: true,
  };
  let sessionId;
  try {
    const attached = await capture(
      own.send('Target.attachToTarget', {
        targetId: popup.targetId,
        flatten: true,
      })
    );
    report.harnessAttach = attached;
    sessionId = attached.result?.sessionId;
    const client = answer.result?.sessionId;
    const [
      target,
      tree,
      guardedTarget,
      guardedTree,
      guardedDOM,
      harnessAttribute,
      guardedAttribute,
    ] = await Promise.all([
      capture(own.send('Target.getTargetInfo', { targetId: popup.targetId })),
      sessionId ? capture(own.send('Page.getFrameTree', {}, sessionId)) : attached,
      capture(guard.send('Target.getTargetInfo', { targetId: popup.targetId }, undefined, 3000)),
      client ? capture(guard.send('Page.getFrameTree', {}, client, 3000)) : null,
      client ? capture(guard.send('DOM.getDocument', { depth: 0 }, client, 3000)) : null,
      sessionId ? capture(own.send('Runtime.evaluate', attribute, sessionId)) : null,
      client ? capture(guard.send('Runtime.evaluate', attribute, client, 3000)) : null,
    ]);
    const frameTree = tree.result?.frameTree;
    const frame = frameTree?.frame;
    const frames = (node) =>
      node?.frame ? [node.frame, ...(node.childFrames ?? []).flatMap(frames)] : [];
    const is = protection(origin);
    const live = frames(frameTree).some(
      (entry) => is.url(entry.url) || is.url(entry.securityOrigin)
    );
    const error = frame?.url?.startsWith('chrome-error:') || frame?.unreachableUrl;
    report.target = target;
    report.frameTree = frameTree ?? tree;
    report.loaderId = frame?.loaderId ?? null;
    report.securityOrigin = frame?.securityOrigin ?? null;
    report.guardedTarget = guardedTarget;
    report.guardedTree = guardedTree;
    report.guardedDOM = guardedDOM && {
      error: guardedDOM.error,
      hasRoot: Boolean(guardedDOM.result?.root),
    };
    report.harnessAttribute = harnessAttribute;
    report.guardedAttribute = guardedAttribute;
    report.pathObserved = live
      ? 'protected frame after attach reply'
      : error
        ? guardedDOM?.error?.message === PROTECTED
          ? 'sealed error/recovery candidate'
          : 'error document after attach reply'
        : frame?.url === BLANKED
          ? 'blocked blank after attach reply'
          : frame?.url?.startsWith('about:blank')
            ? 'ordinary blank after attach reply'
            : 'unknown';
  } catch (error) {
    report.diagnosticError = String(error);
  } finally {
    if (sessionId) {
      try {
        report.detached = await own.send('Target.detachFromTarget', { sessionId });
      } catch (error) {
        report.detachError = String(error);
      }
    }
  }
  report.observedUntil = Date.now();
  return report;
}

function blankFrame(tree, targetId) {
  const frame = tree?.frame;
  assert.equal(frame?.id, targetId, 'the popup root matches the target');
  assert.equal(frame.url, BLANKED, 'the popup frame is the blocked replacement');
  assert.ok(['://', 'null'].includes(frame.securityOrigin), 'the popup has an opaque origin');
  assert.ok(!frame.parentId && !frame.unreachableUrl && !frame.urlFragment);
  assert.deepEqual(tree.childFrames ?? [], [], 'the blocked replacement has no child frames');
  assert.ok(typeof frame.loaderId === 'string' && frame.loaderId, 'the popup loader is known');
  return frame;
}

export function assertPopupOutcome(id, popup, attached, report, attribute, beacon) {
  const failures = [];
  for (const check of [
    () => assert.equal(attribute?.value, null, `${id}: no attribute in the protected popup`),
    () => assert.equal(beacon, false, `${id}: no beacon from the protected popup`),
    () => {
      if (attached.error?.message === PROTECTED) return;
      assert.equal(attached.error, undefined, `${id}: only the protected refusal is accepted`);
      assert.ok(attached.result?.sessionId, `${id}: a successful attach has a session`);
      assert.equal(report?.diagnosticError, undefined, `${id}: the popup proof completed`);
      assert.equal(report?.afterAttachReply, true);
      for (const answer of [report.target, report.guardedTarget]) {
        assert.equal(answer?.error, undefined);
        assert.equal(answer?.result?.targetInfo?.targetId, popup.targetId);
        assert.equal(answer.result.targetInfo.url, BLANKED);
        assert.equal(answer.result.targetInfo.title, 'blocked');
      }
      assert.equal(report.guardedTree?.error, undefined);
      assert.equal(report.guardedTree?.sessionId, attached.result.sessionId);
      const ownFrame = blankFrame(report.frameTree, popup.targetId);
      const clientFrame = blankFrame(report.guardedTree?.result?.frameTree, popup.targetId);
      assert.equal(clientFrame.loaderId, ownFrame.loaderId, 'both sessions prove the same loader');
      assert.equal(report.guardedDOM?.error, undefined);
      assert.equal(report.guardedDOM?.hasRoot, true);
      for (const answer of [report.harnessAttribute, report.guardedAttribute]) {
        assert.equal(answer?.error, undefined);
        assert.equal(answer?.result?.exceptionDetails, undefined);
        assert.equal(answer?.result?.result?.value, null, 'the blocked popup has no attribute');
      }
    },
  ]) {
    try {
      check();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${id}: popup checks failed`);
}
