import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const traced = new Set();

function diagnosticReason(value) {
  const message = String(value?.message ?? value ?? '');
  if (message === "slicc: refused: target is on seven's origin") return 'extension-origin';
  if (
    message ===
    'slicc: refused: seven’s own pages and the vault are out of reach of browser automation'
  )
    return 'bios-protected';
  if (message === 'slicc: refused: the CDP guard couldn’t check this answer, so it held it back')
    return 'bios-proof';
  if (
    message ===
    'slicc: refused: the guard couldn’t keep seven’s pages and the vault out of this tab, so it refuses commands there'
  )
    return 'bios-unguarded';
  if (message === 'slicc: refused: this request wasn’t seen, so it could be seven’s or the vault’s')
    return 'bios-unseen';
  if (message === 'Target detached') return 'target-detached';
  if (message.includes('no answer in')) return 'timeout';
  return message.includes('slicc: refused:') ? 'other-refusal' : message ? 'other' : '';
}

function runtimeTrace(reason) {
  const boot = crypto.randomUUID();
  let seq = 0;
  const rows = [];
  const origin = (value) => {
    if (typeof value !== 'string' || !value) return '';
    try {
      const url = new URL(value);
      return url.origin === 'null'
        ? `${url.protocol}//`
        : `${url.origin}${/^\/recovery-(seed|hop|destination)\.html$|^\/vault$/.test(url.pathname) ? url.pathname : ''}`;
    } catch {
      return 'opaque';
    }
  };
  const error = reason;
  const record = (site, data = {}) => {
    if (seq >= 12000) return;
    const row = { at: Date.now(), boot, seq: ++seq, site, ...data };
    rows.push(row);
  };
  globalThis.__recoveryTrace = { rows, record, origin, error };
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
    `export const trace = (${runtimeTrace.toString()})((${diagnosticReason.toString()}));\n`
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
    trace.record('command-start', {connection:this.traceId, id:message.id, method:message.method, sessionId:message.sessionId, targetId:message.params?.targetId, destination:trace.origin(message.params?.url)});`
  );
  source = swap(
    source,
    '      this.post({ id: message.id, result: await this.dispatch(message) }, message.method);',
    `      const result = await this.dispatch(message);
      trace.record('command-result', {connection:this.traceId, id:message.id, method:message.method, sessionId:result?.sessionId, url:trace.origin(result?.targetInfo?.url), targetId:result?.targetInfo?.targetId, type:result?.targetInfo?.type, frame:result?.frameId, loader:result?.loaderId, errorText:result?.errorText});
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

export function diagnosticConnection(connection, reason, stage) {
  const records = (globalThis.recoveryDiagnosticRecords ??= []);
  const connectionId = `${stage}:${(globalThis.recoveryTraceConnections = (globalThis.recoveryTraceConnections ?? 0) + 1)}`;
  const methods = new Map();
  const origin = (url) => {
    if (typeof url !== 'string' || !url) return '';
    try {
      const parsed = new URL(url);
      return parsed.origin === 'null'
        ? `${parsed.protocol}//`
        : `${parsed.origin}${/^\/recovery-(seed|hop|destination)\.html$|^\/vault$/.test(parsed.pathname) ? parsed.pathname : ''}`;
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
      stage,
      connectionId,
      direction,
      id: message.id,
      method,
      session: message.sessionId,
      target: params.targetId ?? info?.targetId,
      destination: origin(params.url),
      error: message.error ? reason(message.error.message) : undefined,
      attached: message.result?.sessionId,
      frame: tree?.id,
      loader: tree?.loaderId,
      document: origin(tree?.url),
      origin: origin(tree?.securityOrigin),
      unreachable: origin(tree?.unreachableUrl),
      targetType: info?.type,
      targetUrl: origin(info?.url),
      targets: message.result?.targetInfos?.map((target) => ({
        id: target.targetId,
        type: target.type,
        url: origin(target.url),
        active: target.active,
      })),
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
      records.push({ at: Date.now(), stage, connectionId, direction: 'close' });
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
      `return observe((${diagnosticConnection.toString()})(guardProtected((${diagnosticConnection.toString()})(await open(), (${diagnosticReason.toString()}), 'backend'), own, browser ? tabs.get(browser) : undefined), (${diagnosticReason.toString()}), 'cli'));`
    )
  );
  const guardSource = await readFile(new URL('../../src/seed/guard.js', import.meta.url), 'utf8');
  real.overrides.set(
    '/seed/guard.js',
    'globalThis.recoveryGuardTraceLoaded = true;\n' +
      swap(
        guardSource,
        '  refuse(command, message = PROTECTED, release = true) {',
        `  refuse(command, message = PROTECTED, release = true) {
      const rows = (globalThis.recoveryGuardRecords ??= []);
      if (rows.length < 2000) rows.push({at:Date.now(),site:'guard-refuse',id:command?.id,method:command?.method,sessionId:command?.sessionId,targetId:command?.params?.targetId,release,reason:(${diagnosticReason.toString()})(message),caller:new Error().stack.split('\\n').slice(1,6).map(line=>({fn:line.match(/at ([\\w.]+)/)?.[1],site:line.match(/guard[.]js:\\d+:\\d+/)?.[0]}))});`
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
        expression: 'globalThis.__recoveryTrace?.rows ?? []',
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
    const guard = await page
      .evaluate(() => ({
        loaded: globalThis.recoveryGuardTraceLoaded === true,
        rows: globalThis.recoveryGuardRecords ?? [],
      }))
      .catch(() => ({ loaded: false, rows: [] }));
    console.log(
      'RECOVERY_DIAGNOSTIC',
      JSON.stringify({
        label,
        at: Date.now(),
        workerRows: rows.length,
        cliRows: cli.length,
        relayRows: relay.length,
        guardLoaded: guard.loaded,
        guardRows: guard.rows.length,
      })
    );
    await writeFile(
      `diagnostic/recovery-${label}.json`,
      JSON.stringify({ label, extension: rows, cli, relay, guard })
    );
    assert.ok(guard.loaded, 'BIOS trace executed');
    await real.cdp.send('Target.detachFromTarget', { sessionId });
    assert.ok(rows.length > 0, 'extension trace executed');
    assert.ok(cli.length > 0, 'CLI trace executed');
  };
}
