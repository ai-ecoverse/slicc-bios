import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const traced = new Set();

function runtimeTrace() {
  const boot = crypto.randomUUID();
  let seq = 0;
  const rows = [];
  const pending = new Set();
  const origin = (value) => {
    if (typeof value !== 'string' || !value) return '';
    try {
      const url = new URL(value);
      return url.origin === 'null' ? `${url.protocol}//` : url.origin;
    } catch {
      return 'opaque';
    }
  };
  const error = (value) => {
    const message = String(value?.message ?? value ?? '');
    return message.includes('slicc: refused:') ? 'refused' : message ? 'other' : '';
  };
  const record = (site, data = {}) => {
    if (seq >= 12000) return;
    const row = { at: Date.now(), boot, seq: ++seq, site, ...data };
    rows.push(row);
    const write = chrome.storage.session
      .set({ [`recovery-trace:${boot}:${seq}`]: row })
      .catch(() => undefined);
    pending.add(write);
    write.finally(() => pending.delete(write));
    console.info('RECOVERY_TRACE', JSON.stringify(row));
  };
  globalThis.__recoveryTrace = { rows, pending, record, origin, error };
  record('worker-start');
  return globalThis.__recoveryTrace;
}

function swap(source, was, next) {
  assert.equal(source.split(was).length, 2, `unique trace site ${was.slice(0, 70)}`);
  return source.replace(was, next);
}

export async function traceExtension(root) {
  if (traced.has(root)) return;
  traced.add(root);
  await writeFile(
    join(root, 'recovery-trace.js'),
    `export const trace = (${runtimeTrace.toString()})();\n`
  );
  const path = join(root, 'cdp.js');
  let source = await readFile(path, 'utf8');
  source = `import { trace } from './recovery-trace.js';\n${source}`;
  source = swap(
    source,
    '    this.port = port;',
    `    this.traceId = crypto.randomUUID();
    trace.record('connection-start', {connection:this.traceId, sender:trace.origin(port.sender?.url)});
    port.onDisconnect.addListener(() => trace.record('port-disconnect', {connection:this.traceId}));
    this.port = port;`
  );
  source = swap(
    source,
    '    const tab = await readTab(this.api, tabId);\n    if (this.tabState(tabId) || !this.failedAt(tabId, tab.url)) return this.view(tab);',
    `    const tab = await readTab(this.api, tabId);
    trace.record('confirmed-read', {connection:this.traceId, tabId, url:trace.origin(tab.url), pending:trace.origin(tab.pendingUrl), status:tab.status, attached:Boolean(this.tabState(tabId)), failed:trace.origin(this.state.failed.get(tabId))});
    if (this.tabState(tabId) || !this.failedAt(tabId, tab.url)) return this.view(tab);`
  );
  source = swap(
    source,
    '      ?.getFrame?.({ tabId, frameId: 0 })\n      .catch(() => undefined);',
    `      ?.getFrame?.({ tabId, frameId: 0 })
      .catch(error => {
        trace.record('confirmed-proof-error', {connection:this.traceId, tabId, error:trace.error(error)});
        return undefined;
      });`
  );
  source = swap(
    source,
    '    if (frame?.errorOccurred !== true) this.state.failed.delete(tabId);',
    `    trace.record('confirmed-proof', {connection:this.traceId, tabId, present:Boolean(frame), frameId:frame?.frameId, url:trace.origin(frame?.url), errorOccurred:frame?.errorOccurred});
    if (frame?.errorOccurred !== true) {
      trace.record('failed-delete-confirmed', {connection:this.traceId, tabId, failed:trace.origin(this.state.failed.get(tabId))});
      this.state.failed.delete(tabId);
    }`
  );
  source = swap(
    source,
    '    if (!this.failedAt(tab?.id, tab?.url)) return tab;',
    `    trace.record('view', {connection:this.traceId, tabId:tab?.id, url:trace.origin(tab?.url), masked:this.failedAt(tab?.id, tab?.url)});
    if (!this.failedAt(tab?.id, tab?.url)) return tab;`
  );
  source = swap(
    source,
    '    if (this.isMain(tab, frameId)) this.state.failed.set(tabId, unfragmented(url));',
    `    trace.record('protected-document', {connection:this.traceId, tabId, mainFrameId:tab.mainFrameId, pausedFrameId:frameId, main:this.isMain(tab, frameId), url:trace.origin(url)});
    if (this.isMain(tab, frameId)) {
      trace.record('failed-set', {connection:this.traceId, tabId, url:trace.origin(url)});
      this.state.failed.set(tabId, unfragmented(url));
    }`
  );
  source = swap(
    source,
    '  watchFrame(tabId, tab, frame) {',
    `  watchFrame(tabId, tab, frame) {
    if (!frame.parentId) trace.record('root-commit', {connection:this.traceId, tabId, frameId:frame.id, mainFrameId:tab.mainFrameId, url:trace.origin(frame.url), unreachable:trace.origin(frame.unreachableUrl), failed:trace.origin(this.state.failed.get(tabId))});`
  );
  source = swap(
    source,
    '    if (!frame.parentId) {\n      this.state.failed.delete(tabId);',
    `    if (!frame.parentId) {
      trace.record('failed-delete-commit', {connection:this.traceId, tabId, failed:trace.origin(this.state.failed.get(tabId))});
      this.state.failed.delete(tabId);`
  );
  source = swap(
    source,
    '  onUpdated(tabId, changeInfo, tab) {',
    `  onUpdated(tabId, changeInfo, tab) {
    trace.record('tab-updated', {connection:this.traceId, tabId, url:trace.origin(changeInfo?.url), pending:trace.origin(changeInfo?.pendingUrl), status:changeInfo?.status, eventUrl:trace.origin(tab?.url), failed:trace.origin(this.state.failed.get(tabId))});`
  );
  source = swap(
    source,
    '    if (change.url !== undefined && !same) this.state.failed.delete(tabId);',
    `    if (change.url !== undefined && !same) {
      trace.record('failed-delete-updated', {connection:this.traceId, tabId, failed:trace.origin(this.state.failed.get(tabId))});
      this.state.failed.delete(tabId);
    }`
  );
  source = swap(
    source,
    '  onRemoved(tabId) {\n    this.state.failed.delete(tabId);',
    `  onRemoved(tabId) {
    trace.record('failed-delete-removed', {connection:this.traceId, tabId, failed:trace.origin(this.state.failed.get(tabId))});
    this.state.failed.delete(tabId);`
  );
  source = swap(
    source,
    '  async targetInfo(params) {',
    `  async targetInfo(params) {
    trace.record('target-info', {connection:this.traceId, targetId:params.targetId});`
  );
  source = swap(
    source,
    '  async attach(params) {',
    `  async attach(params) {
    trace.record('attach', {connection:this.traceId, targetId:params.targetId});`
  );
  source = swap(
    source,
    '  release(tabId) {',
    `  release(tabId) {
    trace.record('release', {connection:this.traceId, tabId, failed:trace.origin(this.state.failed.get(tabId))});`
  );
  source = swap(
    source,
    '  async run(message) {',
    `  async run(message) {
    trace.record('command-start', {connection:this.traceId, id:message.id, method:message.method, sessionId:message.sessionId, targetId:message.params?.targetId});`
  );
  source = swap(
    source,
    '      this.post({ id: message.id, result: await this.dispatch(message) }, message.method);',
    `      const result = await this.dispatch(message);
      trace.record('command-result', {connection:this.traceId, id:message.id, method:message.method, sessionId:result?.sessionId});
      this.post({ id: message.id, result }, message.method);`
  );
  source = swap(
    source,
    '      this.post({ id: message.id, error: String(error?.message ?? error) });',
    `      trace.record('command-error', {connection:this.traceId, id:message.id, method:message.method, error:trace.error(error)});
      this.post({ id: message.id, error: String(error?.message ?? error) });`
  );
  source = swap(
    source,
    '  shutdown() {\n    if (this.closed) return;',
    `  shutdown() {
    trace.record('connection-shutdown', {connection:this.traceId, closed:this.closed});
    if (this.closed) return;`
  );
  source = swap(
    source,
    '  if (blocked(url, opener)) refusal();',
    `  if (blocked(url, opener)) {
    trace.record('demand-refused-url', {tabId:tab?.id, url:trace.origin(url), pending:trace.origin(pending), opener});
    refusal();
  }`
  );
  source = swap(
    source,
    '  if (pending && pending !== url && blocked(pending, opener, guard.url(url))) refusal();',
    `  if (pending && pending !== url && blocked(pending, opener, guard.url(url))) {
    trace.record('demand-refused-pending', {tabId:tab?.id, url:trace.origin(url), pending:trace.origin(pending), opener});
    refusal();
  }`
  );
  await writeFile(path, source);
  const background = join(root, 'background.js');
  await writeFile(
    background,
    `import { trace } from './recovery-trace.js';\n${await readFile(background, 'utf8')}\n`
  );
  const relay = join(root, 'relay.js');
  const relaySource = await readFile(relay, 'utf8');
  await writeFile(
    relay,
    swap(
      relaySource,
      '    worker.onDisconnect.addListener(() => {\n      if (cdpPort !== worker) return;',
      `    worker.onDisconnect.addListener(() => {
      page.postMessage({recoveryRelayTrace:{at:Date.now(), origin:location.origin}});
      if (cdpPort !== worker) return;`
    )
  );
  const pagePath = join(root, 'page.js');
  await writeFile(
    pagePath,
    swap(
      await readFile(pagePath, 'utf8'),
      '  port1.onmessage = ({ data }) => {',
      `  port1.onmessage = ({ data }) => {
    if (data.recoveryRelayTrace) {
      const rows = (globalThis.recoveryRelayRecords ??= []);
      if (rows.length < 200) rows.push(data.recoveryRelayTrace);
      return;
    }`
    )
  );
}

export function diagnosticConnection(connection) {
  const records = (globalThis.recoveryDiagnosticRecords ??= []);
  const methods = new Map();
  const origin = (url) => {
    if (typeof url !== 'string' || !url) return '';
    try {
      const parsed = new URL(url);
      return parsed.origin === 'null' ? `${parsed.protocol}//` : parsed.origin;
    } catch {
      return 'opaque';
    }
  };
  const record = (direction, text) => {
    if (records.length >= 12000) return;
    const message = JSON.parse(text);
    const params = message.params ?? {};
    if (direction === 'send') methods.set(message.id, message.method);
    const method = message.method ?? methods.get(message.id);
    const tree = message.result?.frameTree?.frame ?? params.frame;
    const info = message.result?.targetInfo ?? params.targetInfo;
    records.push({
      at: Date.now(),
      direction,
      id: message.id,
      method,
      session: message.sessionId,
      target: params.targetId ?? info?.targetId,
      destination: origin(params.url),
      error: message.error
        ? String(message.error.message).includes('slicc: refused:')
          ? 'refused'
          : 'other'
        : undefined,
      attached: message.result?.sessionId,
      frame: tree?.id,
      loader: tree?.loaderId,
      document: origin(tree?.url),
      origin: origin(tree?.securityOrigin),
      unreachable: origin(tree?.unreachableUrl),
      targetType: info?.type,
      targetUrl: origin(info?.url),
      navigateFrame: message.result?.frameId,
      navigateLoader: message.result?.loaderId,
      navigateError: message.result?.errorText,
      historyIndex: message.result?.currentIndex,
      history: message.result?.entries?.map((entry) => ({
        url: origin(entry.url),
        transition: entry.transitionType,
      })),
    });
  };
  const outer = {
    onmessage: null,
    onclose: null,
    send(text) {
      record('send', text);
      connection.send(text);
    },
    close() {
      records.push({ at: Date.now(), direction: 'close' });
      connection.close();
    },
  };
  connection.onmessage = (text) => {
    record('receive', text);
    outer.onmessage?.(text);
  };
  connection.onclose = (...args) => outer.onclose?.(...args);
  return outer;
}

export async function traceRecovery(real, page, label) {
  const source = await readFile(new URL('../../src/seed/cdp.js', import.meta.url), 'utf8');
  real.overrides.set(
    '/seed/cdp.js',
    swap(
      source,
      'return observe(guardProtected(await open(), own, browser ? tabs.get(browser) : undefined));',
      `return observe((${diagnosticConnection.toString()})(guardProtected(await open(), own, browser ? tabs.get(browser) : undefined)));`
    )
  );
  return async () => {
    const { targetInfos } = await real.cdp.send('Target.getTargets');
    let worker = targetInfos.find(
      (target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension:')
    );
    if (!worker) {
      let off;
      const started = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error('trace worker did not start'));
        }, 15000);
        off = real.cdp.on((message) => {
          const target = message.params?.targetInfo;
          if (
            message.method !== 'Target.targetCreated' ||
            target?.type !== 'service_worker' ||
            !target.url.startsWith('chrome-extension:')
          )
            return;
          clearTimeout(timer);
          off();
          resolve(target);
        });
      });
      await real.cdp.send('Target.setDiscoverTargets', { discover: true });
      await real.cdp.send('ServiceWorker.enable', {});
      await real.cdp.send('ServiceWorker.startWorker', {
        scopeURL: 'chrome-extension://akjjllgokmbgpbdbmafpiefnhidlmbgf/',
      });
      worker = await started;
    }
    const { sessionId } = await real.cdp.send('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: true,
    });
    const result = await real.cdp.send(
      'Runtime.evaluate',
      {
        expression:
          '(async()=>{await Promise.all([...globalThis.__recoveryTrace.pending]); const stored = await chrome.storage.session.get(null); return Object.entries(stored).filter(([key])=>key.startsWith("recovery-trace:")).map(([,row])=>row);})()',
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId
    );
    assert.equal(result.exceptionDetails, undefined, 'trace collection succeeded');
    const rows = result.result?.value ?? [];
    const cli = await page
      .evaluate(() => globalThis.recoveryDiagnosticRecords ?? [])
      .catch(() => []);
    const relay = await page.evaluate(() => globalThis.recoveryRelayRecords ?? []).catch(() => []);
    console.log(
      'RECOVERY_DIAGNOSTIC',
      JSON.stringify({
        label,
        at: Date.now(),
        workerRows: rows.length,
        cliRows: cli.length,
        relayRows: relay.length,
      })
    );
    for (const row of rows.sort((a, b) => a.at - b.at || a.seq - b.seq))
      console.log('RECOVERY_EXTENSION', JSON.stringify({ label, ...row }));
    for (const row of cli) console.log('RECOVERY_CLI', JSON.stringify({ label, ...row }));
    for (const row of relay) console.log('RECOVERY_RELAY', JSON.stringify({ label, ...row }));
    await real.cdp.send('Target.detachFromTarget', { sessionId });
    assert.ok(rows.length > 0, 'extension trace executed');
    assert.ok(cli.length > 0, 'CLI trace executed');
  };
}
