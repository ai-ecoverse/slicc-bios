import assert from 'node:assert/strict';

export function tapBrowserIconSource(source) {
  const call =
    "    const { root } = await this.#client.call('DOM.getDocument', { depth: 0 }, sessionId);";
  assert.equal(source.split(call).length, 2);
  return source.replace(
    call,
    `    const cdp675IconRead = { targetId: id, sessionId, method: 'DOM.getDocument', params: { depth: 0 } };
    const cdp675IconTrace = globalThis.cdp675BrowserIconTrace ??= [];
    cdp675IconTrace.push({ at: Date.now(), phase: 'send', ...cdp675IconRead });
    if (cdp675IconTrace.length > 20000) cdp675IconTrace.shift();
${call}
    cdp675IconTrace.push({ at: Date.now(), phase: 'receive', ...cdp675IconRead, nodeId: root?.nodeId, backendNodeId: root?.backendNodeId });
    if (cdp675IconTrace.length > 20000) cdp675IconTrace.shift();`
  );
}
