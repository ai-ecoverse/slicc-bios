import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boot, ready, run, shows } from './bios.mjs';
import { devtools, launch } from './chrome.mjs';
import { fixtureTarget } from './fixtures/cdp-675-target.mjs';
import { linkNode } from './linked-node.mjs';
import { realExtension, SEVEN } from './real-extension.mjs';

const directory = process.env.SLICC_675_ARTIFACT_DIR;
const manifest = directory
  ? JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  : null;
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const ordinaryCases = [
  { name: 'instrumented-list-call', reload: true },
  { name: 'late-no-unasked-reload', reload: false },
  { name: 'armed-seven-hop-error-scrub-bounded', reload: true, protectedHop: 'seven' },
  { name: 'armed-vault-hop-error-scrub-bounded', reload: true, protectedHop: 'vault' },
  { name: 'old-client-terminal', reload: true, negative: true, oldClient: true },
];
const guardCases = [
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
];
const fallbackCases = [
  { name: 'foreign-iframe-cached', reload: true, delay: 0, cached: true },
  { name: 'foreign-iframe-immediate', reload: true, delay: 0 },
  { name: 'foreign-iframe-50ms', reload: true, delay: 50 },
  { name: 'foreign-iframe-500ms', reload: true, delay: 500 },
  { name: 'foreign-iframe-parse-time', reload: true, parse: true },
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
      ? guardCases
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
        chrome =
          route === 'extension'
            ? await realExtension({
                directory: oldRoute ? undefined : process.env.SLICC_675_EXTENSION_DIR,
                args: [
                  '--disable-features=WebMCP,WebMCPTesting',
                  '--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1',
                ],
              })
            : await launch({
                tools: false,
                args: [
                  '--disable-features=WebMCP,WebMCPTesting',
                  '--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1',
                ],
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
          response.writeHead(200, { 'content-type': 'text/html' });
          if (at.pathname === '/protected-doc') {
            (trace.protectedRequests ??= []).push({ at: Date.now(), host: request.headers.host });
            return response.end(
              '<!doctype html><title>675 protected fixture</title><script>globalThis.cdp675Protected = true;</script>'
            );
          }
          if (at.pathname === '/iframe')
            return response.end('<!doctype html><title>ordinary iframe</title>');
          const registration =
            'document.modelContext.registerTool({ name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, execute: ({a,b}) => String(a+b) })';
          const code = at.searchParams.has('foreign')
            ? at.searchParams.has('parse')
              ? `if (document.modelContext) { ${registration}; }`
              : `await fetch('/data?delay=${at.searchParams.get('delay') ?? 0}${at.searchParams.has('cached') ? '&cached=1' : ''}'); if (document.modelContext) { ${registration}; }`
            : `if (document.modelContext) { ${registration}; } else { const retry = setInterval(() => { if (document.modelContext) { clearInterval(retry); ${registration}; } }, 10); }`;
          response.end(
            `<!doctype html><title>675 ordinary</title>${foreign ? '<iframe src="/iframe"></iframe>' : ''}<script type="module">window.cdp675Loads = (Number(sessionStorage.cdp675Loads) || 0) + 1; sessionStorage.cdp675Loads = window.cdp675Loads; ${code}</script>`
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
          if (foreign) {
            url.searchParams.set('foreign', '1');
            url.searchParams.set('delay', String(scene.delay ?? 0));
            if (scene.cached) url.searchParams.set('cached', '1');
            if (scene.parse) url.searchParams.set('parse', '1');
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
          unobserve = chrome.cdp.on(({ method, params, sessionId }) => {
            if (sessionId !== rawSession) return;
            if (method === 'Runtime.executionContextCreated')
              row.rawWorlds.push({
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
          row.step = 'guarded-discovery';
          row.target = await discover(page, url.href);
          row.traceStart = await page.evaluate(() => globalThis.cdp675Trace?.length ?? 0);
          if (guardLevel) {
            row.scope = 'guard-level, real bios browserHook; not Rust-path';
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
            { negative: Boolean(scene.negative), log: row.log }
          );
          row.portAnswered = await waitPort(page, row.port);
          if (scene.negative) {
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
            assert.ok(!forwarded.includes('Debugger.enable'));
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
              1
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
          if (scene.parse) {
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
            assert.ok(tool, row.list.stdout);
            row.step = 'shipped-tools-call';
            row.call = await cone(
              page,
              `timeout 60 mcpcat call http://127.0.0.1:${row.port}/mcp ${quote(tool.name)} --a 2 --b 3`,
              `675-call-${index}`
            );
            assert.match(row.call.stdout, /^5$/m);
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
            assert.ok(
              row.methods.some(
                ({ direction, packet }) =>
                  direction === 'receive' &&
                  /browser extension runs scripts|another extension|profiled|hidden.*world/i.test(
                    packet.error?.message ?? ''
                  )
              )
            );
            assert.equal(forwarded.filter((method) => method.startsWith('Debugger.')).length, 0);
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
