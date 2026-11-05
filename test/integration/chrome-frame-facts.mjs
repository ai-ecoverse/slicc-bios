export const CHROME_FACT_DELAYS_MS = [0, 250, 1000, 3000, 8000];

export const EMBED_RECIPE_HIDDEN = {
  mode: 'hidden',
  source: 'slicc-browsers/extension-frame.mjs embed()',
  steps: [
    'Runtime.evaluate on the reader/observer page session',
    'create light iframe#slicc-extension-frame',
    'create shadow host#slicc-extension-frame-host with closed shadow',
    'create shadow iframe#slicc-extension-frame-shadow (hidden)',
    'set both iframe.src to chrome-extension://<id>/frame.html?username=…',
    'append light iframe + shadow host to document.body',
    'resolve on light iframe load (or 5s timeout)',
    'no Page.navigate({frameId}) in this mode — navigation is via element.src only',
  ],
};

export const chromeFact = (what, payload) => {
  console.log(`CHROME-FACT ${what} ${JSON.stringify(payload)}`);
  return payload;
};

export const flattenFrameTree = (tree, out = []) => {
  const frame = tree?.frame;
  if (frame)
    out.push({
      id: frame.id,
      parentId: frame.parentId ?? null,
      url: frame.url ?? null,
      securityOrigin: frame.securityOrigin ?? null,
    });
  for (const child of tree?.childFrames ?? []) flattenFrameTree(child, out);
  return out;
};

export const collectIframes = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (node.nodeName === 'IFRAME') {
    out.push({
      frameId: node.frameId ?? null,
      backendNodeId: node.backendNodeId ?? null,
      attributes: node.attributes ?? [],
      contentDocument: Boolean(node.contentDocument),
    });
  }
  for (const child of node.children ?? []) collectIframes(child, out);
  for (const root of node.shadowRoots ?? []) collectIframes(root, out);
  if (node.contentDocument) collectIframes(node.contentDocument, out);
  return out;
};

const callRaw = async (send, method, params = {}, sessionId) => {
  try {
    const result = await send(method, params, sessionId);
    return { result };
  } catch (error) {
    return { error: error?.cdp ?? { message: error?.message ?? String(error) } };
  }
};

export const probeChromeFacts = async (send, pageSessionId, detail = {}) => {
  const targets = await callRaw(send, 'Target.getTargets');
  const targetInfos = (targets.result?.targetInfos ?? []).map((info) => ({
    targetId: info.targetId,
    type: info.type,
    url: info.url,
    attached: info.attached,
    openerId: info.openerId ?? null,
    parentId: info.parentId ?? null,
  }));
  chromeFact('getTargets', { ...detail, targets: targetInfos, rawError: targets.error ?? null });

  const doc = await callRaw(send, 'DOM.getDocument', { depth: -1, pierce: true }, pageSessionId);
  const iframes = collectIframes(doc.result?.root);
  chromeFact('getDocument-iframes', {
    ...detail,
    iframes,
    rawError: doc.error ?? null,
  });

  const targetInfosByFrame = [];
  for (const frame of iframes) {
    if (!frame.frameId) {
      targetInfosByFrame.push({ frameId: null, skipped: 'no-frameId' });
      continue;
    }
    const info = await callRaw(send, 'Target.getTargetInfo', { targetId: frame.frameId });
    targetInfosByFrame.push({
      frameId: frame.frameId,
      getTargetInfo: info.result ?? null,
      error: info.error ?? null,
    });
  }
  chromeFact('getTargetInfo-by-frameId', { ...detail, frames: targetInfosByFrame });

  const tree = await callRaw(send, 'Page.getFrameTree', {}, pageSessionId);
  chromeFact('getFrameTree', {
    ...detail,
    frames: flattenFrameTree(tree.result?.frameTree),
    rawError: tree.error ?? null,
  });

  return { targetInfos, iframes, targetInfosByFrame, frameTree: tree };
};

export const scheduleChromeFacts = (
  send,
  pageSessionId,
  embedAt,
  delays = CHROME_FACT_DELAYS_MS
) => {
  const jobs = delays.map(
    (delayMs) =>
      new Promise((resolve) => {
        const run = async () => {
          try {
            await probeChromeFacts(send, pageSessionId, {
              delayMs,
              sinceEmbedMs: embedAt == null ? null : Date.now() - embedAt,
            });
          } finally {
            resolve();
          }
        };
        if (!delayMs) void run();
        else {
          const timer = setTimeout(run, delayMs);
          timer.unref?.();
        }
      })
  );
  return Promise.all(jobs);
};

export const installChromeFrameFacts = (unguarded, delays = CHROME_FACT_DELAYS_MS) => {
  const prior = unguarded.send.bind(unguarded);
  let started = false;
  let done = Promise.resolve();
  chromeFact('embed-recipe', EMBED_RECIPE_HIDDEN);
  unguarded.send = async (method, params = {}, sessionId) => {
    const result = await prior(method, params, sessionId);
    if (
      !started &&
      method === 'Runtime.evaluate' &&
      typeof params?.expression === 'string' &&
      params.expression.includes('slicc-extension-frame') &&
      sessionId
    ) {
      started = true;
      const embedAt = Date.now();
      chromeFact('embed-evaluate-resolved', {
        sessionId,
        embedAt,
        expressionHead: params.expression.slice(0, 160),
      });
      done = scheduleChromeFacts(prior, sessionId, embedAt, delays);
    }
    return result;
  };
  unguarded.chromeFactsDone = () => done;
  return unguarded;
};
