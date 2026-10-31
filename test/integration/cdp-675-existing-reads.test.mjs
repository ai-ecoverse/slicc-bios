import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as https } from 'node:https';
import { join } from 'node:path';
import { test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { devtools, launch } from './chrome.mjs';
import { linkNode } from './linked-node.mjs';
import { certificate, realExtension, SEVEN } from './real-extension.mjs';

const dom = `JSON.stringify((() => {
  const rows = [];
  const walk = (w, path) => {
    if (rows.length >= 64 || path.length > 8) throw new Error('frame budget');
    const row = { path, children: w.length, readable: false };
    rows.push(row);
    try {
      row.url = w.location.href;
      row.sources = [...w.document.querySelectorAll('iframe,frame')].map(n => n.src);
      row.readable = true;
    } catch { row.unknown = true; }
    for (let i = 0; i < row.children; i++) walk(w.frames[i], [...path, i]);
  };
  walk(window, []);
  return rows;
})())`;

function install({ route, runtime }) {
  const pending = new Map();
  let counter = 0;
  const records = [];
  const open = async (lane) => {
    if (lane === 'bios') return globalThis.sliccBrowserHook({ runtime });
    if (route === 'link') {
      const found = globalThis.sliccLinkedBrowsers().find((n) => n.runtime === runtime);
      return found.open();
    }
    const { extensionConnection } = await import(new URL('cdp.js', location.href));
    return extensionConnection(globalThis.sliccExtension.cdp);
  };
  const connections = new Map();
  globalThis.cdp675Reads = {
    records: () => records,
    async call(lane, method, params = {}, sessionId) {
      if (!connections.has(lane)) {
        const connection = await open(lane);
        connection.onmessage = (text) => {
          const packet = JSON.parse(text);
          const entry = pending.get(packet.id);
          if (!entry) return;
          pending.delete(packet.id);
          clearTimeout(entry.timer);
          entry.resolve(packet.error ? { error: packet.error.message } : { result: packet.result });
        };
        connections.set(lane, connection);
      }
      const id = ++counter;
      records.push({ id, lane, method, sessionId });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ deadline: true });
        }, 10000);
        pending.set(id, { resolve, timer });
        connections
          .get(lane)
          .send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() {
      for (const connection of connections.values()) connection.close();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.resolve({ closed: true });
      }
      pending.clear();
    },
  };
}

function treeRows(tree, path = []) {
  if (!tree?.frame) return [];
  return [
    {
      path,
      url: tree.frame.url,
      securityOrigin: tree.frame.securityOrigin,
      unreachableUrl: tree.frame.unreachableUrl,
      children: tree.childFrames?.length ?? 0,
    },
    ...(tree.childFrames ?? []).flatMap((child, i) => treeRows(child, [...path, i])),
  ];
}

for (const route of ['extension', 'link']) {
  test(`cdp 675 existing reads ${route}`, {
    skip: process.env.SLICC_675_STAGE1_DIAGNOSTIC !== '1',
    timeout: 900000,
  }, async (t) => {
    const trace = {
      route,
      scope:
        'Existing guarded frame tree and main-world DOM reads; diagnostic only, not Rust or shipped Stage1 admission/fallback acceptance',
      newGuardOutput: 0,
      plainPathStillGuarded: true,
      rows: [],
    };
    const persist = async () => {
      if (!process.env.SLICC_PROOF_TRACE_DIR) return;
      await mkdir(process.env.SLICC_PROOF_TRACE_DIR, { recursive: true });
      await writeFile(
        join(process.env.SLICC_PROOF_TRACE_DIR, `cdp-675-existing-reads-${route}.json`),
        JSON.stringify(trace, null, 2)
      );
    };
    t.after(persist);
    try {
      const secure = https(await certificate(), (_request, response) =>
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            '<!doctype html><title>Owned protected frame fixture</title><script>globalThis.cdp675OwnFrame = true;</script>'
          )
      );
      await new Promise((resolve) => secure.listen(0, '127.0.0.1', resolve));
      t.after(() => {
        secure.closeAllConnections();
        secure.close();
      });
      const site = createServer((request, response) => {
        const url = new URL(request.url, 'http://fixture');
        const child = url.searchParams.get('child');
        const nested = url.pathname === '/nested';
        const src = nested ? `/container?child=${encodeURIComponent(child)}` : child;
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          `<!doctype html><title>Owned ordinary frame fixture</title>${src ? `<iframe src="${src}"></iframe>` : ''}`
        );
      });
      await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
      t.after(() => {
        site.closeAllConnections();
        site.close();
      });
      const origin = `http://localhost:${site.address().port}`;
      for (const otherExtension of [false, true]) {
        trace.phase = `setup-${otherExtension ? 'other-extension' : 'protected-frames'}`;
        await persist();
        const previous = process.env.SLICC_HARNESS_EXTENSION;
        process.env.SLICC_HARNESS_EXTENSION = otherExtension ? '1' : '0';
        let chrome;
        try {
          const rules = [`MAP vault.sliccy.ai 127.0.0.1:${secure.address().port}`];
          chrome =
            route === 'extension'
              ? await realExtension({ rules })
              : await launch({
                  tools: false,
                  args: [
                    '--ignore-certificate-errors',
                    `--host-resolver-rules=${[`MAP seven.sliccy.ai 127.0.0.1:${secure.address().port}`, ...rules].join(', ')}`,
                  ],
                });
        } finally {
          if (previous === undefined) delete process.env.SLICC_HARNESS_EXTENSION;
          else process.env.SLICC_HARNESS_EXTENSION = previous;
        }
        try {
          chrome.overrides.set(
            '/__675_frame',
            '<!doctype html><title>Owned protected frame fixture</title><script>globalThis.cdp675OwnFrame = true;</script>'
          );
          const page = await chrome.page(t);
          await page.init(() => {
            globalThis.sliccKernelDebug = true;
          });
          let runtime;
          if (route === 'extension') {
            await page.goto(SEVEN);
            await ready(page, undefined, { tools: false });
            assert.equal(await page.evaluate(() => globalThis.sliccLinkedBrowsers().length), 0);
          } else {
            await boot(page, undefined, { tools: false });
            assert.equal(await page.evaluate(() => typeof globalThis.sliccExtension), 'undefined');
            [runtime] = await linkNode(
              t,
              page,
              (await devtools(chrome)).port,
              'cdp-675-existing-reads'
            );
            assert.ok(runtime);
          }
          await page.evaluate(install, { route, runtime });
          const call = (lane, method, params = {}, sessionId) =>
            page.evaluate(
              ({ lane, method, params, sessionId }) =>
                cdp675Reads.call(lane, method, params, sessionId),
              { lane, method, params, sessionId }
            );
          const cases = otherExtension
            ? [{ name: 'other-extension-only', url: `${origin}/plain`, expectedFrames: 1 }]
            : ['seven', 'vault'].flatMap((host) =>
                [false, true].map((nested) => ({
                  name: `${nested ? 'nested' : 'direct'}-${host}`,
                  url: `${origin}/${nested ? 'nested' : 'direct'}?child=${encodeURIComponent(`https://${host}.sliccy.ai/__675_frame`)}`,
                  expectedFrames: nested ? 3 : 2,
                  protectedOrigin: `https://${host}.sliccy.ai`,
                }))
              );
          for (const scene of cases) {
            const row = {
              name: scene.name,
              otherExtension,
              selectedRuntime: runtime ?? 'extension',
              lanes: {},
            };
            trace.rows.push(row);
            trace.phase = scene.name;
            await persist();
            const { targetId } = await chrome.cdp.send('Target.createTarget', {
              url: 'about:blank',
            });
            const { sessionId: rawSession } = await chrome.cdp.send('Target.attachToTarget', {
              targetId,
              flatten: true,
            });
            await chrome.cdp.send('Page.enable', {}, rawSession);
            let timer;
            let off;
            const loaded = new Promise((resolve) => {
              timer = setTimeout(() => resolve({ deadline: true }), 10000);
              off = chrome.cdp.on((event) => {
                if (event.sessionId === rawSession && event.method === 'Page.loadEventFired')
                  resolve({ loaded: true });
              });
            });
            await chrome.cdp.send('Page.navigate', { url: scene.url }, rawSession);
            row.rawLoad = await loaded;
            clearTimeout(timer);
            off();
            row.rawTree = treeRows(
              (await chrome.cdp.send('Page.getFrameTree', {}, rawSession)).frameTree
            );
            assert.equal(row.rawLoad.loaded, true);
            assert.equal(row.rawTree.length, scene.expectedFrames);
            if (scene.protectedOrigin)
              assert.ok(
                row.rawTree.some(
                  (frame) =>
                    frame.securityOrigin === scene.protectedOrigin &&
                    frame.url === `${scene.protectedOrigin}/__675_frame`
                )
              );
            for (const lane of ['route', 'bios']) {
              const info = (row.lanes[lane] = {});
              const attached = await call(lane, 'Target.attachToTarget', {
                targetId,
                flatten: true,
              });
              info.attach = attached.error
                ? { error: attached.error }
                : attached.deadline
                  ? { deadline: true }
                  : { admitted: true };
              if (!attached.result?.sessionId) continue;
              const sessionId = attached.result.sessionId;
              const frames = await call(lane, 'Page.getFrameTree', {}, sessionId);
              info.frameTree = frames.result ? treeRows(frames.result.frameTree) : frames;
              const evaluated = await call(
                lane,
                'Runtime.evaluate',
                { expression: dom, returnByValue: true },
                sessionId
              );
              info.dom = evaluated.result?.result?.value
                ? JSON.parse(evaluated.result.result.value)
                : evaluated.result
                  ? {
                      exception: Boolean(evaluated.result.exceptionDetails),
                      type: evaluated.result.result?.type,
                    }
                  : evaluated;
              const debuggerResult = await call(lane, 'Debugger.enable', {}, sessionId);
              info.debugger = debuggerResult.result ? { admitted: true } : debuggerResult;
              if (debuggerResult.result) await call(lane, 'Debugger.disable', {}, sessionId);
              await call(lane, 'Target.detachFromTarget', { sessionId });
            }
            trace.methods = await page.evaluate(() => cdp675Reads.records());
            await persist();
            await chrome.cdp.send('Target.detachFromTarget', { sessionId: rawSession });
            await chrome.cdp.send('Target.closeTarget', { targetId });
          }
          await page.evaluate(() => cdp675Reads.close());
        } finally {
          await chrome.close();
        }
      }
      trace.phase = 'completed';
    } catch (error) {
      trace.failure = { name: error.name, code: error.code };
      throw error;
    } finally {
      await persist();
    }
  });
}
