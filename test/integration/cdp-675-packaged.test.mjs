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
    `sudo -u cone bash -c ${quote(`export PATH=$PNPM_HOME/bin:$PATH; export SLICC_CDP_URL=http://127.0.0.1:9222; ${command}`)} > /tmp/${name}.log 2>&1; echo ${name}-finished`
  );
  await shows(page, `${name}-finished`, 240000);
  return sh(page, `cat /tmp/${name}.log`);
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
  for (const mode of ['ordinary', 'foreign', 'old-route']) {
    const foreign = mode === 'foreign';
    const oldRoute = mode === 'old-route';
    const cases = foreign
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
        chrome.overrides.set(
          '/__675/protected-doc',
          '<!doctype html><title>675 protected fixture</title><script>globalThis.cdp675Protected = true;</script>'
        );
        for (const name of [manifest.cdp, manifest.mcpcat, manifest.oldClient])
          chrome.overrides.set(`/__675/${name}`, await readFile(join(directory, name)));
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
          assert.equal(trace.selectedRoute.extension, oldRoute ? '7.10.0' : '7.10.1');
          assert.equal(trace.selectedRoute.links, 0);
        } else {
          await boot(page, undefined, { tools: false });
          assert.equal(await page.evaluate(() => typeof globalThis.sliccExtension), 'undefined');
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
          assert.ok(runtimes.length);
          assert.ok(
            trace.selectedRoute.every(
              ({ route }) => route.version === (oldRoute ? '1.49.36' : '1.49.37')
            )
          );
        }
        const port = new URL(chrome.url).port;
        trace.install = await cone(
          page,
          `timeout 180 pnpm add -g --config.minimum-release-age=0 http://host.slicc.internal:${port}/__675/${manifest.cdp} http://host.slicc.internal:${port}/__675/${manifest.mcpcat}; echo install-status-$?; hash -r; echo which-$(which playwright-cli)-$(which mcpcat); playwright-cli --version; mcpcat --version; root=$(pnpm root -g); echo package-root-$root; sha256sum "$root/@ai-ecoverse/slicc-cdp/bin/playwright-cli.wasm"; pnpm ls -g --depth 0`,
          '675-install'
        );
        assert.match(trace.install.stdout, /install-status-0/);
        assert.match(trace.install.stdout, /playwright-cli 1\.43\.2/);
        assert.match(
          trace.install.stdout,
          /which-\/home\/cone\/.*playwright-cli-\/home\/cone\/.*mcpcat/
        );
        assert.ok(trace.install.stdout.includes(manifest.wasmSha256));
        trace.packageProof = {
          binary: 'playwright-cli',
          version: '1.43.2',
          sha256: manifest.wasmSha256,
          install: 'pnpm add -g as cone',
          assertionPassed: true,
        };
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
        const row = { name: scene.name, step: 'setup', status: 'running' };
        trace.rows.push(row);
        let targetId;
        let rawSession;
        let unobserve;
        try {
          if (setupError) throw setupError;
          row.packageProof = trace.packageProof;
          if (scene.oldClient) {
            row.step = 'install-old-client';
            row.oldInstall = await cone(
              page,
              `timeout 180 pnpm add -g --config.minimum-release-age=0 http://host.slicc.internal:${new URL(chrome.url).port}/__675/${manifest.oldClient}; echo install-status-$?; playwright-cli --version; root=$(pnpm root -g); sha256sum "$root/@ai-ecoverse/slicc-cdp/bin/playwright-cli.wasm"`,
              '675-old-install'
            );
            assert.match(row.oldInstall.stdout, /install-status-0/);
            assert.match(row.oldInstall.stdout, /playwright-cli 1\.43\.1/);
            assert.ok(row.oldInstall.stdout.includes(manifest.oldClientWasmSha256));
            row.packageProof = {
              binary: 'playwright-cli',
              version: '1.43.1',
              sha256: manifest.oldClientWasmSha256,
            };
          }
          row.step = 'create-ordinary-target';
          const url = new URL(`/page?row=${index}`, trace.fixtureOrigin);
          if (foreign) {
            url.searchParams.set('foreign', '1');
            url.searchParams.set('delay', String(scene.delay ?? 0));
            if (scene.cached) url.searchParams.set('cached', '1');
            if (scene.parse) url.searchParams.set('parse', '1');
          }
          ({ targetId } = await chrome.cdp.send('Target.createTarget', { url: 'about:blank' }));
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
          assert.equal(row.initialLoaded, true);
          if (foreign)
            assert.ok(
              row.rawWorlds.some(
                ({ origin, name, auxData }) =>
                  origin.startsWith('chrome-extension://') &&
                  name !== 'slicc-navigate' &&
                  auxData?.isDefault === false
              )
            );
          row.step = 'guarded-discovery';
          row.target = await discover(page, url.href);
          row.traceStart = await page.evaluate(() => globalThis.cdp675Trace?.length ?? 0);
          const command = `mcpcat serve --webmcp ${scene.reload ? '--webmcp-reload ' : ''}--tab ${quote(row.target)} --http 8812 --no-auth`;
          row.command = command;
          row.step = 'shipped-serve';
          await page.evaluate(
            async ({ command }) => {
              globalThis.cdp675Client ??= await globalThis.sliccKernelClient();
              globalThis.cdp675Server = globalThis.cdp675Client
                .run(
                  [
                    'bash',
                    '-c',
                    `sudo -u cone bash -c '${command.replaceAll("'", "'\\''")}' > /tmp/675-serve.log 2>&1`,
                  ],
                  { cwd: '/' }
                )
                .then(({ status, stdout, stderr }) => ({ status, stdout, stderr }));
            },
            {
              command: `export PATH=$PNPM_HOME/bin:$PATH; export SLICC_CDP_URL=http://127.0.0.1:9222; echo $$ > /tmp/675-serve.pid; exec ${command}`,
            }
          );
          await page.within(
            120000,
            async (negative) => {
              const { stdout } = await globalThis.cdp675Client.run(
                ['bash', '-c', 'cat /tmp/675-serve.log'],
                { cwd: '/' }
              );
              return negative
                ? /refused|update|needs.*newer/i.test(stdout)
                : stdout.includes('listening on http:');
            },
            Boolean(scene.negative)
          );
          if (scene.negative) {
            row.step = 'terminal-bound';
            await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30000)));
            row.terminal = await sh(page, 'cat /tmp/675-serve.log');
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
            'timeout 60 mcpcat tools http://127.0.0.1:8812/mcp --json',
            `675-list-${index}`
          );
          const listing = JSON.parse(row.list.stdout);
          const tools = Array.isArray(listing) ? listing : listing.tools;
          row.tools = tools;
          assert.ok(Array.isArray(tools));
          if (scene.parse) {
            assert.equal(tools.length, 0, row.list.stdout);
            row.clearMessage = await sh(page, 'cat /tmp/675-serve.log');
            assert.match(row.clearMessage.stdout, /other-extension fallback|startup or parse-time/);
          } else {
            const tool = tools.find(({ name }) => name === 'add' || name.endsWith('_add'));
            if (foreign && !tool) {
              row.zeroToolsMessage = await sh(page, 'cat /tmp/675-serve.log');
              assert.match(
                row.zeroToolsMessage.stdout,
                /other-extension fallback|startup or parse-time/
              );
            }
            assert.ok(tool, row.list.stdout);
            row.step = 'shipped-tools-call';
            row.call = await cone(
              page,
              `timeout 60 mcpcat call http://127.0.0.1:8812/mcp ${quote(tool.name)} --a 2 --b 3`,
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
                ? `${SEVEN}/__675/protected-doc`
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
          row.status = ['setup', 'install-old-client', 'create-ordinary-target'].includes(row.step)
            ? 'setup-failure'
            : 'finding';
          row.failure = { name: error.name, message: error.message };
        } finally {
          if (page && !setupError) {
            row.serverLog = await sh(page, 'cat /tmp/675-serve.log').catch((error) => ({
              error: error.message,
            }));
            row.methods ??= await page
              .evaluate((start) => globalThis.cdp675Trace?.slice(start ?? 0) ?? [], row.traceStart)
              .catch(() => []);
            await sh(page, 'kill "$(cat /tmp/675-serve.pid)"').catch(() => {});
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
          trace.rows.map(({ name, status, step, failure }) => ({ name, status, step, failure }))
        )
      );
    });
  }
}
