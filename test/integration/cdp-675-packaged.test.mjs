import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as https } from 'node:https';
import { tmpdir } from 'node:os';
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
const { bfcacheNavigation } = manifest
  ? await import(new URL('../../candidates/browsers/bfcache-restore.mjs', import.meta.url))
  : { bfcacheNavigation: null };
const harnessExtensionPath = fileURLToPath(
  new URL('./extension', import.meta.resolve('@ai-ecoverse/slicc-shared-web/harness'))
);
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const ordinaryCases = [
  { name: 'instrumented-list-call', reload: true },
  { name: 'armed-protected-and-ordinary-bfcache-restore', reload: true, bfcache: true },
  {
    name: 'armed-clean-ordinary-bfcache-restore',
    reload: true,
    bfcache: true,
    ordinaryBfcache: true,
    linkOnly: true,
  },
  { name: 'armed-speculation-no-prerender-activation', reload: true, prerender: true },
  { name: 'armed-exact-extra-origin-same-process-hop', reload: true, sameProcess: true },
  { name: 'shipped-publication-before-document-change-no-install', reload: true, race: true },
  { name: 'instrumented-plain-100-script-list-call', reload: true, many: true, loadCost: true },
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
  { name: 'ordinary-root-cross-origin-child-clear-error', reload: true, crossOriginChild: true },
  {
    name: 'protected-cross-origin-child-refuses',
    reload: true,
    crossOriginChild: true,
    protectedSubframe: 'vault',
  },
  {
    name: 'protected-among-ordinary-cross-origin-children-refuses',
    reload: true,
    crossOriginChild: true,
    protectedSubframe: 'vault',
    siblings: true,
  },
  {
    name: 'late-ordinary-cross-origin-frame-replaces-suspended-lease',
    reload: true,
    lateFrame: 'ordinary',
  },
  {
    name: 'late-protected-cross-origin-frame-revokes-document-lease',
    reload: true,
    lateFrame: 'protected',
  },
  {
    name: 'armed-seven-redirect-history-return',
    reload: true,
    protectedHop: 'seven',
    hopMode: 'redirect',
  },
  {
    name: 'armed-vault-redirect-history-return',
    reload: true,
    protectedHop: 'vault',
    hopMode: 'redirect',
  },
  {
    name: 'armed-seven-renderer-navigation-history-return',
    reload: true,
    protectedHop: 'seven',
    hopMode: 'renderer',
  },
  {
    name: 'armed-vault-renderer-navigation-history-return',
    reload: true,
    protectedHop: 'vault',
    hopMode: 'renderer',
  },
  { name: 'old-client-terminal', reload: true, negative: true, oldClient: true },
];
const guardCases = [
  { name: 'guard-level-frames-call-not-CDP', method: 'frames', params: {}, privateCall: true },
  {
    name: 'guard-level-sliccExtension-frames-not-CDP',
    method: 'sliccExtension.frames',
    params: {},
    privateCall: true,
  },
  {
    name: 'guard-level-Slicc-frames-not-CDP',
    method: 'Slicc.frames',
    params: {},
    privateCall: true,
  },
  { name: 'guard-level-own-https-echo-protected', lifecycle: 'echo' },
  { name: 'guard-level-late-real-foreign-world-rescue', lifecycle: 'late-world' },
  { name: 'guard-level-method-negatives-at-published-pause', lifecycle: 'negatives' },
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
  {
    name: 'foreign-opspile-two-sequential-fetches-repeat2',
    reload: true,
    delay: 150,
    sequential: true,
    extensionOnly: true,
  },
  {
    name: 'foreign-opspile-two-sequential-fetches-repeat3',
    reload: true,
    delay: 150,
    sequential: true,
    extensionOnly: true,
  },
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

function bfcacheMarkup(url) {
  const marker = JSON.stringify(
    `bfcache-marker-${new URL(url, 'http://fixture').searchParams.get('n') ?? ''}`
  ).replaceAll('<', '\\u003c');
  return `<script>globalThis.__bfcacheMarker=${marker};sessionStorage.setItem('bfcache-marker',globalThis.__bfcacheMarker);globalThis.__bfcachePersisted=false;addEventListener('pageshow',e=>{globalThis.__bfcachePersisted=e.persisted});globalThis.__bfcacheKeys=0;</script>`;
}

function tapSource(source) {
  const call =
    /guardProtected\(\s*await open\(\),\s*own,\s*browser \? tabs.get\(browser\) : undefined,\s*route(?:,\s*privateFrames)?\s*\)/;
  assert.ok(call.test(source));
  return (
    source.replace(
      call,
      (matched) =>
        `cdp675Tap(guardProtected(cdp675Tap(await open(), "route", route), own, browser ? tabs.get(browser) : undefined, route${matched.includes('privateFrames') ? ', privateFrames' : ''}), "bios", route)`
    ) +
    `
function cdp675Tap(connection, boundary, route) {
  const trace = globalThis.cdp675Trace ??= [];
  const connectionId = globalThis.cdp675ConnectionId = (globalThis.cdp675ConnectionId ?? 0) + 1;
  const record = (direction, text) => {
    const packet = JSON.parse(text);
    trace.push({ at: Date.now(), boundary, route, direction, connectionId, packet });
  };
  const send = connection.send.bind(connection);
  connection.send = (text) => {
    record('send', text);
    const race = globalThis.cdp675Race;
    const packet = JSON.parse(text);
    if (boundary === 'bios' && race?.armed && packet.method === 'Page.reload') {
      race.owner = packet.sessionId;
      race.reload = { at: Date.now(), packet };
    }
    return send(text);
  };
  let receive;
  connection.onmessage = (text) => {
    record('receive', text);
    const race = globalThis.cdp675Race;
    const packet = JSON.parse(text);
    if (boundary === 'bios' && race?.armed && race.owner === packet.sessionId && packet.method === 'Debugger.paused' && packet.params.reason === 'other') {
      race.armed = false;
      race.held = { at: Date.now(), packet };
      race.release = () => { if (race.released) return; race.released = true; receive?.(text); };
      return;
    }
    receive?.(text);
  };
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

function tapGuardSource(source) {
  const method = '  setDebuggerLease(targetId, state) {';
  return source.replace(
    method,
    `${method}\n    (globalThis.cdp675LeaseTrace ??= []).push({ at: Date.now(), targetId, state });`
  );
}

async function lateFrameRow(page, chrome, rawSession, row, scene, origin, binding) {
  row.lateFrameStart = await page.evaluate(() => ({
    wire: globalThis.cdp675Trace.length,
    leases: globalThis.cdp675LeaseTrace?.length ?? 0,
  }));
  row.lateFrameStartedAt = Date.now();
  const src =
    scene.lateFrame === 'protected'
      ? 'https://vault.sliccy.ai/__675_frame'
      : new URL('/iframe?late-child=1', origin.replace('localhost', '127.0.0.1')).href;
  row.lateFrameInserted = await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
    expression: `new Promise(resolve => { const frame = document.createElement('iframe'); frame.id = 'cdp675-late-frame'; frame.onload = () => resolve(true); frame.onerror = () => resolve(false); frame.src = ${JSON.stringify(src)}; document.body.append(frame); })`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(row.lateFrameInserted.result?.value, true);
  assert.ok(
    Date.now() - row.lateFrameStartedAt < 7000,
    'late frame must complete within the bound'
  );
  row.lateRootTools = (
    await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
      expression: `({ready: document.readyState, binding: typeof ${binding}, tools: ${binding}.list()})`,
      returnByValue: true,
    })
  ).result.value;
  assert.equal(row.lateRootTools.ready, 'complete');
  assert.equal(row.lateRootTools.binding, 'object', 'already installed root bridge stays');
  assert.match(row.lateRootTools.tools.toolsJson, /"add"/);
  row.lateLeaseStates = await page.evaluate(
    (start) => (globalThis.cdp675LeaseTrace ?? []).slice(start),
    row.lateFrameStart.leases
  );
  const states = row.lateLeaseStates.filter(({ targetId }) => targetId === row.target);
  assert.ok(
    states.some(({ state }) => state === 'suspended'),
    'frame arrival must suspend the bios-owned lease'
  );
  assert.equal(states.at(-1)?.state, scene.lateFrame === 'protected' ? 'revoked' : 'placed');
  row.lateFrameMethods = await page.evaluate(
    (start) => globalThis.cdp675Trace.slice(start),
    row.lateFrameStart.wire
  );
  const suspension = states.find(({ state }) => state === 'suspended');
  const outcome = states.at(-1);
  assert.equal(
    row.lateFrameMethods.some(
      ({ at, boundary, direction, packet }) =>
        at >= suspension.at &&
        at < outcome.at &&
        boundary === 'route' &&
        direction === 'send' &&
        packet.id < 2 ** 30 &&
        packet.method?.startsWith('Debugger.')
    ),
    false,
    'no client Debugger forwarding during suspension'
  );
  assert.equal(
    row.lateFrameMethods.some(
      ({ boundary, direction, packet }) =>
        boundary === 'bios' &&
        direction === 'receive' &&
        ['Debugger.paused', 'Debugger.scriptParsed', 'Debugger.scriptFailedToParse'].includes(
          packet.method
        )
    ),
    false
  );
  assert.equal(
    row.lateFrameMethods.some(
      ({ boundary, direction, packet }) =>
        boundary === 'bios' &&
        direction === 'send' &&
        packet.method === 'Runtime.evaluate' &&
        /^const __wmcp_/.test(packet.params?.expression ?? '')
    ),
    false,
    'late cross-origin frame must receive no installer and root must not install twice'
  );
  if (scene.lateFrame === 'protected') {
    assert.equal(
      row.lateFrameMethods.some(
        ({ at, boundary, direction, packet }) =>
          at >= outcome.at &&
          boundary === 'route' &&
          direction === 'send' &&
          packet.id < 2 ** 30 &&
          packet.method?.startsWith('Debugger.')
      ),
      false
    );
    assert.doesNotMatch(
      JSON.stringify(
        row.lateFrameMethods.filter(
          ({ boundary, direction }) => boundary === 'bios' && direction === 'receive'
        )
      ),
      /vault\.sliccy\.ai/
    );
  } else {
    row.lateToolsList = await cone(
      page,
      `timeout 60 mcpcat tools http://127.0.0.1:${row.port}/mcp --json`,
      `675-late-frame-list-${row.port}`
    );
    const listing = JSON.parse(row.lateToolsList.stdout);
    const tools = Array.isArray(listing) ? listing : listing.tools;
    const tool = tools.find(({ name }) => name === 'add' || name.endsWith('_add'));
    assert.ok(tool);
    row.lateToolsCall = await cone(
      page,
      `timeout 60 mcpcat call http://127.0.0.1:${row.port}/mcp ${quote(tool.name)} --a 2 --b 3`,
      `675-late-frame-call-${row.port}`
    );
    assert.match(row.lateToolsCall.stdout, /^5$/m);
  }
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
      if (
        packet.sessionId === sessionId &&
        (packet.method === 'Page.loadEventFired' ||
          (((method === 'Runtime.evaluate' && params.expression === 'history.back()') ||
            method === 'Page.navigateToHistoryEntry') &&
            packet.method === 'Page.frameNavigated' &&
            packet.params.type === 'BackForwardCacheRestore'))
      )
        resolve(true);
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

async function lateExtensionFixture() {
  const path = await mkdtemp(join(tmpdir(), 'thr_uzh6iuph2q-late-extension-'));
  try {
    await cp(harnessExtensionPath, path, { recursive: true });
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    for (const entry of manifest.content_scripts) entry.matches = ['http://*/*late=1*'];
    await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest));
    return path;
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

async function rawNavigate(chrome, sessionId, url) {
  const events = [];
  let reply;
  let timer;
  let resolveLoad;
  const check = () => {
    if (!reply?.loaderId) return;
    const commit = events.findIndex(
      ({ method, params }) =>
        method === 'Page.frameNavigated' &&
        params.frame?.id === reply.frameId &&
        params.frame.loaderId === reply.loaderId
    );
    if (
      commit >= 0 &&
      events.slice(commit + 1).some(({ method }) => method === 'Page.loadEventFired')
    )
      resolveLoad();
  };
  const loaded = new Promise((resolve, reject) => {
    resolveLoad = resolve;
    timer = setTimeout(() => reject(new Error('new ordinary loader load exceeded 6000ms')), 6000);
  });
  const off = chrome.cdp.on((packet) => {
    if (packet.sessionId !== sessionId) return;
    if (['Page.frameNavigated', 'Page.loadEventFired'].includes(packet.method)) events.push(packet);
    check();
  });
  try {
    const navigation = rawBounded(chrome, sessionId, 'Page.navigate', { url }).then((result) => {
      reply = result;
      assert.ok(reply.loaderId && reply.frameId, 'ordinary navigation needs the actual new loader');
      check();
      return result;
    });
    const [result] = await Promise.all([navigation, loaded]);
    const tree = await rawBounded(chrome, sessionId, 'Page.getFrameTree', {});
    assert.equal(tree.frameTree.frame.loaderId, result.loaderId);
    return result;
  } finally {
    clearTimeout(timer);
    off();
  }
}

async function workerRenderer(
  chrome,
  row,
  readProcesses = (ids) =>
    execFileSync('ps', ['-p', ids.join(','), '-o', 'pid=,args='], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 1048576,
    })
) {
  const extensionId = new URL(row.workerBefore.url).hostname;
  const targets = (await chrome.cdp.send('Target.getTargets', {})).targetInfos;
  const extensionTargets = targets.filter((target) =>
    target.url?.startsWith('chrome-extension://')
  );
  const workers = extensionTargets.filter((target) => target.type === 'service_worker');
  assert.equal(
    workers.length,
    1,
    'PID mapping requires only the owned extension worker in this Chrome'
  );
  assert.equal(workers[0].targetId, row.workerBefore.targetId);
  assert.ok(
    extensionTargets.every((target) => new URL(target.url).hostname === extensionId),
    'another extension makes renderer PID association unproved'
  );
  row.workerProcessInfo = await chrome.cdp.send('SystemInfo.getProcessInfo', {});
  const renderers = row.workerProcessInfo.processInfo.filter(
    (process) => process.type === 'renderer'
  );
  const ids = renderers.map((process) => Number(process.id));
  assert.ok(ids.length > 0 && ids.every((id) => Number.isSafeInteger(id) && id > 1));
  const commands = readProcesses(ids)
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
  row.workerRendererCandidates = commands.filter(
    ({ pid, command }) => ids.includes(pid) && /(?:^|\s)--extension-process(?:\s|$)/.test(command)
  );
  assert.equal(
    row.workerRendererCandidates.length,
    1,
    'exactly one owned extension renderer is required; never guess a PID'
  );
  const candidate = row.workerRendererCandidates[0];
  row.workerRenderer = renderers.find((process) => Number(process.id) === candidate.pid);
  const current = await chrome.cdp.send('SystemInfo.getProcessInfo', {});
  assert.ok(
    current.processInfo.some(
      (process) => process.type === 'renderer' && Number(process.id) === candidate.pid
    )
  );
  row.workerPIDProof = {
    pid: candidate.pid,
    extensionId,
    soleWorkerTarget: workers[0].targetId,
    activeWorkerScope: true,
    rendererCommand: candidate.command,
    source:
      'own Chrome SystemInfo renderer IDs, active sole owned extension worker, sole --extension-process renderer among exactly those PIDs',
  };
  return candidate.pid;
}

async function recoverWorker(page, row, budget = 30000) {
  const until = Date.now() + budget;
  const retryable =
    "Seven couldn't check the browser for sign-in tabs before handing it over. Try again.";
  row.workerGuardAttempts = [];
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('new guarded extension call did not recover within its bound')),
      budget
    );
  });
  const recovering = async () => {
    do {
      const attempt = { at: Date.now() };
      row.workerGuardAttempts.push(attempt);
      try {
        row.workerGuardAttach = await lifecycleOpen(page, row.target);
        assert.ok(row.workerGuardAttach.result?.sessionId, JSON.stringify(row.workerGuardAttach));
        row.workerGuardEnable = await lifecycleCall(page, 'Runtime.enable');
        assert.ok(row.workerGuardEnable.result, JSON.stringify(row.workerGuardEnable));
        row.workerGuardRead = await lifecycleCall(page, 'Runtime.evaluate', {
          expression: '6 * 7',
          returnByValue: true,
        });
        assert.equal(
          row.workerGuardRead.result?.result?.value,
          42,
          'a new guarded call must work after lazy extension restart'
        );
        attempt.success = true;
        return;
      } catch (error) {
        attempt.error = error.message;
        await Promise.resolve(page.evaluate(() => globalThis.cdp675Lifecycle?.close())).catch(
          () => {}
        );
        if (!error.message.includes(retryable)) throw error;
        if (Date.now() >= until) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())));
      }
    } while (Date.now() < until);
    throw new Error('new guarded extension call did not recover within its bound');
  };
  try {
    await Promise.race([recovering(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopOwnedWorker(chrome, row) {
  const targetId = row.workerBefore.targetId;
  const destroyed = [];
  const off = chrome.cdp.on(({ method, params }) => {
    if (method === 'Target.targetDestroyed' && params.targetId === targetId)
      destroyed.push({ at: Date.now(), targetId });
  });
  let extensionTarget;
  let extensionSession;
  try {
    ({ targetId: extensionTarget } = await chrome.cdp.send('Target.createTarget', {
      url: new URL('/manifest.json', row.workerBefore.url).href,
      background: true,
    }));
    ({ sessionId: extensionSession } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: extensionTarget,
      flatten: true,
    }));
    await chrome.cdp.send('Target.setDiscoverTargets', { discover: true });
    row.workerEnable = await rawBounded(chrome, extensionSession, 'ServiceWorker.enable', {}, 1000);
    row.workerStop = await rawBounded(
      chrome,
      extensionSession,
      'ServiceWorker.stopAllWorkers',
      {},
      1000
    ).catch((error) => ({ error: error.message }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    row.workerAfterStopTargets = (await chrome.cdp.send('Target.getTargets', {})).targetInfos;
    if (
      !destroyed.length &&
      row.workerAfterStopTargets.some((target) => target.targetId === targetId)
    ) {
      const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      try {
        const extensionId = new URL(row.workerBefore.url).hostname;
        row.workerActiveScope = await rawBounded(
          chrome,
          sessionId,
          'Runtime.evaluate',
          {
            expression: `typeof ServiceWorkerGlobalScope === 'function' && globalThis instanceof ServiceWorkerGlobalScope && chrome.runtime.id === ${JSON.stringify(extensionId)}`,
            returnByValue: true,
          },
          1000
        );
        assert.equal(
          row.workerActiveScope.result?.value,
          true,
          'the owned worker must execute in its live service-worker realm'
        );
        const pid = await workerRenderer(chrome, row);
        assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
        process.kill(pid, 'SIGKILL');
        row.workerKilledAt = Date.now();
        row.workerStopPath = 'owned-renderer-SIGKILL';
      } finally {
        await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
    } else {
      row.workerStopPath = 'ServiceWorker.stopAllWorkers';
    }
    row.workerStopChecks = [];
    const until = Math.min(Date.now() + 1000, (row.pause?.at ?? Date.now()) + 7000);
    do {
      row.workerStoppedTargets = (await chrome.cdp.send('Target.getTargets', {})).targetInfos;
      const present = row.workerStoppedTargets.some((target) => target.targetId === targetId);
      if (row.workerPIDProof && present && !destroyed.length) {
        row.workerProcessAfterKill = await chrome.cdp.send('SystemInfo.getProcessInfo', {});
        row.workerRendererExitObserved = !row.workerProcessAfterKill.processInfo.some(
          (process) => Number(process.id) === row.workerPIDProof.pid
        );
      }
      row.workerStopChecks.push({
        at: Date.now(),
        targetPresent: present,
        destroyed: destroyed.length,
        rendererExitObserved: row.workerRendererExitObserved === true,
      });
      if (!present || destroyed.length || row.workerRendererExitObserved) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < until);
    row.workerDestroyed = destroyed;
    row.workerStopSupported =
      destroyed.length > 0 ||
      row.workerRendererExitObserved === true ||
      !row.workerStoppedTargets.some((target) => target.targetId === targetId);
    assert.equal(
      row.workerStopSupported,
      true,
      'neither worker stop nor owned renderer kill proved that the original target stopped'
    );
  } finally {
    off();
    if (extensionSession)
      await chrome.cdp
        .send('Target.detachFromTarget', { sessionId: extensionSession })
        .catch(() => {});
    if (extensionTarget)
      await chrome.cdp.send('Target.closeTarget', { targetId: extensionTarget }).catch(() => {});
  }
}

function oncePerRealm(installations) {
  const counts = new Map();
  for (const { packet } of installations) {
    const realm = packet.params?.uniqueContextId;
    assert.ok(realm, 'installer must name the verified realm');
    counts.set(realm, (counts.get(realm) ?? 0) + 1);
  }
  assert.ok(counts.size > 0);
  for (const count of counts.values())
    assert.equal(count, 1, 'same realm installed more than once');
  return Object.fromEntries(counts);
}

async function echoRefusal(page, chrome, rawSession, row, url) {
  row.echoControl = await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
    expression:
      '({ origin: location.origin, ready: document.readyState, loaded: globalThis.cdp675ProtectedChild })',
    returnByValue: true,
  });
  assert.equal(row.echoControl.result?.value?.origin, new URL(url).origin);
  assert.equal(row.echoControl.result?.value?.ready, 'complete');
  assert.equal(row.echoControl.result?.value?.loaded, true);
  row.echoDiscovery = await page.evaluate(async () => {
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
  assert.ok(row.echoDiscovery.result?.targetInfos);
  assert.equal(
    row.echoDiscovery.result.targetInfos.some(
      (target) =>
        target.targetId === row.rawTargetId ||
        target.targetId === row.echoTargetId ||
        target.url?.startsWith('https://echo.sliccy.ai')
    ),
    false
  );
  assert.ok(row.echoTargetId, 'protected attach probe needs the real route target identity');
  row.echoAttach = await lifecycleOpen(page, row.echoTargetId);
  assert.match(row.echoAttach.error?.message ?? '', /^slicc: refused:/);
  row.echoRefusals = [];
  for (const [method, params] of [
    ['Debugger.enable', {}],
    ['Debugger.disable', {}],
    ['Debugger.resume', {}],
    ['Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' }],
    ['Debugger.removeBreakpoint', { breakpointId: '675-echo' }],
    ['Page.getFrameTree', {}],
  ]) {
    const reply = await page.evaluate(
      ({ method, params, sessionId }) => globalThis.cdp675Lifecycle.call(method, params, sessionId),
      { method, params, sessionId: rawSession }
    );
    row.echoRefusals.push({ method, reply });
    assert.match(reply.error?.message ?? '', /^slicc: refused:/);
  }
  row.echoLeaseRefused = row.echoRefusals.find(({ method }) => method === 'Debugger.enable');
  row.echoEvents = await page.evaluate(() => globalThis.cdp675Lifecycle.events);
  assert.deepEqual(row.echoEvents, []);
  row.methods = await page.evaluate((start) => globalThis.cdp675Trace.slice(start), row.traceStart);
  assert.equal(
    row.methods.some(
      ({ boundary, direction, packet }) =>
        boundary === 'route' && direction === 'send' && packet.method?.startsWith('Debugger.')
    ),
    false
  );
  await page.evaluate(() => globalThis.cdp675Lifecycle.close());
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
  if (scene.lifecycle !== 'late-world') {
    row.removed = await lifecycleCall(page, 'Debugger.removeBreakpoint', {
      breakpointId: row.armReplies.at(-1).reply.result.breakpointId,
    });
    assert.ok(row.removed.result, JSON.stringify(row.removed));
  }
  if (['close', 'stall', 'owner-gone', 'worker', 'worker-stop'].includes(scene.lifecycle)) {
    await lifecycleRescue(page, chrome, rawSession, row, scene.lifecycle);
    return;
  }
  if (scene.lifecycle === 'late-world') {
    row.lateWorldStartedAt = Date.now();
    row.lateExtension = { path: row.lateExtensionPath, loadedAtLaunch: true };
    const marked = new URL(url);
    marked.searchParams.set('late', '1');
    row.lateNavigation = await rawNavigate(chrome, rawSession, marked.href);
    row.lateProgress = await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
      expression: '({ready: document.readyState, loads: globalThis.cdp675Loads})',
      returnByValue: true,
    });
    assert.equal(row.lateProgress.result?.value?.ready, 'complete');
    assert.ok(
      [2, 3].includes(row.lateProgress.result?.value?.loads),
      'only the one pending reload may also complete before the marked navigation'
    );
    assert.ok(Date.now() - row.lateWorldStartedAt < 7000, 'late foreign world transition stalled');
    row.lateForeignWorlds = row.rawWorlds.filter(
      ({ origin, auxData }) =>
        origin.startsWith('chrome-extension://') && auxData?.isDefault === false
    );
    assert.ok(row.lateForeignWorlds.length > 0, 'late real extension world must actually arrive');
    row.lateRefusal = await lifecycleCall(page, 'Debugger.enable');
    assert.match(row.lateRefusal.error?.message ?? '', /^slicc: refused:/);
    row.lateEvents = await page.evaluate(
      (at) => globalThis.cdp675Lifecycle.events.filter((event) => event.at >= at),
      row.lateWorldStartedAt
    );
    assert.equal(
      row.lateEvents.some(({ packet }) =>
        ['Debugger.paused', 'Debugger.scriptParsed', 'Debugger.scriptFailedToParse'].includes(
          packet.method
        )
      ),
      false
    );
    row.methods = await page.evaluate(
      (start) => globalThis.cdp675Trace.slice(start),
      row.traceStart
    );
    assert.equal(
      row.methods.some(
        ({ direction, packet }) => direction === 'send' && packet.method === 'Debugger.resume'
      ),
      false
    );
    row.lateFallbackReloads = row.methods.filter(
      ({ at, boundary, direction, packet }) =>
        at >= row.lateWorldStartedAt &&
        boundary === 'bios' &&
        direction === 'send' &&
        packet.method === 'Page.reload'
    ).length;
    assert.equal(row.lateFallbackReloads, 0);
    assert.equal(
      row.methods.filter(
        ({ boundary, direction, packet }) =>
          boundary === 'bios' && direction === 'send' && packet.method === 'Page.reload'
      ).length,
      1
    );
    row.lateScope =
      'guard-level successful enable and normal pause on unmarked page before real launch-loaded fixture extension content script matches marked new loader; pause privately rescued within bound; no shipped fallback transition claimed';
    await page.evaluate(() => globalThis.cdp675Lifecycle.close());
    return;
  }
  if (scene.lifecycle === 'negatives') {
    row.negativeReplies = [];
    const frame = row.pause.packet.params.callFrames[0];
    for (const [method, params] of [
      ['Debugger.setBreakpoint', { location: frame.location }],
      ['Debugger.setBreakpointByUrl', { lineNumber: 0, url }],
      ['DOMDebugger.setEventListenerBreakpoint', { eventName: 'click' }],
      ['EventBreakpoints.setInstrumentationBreakpoint', { eventName: 'beforeScriptExecution' }],
      ['Page.addScriptToEvaluateOnNewDocument', { source: 'globalThis.__675_negative = true' }],
      ['Runtime.addBinding', { name: '__675_negative' }],
    ]) {
      const reply = await lifecycleCall(page, method, params);
      row.negativeReplies.push({ method, reply });
      assert.match(reply.error?.message ?? '', /^slicc: refused:/);
    }
    await lifecycleRescue(page, chrome, rawSession, row, 'close');
    for (const { method } of row.negativeReplies)
      assert.equal(
        row.methods.some(
          ({ boundary, direction, packet }) =>
            boundary === 'route' && direction === 'send' && packet.method === method
        ),
        false
      );
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
    row.ownerBefore = (await page.send('Target.getTargetInfo', {})).targetInfo;
    assert.equal(row.ownerBefore.type, 'page');
    assert.ok(row.ownerBefore.targetId);
    assert.notEqual(
      row.ownerBefore.targetId,
      row.rawTargetId,
      'owner is not the controlled paused page'
    );
    row.ownerTarget = row.ownerBefore.targetId;
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
    row.workerBeforeInfo = (
      await chrome.cdp.send('Target.getTargetInfo', { targetId: row.workerBefore.targetId })
    ).targetInfo;
    assert.equal(row.workerBeforeInfo.targetId, row.workerBefore.targetId);
    row.workerRestartAt = Date.now();
    if (kind === 'worker-stop') {
      await stopOwnedWorker(chrome, row);
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
    const targets = await chrome.cdp.send('Target.getTargets', {});
    row.workerAfterTargets = targets.targetInfos.filter(
      (info) => info.type === 'service_worker' && info.url === row.workerBefore.url
    );
    row.workerAfter = row.workerAfterTargets[0] ?? null;
    row.workerAfterInfo = row.workerAfter
      ? (await chrome.cdp.send('Target.getTargetInfo', { targetId: row.workerAfter.targetId }))
          .targetInfo
      : null;
    row.workerIdentityChanged = Boolean(
      row.workerAfter && row.workerAfter.targetId !== row.workerBefore.targetId
    );
    row.workerRestartScope =
      kind === 'worker-stop'
        ? `${row.workerStopPath} of the owned worker renderer, extension not unloaded`
        : 'chrome.runtime.reload of only the owned extension';
    row.workerObservation =
      kind === 'worker-stop' && row.workerRendererExitObserved
        ? 'owned worker renderer exited; CDP target identity may remain cached; raw page progress observed'
        : row.workerIdentityChanged
          ? 'owned worker target identity replaced; raw page progress observed'
          : row.workerAfter
            ? 'original worker target identity remained; stop or restart not established despite raw page progress'
            : 'no owned worker target observed after operation; replacement not established';
    if (kind === 'worker-stop') assert.equal(row.workerStopSupported, true, row.workerObservation);
    else {
      row.workerGuardCallAt = Date.now();
      try {
        row.lifecycleBeforeRecovery = await page.evaluate(() => {
          const holder = globalThis.cdp675Lifecycle;
          holder.close();
          return { calls: holder.calls, events: holder.events };
        });
        await recoverWorker(page, row);
        row.workerGuardRecovered = true;
      } catch (error) {
        row.workerGuardRecovered = false;
        row.workerGuardRecoveryError = error.message;
      }
      row.workerGuardCallMs = Date.now() - row.workerGuardCallAt;
      row.workerAfterGuardCallTargets = (
        await chrome.cdp.send('Target.getTargets', {})
      ).targetInfos.filter(
        (info) => info.type === 'service_worker' && info.url === row.workerBefore.url
      );
      row.workerObservation = row.workerGuardRecovered
        ? 'paused page continued within bound; optional new guarded extension call recovered, target facts recorded'
        : 'paused page continued within bound; guarded-call recovery not established and recorded only as a status-quo fact';
    }
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
  if (kind === 'worker' && row.workerGuardRecovered) {
    for (const boundary of ['bios', 'route'])
      assert.ok(
        row.methods.some(
          ({ at, boundary: lane, direction, route, packet }) =>
            at >= row.workerGuardCallAt &&
            lane === boundary &&
            direction === 'send' &&
            route?.kind === 'extension' &&
            packet.method === 'Runtime.evaluate' &&
            packet.params?.expression === '6 * 7'
        ),
        'restart recovery call must cross bios and the extension'
      );
  }
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
  row.processIdentity = await sh(page, `printf 'server-pid '; cat ${row.pid}; cat ${row.log}`);
  const server = Number(row.processIdentity.stdout.match(/server-pid\s+(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(server) && server > 1, 'owned server PID is required');
  const holders = row.processIdentity.stdout.split('\n').flatMap((line) => {
    const match = line.match(/holder-pid (\d+) tab (\S+)$/);
    return match && match[2] === row.target ? [{ pid: Number(match[1]), tab: match[2] }] : [];
  });
  assert.equal(
    holders.length,
    1,
    'exact PID reported by the owned packaged holder spawn is required'
  );
  assert.ok(
    Number.isSafeInteger(holders[0].pid) && holders[0].pid > 1 && holders[0].pid !== server
  );
  row.killedHolder = holders[0];
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
  row.kill = await sh(page, `kill -9 ${holders[0].pid} ${server}; echo holder-kill-status-$?`);
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

async function publicationRace(page, chrome, rawSession, row, url) {
  await page.within(10000, () => Boolean(globalThis.cdp675Race?.held));
  row.race = await page.evaluate(() => ({
    held: globalThis.cdp675Race.held,
    reload: globalThis.cdp675Race.reload,
    owner: globalThis.cdp675Race.owner,
  }));
  assert.equal(row.race.held.packet.params.reason, 'other');
  assert.equal(row.race.held.packet.sessionId, row.race.reload.packet.sessionId);
  row.race.beforeTree = await rawBounded(chrome, rawSession, 'Page.getFrameTree', {});
  row.race.beforeContext = row.rawWorlds.findLast(({ auxData }) => auxData?.isDefault)?.uniqueId;
  assert.ok(row.race.beforeContext);
  row.race.changedAt = Date.now();
  const changed = new URL(url);
  changed.searchParams.set('raceChanged', '1');
  row.race.navigation = await rawLoad(chrome, rawSession, 'Page.navigate', { url: changed.href });
  row.race.afterTree = await rawBounded(chrome, rawSession, 'Page.getFrameTree', {});
  row.race.afterContext = row.rawWorlds.findLast(({ auxData }) => auxData?.isDefault)?.uniqueId;
  assert.notEqual(
    row.race.afterTree.frameTree.frame.loaderId,
    row.race.beforeTree.frameTree.frame.loaderId
  );
  assert.notEqual(row.race.afterContext, row.race.beforeContext);
  assert.ok(row.race.afterContext);
  row.race.releasedAt = Date.now();
  await page.evaluate(() => globalThis.cdp675Race.release());
  assert.ok(
    row.race.releasedAt - row.race.reload.at < 2000,
    'race must replace the document before the shipped installer budget expires'
  );
  row.race.scope =
    'real shipped Rust holder, guard-published normal pause delivery held in existing bios trace tap until raw owned-root loader and context change; unchanged packet then released';
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
  for (const mode of [
    'ordinary',
    'foreign',
    'old-route',
    'guard-level',
    'owner-death',
    'worker-stop',
    'worker-restart',
    'late-world',
  ]) {
    if (route === 'link' && mode.startsWith('worker-')) continue;
    const foreign = mode === 'foreign';
    const oldRoute = mode === 'old-route';
    const guardLevel = [
      'guard-level',
      'owner-death',
      'worker-stop',
      'worker-restart',
      'late-world',
    ].includes(mode);
    const cases = guardLevel
      ? guardCases.filter(
          (scene) =>
            (mode === 'owner-death'
              ? scene.lifecycle === 'owner-gone'
              : mode === 'worker-stop'
                ? scene.lifecycle === 'worker-stop'
                : mode === 'worker-restart'
                  ? scene.lifecycle === 'worker'
                  : mode === 'late-world'
                    ? scene.lifecycle === 'late-world'
                    : !['owner-gone', 'worker-stop', 'worker', 'late-world'].includes(
                        scene.lifecycle
                      )) &&
            (!scene.extensionOnly || route === 'extension')
        )
      : foreign
        ? fallbackCases.filter((scene) => !scene.extensionOnly || route === 'extension')
        : oldRoute
          ? [{ name: 'old-route-terminal', reload: true, negative: true }]
          : ordinaryCases.filter((scene) => !scene.linkOnly || route === 'link');
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
        const lateExtensionPath = mode === 'late-world' ? await lateExtensionFixture() : null;
        if (lateExtensionPath)
          t.after(() => rm(lateExtensionPath, { recursive: true, force: true }));
        trace.lateExtensionPath = lateExtensionPath;
        const protectedSite = https(await certificate(), (request, response) =>
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              `<!doctype html><title>Owned protected child</title>${request.url.startsWith('/bfcache') ? bfcacheMarkup(request.url) : '<script>globalThis.cdp675ProtectedChild = true;</script>'}`
            )
        );
        await new Promise((resolve) => protectedSite.listen(0, '127.0.0.1', resolve));
        t.after(() => {
          protectedSite.closeAllConnections();
          protectedSite.close();
        });
        const protectedRules = [
          `MAP vault.sliccy.ai 127.0.0.1:${protectedSite.address().port}`,
          `MAP echo.sliccy.ai 127.0.0.1:${protectedSite.address().port}`,
        ];
        chrome =
          route === 'extension'
            ? await realExtension({
                rules: protectedRules,
                directory: oldRoute ? undefined : process.env.SLICC_675_EXTENSION_DIR,
                extraExtensions: lateExtensionPath ? [lateExtensionPath] : [],
                args: ['--disable-features=WebMCP,WebMCPTesting'],
              })
            : await launch({
                tools: false,
                extensions: lateExtensionPath ? [lateExtensionPath] : [],
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
        const sameProcessSite = createServer((_request, response) =>
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              '<!doctype html><title>Owned extra-origin protected document</title><script>globalThis.cdp675Protected = true;</script>'
            )
        );
        await new Promise((resolve) => sameProcessSite.listen(0, '127.0.0.1', resolve));
        trace.sameProcessOrigin = `http://localhost:${sameProcessSite.address().port}`;
        t.after(() => {
          sameProcessSite.closeAllConnections();
          sameProcessSite.close();
        });
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
          if (at.pathname === '/redirect') {
            response.writeHead(302, { location: at.searchParams.get('to') });
            return response.end();
          }
          response.writeHead(200, { 'content-type': 'text/html' });
          if (at.pathname === '/prerender-candidate')
            return response.end('<!doctype html><title>675 no-activation candidate</title>');
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
            `<!doctype html><title>675 ordinary</title>${at.pathname === '/bfcache' ? bfcacheMarkup(request.url) : ''}${scripts}${at.searchParams.has('crossChild') ? `<iframe src="${at.searchParams.has('protected') ? `https://${at.searchParams.get('protected')}.sliccy.ai/__675_frame` : `http://127.0.0.1:${fixture.address().port}/iframe`}"></iframe>` : ''}${at.searchParams.has('siblings') ? `<iframe src="http://127.0.0.1:${fixture.address().port}/iframe?ordinary=one"></iframe><iframe src="http://127.0.0.1:${fixture.address().port}/iframe?ordinary=two"></iframe>` : ''}${foreign ? `<iframe src="${at.searchParams.has('protected') ? `https://${at.searchParams.get('protected')}.sliccy.ai/__675_frame` : '/iframe'}"></iframe>` : ''}<script type="module">window.cdp675Loads = (Number(sessionStorage.cdp675Loads) || 0) + 1; sessionStorage.cdp675Loads = window.cdp675Loads; ${startup}</script>`
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
        chrome.overrides.set(
          '/seed/guard.js',
          tapGuardSource(
            await readFile(new URL('../../src/seed/guard.js', import.meta.url), 'utf8')
          )
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
              : undefined,
            oldRoute ? [] : [trace.sameProcessOrigin]
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
        let bfcacheDriver;
        let bfcacheOff;
        try {
          if (setupError) throw setupError;
          row.packageProof = trace.packageProof;
          row.setupChecks = [...trace.setupChecks];
          if (route === 'extension' && scene.sequential)
            row.repeatReason =
              'three sequential opspile rows verify the frame-tree freshness fence, rather than fetch latency or a lucky result';
          if (scene.oldClient) {
            row.step = 'install-old-client';
            const oldPackage = await stagePackage(page, manifest.oldClient, row.setupChecks);
            row.oldInstall = await cone(page, installCommand([oldPackage]), '675-old-install');
            assert.match(row.oldInstall.stdout, /install-status-0/);
            row.packageProof = packageProof(row.oldInstall, '1.43.1', manifest.oldClientWasmSha256);
          }
          row.step = 'create-ordinary-target';
          let url = new URL(
            scene.bfcache ? `/bfcache?n=675-${route}-${index}-a` : `/page?row=${index}`,
            trace.fixtureOrigin
          );
          if (scene.lifecycle === 'echo') url = new URL('https://echo.sliccy.ai/__675_echo');
          if (scene.crossOriginChild) url.searchParams.set('crossChild', '1');
          if (scene.siblings) url.searchParams.set('siblings', '1');
          if (scene.protectedSubframe) url.searchParams.set('protected', scene.protectedSubframe);
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
          row.rawTargetId = targetId;
          row.rawNetwork = [];
          row.rawWorlds = [];
          row.rawFrames = [];
          row.rawLoads = [];
          row.rawRedirects = [];
          unobserve = chrome.cdp.on(({ method, params, sessionId }) => {
            if (sessionId !== rawSession) return;
            if (method === 'Network.requestWillBeSent' && params.redirectResponse)
              row.rawRedirects.push({
                at: Date.now(),
                from: params.redirectResponse.url,
                to: params.request.url,
                status: params.redirectResponse.status,
              });
            if (method === 'Page.frameNavigated') {
              row.rawFrames.push(params.frame);
              (row.rawEvents ??= []).push({ method, params, sessionId, at: Date.now() });
            }
            if (method === 'Page.loadEventFired')
              row.rawLoads.push({ at: Date.now(), timestamp: params.timestamp });
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
          row.baselineLoadStartedAt = Date.now();
          await chrome.cdp.send('Page.navigate', { url: url.href }, rawSession);
          row.initialLoaded = await loaded;
          row.baselineLoadCompletedAt = Date.now();
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
          if (scene.crossOriginChild && !scene.protectedSubframe) {
            row.ordinaryPageRelay = (
              await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
                expression: 'typeof globalThis.sliccExtension',
                returnByValue: true,
              })
            ).result.value;
            assert.equal(
              row.ordinaryPageRelay,
              'undefined',
              'ordinary page cannot reach the seven-only relay'
            );
          }
          if (scene.lifecycle === 'late-world') {
            row.lateExtensionPath = trace.lateExtensionPath;
            assert.equal(
              row.rawWorlds.some(
                ({ origin, auxData }) =>
                  origin.startsWith('chrome-extension://') && auxData?.isDefault === false
              ),
              false,
              'unmarked page must have no real foreign world before enable'
            );
          }
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
            if (scene.crossOriginChild)
              row.protectedFrames = frames.filter((frame) =>
                [frame.url, frame.unreachableUrl].some((url) =>
                  url?.startsWith(`https://${scene.protectedSubframe}.sliccy.ai/`)
                )
              );
            if (scene.siblings)
              assert.ok(
                frames.filter((frame) =>
                  frame.url?.startsWith(
                    `http://127.0.0.1:${new URL(trace.fixtureOrigin).port}/iframe`
                  )
                ).length >= 2,
                'protected-sibling row needs several actual ordinary children'
              );
            assert.equal(
              row.protectedFrames.length,
              1,
              'protected child must really commit before guarded attach'
            );
          }
          if (scene.bfcache) {
            const reader = {
              events: [],
              send: (method, params, sessionId) => rawBounded(chrome, sessionId, method, params),
            };
            bfcacheOff = chrome.cdp.on((event) => reader.events.push(event));
            bfcacheDriver = bfcacheNavigation({
              reader,
              targetId,
              ordinary: trace.fixtureOrigin,
              protectedOrigin: scene.ordinaryBfcache
                ? trace.fixtureOrigin
                : 'https://vault.sliccy.ai',
              tag: `675-${route}-${index}`,
            });
            row.bfcache = await bfcacheDriver.prepare();
            row.bfcache.ordinaryHistoryOnly = Boolean(scene.ordinaryBfcache);
            url = new URL(row.bfcache.url);
          }
          row.step = 'guarded-discovery';
          row.traceStart = await page.evaluate(() => globalThis.cdp675Trace?.length ?? 0);
          if (scene.lifecycle === 'echo') {
            row.scope =
              'guard-level, real bios browserHook; raw own HTTPS echo control, not Rust-path';
            row.step = 'guard-level-echo-refusal';
            row.echoTargetId = targetId;
            if (route === 'extension') {
              const workers = (await chrome.cdp.send('Target.getTargets', {})).targetInfos.filter(
                ({ type, url }) =>
                  type === 'service_worker' && url.startsWith('chrome-extension://')
              );
              assert.equal(
                workers.length,
                1,
                'echo identity lookup only uses the owned candidate worker'
              );
              const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
                targetId: workers[0].targetId,
                flatten: true,
              });
              try {
                const lookup = await rawBounded(chrome, sessionId, 'Runtime.evaluate', {
                  expression: `chrome.tabs.query({url: ${JSON.stringify(url.href)}}).then(tabs => tabs.map(tab => tab.id))`,
                  awaitPromise: true,
                  returnByValue: true,
                });
                assert.equal(lookup.result?.value?.length, 1);
                row.echoTargetId = String(lookup.result.value[0]);
              } finally {
                await chrome.cdp.send('Target.detachFromTarget', { sessionId });
              }
            }
            row.echoGuardIdentity =
              route === 'extension'
                ? 'owned extension chrome.tabs exact URL lookup'
                : 'raw Chrome target ID used by CLI route';
            await echoRefusal(page, chrome, rawSession, row, url.href);
            row.status = 'pass';
            continue;
          }
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
            row.probe = await guardRefusal(
              page,
              row.target,
              scene.method,
              scene.privateCall ? { tabId: row.target } : scene.params
            );
            assert.ok(row.probe.attached.result?.sessionId, JSON.stringify(row.probe));
            if (scene.privateCall) {
              assert.ok(
                row.probe.reply?.error,
                'a CDP client cannot call the private frame reader'
              );
              assert.doesNotMatch(
                JSON.stringify(row.probe.reply),
                /rootDocumentId|remoteOwners|native-child/
              );
            } else assert.match(row.probe.reply?.error?.message ?? '', /^slicc: refused:/);
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
            if (!scene.privateCall)
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
          if (scene.race)
            await page.evaluate(() => {
              globalThis.cdp675Race = { armed: true };
            });
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
          if (scene.race) {
            row.step = 'shipped-publication-document-race';
            await publicationRace(page, chrome, rawSession, row, url);
          }
          row.step = 'shipped-server-ready';
          await page.within(
            120000,
            async ({ negative, race, log }) => {
              const { stdout } = await globalThis.cdp675Client.run(['bash', '-c', `cat ${log}`], {
                cwd: '/',
              });
              return race
                ? /refused|could not verify|listening on http:/i.test(stdout)
                : negative
                  ? /refused|update|needs.*newer/i.test(stdout)
                  : stdout.includes('listening on http:');
            },
            {
              negative: Boolean(scene.negative || scene.protectedSubframe),
              race: Boolean(scene.race),
              log: row.log,
            }
          );
          row.portAnswered = await waitPort(page, row.port);
          if (scene.bfcache && route === 'link' && !scene.ordinaryBfcache) {
            row.step = 'protected-history-pre-arm-refusal';
            row.terminal = await sh(page, `cat ${row.log}`);
            assert.match(
              row.terminal.stdout,
              /Target.attachToTarget: slicc: refused: the guard couldn’t keep seven’s pages and the vault out of this tab/
            );
            row.methods = await page.evaluate(
              (start) => globalThis.cdp675Trace.slice(start),
              row.traceStart
            );
            assert.equal(
              row.methods.some(
                ({ boundary, direction, packet }) =>
                  boundary === 'bios' &&
                  direction === 'send' &&
                  (packet.method?.startsWith('Debugger.') ||
                    packet.method === 'Page.reload' ||
                    (packet.method === 'Runtime.evaluate' &&
                      /^const __wmcp_/.test(packet.params?.expression ?? '')))
              ),
              false,
              'protected history must be refused before holder arms or fallback begins'
            );
            const publications = row.methods.filter(
              ({ boundary, direction }) => boundary === 'bios' && direction === 'receive'
            );
            assert.equal(
              publications.some(({ packet }) => packet.method?.startsWith('Debugger.')),
              false
            );
            for (const output of [
              JSON.stringify(publications),
              row.terminal.stdout,
              row.terminal.stderr,
            ])
              assert.doesNotMatch(output, /vault\.sliccy\.ai/i);
            row.bfcache.scope =
              'protected history refused before holder attach; no protected restore reached through an armed link holder';
            row.status = 'pass';
            continue;
          }
          if (scene.race) {
            row.race.terminal = await sh(page, `cat ${row.log}`);
            assert.match(row.race.terminal.stdout, /refused|could not verify|listening on http:/i);
            row.race.newDocument = await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
              expression:
                '({ ready: document.readyState, modelContext: typeof document.modelContext })',
              returnByValue: true,
            });
            assert.equal(row.race.newDocument.result?.value?.ready, 'complete');
            row.methods = await page.evaluate(
              (start) => globalThis.cdp675Trace.slice(start),
              row.traceStart
            );
            row.race.installations = row.methods.filter(
              ({ boundary, direction, packet }) =>
                boundary === 'bios' &&
                direction === 'send' &&
                packet.method === 'Runtime.evaluate' &&
                packet.params.expression?.startsWith('const __wmcp_')
            );
            for (const installation of row.race.installations) {
              assert.notEqual(
                installation.packet.params.uniqueContextId,
                row.race.beforeContext,
                'stale context must never receive the shim'
              );
              assert.equal(installation.packet.params.uniqueContextId, row.race.afterContext);
              assert.ok(
                row.methods.some(
                  ({ at, boundary, direction, packet }) =>
                    at >= row.race.changedAt &&
                    at <= installation.at &&
                    boundary === 'bios' &&
                    direction === 'receive' &&
                    packet.method === 'Debugger.paused' &&
                    packet.params.reason === 'other' &&
                    packet.params.callFrames?.[0]?.callFrameId !==
                      row.race.held.packet.params.callFrames?.[0]?.callFrameId
                ),
                'new document install requires its own fresh published pause'
              );
            }
            assert.equal(
              row.methods.filter(
                ({ boundary, direction, packet }) =>
                  boundary === 'bios' && direction === 'send' && packet.method === 'Page.reload'
              ).length,
              1
            );
            row.status = 'pass';
            continue;
          }
          if (scene.negative || scene.protectedSubframe) {
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
              scene.protectedSubframe ? (route === 'extension' ? 1 : 0) : scene.oldClient ? 2 : 1
            );
            if (scene.protectedSubframe) {
              if (route === 'extension') {
                const request = row.methods.find(
                  ({ boundary, direction, packet }) =>
                    boundary === 'bios' &&
                    direction === 'send' &&
                    packet.method === 'Debugger.enable'
                );
                assert.ok(request);
                row.protectedRefusal = row.methods.find(
                  ({ at, boundary, direction, packet }) =>
                    at >= request.at &&
                    boundary === 'bios' &&
                    direction === 'receive' &&
                    packet.id === request.packet.id &&
                    packet.error?.message ===
                      'slicc: refused: seven’s own pages and the vault are out of reach of browser automation'
                );
                assert.ok(
                  row.protectedRefusal,
                  'bios must refuse Debugger.enable for the protected subframe'
                );
              }
              assert.equal(
                row.methods.some(
                  ({ boundary, direction, packet }) =>
                    boundary === 'bios' &&
                    direction === 'send' &&
                    packet.method === 'Runtime.evaluate' &&
                    /^const __wmcp_/.test(packet.params?.expression ?? '')
                ),
                false,
                'protected refusal must never start fallback'
              );
              row.protectedList = await cone(
                page,
                `timeout 60 mcpcat tools http://127.0.0.1:${row.port}/mcp --json`,
                `675-protected-list-${index}`
              );
              const listing = JSON.parse(row.protectedList.stdout);
              if (route === 'link') {
                assert.equal(listing.tools, undefined, 'refusal is not an empty page');
                assert.match(
                  listing.error?.message ?? '',
                  /Target.attachToTarget: slicc: refused: seven’s own pages and the vault/
                );
              } else {
                assert.deepEqual(listing.tools, []);
                assert.match(listing.hint, /guard refused|refused/i);
              }
              const publications = row.methods.filter(
                ({ boundary, direction }) => boundary === 'bios' && direction === 'receive'
              );
              for (const output of [
                JSON.stringify(publications),
                row.protectedList.stdout,
                row.protectedList.stderr,
                row.terminal.stdout,
                row.terminal.stderr,
              ])
                assert.doesNotMatch(output, /(?:seven|vault)\.sliccy\.ai/i);
            }
            if (scene.oldClient) {
              row.oldClientStartup = Object.fromEntries(
                ['Debugger.enable', 'Page.addScriptToEvaluateOnNewDocument'].map((method) => [
                  method,
                  row.methods.filter(
                    ({ boundary, direction, packet }) =>
                      boundary === 'bios' && direction === 'send' && packet.method === method
                  ).length,
                ])
              );
              assert.equal(row.oldClientStartup['Debugger.enable'], 1);
              assert.equal(row.oldClientStartup['Page.addScriptToEvaluateOnNewDocument'], 1);
            }
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
          if (
            foreign &&
            (scene.measure || scene.parse) &&
            listing.hint ===
              'webmcp: other-extension fallback could not verify the reloaded document; tools are unavailable'
          ) {
            assert.deepEqual(tools, []);
            assert.equal(listing.error, undefined);
            assert.doesNotMatch(row.list.stdout, /unverified isolated context/);
            row.raceOutcome = 'clear-message-after-fallback-refusal';
            row.clearMessage = await sh(page, `cat ${row.log}`);
            assert.match(row.clearMessage.stdout, /other-extension fallback could not verify/);
            row.methods = await page.evaluate(
              (start) => globalThis.cdp675Trace.slice(start),
              row.traceStart
            );
            const trigger = row.methods.findIndex(
              ({ boundary, direction, packet }) =>
                boundary === 'bios' &&
                direction === 'receive' &&
                /browser extension runs scripts|another extension/.test(packet.error?.message ?? '')
            );
            assert.ok(trigger >= 0, 'fallback must have a real other-extension cause');
            const after = row.methods.slice(trigger + 1);
            assert.equal(
              after.some(
                ({ boundary, direction, packet }) =>
                  boundary === 'route' &&
                  direction === 'send' &&
                  packet.method?.startsWith('Debugger.')
              ),
              false
            );
            assert.equal(
              after.filter(
                ({ boundary, direction, packet }) =>
                  boundary === 'bios' && direction === 'send' && packet.method === 'Page.reload'
              ).length,
              1
            );
            const reload = after.find(
              ({ boundary, direction, packet }) =>
                boundary === 'bios' && direction === 'send' && packet.method === 'Page.reload'
            );
            assert.ok(reload);
            row.fallbackRefusal = after.find(
              ({ boundary, direction, connectionId, packet }) =>
                connectionId === reload.connectionId &&
                boundary === 'bios' &&
                direction === 'receive' &&
                /seven’s own pages and the vault|target is on seven's origin/.test(
                  packet.error?.message ?? ''
                )
            );
            assert.ok(
              row.fallbackRefusal,
              'fresh replay refusal must remain terminal, never retried'
            );
            const afterRefusal = after.slice(after.indexOf(row.fallbackRefusal) + 1);
            assert.equal(
              afterRefusal.some(
                ({ boundary, direction, connectionId, packet }) =>
                  connectionId === reload.connectionId &&
                  boundary === 'bios' &&
                  direction === 'send' &&
                  ['Target.attachToTarget', 'Runtime.enable', 'Page.reload'].includes(packet.method)
              ),
              false,
              'protected refusal must not be retried'
            );
            assert.equal(
              after.some(
                ({ boundary, direction, packet }) =>
                  boundary === 'bios' &&
                  direction === 'send' &&
                  packet.method === 'Runtime.evaluate' &&
                  /^const __wmcp_/.test(packet.params?.expression ?? '')
              ),
              false
            );
            row.status = 'pass';
            continue;
          }
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
          row.installationsPerRealm = oncePerRealm(installations);
          if (scene.crossOriginChild) {
            row.crossOriginChildren = await rawChildren(chrome, rawSession);
            assert.ok(
              row.crossOriginChildren.some(
                ({ tree }) => new URL(tree.frameTree.frame.url).origin !== trace.fixtureOrigin
              ),
              'cross-origin child must really exist'
            );
            row.crossOriginMessage = await sh(page, `cat ${row.log}`);
            assert.match(
              row.crossOriginMessage.stdout,
              /cross-origin child tools are unavailable on this guarded route/
            );
            assert.ok(row.tools.some(({ name }) => name === 'add' || name.endsWith('_add')));
            assert.match(row.call.stdout, /^5$/m);
            for (const { tree } of row.crossOriginChildren)
              assert.equal(
                installations.some(({ packet }) =>
                  row.rawWorlds.some(
                    ({ uniqueId, auxData }) =>
                      uniqueId === packet.params.uniqueContextId &&
                      auxData?.frameId === tree.frameTree.frame.id
                  )
                ),
                false
              );
          }
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
          assert.equal(
            row.lexical.loads,
            scene.ordinaryBfcache ? 4 : scene.bfcache ? 3 : scene.reload ? 2 : 1
          );
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
          if (scene.loadCost) {
            const reload = row.methods.find(
              ({ boundary, direction, packet }) =>
                boundary === 'bios' && direction === 'send' && packet.method === 'Page.reload'
            );
            const completed = row.rawLoads.find(({ at }) => at >= reload.at);
            assert.ok(
              completed,
              '100-script positive must finish loading before list/call completes'
            );
            row.loadCost = {
              scripts: 100,
              baselineMs: row.baselineLoadCompletedAt - row.baselineLoadStartedAt,
              holderMs: completed.at - reload.at,
            };
            row.loadCost.addedMs = row.loadCost.holderMs - row.loadCost.baselineMs;
            assert.ok(
              row.loadCost.addedMs < (route === 'link' ? 2000 : 1000),
              `100-script holder added ${row.loadCost.addedMs}ms`
            );
          }
          if (scene.bfcache) {
            row.step = 'armed-bfcache-restore';
            const start = await page.evaluate(() => globalThis.cdp675Trace.length);
            row.bfcache.protectedRestore = await bfcacheDriver.restore(row.bfcache.protectedEntry);
            if (scene.ordinaryBfcache)
              row.bfcache.scope =
                'clean tab with only ordinary history; first ordinary restore and return to armed ordinary B measured separately from refused protected-history tab';
            row.bfcache.methods = await page.evaluate(
              (start) => globalThis.cdp675Trace.slice(start),
              start
            );
            const publications = row.bfcache.methods.filter(
              ({ boundary, direction }) => boundary === 'bios' && direction === 'receive'
            );
            if (!scene.ordinaryBfcache)
              assert.equal(
                publications.some(({ packet }) => packet.method?.startsWith('Debugger.')),
                false,
                'protected restore must publish nothing'
              );
            row.bfcache.protectedOutput = await sh(page, `cat ${row.log}`);
            for (const output of [
              JSON.stringify(publications),
              row.list.stdout,
              row.call.stdout,
              row.bfcache.protectedOutput.stdout,
              row.bfcache.protectedOutput.stderr,
            ])
              assert.doesNotMatch(output, /vault\.sliccy\.ai/i);
            row.bfcache.ordinaryRestore = await bfcacheDriver.restore(row.bfcache.ordinaryEntry);
            row.bfcache.list = await cone(
              page,
              `timeout 60 mcpcat tools http://127.0.0.1:${row.port}/mcp --json`,
              `675-bfcache-${index}`
            );
            const listing =
              row.bfcache.list.status === 0 ? JSON.parse(row.bfcache.list.stdout) : {};
            const tools = Array.isArray(listing) ? listing : listing.tools;
            if (!tools?.some(({ name }) => name === 'add' || name.endsWith('_add'))) {
              row.bfcache.clearMessage = await sh(page, `cat ${row.log}`);
              assert.match(
                row.bfcache.clearMessage.stdout,
                /refused|could not verify|closed, changed|startup or parse-time/i
              );
            }
          }
          if (scene.prerender) {
            row.step = 'armed-prerender-no-activation';
            const start = await page.evaluate(() => globalThis.cdp675Trace.length);
            const candidate = new URL('/prerender-candidate', url).href;
            row.prerender = { candidate, statuses: [] };
            await rawBounded(chrome, rawSession, 'Preload.enable', {});
            let prerenderOff;
            let prerenderTimer;
            const disabled = new Promise((resolve) => {
              prerenderTimer = setTimeout(() => resolve(false), 7000);
              prerenderOff = chrome.cdp.on(({ method, params, sessionId }) => {
                if (sessionId !== rawSession || method !== 'Preload.prerenderStatusUpdated') return;
                row.prerender.statuses.push(params);
                if (params.prerenderStatus === 'PrerenderingDisabledByDevTools') resolve(true);
              });
            });
            try {
              row.prerender.rules = await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
                expression: `(()=>{const rules=document.createElement('script');rules.type='speculationrules';rules.textContent=${JSON.stringify(JSON.stringify({ prerender: [{ source: 'list', urls: [candidate] }] }))};document.head.append(rules);return true})()`,
                returnByValue: true,
              });
              assert.equal(row.prerender.rules.result?.value, true);
              assert.equal(
                await disabled,
                true,
                'armed page-session holder must disable prerender before navigation'
              );
            } finally {
              clearTimeout(prerenderTimer);
              prerenderOff?.();
            }
            row.prerender.navigation = await rawLoad(chrome, rawSession, 'Page.navigate', {
              url: candidate,
            });
            row.prerender.state = (
              await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
                expression:
                  '({ url: location.href, ready: document.readyState, activationStart: performance.getEntriesByType("navigation")[0].activationStart, prerendering: document.prerendering })',
                returnByValue: true,
              })
            ).result?.value;
            assert.equal(row.prerender.state.url, candidate);
            assert.equal(row.prerender.state.ready, 'complete');
            assert.equal(
              row.prerender.state.activationStart,
              0,
              'prerender activation is a finding'
            );
            assert.equal(row.prerender.state.prerendering, false);
            row.prerender.methods = await page.evaluate(
              (start) => globalThis.cdp675Trace.slice(start),
              start
            );
            assert.equal(
              row.prerender.methods.some(
                ({ boundary, direction, packet }) =>
                  boundary === 'bios' &&
                  direction === 'receive' &&
                  packet.method === 'Debugger.paused'
              ),
              false
            );
          }
          if (scene.sameProcess) {
            row.step = 'armed-same-process-extra-origin';
            if (route === 'extension') {
              row.sameProcess = {
                outcome: 'not-producible',
                reason:
                  'The extension protected-origin matcher is static; it has no CLI --origin equivalent. All sliccy.ai siblings are protected, so no ordinary same-site predecessor exists.',
              };
            } else {
              row.sameProcess = {
                protectedOrigin: trace.sameProcessOrigin,
                ordinaryOrigin: url.origin,
                before: await rawBounded(chrome, rawSession, 'Runtime.getIsolateId', {}),
              };
              assert.equal(new URL(trace.sameProcessOrigin).hostname, url.hostname);
              assert.notEqual(trace.sameProcessOrigin, url.origin);
              const start = await page.evaluate(() => globalThis.cdp675Trace.length);
              const frameStart = row.rawFrames.length;
              row.sameProcess.navigation = await rawLoad(chrome, rawSession, 'Page.navigate', {
                url: `${trace.sameProcessOrigin}/protected-doc?675-private=present`,
              });
              row.sameProcess.after = await rawBounded(
                chrome,
                rawSession,
                'Runtime.getIsolateId',
                {}
              );
              row.sameProcess.state = (
                await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
                  expression: '({ origin: location.origin, ready: document.readyState })',
                  returnByValue: true,
                })
              ).result?.value;
              row.sameProcess.frames = row.rawFrames.slice(frameStart);
              assert.equal(row.sameProcess.state.ready, 'complete');
              assert.ok(row.sameProcess.before.id && row.sameProcess.after.id);
              if (row.sameProcess.navigation.errorText === 'net::ERR_BLOCKED_BY_CLIENT') {
                assert.equal(row.sameProcess.state.origin, 'null');
                assert.ok(row.sameProcess.frames.length > 0);
                assert.equal(
                  row.sameProcess.frames.some((frame) =>
                    frame.url?.startsWith(`${trace.sameProcessOrigin}/`)
                  ),
                  false,
                  'blocked protected hop must never commit'
                );
                row.sameProcess.outcome =
                  'protected-hop-blocked-before-commit-no-same-process-proof';
                row.sameProcess.scope =
                  'no same-process protected commit exists to measure; ordinary and error-document isolate identities recorded only';
              } else {
                assert.equal(row.sameProcess.state.origin, trace.sameProcessOrigin);
                row.sameProcess.outcome =
                  row.sameProcess.before.id === row.sameProcess.after.id
                    ? 'same-process-proved'
                    : 'Chrome-swapped-process-no-claim';
              }
              row.sameProcess.methods = await page.evaluate(
                (start) => globalThis.cdp675Trace.slice(start),
                start
              );
              const publications = row.sameProcess.methods.filter(
                ({ boundary, direction }) => boundary === 'bios' && direction === 'receive'
              );
              assert.equal(
                publications.some(({ packet }) => packet.method?.startsWith('Debugger.')),
                false
              );
              const published = JSON.stringify(publications);
              for (const suffix of ['/', '?', '#'])
                assert.ok(
                  !published.includes(`${trace.sameProcessOrigin}${suffix}`),
                  'Page and Network events may expose the test-only protected origin but no path or query'
                );
              row.sameProcess.outputScope =
                'existing origin-only Page/Network/Target metadata for CLI-only --origin; no Debugger publication or path/query';
            }
          }
          if (scene.lateFrame) {
            row.step = 'late-frame-placement';
            await lateFrameRow(page, chrome, rawSession, row, scene, trace.fixtureOrigin, binding);
          }
          if (scene.holderKill) {
            row.step = 'shipped-holder-death';
            await shippedHolderDeath(page, chrome, rawSession, row, scene);
          }
          if (scene.protectedHop) {
            row.step = 'armed-protected-hop';
            const destination = scene.hopMode
              ? scene.protectedHop === 'seven'
                ? `${SEVEN}/protected-doc`
                : 'https://vault.sliccy.ai/protected-doc'
              : scene.protectedHop === 'seven'
                ? `${SEVEN}/protected-doc`
                : `http://vault.sliccy.ai:${new URL(trace.fixtureOrigin).port}/protected-doc`;
            if (scene.hopMode) {
              row.ordinaryHistory = await rawBounded(
                chrome,
                rawSession,
                'Page.getNavigationHistory',
                {}
              );
              row.ordinaryHistoryCheckpoint =
                row.ordinaryHistory.entries[row.ordinaryHistory.currentIndex];
              assert.equal(new URL(row.ordinaryHistoryCheckpoint.url).origin, trace.fixtureOrigin);
            }
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
              if (scene.hopMode === 'renderer') {
                row.hopReply = await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
                  expression: `location.assign(${JSON.stringify(destination)})`,
                  returnByValue: true,
                });
              } else {
                const redirect = new URL('/redirect', trace.fixtureOrigin);
                redirect.searchParams.set('to', destination);
                row.hopReply = await chrome.cdp.send(
                  'Page.navigate',
                  { url: scene.hopMode === 'redirect' ? redirect.href : destination },
                  rawSession
                );
              }
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
            if (scene.hopMode) {
              assert.ok(
                row.hopFrames.some((frame) =>
                  [frame.url, frame.unreachableUrl].some(
                    (url) => url && new URL(url).origin === new URL(destination).origin
                  )
                ),
                'protected destination must really be the blocked hop'
              );
              if (scene.hopMode === 'redirect')
                assert.ok(
                  row.rawRedirects.some(
                    ({ at, from, to, status }) =>
                      at >= began &&
                      new URL(from).pathname === '/redirect' &&
                      to === destination &&
                      status === 302
                  ),
                  'real HTTP redirect to the protected destination was not observed'
                );
              assert.doesNotMatch(JSON.stringify(published), /(?:seven|vault)\.sliccy\.ai/i);
              row.hopLog = await sh(page, `cat ${row.log}`);
              assert.doesNotMatch(
                `${row.hopLog.stdout}\n${row.hopLog.stderr}`,
                /(?:seven|vault)\.sliccy\.ai/i
              );
              row.historyAfterHop = await rawBounded(
                chrome,
                rawSession,
                'Page.getNavigationHistory',
                {}
              );
              const checkpoint = row.historyAfterHop.entries.find(
                (entry) =>
                  entry.id === row.ordinaryHistoryCheckpoint.id &&
                  entry.url === row.ordinaryHistoryCheckpoint.url
              );
              assert.ok(checkpoint, 'actual history must retain the recorded ordinary checkpoint');
              row.historyReturnScope =
                'return to exact recorded ordinary history entry; link may add a private blocked-data entry, so one history.back is not assumed';
              row.historyReturnAt = Date.now();
              await rawLoad(chrome, rawSession, 'Page.navigateToHistoryEntry', {
                entryId: checkpoint.id,
              });
              row.historyReturn = await rawBounded(chrome, rawSession, 'Runtime.evaluate', {
                expression: '({origin: location.origin, ready: document.readyState})',
                returnByValue: true,
              });
              assert.equal(row.historyReturn.result?.value?.origin, trace.fixtureOrigin);
              assert.equal(row.historyReturn.result?.value?.ready, 'complete');
              assert.ok(Date.now() - row.historyReturnAt < 7000, 'ordinary history return stalled');
              row.historyList = await cone(
                page,
                `timeout 60 mcpcat tools http://127.0.0.1:${row.port}/mcp --json`,
                `675-history-list-${index}`
              );
              const historyListing = JSON.parse(row.historyList.stdout);
              const historyTools = Array.isArray(historyListing)
                ? historyListing
                : historyListing.tools;
              assert.ok(Array.isArray(historyTools));
              assert.ok(
                historyTools.some(({ name }) => name === 'add' || name.endsWith('_add')) ||
                  typeof historyListing.hint === 'string',
                row.historyList.stdout
              );
              assert.doesNotMatch(row.historyList.stdout, /(?:seven|vault)\.sliccy\.ai/i);
            }
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
          bfcacheOff?.();
          if (bfcacheDriver) await bfcacheDriver.close().catch(() => {});
          if (scene.race && page)
            await page
              .evaluate(() => {
                globalThis.cdp675Race?.release?.();
                delete globalThis.cdp675Race;
              })
              .catch(() => {});
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
