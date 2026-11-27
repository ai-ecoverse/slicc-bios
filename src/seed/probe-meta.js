const PROBE_GONE =
  'slicc: refused: the guard couldn’t keep seven’s pages and the vault out of this tab, so it refuses commands there';

export const ERROR_PAGE_REFUSAL =
  "slicc: refused: the target shows Chrome's error page for a protected URL, which names it; slicc only lets a page navigate, reload or close it";

export const PROBE_ANSWER_MS = 1000;

export const urlScheme = (url) => {
  if (typeof url !== 'string' || !URL.canParse(url)) return undefined;
  return new URL(url).protocol.replace(/:$/, '');
};

export const urlOrigin = (url) => {
  if (typeof url !== 'string' || !URL.canParse(url)) return undefined;
  return new URL(url).origin;
};

export const probeMetaLine = (fields) => `PROBE-META: ${JSON.stringify(fields)}`;

export function probeMetaCall(guard, method, params, sessionId) {
  if (guard.closed || (sessionId !== undefined && guard.gone.has(sessionId)))
    return Promise.resolve({ error: { code: -32000, message: PROBE_GONE } });
  return new Promise((resolve) => {
    const id = ++guard.next;
    let timer;
    const answer = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
    answer.sessionId = sessionId;
    timer = setTimeout(() => {
      guard.internal.delete(id);
      resolve({ id, sessionId, error: { code: -32000, message: PROBE_GONE } });
    }, PROBE_ANSWER_MS);
    timer.unref?.();
    guard.internal.set(id, answer);
    guard.connection.send(
      JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
    );
  });
}

export async function maybeProbeErrorPageMeta(guard, answer, targetId) {
  if (answer?.error?.message !== ERROR_PAGE_REFUSAL) return answer;
  await probeErrorPageMeta(guard, targetId);
  return answer;
}

export async function probeErrorPageMeta(guard, targetId) {
  if (guard.probeMetaDone.has(targetId)) return;
  guard.probeMetaDone.add(targetId);
  const infoAnswer = await guard.within(
    probeMetaCall(guard, 'Target.getTargetInfo', { targetId }),
    PROBE_ANSWER_MS
  );
  if (infoAnswer?.error) {
    console.warn(
      probeMetaLine({
        method: 'Target.getTargetInfo',
        answered: false,
        refusal: infoAnswer.error.message,
      })
    );
  } else {
    console.warn(
      probeMetaLine({
        method: 'Target.getTargetInfo',
        answered: true,
        targetInfoUrlScheme: urlScheme(infoAnswer?.result?.targetInfo?.url),
      })
    );
  }
  const nav = guard.navs.get(targetId);
  const session = nav?.session;
  if (!session) {
    console.warn(
      probeMetaLine({
        method: 'Page.getFrameTree',
        answered: false,
        refusal: 'no bios session',
      })
    );
    return;
  }
  const treeAnswer = await guard.within(
    probeMetaCall(guard, 'Page.getFrameTree', {}, session),
    PROBE_ANSWER_MS
  );
  if (treeAnswer?.error) {
    console.warn(
      probeMetaLine({
        method: 'Page.getFrameTree',
        answered: false,
        refusal: treeAnswer.error.message,
      })
    );
    return;
  }
  const frame = treeAnswer?.result?.frameTree?.frame;
  const unreachable = frame?.unreachableUrl;
  console.warn(
    probeMetaLine({
      method: 'Page.getFrameTree',
      answered: true,
      frameUrlScheme: urlScheme(frame?.url),
      unreachableUrlPresent: typeof unreachable === 'string' && unreachable.length > 0,
      unreachableUrlOrigin: urlOrigin(unreachable),
    })
  );
}
