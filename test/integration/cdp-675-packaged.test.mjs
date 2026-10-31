import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as https } from 'node:https';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boot, ready, run, shows } from './bios.mjs';
import { devtools, launch } from './chrome.mjs';
import { fixtureTarget } from './fixtures/cdp-675-target.mjs';
import { linkNode } from './linked-node.mjs';
import { certificate, realExtension, SEVEN } from './real-extension.mjs';

const directory = process.env.SLICC_675_ARTIFACT_DIR;
const manifest = directory
  ? JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  : null;
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const ordinaryCases = [
  { name: 'instrumented-list-call', reload: true },
  { name: 'late-no-unasked-reload', reload: false, late: true },
  { name: 'armed-seven-hop-error-scrub-bounded', reload: true, protectedHop: 'seven' },
  { name: 'armed-vault-hop-error-scrub-bounded', reload: true, protectedHop: 'vault' },
  { name: 'shipped-kernel-holder-killed-while-armed', reload: true, holderKill: 'armed' },
  {
    name: 'shipped-kernel-holder-killed-during-many-script-load',
    reload: true,
    holderKill: 'load',
    many: true,
  },
  { name: 'old-client-terminal', reload: true, negative: true, oldClient: true },
];
const guardCases = [
  { name: 'guard-level-holder-close-at-pause', lifecycle: 'close' },
  { name: 'guard-level-pause-deadline-stall', lifecycle: 'stall' },
  { name: 'guard-level-protected-commit-revoke', lifecycle: 'revoke' },
  { name: 'guard-level-stale-published-ids', lifecycle: 'stale' },
  { name: 'guard-level-change-before-stale-context-install', lifecycle: 'change' },
  { name: 'guard-level-free-pause-refused', method: 'Debugger.pause', params: {} },
  {
    name: 'guard-level-script-source-refused',
    method: 'Debugger.getScriptSource',
    params: { scriptId: '675-unpublished' },
  },
  {
    name: 'guard-level-call-frame-evaluate-refused',
    method: 'Debugger.evaluateOnCallFrame',
    params: { callFrameId: '675-unpublished', expression: '1', returnByValue: true },
  },
  {
    name: 'guard-level-extension-worker-target-stopped-at-pause',
    lifecycle: 'worker-stop',
    extensionOnly: true,
  },
  {
    name: 'guard-level-extension-runtime-reload-worker-restart-at-pause',
    lifecycle: 'worker',
    extensionOnly: true,
  },
  { name: 'guard-level-seven-owner-tab-gone-at-pause', lifecycle: 'owner-gone' },
];
const fallbackCases = [
  { name: 'foreign-iframe-cached', reload: true, delay: 0, cached: true, measure: true },
  { name: 'foreign-iframe-immediate', reload: true, delay: 0, measure: true },
  { name: 'foreign-iframe-50ms', reload: true, delay: 50, measure: true },
  { name: 'foreign-iframe-500ms', reload: true, delay: 500 },
  { name: 'foreign-opspile-two-sequential-fetches', reload: true, delay: 150, sequential: true },
  { name: 'foreign-iframe-parse-time', reload: true, parse: true },
  {
    name: 'fallback-protected-seven-subframe-root-only',
    reload: true,
    delay: 500,
    protectedSubframe: 'seven',
  },
  {
    name: 'fallback-protected-vault-subframe-root-only',
    reload: true,
    delay: 500,
    protectedSubframe: 'vault',
  },
];

function tapSource(source) {
  assert.ok(
    source.includes(
      'guardProtected(await open(), own, browser ? tabs.get(browser) : undefined, route)'
    )
  );
  return (
    source.replace(
      'guardProtected(await open(), own, browser ? tabs.get(browser) : undefined, route)',
      'cdp675Tap(guardProtected(cdp675Tap(await open(), "route", route), own, browser ? tabs.get(browser) : undefined, route), "bios", route)'
    ) +
    `
function cdp675Tap(connection, boundary, route) {
  const trace = globalThis.cdp675Trace ??= [];
  const record = (direction, text) => {
    const packet = JSON.parse(text);
    trace.push({ at: Date.now(), boundary, route, direction, packet });
  };
  const send = connection.send.bind(connection);
  connection.send = (text) => { record('send', text); return send(text); };
  let receive;
  connection.onmessage = (text) => { record('receive', text); receive?.(text); };
  const wrapped = {
    send: connection.send.bind(connection),
    close: connection.close.bind(connection),
    get onclose() { return connection.onclose; },
    set onclose(value) { connection.onclose = value; },
    get onmessage() { return receive; },
    set onmessage(value) { receive = value; },
  };
  return wrapped;
}
`
  );
}

async function sh(page, command) {
  return page.evaluate(async (command) => {
    globalThis.cdp675Client ??= await globalThis.sliccKernelClient();
    const { status, stdout, stderr } = await globalThis.cdp675Client.run(['bash', '-c', command], {
      cwd: '/',
    });
    return { status, stdout, stderr };
  }, command);
}

async function cone(page, command, name) {
  await run(
    page,
    `sudo -u cone bash -c ${quote(`export PATH=$PNPM_HOME/bin:$PATH; export SLICC_CDP_URL=http://127.0.0.1:9222; ${command}`)} > /tmp/${name}.log 2>&1; echo ${name}-$((40 + 2))`
  );
  await shows(page, `${name}-42`, 240000);
  return sh(page, `cat /tmp/${name}.log`);
}

function installCommand(paths) {
  return `timeout 180 pnpm add -g --config.minimum-release-age=0 ${paths.map(quote).join(' ')}; echo install-status-$?; hash -r; echo playwright-command-$(command -v playwright-cli); echo mcpcat-command-$(command -v mcpcat); echo playwright-version-$(playwright-cli --version); echo mcpcat-version-$(mcpcat --version); root=$(pnpm root -g); echo package-root-$root; find -L "$root" -name playwright-cli.wasm | while IFS= read -r wasm; do echo wasm-path-$wasm; sha256sum "$wasm"; done; pnpm ls -g --depth 0`;
}

function packageProof(output, version, sha256) {
  const stdout = output.stdout ?? '';
  const binary = stdout.match(/^playwright-command-(.*)$/m)?.[1] ?? null;
  const mcpcat = stdout.match(/^mcpcat-command-(.*)$/m)?.[1] ?? null;
  const actualVersion = stdout.match(/^playwright-version-playwright-cli (.*)$/m)?.[1] ?? null;
  const mcpcatVersion = stdout.match(/^mcpcat-version-(.*)$/m)?.[1] ?? null;
  const wasm = [...stdout.matchAll(/^([a-f0-9]{64})\s+(.+playwright-cli\.wasm)$/gm)].map(
    ([, sha256, path]) => ({ path, sha256 })
  );
  const checks = {
    binary: Boolean(binary?.startsWith('/home/cone/') && binary.endsWith('playwright-cli')),
    mcpcat: Boolean(mcpcat?.startsWith('/home/cone/') && mcpcat.endsWith('mcpcat')),
    version: actualVersion === version,
    mcpcatVersion: mcpcatVersion === '0.80.1',
    sha256: wasm.some((entry) => entry.sha256 === sha256),
  };
  return {
    status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
    binary,
    mcpcat,
    version: actualVersion,
    mcpcatVersion,
    wasm,
    expected: { version, sha256 },
    checks,
    install: 'pnpm add -g as cone',
  };
}

function countRow(row) {
  row.counted =
    row.packageProof?.status === 'pass' && row.setupChecks?.every(({ pass }) => pass) === true;
  row.outcome = row.status;
  if (!row.counted && row.status !== 'setup-failure') row.status = 'not-counted';
}

async function stagePackage(page, name, checks = []) {
  const encoded = (await readFile(join(directory, name))).toString('base64');
  const path = `/tmp/cdp-675-packages/${name}`;
  const result = await page.evaluate(
    async ({ encoded, path }) => {
      globalThis.cdp675Client ??= await globalThis.sliccKernelClient();
      await globalThis.cdp675Client.fs.mkdir('/tmp/cdp-675-packages', { recursive: true });
      await globalThis.cdp675Client.fs.writeFile(
        path,
        Uint8Array.from(atob(encoded), (each) => each.charCodeAt(0))
      );
      return globalThis.cdp675Client.run(['chmod', '755', '/tmp/cdp-675-packages']);
    },
    { encoded, path }
  );
  const readable = await sh(page, `chmod 644 ${quote(path)}`);
  checks.push({
    name: `staged package permissions ${name}`,
    pass: result.status === 0 && readable.status === 0,
    directory: result,
    file: readable,
  });
  return path;
}

async function rawChildren(chrome, rootSession) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const children = [];
  for (const target of targetInfos.filter((target) => target.type === 'iframe')) {
    const owner = await chrome.cdp
      .send('DOM.getFrameOwner', { frameId: target.targetId }, rootSession)
      .catch(() => null);
    if (!owner?.backendNodeId) continue;
    const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    try {
      children.push({
        targetId: target.targetId,
        owner,
        tree: await chrome.cdp.send('Page.getFrameTree', {}, sessionId),
      });
    } finally {
      await chrome.cdp.send('Target.detachFromTarget', { sessionId });
    }
  }
  return children;
}

async function guardRefusal(page, targetId, method, params) {
  return page.evaluate(
    async ({ targetId, method, params }) => {
      const connection = await globalThis.sliccBrowserHook();
      const pending = new Map();
      connection.onmessage = (text) => {
        const packet = JSON.parse(text);
        const entry = pending.get(packet.id);
        if (!entry) return;
        pending.delete(packet.id);
        clearTimeout(entry.timer);
        entry.resolve(packet);
      };
      const call = (id, method, params, sessionId) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ id, deadline: true });
          }, 10000);
          pending.set(id, { timer, resolve });
          connection.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
          );
        });
      try {
        const attached = await call(1, 'Target.attachToTarget', { targetId, flatten: true });
        if (!attached.result?.sessionId) return { attached };
        const request = { id: 2, method, params, sessionId: attached.result.sessionId };
        const reply = await call(request.id, method, params, request.sessionId);
        return { attached, request, reply };
      } finally {
        connection.close();
        for (const entry of pending.values()) clearTimeout(entry.timer);
      }
    },
    { targetId, method, params }
  );
}

async function lifecycleOpen(page, targetId) {
  return page.evaluate(async (targetId) => {
    const connection = await globalThis.sliccBrowserHook();
    const pending = new Map();
    const events = [];
    const calls = [];
    let next = 0;
    connection.onmessage = (text) => {
      const packet = JSON.parse(text);
      if (!packet.id) {
        events.push({ at: Date.now(), packet });
        return;
      }
      const entry = pending.get(packet.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(packet.id);
      entry.resolve(packet);
    };
    const holder = {
      events,
      calls,
      call(method, params = {}, sessionId = holder.sessionId) {
        const packet = { id: ++next, method, params, ...(sessionId ? { sessionId } : {}) };
        calls.push({ at: Date.now(), packet });
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(packet.id);
            resolve({ id: packet.id, deadline: true });
          }, 10000);
          pending.set(packet.id, { timer, resolve });
          connection.send(JSON.stringify(packet));
        });
      },
      close() {
        connection.close();
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.resolve({ id, closed: true });
        }
        pending.clear();
      },
    };
    globalThis.cdp675Lifecycle = holder;
    const attached = await holder.call('Target.attachToTarget', { targetId, flatten: true });
    holder.sessionId = attached.result?.sessionId;
    return attached;
  }, targetId);
}

async function lifecycleCall(page, method, params = {}) {
  return page.evaluate(({ method, params }) => globalThis.cdp675Lifecycle.call(method, params), {
    method,
    params,
  });
}

async function rawBounded(chrome, sessionId, method, params, milliseconds = 7000) {
  let timer;
  try {
    return await Promise.race([
      chrome.cdp.send(method, params, sessionId),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`raw ${method} exceeded ${milliseconds}ms`)),
          milliseconds
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function rawLoad(chrome, sessionId, method, params) {
  let off;
  let timer;
  const loaded = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('raw document load exceeded 6000ms')), 6000);
    off = chrome.cdp.on((packet) => {
      if (packet.sessionId === sessionId && packet.method === 'Page.loadEventFired') resolve(true);
    });
  });
  try {
    const [reply] = await Promise.all([rawBounded(chrome, sessionId, method, params), loaded]);
    return reply;
  } finally {
    clearTimeout(timer);
    off?.();
  }
}

async function lifecycleRow(page, chrome, rawSession, row, scene, url) {
  row.attached = await lifecycleOpen(page, row.target);
  assert.ok(row.attached.result?.sessionId, JSON.stringify(row.attached));
  row.armReplies = [];
  for (const [method, params] of [
    ['Page.enable', {}],
    ['Runtime.enable', {}],
    ['Debugger.enable', {}],
    ['Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' }],
  ]) {
    const reply = await lifecycleCall(page, method, params);
    row.armReplies.push({ method, reply });
    assert.ok(reply.result, JSON.stringify({ method, reply }));
  }
  await page.evaluate(() => {
    const holder = globalThis.cdp675Lifecycle;
    holder.reload = holder.call('Page.reload');
  });
  await page.within(10000, () =>
    globalThis.cdp675Lifecycle.events.some(({ packet }) => packet.method === 'Debugger.paused')
  );
  row.pause = await page.evaluate(() =>
    globalThis.cdp675Lifecycle.events.find(({ packet }) => packet.method === 'Debugger.paused')
  );
  assert.equal(row.pause.packet.params.reason, 'other');
  assert.ok(row.pause.packet.params.callFrames.length > 0);
  row.publishedScripts = await page.evaluate(() =>
    globalThis.cdp675Lifecycle.events.filter(
      ({ packet }) => packet.method === 'Debugger.scriptParsed'
    )
  );
  assert.ok(row.publishedScripts.length > 0, 'published pause needs placed script identity');
  row.pausedContext = row.rawWorlds.findLast(({ auxData }) => auxData?.isDefault)?.uniqueId;
  assert.ok(row.pausedContext);
  row.removed = await lifecycleCall(page, 'Debugger.removeBreakpoint', {
    breakpointId: row.armReplies.at(-1).reply.result.breakpointId,
  });
  assert.ok(row.removed.result, JSON.stringify(row.removed));
  if (['close', 'stall', 'owner-gone', 'worker', 'worker-stop'].includes(scene.lifecycle)) {
    await lifecycleRescue(page, chrome, rawSession, row, scene.lifecycle);
    return;
  }
  if (scene.lifecycle === 'stale') {
    const frame = row.pause.packet.params.callFrames[0];
    row.publishedSource = await lifecycleCall(page, 'Debugger.getScriptSource', {
      scriptId: frame.location.scriptId,
    });
    row.publishedFrame = await lifecycleCall(page, 'Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: '1',
      returnByValue: true,
    });
    for (const reply of [row.publishedSource, row.publishedFrame])
      assert.match(reply.error?.message ?? '', /^slicc: refused:/);
  }
  await lifecycleChanged(page, chrome, rawSession, row, scene, url);
}

async function lifecycleRescue(page, chrome, rawSession, row, kind) {
  if (kind === 'close') await page.evaluate(() => globalThis.cdp675Lifecycle.close());
  if (kind === 'owner-gone') {
    row.methods = await page.evaluate(
      (start) => globalThis.cdp675Trace.slice(start),
      row.traceStart
    );
    row.lifecycleFinal = await page.evaluate(() => ({
      events: globalThis.cdp675Lifecycle.events,
      calls: globalThis.cdp675Lifecycle.calls,
    }));
    const targets = await chrome.cdp.send('Target.getTargets', {});
    const owners = targets.targetInfos.filter(
      (info) => info.type === 'page' && info.url.startsWith(SEVEN)
    );
    assert.equal(owners.length, 1, 'only the controlled seven owner tab may be closed');
    row.ownerTarget = owners[0].targetId;
    row.ownerClosedAt = Date.now();
    row.ownerClosed = await chrome.cdp.send('Target.closeTarget', { targetId: row.ownerTarget });
    assert.equal(row.ownerClosed.success, true);
  }
  if (kind === 'worker' || kind === 'worker-stop') {
    const before = await chrome.cdp.send('Target.getTargets', {});
    const workers = before.targetInfos.filter(
      (info) => info.type === 'service_worker' && info.url.startsWith('chrome-extension://')
    );
    assert.equal(
      workers.length,
      1,
      'only the controlled candidate extension worker may be restarted'
    );
    row.workerBefore = workers[0];
    row.workerRestartAt = Date.now();
    if (kind === 'worker-stop') {
      row.workerStop = await chrome.cdp
        .send('Target.closeTarget', { targetId: workers[0].targetId })
        .catch((error) => ({ error: error.message }));
      row.workerStopSupported = row.workerStop.success === true;
      assert.equal(
        row.workerStopSupported,
        true,
        `raw CDP could not stop the owned extension worker target without unloading the extension: ${JSON.stringify(row.workerStop)}`
      );
    } else {
      const attached = await chrome.cdp.send('Target.attachToTarget', {
        targetId: workers[0].targetId,
        flatten: true,
      });
      row.workerRestart = await rawBounded(
        chrome,
        attached.sessionId,
        'Runtime.evaluate',
        { expression: 'chrome.runtime.reload()', returnByValue: true },
        1000
      ).catch((error) => ({ error: error.message }));
      await chrome.cdp
        .send('Target.detachFromTarget', { sessionId: attached.sessionId })
        .catch(() => {});
    }
  }
  row.progressReads = [];
  const until = row.pause.at + 7000;
  do {
    const started = Date.now();
    row.continued = await rawBounded(
      chrome,
      rawSession,
      'Runtime.evaluate',
      {
        expression: 'globalThis.cdp675Loads',
        returnByValue: true,
      },
      Math.max(1, until - started)
    );
    row.continuedAt = Date.now();
    row.progressReads.push({ started, ended: row.continuedAt, reply: row.continued });
    if (row.continued.result?.value === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < until);
  assert.equal(row.continued.result?.value, 2, 'raw observer must see paused page continue');
  assert.ok(row.continuedAt - row.pause.at < 7000, 'pause rescue exceeded its bound');
  row.rescueBoundMs = row.continuedAt - row.pause.at;
  if (kind === 'worker' || kind === 'worker-stop') {
    const until = Date.now() + 5000;
    do {
      const targets = await chrome.cdp.send('Target.getTargets', {});
      row.workerAfter = targets.targetInfos.find(
        (info) =>
          info.type === 'service_worker' &&
          info.url === row.workerBefore.url &&
          info.targetId !== row.workerBefore.targetId
      );
      if (row.workerAfter) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < until);
    assert.ok(row.workerAfter, 'extension runtime reload must actually replace its worker');
    row.workerRestartScope =
      kind === 'worker-stop'
        ? 'raw Target.closeTarget of only the owned worker; extension not unloaded, replacement target identity required'
        : 'chrome.runtime.reload of the owned extension; old worker death and new target identity required';
  }
  if (kind !== 'owner-gone') await page.evaluate(() => globalThis.cdp675Lifecycle.close());
  row.nextReloadAt = Date.now();
  await rawLoad(chrome, rawSession, 'Page.reload', {});
  row.nextReloadContinued = await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
    expression: 'globalThis.cdp675Loads',
    returnByValue: true,
  });
  assert.equal(row.nextReloadContinued.result?.value, 3);
  if (kind !== 'owner-gone')
    row.methods = await page.evaluate(
      (start) => globalThis.cdp675Trace.slice(start),
      row.traceStart
    );
  if (kind === 'owner-gone')
    row.postDeathEvidence = 'raw progress and next reload; owner tab has no event receiver';
  assert.equal(
    row.methods.some(
      ({ at, packet }) => at >= row.nextReloadAt && packet.method === 'Debugger.paused'
    ),
    false,
    'holder death left a pause on next reload'
  );
  assert.equal(
    row.methods.some(
      ({ direction, packet }) => direction === 'send' && packet.method === 'Debugger.resume'
    ),
    false,
    'client must not provide rescue'
  );
}

async function lifecycleChanged(page, chrome, rawSession, row, scene, url) {
  row.changedAt = Date.now();
  const destination = scene.lifecycle === 'revoke' ? `${SEVEN}/__675_frame` : `${url}&changed=1`;
  row.changedNavigation = await rawLoad(chrome, rawSession, 'Page.navigate', { url: destination });
  await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
    expression: 'document.readyState',
    returnByValue: true,
  });
  row.changedTree = await rawBounded(chrome, rawSession, 'Page.getFrameTree', {});
  assert.notEqual(row.changedTree.frameTree.frame.id, undefined);
  assert.notEqual(
    row.rawWorlds.findLast(({ auxData }) => auxData?.isDefault)?.uniqueId,
    row.pausedContext,
    'document-change premise requires a new realm'
  );
  if (scene.lifecycle === 'revoke') {
    assert.ok(
      row.rawFrames.some(
        (frame) => frame.url?.startsWith(SEVEN) || frame.unreachableUrl?.startsWith(SEVEN)
      ),
      'protected commit premise absent'
    );
    row.revokedResume = await lifecycleCall(page, 'Debugger.resume');
    assert.match(row.revokedResume.error?.message ?? '', /^slicc: refused:/);
    row.changedEvents = await page.evaluate(
      (at) => globalThis.cdp675Lifecycle.events.filter((event) => event.at >= at),
      row.changedAt
    );
    assert.equal(
      row.changedEvents.some(({ packet }) =>
        ['Debugger.paused', 'Debugger.scriptParsed', 'Debugger.scriptFailedToParse'].includes(
          packet.method
        )
      ),
      false
    );
    assert.ok(Date.now() - row.changedAt < 7000, 'protected document stalled');
    return;
  }
  if (scene.lifecycle === 'stale') {
    const frame = row.pause.packet.params.callFrames[0];
    row.staleSource = await lifecycleCall(page, 'Debugger.getScriptSource', {
      scriptId: frame.location.scriptId,
    });
    row.staleFrame = await lifecycleCall(page, 'Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: '1',
      returnByValue: true,
    });
    for (const reply of [row.staleSource, row.staleFrame])
      assert.match(reply.error?.message ?? '', /^slicc: refused:/);
  }
  row.staleInstall = await lifecycleCall(page, 'Runtime.evaluate', {
    expression: 'const __wmcp_675_stale_probe = 675',
    uniqueContextId: row.pausedContext,
    returnByValue: true,
  });
  assert.ok(
    row.staleInstall.error || row.staleInstall.result?.exceptionDetails,
    'old realm must not accept installation'
  );
  row.noNewInstall = await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
    expression: 'typeof __wmcp_675_stale_probe',
    returnByValue: true,
  });
  assert.equal(row.noNewInstall.result?.value, 'undefined');
  row.installProofScope =
    'guard-level stale uniqueContextId; not the Rust holder publication-to-install race';
}

async function shippedHolderDeath(page, chrome, rawSession, row, scene) {
  row.processTable = await sh(page, `printf 'server-pid '; cat ${row.pid}; ps -o pid,ppid,args`);
  const server = Number(row.processTable.stdout.match(/server-pid\s+(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(server) && server > 1, 'owned server PID is required');
  const children = row.processTable.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match &&
      Number(match[2]) === server &&
      /\bwebmcp-polyfill\b/.test(match[3]) &&
      match[3].includes(row.target)
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), argv: match[3] }]
      : [];
  });
  assert.equal(children.length, 1, 'exact owned packaged holder child is required');
  row.killedHolder = children[0];
  row.deathTraceStart = await page.evaluate(() => globalThis.cdp675Trace.length);
  let loading;
  if (scene.holderKill === 'load') {
    row.reloadStartedAt = Date.now();
    loading = rawLoad(chrome, rawSession, 'Page.reload', {});
    loading.catch(() => {});
    await page.within(
      7000,
      ({ start }) =>
        globalThis.cdp675Trace
          .slice(start)
          .some(
            ({ boundary, direction, packet }) =>
              boundary === 'bios' && direction === 'receive' && packet.method === 'Debugger.paused'
          ),
      { start: row.deathTraceStart }
    );
  }
  row.killStartedAt = Date.now();
  row.kill = await sh(page, `kill -9 ${children[0].pid} ${server}; echo holder-kill-status-$?`);
  row.killCompletedAt = Date.now();
  row.postDeathTraceStart = await page.evaluate(() => globalThis.cdp675Trace.length);
  assert.match(row.kill.stdout, /holder-kill-status-0/);
  row.deathMethods = await page.evaluate(
    (start) => globalThis.cdp675Trace.slice(start),
    row.deathTraceStart
  );
  const pauses = row.deathMethods.filter(
    ({ boundary, direction, packet, at }) =>
      boundary === 'bios' &&
      direction === 'receive' &&
      packet.method === 'Debugger.paused' &&
      at <= row.killStartedAt
  );
  const pause = pauses.at(-1);
  row.pauseAtKill = {
    publishedPauseAt: pause?.at ?? null,
    killStartedAt: row.killStartedAt,
    killCompletedAt: row.killCompletedAt,
    noObservedResumeDuringKill:
      Boolean(pause) &&
      !row.deathMethods.some(
        ({ at, packet }) =>
          at >= pause.at &&
          at <= row.killCompletedAt &&
          ['Debugger.resume', 'Debugger.resumed'].includes(packet.method)
      ),
    scope: 'publication and resume wire timing; does not claim an unobserved native pause',
  };
  if (!loading) {
    row.reloadStartedAt = Date.now();
    loading = rawLoad(chrome, rawSession, 'Page.reload', {});
  }
  await loading;
  row.loadCompletedAt = Date.now();
  row.deathProgress = await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
    expression: '({ loads: window.cdp675Loads, ready: document.readyState })',
    returnByValue: true,
  });
  assert.equal(row.deathProgress.result?.value?.loads, 3);
  assert.equal(row.deathProgress.result?.value?.ready, 'complete');
  assert.ok(row.loadCompletedAt - row.killStartedAt < 7000, 'holder death left the page stalled');
  row.deathMethods = await page.evaluate(
    (start) => globalThis.cdp675Trace.slice(start),
    row.deathTraceStart
  );
  row.postDeathMethods = await page.evaluate(
    (start) => globalThis.cdp675Trace.slice(start),
    row.postDeathTraceStart
  );
  assert.equal(
    row.postDeathMethods.some(
      ({ direction, packet }) => direction === 'receive' && packet.method?.startsWith('Debugger.')
    ),
    false,
    'Debugger publication survived holder death'
  );
  row.deathBoundMs = row.loadCompletedAt - row.killStartedAt;
}

async function waitPort(page, port) {
  return page.within(
    120000,
    async (port) => {
      try {
        const response = await globalThis.cdp675Client.loopbackFetch(
          new Request(`http://${port}.kernel.localhost/mcp`, { signal: AbortSignal.timeout(2000) }),
          { port }
        );
        await response.body?.cancel();
        return response.status >= 100 && response.status <= 599;
      } catch {
        return false;
      }
    },
    port
  );
}

async function discover(page, url) {
  const result = await page.evaluate(async () => {
    const connection = await globalThis.sliccBrowserHook();
    try {
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ deadline: true }), 10000);
        connection.onmessage = (text) => {
          const packet = JSON.parse(text);
          if (packet.id !== 1) return;
          clearTimeout(timer);
          resolve(packet);
        };
        connection.send(JSON.stringify({ id: 1, method: 'Target.getTargets', params: {} }));
      });
    } finally {
      connection.close();
    }
  });
  const target = fixtureTarget(result.result?.targetInfos, url);
  assert.ok(target, JSON.stringify(result));
  return target.targetId;
}

for (const route of ['extension', 'link']) {
  for (const mode of ['ordinary', 'foreign', 'old-route', 'guard-level']) {
    const foreign = mode === 'foreign';
    const oldRoute = mode === 'old-route';
    const guardLevel = mode === 'guard-level';
    const cases = guardLevel
      ? guardCases.filter((scene) => !scene.extensionOnly || route === 'extension')
      : foreign
        ? fallbackCases
        : oldRoute
          ? [{ name: 'old-route-terminal', reload: true, negative: true }]
          : ordinaryCases;
    test(`cdp 675 packaged ${route} ${mode}`, {
      skip: process.env.SLICC_675_STAGE1_DIAGNOSTIC !== '1',
      timeout: 900000,
    }, async (t) => {
      const trace = {
        route,
        mode,
        foreign,
        oldRoute,
        manifest,
        newGuardOutput: 0,
        setupChecks: [],
        rows: [],
        fetches: [],
        failedRequests: [],
      };
      const persist = async () => {
        if (!process.env.SLICC_PROOF_TRACE_DIR) return;
        await mkdir(process.env.SLICC_PROOF_TRACE_DIR, { recursive: true });
        await writeFile(
          join(process.env.SLICC_PROOF_TRACE_DIR, `cdp-675-packaged-${route}-${mode}.json`),
          JSON.stringify(trace, null, 2)
        );
      };
      t.after(persist);
      let chrome;
      let page;
      let setupError;
      let offBoot;
      const previous = process.env.SLICC_HARNESS_EXTENSION;
      try {
        process.env.SLICC_HARNESS_EXTENSION = foreign ? '1' : '0';
        const protectedSite = https(await certificate(), (_request, response) =>
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              '<!doctype html><title>Owned protected child</title><script>globalThis.cdp675ProtectedChild = true;</script>'
            )
        );
        await new Promise((resolve) => protectedSite.listen(0, '127.0.0.1', resolve));
        t.after(() => {
          protectedSite.closeAllConnections();
          protectedSite.close();
        });
        const protectedRules = [`MAP vault.sliccy.ai 127.0.0.1:${protectedSite.address().port}`];
        chrome =
          route === 'extension'
            ? await realExtension({
                rules: protectedRules,
                directory: oldRoute ? undefined : process.env.SLICC_675_EXTENSION_DIR,
                args: ['--disable-features=WebMCP,WebMCPTesting'],
              })
            : await launch({
                tools: false,
                args: [
                  '--disable-features=WebMCP,WebMCPTesting',
                  '--ignore-certificate-errors',
                  `--host-resolver-rules=${[`MAP seven.sliccy.ai 127.0.0.1:${protectedSite.address().port}`, ...protectedRules].join(', ')}`,
                ],
              });
        chrome.overrides.set(
          '/__675_frame',
          '<!doctype html><title>Owned protected child</title><script>globalThis.cdp675ProtectedChild = true;</script>'
        );
        const fixture = createServer((request, response) => {
          const at = new URL(request.url, 'http://fixture');
          if (at.pathname === '/data') {
            const entry = {
              at: Date.now(),
              url: request.url,
              delay: Number(at.searchParams.get('delay')),
            };
            trace.fetches.push(entry);
            setTimeout(() => {
              entry.sent = Date.now();
              response
                .writeHead(200, {
                  'content-type': 'text/plain',
                  'cache-control': at.searchParams.has('cached') ? 'max-age=3600' : 'no-store',
                })
                .end('ready');
            }, entry.delay);
            return;
          }
          response.writeHead(200, { 'content-type': 'text/html' });
          if (at.pathname === '/protected-doc') {
            (trace.protectedRequests ??= []).push({ at: Date.now(), host: request.headers.host });
            return response.end(
              '<!doctype html><title>675 protected fixture</title><script>globalThis.cdp675Protected = true;</script>'
            );
          }
          if (at.pathname === '/script')
            return response.end(`window.cdp675ScriptCount = (window.cdp675ScriptCount || 0) + 1;`);
          if (at.pathname === '/iframe')
            return response.end('<!doctype html><title>ordinary iframe</title>');
          const registration =
            'document.modelContext.registerTool({ name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, execute: ({a,b}) => String(a+b) })';
          const code = at.searchParams.has('foreign')
            ? at.searchParams.has('parse')
              ? `if (document.modelContext) { ${registration}; }`
              : `await fetch('/data?delay=${at.searchParams.get('delay') ?? 0}${at.searchParams.has('cached') ? '&cached=1' : ''}'); if (document.modelContext) { ${registration}; }`
            : `if (document.modelContext) { ${registration}; } else { const retry = setInterval(() => { if (document.modelContext) { clearInterval(retry); ${registration}; } }, 10); }`;
          const startup = at.searchParams.has('sequential')
            ? `async function start() { await fetch('/data?delay=150&step=who'); await fetch('/data?delay=150&step=inbox'); window.cdp675Connected = true; window.cdp675RegisterCalls = 1; if (document.modelContext) { ${registration}; } } await start();`
            : code;
          const scripts = at.searchParams.has('many')
            ? Array.from({ length: 100 }, (_, i) => `<script src="/script?i=${i}"></script>`).join(
                ''
              )
            : '';
          response.end(
            `<!doctype html><title>675 ordinary</title>${scripts}${foreign ? `<iframe src="${at.searchParams.has('protected') ? `https://${at.searchParams.get('protected')}.sliccy.ai/__675_frame` : '/iframe'}"></iframe>` : ''}<script type="module">window.cdp675Loads = (Number(sessionStorage.cdp675Loads) || 0) + 1; sessionStorage.cdp675Loads = window.cdp675Loads; ${startup}</script>`
          );
        });
        await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
        t.after(() => {
          fixture.closeAllConnections();
          fixture.close();
        });
        trace.fixtureOrigin = `http://localhost:${fixture.address().port}`;
        page = await chrome.page(t);
        chrome.overrides.set(
          '/seed/cdp.js',
          tapSource(await readFile(new URL('../../src/seed/cdp.js', import.meta.url), 'utf8'))
        );
        const requests = new Map();
        const failed = (entry) => {
          trace.failedRequests.push(entry);
          if (trace.failedRequests.length > 100) trace.failedRequests.shift();
        };
        offBoot = chrome.cdp.on(({ method, params, sessionId }) => {
          const key = `${sessionId ?? ''}:${params?.requestId}`;
          if (method === 'Network.requestWillBeSent') {
            const url = new URL(params.request.url);
            requests.set(key, {
              url: `${url.origin}${url.pathname}`.slice(0, 500),
              method: params.request.method,
            });
            if (requests.size > 1000) requests.delete(requests.keys().next().value);
          }
          if (method === 'Network.responseReceived' && params.response.status >= 400)
            failed({ ...requests.get(key), status: params.response.status });
          if (method === 'Network.loadingFailed') {
            failed({
              ...requests.get(key),
              errorText: params.errorText,
              canceled: params.canceled,
            });
            requests.delete(key);
          }
          if (method === 'Network.loadingFinished') requests.delete(key);
        });
        await page.init(() => {
          globalThis.sliccKernelDebug = true;
        });
        if (route === 'extension') {
          await page.goto(`${SEVEN}#users=enforce`);
          await ready(page, undefined, { tools: false });
          trace.selectedRoute = await page.evaluate(() => ({
            extension: globalThis.sliccExtension?.version,
            links: globalThis.sliccLinkedBrowsers().length,
          }));
          trace.setupChecks.push({
            name: 'selected extension route',
            pass:
              trace.selectedRoute.extension === (oldRoute ? '7.10.0' : '7.10.1') &&
              trace.selectedRoute.links === 0,
            actual: trace.selectedRoute,
          });
        } else {
          await boot(page, undefined, { tools: false });
          trace.setupChecks.push({
            name: 'link has no extension route',
            pass: (await page.evaluate(() => typeof globalThis.sliccExtension)) === 'undefined',
          });
          const runtimes = await linkNode(
            t,
            page,
            (await devtools(chrome)).port,
            'cdp-675-packaged',
            oldRoute
              ? fileURLToPath(new URL('../../node_modules/.bin/slicc', import.meta.url))
              : undefined
          );
          trace.selectedRoute = await page.evaluate(() =>
            globalThis.sliccLinkedBrowsers().map(({ runtime, route }) => ({ runtime, route }))
          );
          trace.setupChecks.push({
            name: 'selected link route',
            pass:
              runtimes.length > 0 &&
              trace.selectedRoute.length > 0 &&
              trace.selectedRoute.every(
                ({ route }) => route.version === (oldRoute ? '1.49.36' : '1.49.37')
              ),
            actual: trace.selectedRoute,
          });
        }
        const cdpPackage = await stagePackage(page, manifest.cdp, trace.setupChecks);
        const mcpcatPackage = await stagePackage(page, manifest.mcpcat, trace.setupChecks);
        trace.install = await cone(
          page,
          installCommand([cdpPackage, mcpcatPackage]),
          '675-install'
        );
        assert.match(trace.install.stdout, /install-status-0/);
        trace.packageProof = packageProof(trace.install, '1.43.2', manifest.wasmSha256);
      } catch (error) {
        setupError = error;
        trace.setupFailure = { name: error.name, message: error.message };
        if (page) {
          trace.bootState = await page
            .evaluate(() => ({
              location: `${location.origin}${location.pathname}`,
              splash: document.querySelector('.splash')?.dataset ?? null,
              verb: document.querySelector('.verb')?.textContent?.slice(0, 1000),
              steps: [...document.querySelectorAll('[data-step]')].map((item) => ({
                step: item.dataset.step,
                state: item.dataset.state,
                output: item.querySelector('output')?.value?.slice(0, 1000),
              })),
            }))
            .catch((failure) => ({ captureFailure: failure.message }));
          trace.consoleErrors = [...(page.errors ?? []), ...(page.console ?? [])]
            .slice(-40)
            .map((message) => String(message).slice(0, 1000));
        }
      } finally {
        offBoot?.();
        if (previous === undefined) delete process.env.SLICC_HARNESS_EXTENSION;
        else process.env.SLICC_HARNESS_EXTENSION = previous;
        await persist();
      }
      for (const [index, scene] of cases.entries()) {
        const row = {
          name: scene.name,
          step: 'setup',
          status: 'running',
          port: 8812 + index,
          log: `/tmp/675-serve-${index}.log`,
          pid: `/tmp/675-serve-${index}.pid`,
        };
        trace.rows.push(row);
        let targetId;
        let rawSession;
        let unobserve;
        try {
          if (setupError) throw setupError;
          row.packageProof = trace.packageProof;
          row.setupChecks = [...trace.setupChecks];
          if (scene.oldClient) {
            row.step = 'install-old-client';
            const oldPackage = await stagePackage(page, manifest.oldClient, row.setupChecks);
            row.oldInstall = await cone(page, installCommand([oldPackage]), '675-old-install');
            assert.match(row.oldInstall.stdout, /install-status-0/);
            row.packageProof = packageProof(row.oldInstall, '1.43.1', manifest.oldClientWasmSha256);
          }
          row.step = 'create-ordinary-target';
          const url = new URL(`/page?row=${index}`, trace.fixtureOrigin);
          if (scene.many) url.searchParams.set('many', '1');
          if (foreign) {
            url.searchParams.set('foreign', '1');
            url.searchParams.set('delay', String(scene.delay ?? 0));
            if (scene.cached) url.searchParams.set('cached', '1');
            if (scene.parse) url.searchParams.set('parse', '1');
            if (scene.sequential) url.searchParams.set('sequential', '1');
            if (scene.protectedSubframe) url.searchParams.set('protected', scene.protectedSubframe);
          }
          ({ targetId } = await chrome.cdp.send('Target.createTarget', {
            url: 'about:blank',
            newWindow: route === 'extension',
          }));
          ({ sessionId: rawSession } = await chrome.cdp.send('Target.attachToTarget', {
            targetId,
            flatten: true,
          }));
          row.rawNetwork = [];
          row.rawWorlds = [];
          row.rawFrames = [];
          unobserve = chrome.cdp.on(({ method, params, sessionId }) => {
            if (sessionId !== rawSession) return;
            if (method === 'Page.frameNavigated') row.rawFrames.push(params.frame);
            if (method === 'Runtime.executionContextCreated')
              row.rawWorlds.push({
                id: params.context.id,
                uniqueId: params.context.uniqueId,
                origin: params.context.origin,
                name: params.context.name,
                auxData: params.context.auxData,
              });
            if (method === 'Network.responseReceived')
              row.rawNetwork.push({
                at: Date.now(),
                url: params.response.url,
                status: params.response.status,
                fromDiskCache: params.response.fromDiskCache,
                fromServiceWorker: params.response.fromServiceWorker,
              });
          });
          await chrome.cdp.send('Network.enable', {}, rawSession);
          await chrome.cdp.send('Runtime.enable', {}, rawSession);
          await chrome.cdp.send('Page.enable', {}, rawSession);
          let loadTimer;
          let loadOff;
          const loaded = new Promise((resolve) => {
            loadTimer = setTimeout(() => resolve(false), 10000);
            loadOff = chrome.cdp.on(({ method, sessionId }) => {
              if (sessionId === rawSession && method === 'Page.loadEventFired') resolve(true);
            });
          });
          await chrome.cdp.send('Page.navigate', { url: url.href }, rawSession);
          row.initialLoaded = await loaded;
          clearTimeout(loadTimer);
          loadOff();
          row.setupChecks.push({
            name: 'ordinary target loaded',
            pass: row.initialLoaded === true,
          });
          if (foreign)
            row.setupChecks.push({
              name: 'real other extension world',
              pass: row.rawWorlds.some(
                ({ origin, name, auxData }) =>
                  origin.startsWith('chrome-extension://') &&
                  name !== 'slicc-navigate' &&
                  auxData?.isDefault === false
              ),
            });
          if (scene.protectedSubframe) {
            row.rawTree = await chrome.cdp.send('Page.getFrameTree', {}, rawSession);
            const frames = [];
            const walk = (node) => {
              frames.push(node.frame);
              for (const child of node.childFrames ?? []) walk(child);
            };
            row.rawProtectedChildren = await rawChildren(chrome, rawSession);
            walk(row.rawTree.frameTree);
            for (const child of row.rawProtectedChildren) walk(child.tree.frameTree);
            row.protectedFrames = frames.filter((frame) =>
              frame.url.startsWith(`https://${scene.protectedSubframe}.sliccy.ai/`)
            );
            assert.equal(
              row.protectedFrames.length,
              1,
              'protected child must really commit before guarded attach'
            );
          }
          row.step = 'guarded-discovery';
          row.target = await discover(page, url.href);
          row.traceStart = await page.evaluate(() => globalThis.cdp675Trace?.length ?? 0);
          if (guardLevel) {
            row.scope = 'guard-level, real bios browserHook; not Rust-path';
            if (scene.lifecycle) {
              row.step = 'guard-level-lifecycle';
              await lifecycleRow(page, chrome, rawSession, row, scene, url.href);
              row.status = 'pass';
              continue;
            }
            row.step = 'guard-level-refusal';
            row.probe = await guardRefusal(page, row.target, scene.method, scene.params);
            assert.ok(row.probe.attached.result?.sessionId, JSON.stringify(row.probe));
            assert.match(row.probe.reply?.error?.message ?? '', /^slicc: refused:/);
            row.methods = await page.evaluate(
              (start) => globalThis.cdp675Trace.slice(start),
              row.traceStart
            );
            assert.ok(
              row.methods.some(
                ({ boundary, direction, packet }) =>
                  boundary === 'bios' && direction === 'send' && packet.method === scene.method
              )
            );
            assert.equal(
              row.methods.some(
                ({ boundary, direction, packet }) =>
                  boundary === 'route' && direction === 'send' && packet.method === scene.method
              ),
              false,
              'refused method reached route'
            );
            row.status = 'pass';
            continue;
          }
          const command = `mcpcat serve --webmcp ${scene.reload ? '--webmcp-reload ' : ''}--tab ${quote(row.target)} --http ${row.port} --no-auth`;
          row.command = command;
          row.step = 'shipped-serve';
          await page.evaluate(
            async ({ command, log }) => {
              globalThis.cdp675Client ??= await globalThis.sliccKernelClient();
              globalThis.cdp675Server = globalThis.cdp675Client
                .run(
                  [
                    'bash',
                    '-c',
                    `sudo -u cone bash -c '${command.replaceAll("'", "'\\''")}' > ${log} 2>&1`,
                  ],
                  { cwd: '/' }
                )
                .then(({ status, stdout, stderr }) => ({ status, stdout, stderr }));
            },
            {
              command: `export PATH=$PNPM_HOME/bin:$PATH; export SLICC_CDP_URL=http://127.0.0.1:9222; echo $$ > ${row.pid}; exec ${command}`,
              log: row.log,
            }
          );
          row.step = 'shipped-server-ready';
          await page.within(
            120000,
            async ({ negative, log }) => {
              const { stdout } = await globalThis.cdp675Client.run(['bash', '-c', `cat ${log}`], {
                cwd: '/',
              });
              return negative
                ? /refused|update|needs.*newer/i.test(stdout)
                : stdout.includes('listening on http:');
            },
            {
              negative: Boolean(scene.negative || (scene.protectedSubframe && route === 'link')),
              log: row.log,
            }
          );
          row.portAnswered = await waitPort(page, row.port);
          if (scene.negative || (scene.protectedSubframe && route === 'link')) {
            row.step = 'terminal-bound';
            await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30000)));
            row.terminal = await sh(page, `cat ${row.log}`);
            assert.match(row.terminal.stdout, /refused|update|needs.*newer/i);
            assert.doesNotMatch(row.terminal.stdout, /restarting|restart in/i);
            row.methods = await page.evaluate(
              (start) => globalThis.cdp675Trace.slice(start),
              row.traceStart
            );
            const forwarded = row.methods
              .filter(({ boundary, direction }) => boundary === 'route' && direction === 'send')
              .map(({ packet }) => packet.method);
            if (!scene.oldClient) assert.ok(!forwarded.includes('Debugger.enable'));
            assert.equal(
              row.methods.some(
                ({ boundary, direction, packet }) =>
                  boundary === 'bios' &&
                  direction === 'receive' &&
                  [
                    'Debugger.paused',
                    'Debugger.scriptParsed',
                    'Debugger.scriptFailedToParse',
                  ].includes(packet.method)
              ),
              false,
              'terminal refusal must publish no Debugger content'
            );
            assert.equal(forwarded.filter((method) => method === 'Page.reload').length, 0);
            assert.equal(
              row.methods.filter(
                ({ boundary, direction, packet }) =>
                  boundary === 'bios' &&
                  direction === 'send' &&
                  ['Debugger.enable', 'Page.addScriptToEvaluateOnNewDocument'].includes(
                    packet.method
                  )
              ).length,
              scene.protectedSubframe ? 0 : 1
            );
            row.status = 'pass';
            continue;
          }
          row.step = 'shipped-tools-list';
          row.list = await cone(
            page,
            `timeout 60 mcpcat tools http://127.0.0.1:${row.port}/mcp --json`,
            `675-list-${index}`
          );
          const listing = JSON.parse(row.list.stdout);
          const tools = Array.isArray(listing) ? listing : listing.tools;
          row.tools = tools;
          assert.ok(Array.isArray(tools));
          if (scene.late) {
            assert.equal(tools.length, 0, row.list.stdout);
            assert.match(listing.hint ?? '', /before the polyfill was injected.*--webmcp-reload/);
            row.statusEvidence = {
              source: 'mcpcat late-only hint; no wire reload; root load count',
              late: true,
              reloaded: false,
            };
          } else if (scene.parse) {
            assert.equal(tools.length, 0, row.list.stdout);
            row.clearMessage = await sh(page, `cat ${row.log}`);
            assert.match(row.clearMessage.stdout, /other-extension fallback|startup or parse-time/);
          } else {
            const tool = tools.find(({ name }) => name === 'add' || name.endsWith('_add'));
            if (foreign && !tool) {
              row.zeroToolsMessage = await sh(page, `cat ${row.log}`);
              assert.match(
                row.zeroToolsMessage.stdout,
                /other-extension fallback|startup or parse-time/
              );
            }
            if (!tool && scene.measure) {
              row.raceOutcome = 'clear-message';
            } else {
              assert.ok(tool, row.list.stdout);
              if (scene.measure) row.raceOutcome = 'tools-listed';
              row.step = 'shipped-tools-call';
              row.call = await cone(
                page,
                `timeout 60 mcpcat call http://127.0.0.1:${row.port}/mcp ${quote(tool.name)} --a 2 --b 3`,
                `675-call-${index}`
              );
              assert.match(row.call.stdout, /^5$/m);
            }
          }
          row.methods = await page.evaluate(
            (start) => globalThis.cdp675Trace.slice(start),
            row.traceStart
          );
          const sent = row.methods
            .filter(({ boundary, direction }) => boundary === 'bios' && direction === 'send')
            .map(({ packet }) => packet.method);
          const forwarded = row.methods
            .filter(({ boundary, direction }) => boundary === 'route' && direction === 'send')
            .map(({ packet }) => packet.method);
          assert.ok(sent.includes('Runtime.evaluate'));
          assert.ok(forwarded.includes('Runtime.evaluate'));
          if (foreign) {
            const refusal = row.methods.findIndex(
              ({ boundary, direction, packet }) =>
                boundary === 'bios' &&
                direction === 'receive' &&
                /browser extension runs scripts|that execution context belongs to a browser extension|another extension|profiled|hidden.*world/i.test(
                  packet.error?.message ?? ''
                )
            );
            assert.ok(refusal >= 0, 'real other-extension refusal missing');
            row.fallbackStart = refusal;
            assert.equal(
              row.methods
                .slice(refusal + 1)
                .filter(
                  ({ boundary, direction, packet }) =>
                    boundary === 'route' &&
                    direction === 'send' &&
                    packet.method?.startsWith('Debugger.')
                ).length,
              0,
              'Debugger method sent after fallback began'
            );
          } else {
            assert.ok(forwarded.includes('Debugger.enable'));
            assert.ok(forwarded.includes('Debugger.setInstrumentationBreakpoint'));
          }
          for (const method of [
            'Debugger.pause',
            'Debugger.getScriptSource',
            'Debugger.evaluateOnCallFrame',
            'Page.addScriptToEvaluateOnNewDocument',
            'Runtime.addBinding',
          ])
            assert.ok(!sent.includes(method), method);
          const installations = row.methods.filter(
            ({ boundary, direction, packet }) =>
              boundary === 'bios' &&
              direction === 'send' &&
              packet.method === 'Runtime.evaluate' &&
              /^const __wmcp_/.test(packet.params?.expression ?? '')
          );
          assert.ok(installations.length > 0);
          if (foreign) {
            const reload = row.methods.find(
              ({ boundary, direction, packet }) =>
                boundary === 'bios' && direction === 'send' && packet.method === 'Page.reload'
            );
            assert.ok(reload);
            row.installLatencyMs = installations[0].at - reload.at;
            assert.ok(row.installLatencyMs >= 0);
          }
          if (scene.sequential) {
            row.startup = (
              await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
                expression:
                  '({ connected: window.cdp675Connected, registerCalls: window.cdp675RegisterCalls })',
                returnByValue: true,
              })
            ).result.value;
            assert.equal(row.startup.connected, true);
            assert.equal(row.startup.registerCalls, 1);
            row.sequentialFetches = trace.fetches.filter(
              ({ at, url }) =>
                at >=
                  row.methods.find(
                    ({ boundary, direction, packet }) =>
                      boundary === 'bios' && direction === 'send' && packet.method === 'Page.reload'
                  ).at && /step=(who|inbox)/.test(url)
            );
            assert.equal(row.sequentialFetches.length, 2);
            assert.ok(row.sequentialFetches[1].at >= row.sequentialFetches[0].sent);
          }
          if (scene.protectedSubframe) {
            const root = row.rawTree.frameTree.frame.id;
            for (const install of installations) {
              assert.ok(
                row.rawWorlds.some(
                  (world) =>
                    world.uniqueId === install.packet.params.uniqueContextId &&
                    world.auxData?.isDefault === true &&
                    world.auxData.frameId === root
                ),
                'fallback install must bind only to root main realm'
              );
            }
            row.reloadedChildren = await rawChildren(chrome, rawSession);
            const privateFrames = [
              ...row.protectedFrames,
              ...row.rawFrames.filter(
                (frame) =>
                  frame.parentId &&
                  [frame.url, frame.unreachableUrl].some((url) =>
                    /^https:\/\/(?:seven|vault)\.sliccy\.ai(?:\/|$)/i.test(url ?? '')
                  )
              ),
            ].map((frame) => frame.id);
            privateFrames.push(
              ...row.reloadedChildren.map((child) => child.tree.frameTree.frame.id)
            );
            const wire = JSON.stringify(row.methods.slice(row.fallbackStart + 1));
            for (const id of privateFrames)
              assert.ok(!wire.includes(id), 'fallback wire names protected subframe');
            row.fallbackOutputs = await sh(page, `cat ${row.log}`);
            for (const output of [
              row.list.stdout,
              row.list.stderr,
              row.call?.stdout ?? '',
              row.call?.stderr ?? '',
              JSON.stringify(tools),
              row.fallbackOutputs.stdout ?? '',
              row.fallbackOutputs.stderr ?? '',
            ])
              assert.doesNotMatch(output, /(?:seven|vault)\.sliccy\.ai/i);
          }
          const binding =
            installations[0].packet.params.expression.match(/^const (__wmcp_\w+)\s*=/)?.[1];
          assert.ok(binding);
          row.lexical = (
            await chrome.cdp.send(
              'Runtime.evaluate',
              {
                expression: `({type: typeof ${binding}, own: Object.getOwnPropertyNames(globalThis).includes(${JSON.stringify(binding)}), window: window[${JSON.stringify(binding)}] !== undefined, loads: window.cdp675Loads})`,
                returnByValue: true,
              },
              rawSession
            )
          ).result.value;
          assert.equal(row.lexical.type, 'object');
          assert.equal(row.lexical.own, false);
          assert.equal(row.lexical.window, false);
          assert.equal(row.lexical.loads, scene.reload ? 2 : 1);
          if (scene.reload && !foreign) {
            const published = row.methods.findIndex(
              ({ boundary, direction, packet }) =>
                boundary === 'bios' &&
                direction === 'receive' &&
                packet.method === 'Debugger.paused' &&
                packet.params.reason !== 'instrumentation'
            );
            const installed = row.methods.indexOf(installations[0]);
            assert.ok(published >= 0 && published < installed);
          }
          assert.equal(
            sent.filter((method) => method === 'Page.reload').length,
            scene.reload ? 1 : 0
          );
          assert.equal(
            forwarded.filter((method) => method === 'Page.reload').length,
            scene.reload ? 1 : 0,
            'reload must go through the selected guarded route'
          );
          row.reloadGuardEvidence = {
            source:
              'real wasm command through bios and selected route; raw observer sent no reload',
            bios: sent.filter((method) => method === 'Page.reload').length,
            route: forwarded.filter((method) => method === 'Page.reload').length,
          };
          if (scene.holderKill) {
            row.step = 'shipped-holder-death';
            await shippedHolderDeath(page, chrome, rawSession, row, scene);
          }
          if (scene.protectedHop) {
            row.step = 'armed-protected-hop';
            const destination =
              scene.protectedHop === 'seven'
                ? `${SEVEN}/protected-doc`
                : `http://vault.sliccy.ai:${new URL(trace.fixtureOrigin).port}/protected-doc`;
            const start = await page.evaluate(() => globalThis.cdp675Trace.length);
            const began = Date.now();
            let timer;
            let off;
            row.hopFrames = [];
            const settled = new Promise((resolve) => {
              timer = setTimeout(() => resolve(false), 6000);
              off = chrome.cdp.on(({ method, params, sessionId }) => {
                if (sessionId !== rawSession) return;
                if (method === 'Page.frameNavigated') row.hopFrames.push(params.frame);
                if (method === 'Page.loadEventFired') resolve(true);
              });
            });
            try {
              row.hopReply = await chrome.cdp.send(
                'Page.navigate',
                { url: destination },
                rawSession
              );
              row.hopSettled = await settled;
              row.hopMilliseconds = Date.now() - began;
              assert.equal(row.hopSettled, true, 'protected hop or error document stalled');
              assert.ok(row.hopMilliseconds < 6000, 'protected hop exceeded rescue bound');
            } finally {
              clearTimeout(timer);
              off();
            }
            await page.evaluate(
              (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
              Math.max(0, 6000 - (Date.now() - began))
            );
            row.hopMethods = await page.evaluate(
              (start) => globalThis.cdp675Trace.slice(start),
              start
            );
            const published = row.hopMethods.filter(
              ({ direction, packet }) =>
                direction === 'receive' &&
                [
                  'Debugger.scriptParsed',
                  'Debugger.scriptFailedToParse',
                  'Debugger.paused',
                ].includes(packet.method)
            );
            assert.deepEqual(
              published,
              [],
              'protected or blocked-hop error Debugger event published'
            );
            assert.equal(
              row.hopMethods.some(
                ({ direction, packet }) =>
                  direction === 'send' &&
                  packet.method === 'Runtime.evaluate' &&
                  /^const __wmcp_/.test(packet.params?.expression ?? '')
              ),
              false,
              'shim was installed after protected hop'
            );
            assert.ok(
              row.hopFrames.length > 0,
              'raw observer never saw the hop commit or error page'
            );
            row.hopErrorPage = row.hopFrames.some(
              (frame) =>
                frame.url?.startsWith('chrome-error:') ||
                frame.url?.startsWith('data:text/html') ||
                Boolean(frame.unreachableUrl)
            );
            assert.equal(row.hopErrorPage, true, 'blocked-hop error-page premise was not reached');
            row.hopEvidence = { shippedHolderArmed: true, rawObserverDebuggerEnabled: false };
          }
          row.status = 'pass';
        } catch (error) {
          row.status = [
            'setup',
            'install-old-client',
            'create-ordinary-target',
            'guarded-discovery',
            'shipped-server-ready',
          ].includes(row.step)
            ? 'setup-failure'
            : 'finding';
          row.failure = { name: error.name, message: error.message };
        } finally {
          countRow(row);
          if (page && !setupError) {
            if (!guardLevel) {
              row.serverLog = await sh(page, `cat ${row.log}`).catch((error) => ({
                error: error.message,
              }));
              await sh(page, `kill "$(cat ${row.pid})"`).catch(() => {});
            }
            if (guardLevel && !row.ownerClosed?.success) {
              row.lifecycleFinal = await page
                .evaluate(() => {
                  const holder = globalThis.cdp675Lifecycle;
                  if (!holder) return null;
                  holder.close();
                  const result = { events: holder.events, calls: holder.calls };
                  delete globalThis.cdp675Lifecycle;
                  return result;
                })
                .catch((error) => ({ error: error.message }));
            }
            row.methods ??= await page
              .evaluate((start) => globalThis.cdp675Trace?.slice(start ?? 0) ?? [], row.traceStart)
              .catch(() => []);
          }
          unobserve?.();
          if (rawSession)
            await chrome.cdp
              .send('Target.detachFromTarget', { sessionId: rawSession })
              .catch(() => {});
          if (targetId) await chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
          await persist();
        }
      }
      await chrome?.close();
      assert.equal(
        trace.rows.filter(({ status }) => status !== 'pass').length,
        0,
        JSON.stringify(
          trace.rows.map(
            ({ name, status, outcome, counted, step, failure, packageProof, setupChecks }) => ({
              name,
              status,
              outcome,
              counted,
              step,
              failure,
              packageProof,
              setupChecks,
            })
          )
        )
      );
    });
  }
}
