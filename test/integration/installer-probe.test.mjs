import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, watch } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeCatalog } from './fake-catalog.mjs';

const chrome = await launch({ tools: false, timeout: 120000, intercept: [] });
const registry = await fakeCatalog(chrome.cdp);
after(() => chrome.close());

async function installerWorker(t) {
  const href = new URL('/installer.js', chrome.url).href;
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const found = targetInfos.filter(({ type, url }) => type === 'shared_worker' && url === href);
  assert.equal(found.length, 1, `installer workers: ${JSON.stringify(targetInfos)}`);
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: found[0].targetId,
    flatten: true,
  });
  t.after(() => chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}));
  return (expression) =>
    chrome.cdp
      .send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      .then(({ result, exceptionDetails }) => {
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description);
        return result.value;
      });
}

test('a probe that gets no answer while a packages run still receives data from npm replaces nothing, so a slow link never stops a run that is making progress', async (t) => {
  const page = await chrome.page(t);
  registry.reset();
  await boot(page, undefined, { tools: false });
  chrome.overrides.set('/hold.html', '<!doctype html><title>hold</title>');
  const holder = await page.tab();
  await holder.goto('/hold.html');
  await holder.evaluate(() => {
    const { port } = new SharedWorker('/installer.js', 'slicc-installer');
    port.start();
    window.kept = port;
  });
  const installer = await installerWorker(t);
  const born = await installer('born');
  await installer(`(() => {
    const work = { key: -1, port: { postMessage() {} }, id: 0, op: 'packages', phase: 'running', since: Date.now(), at: Date.now(), note: 'downloading node_modules/pako', inflight: new Set(['node_modules/pako']) };
    running.set(-1, work);
    globalThis.flowing = setInterval(() => { work.at = Date.now(); heard = Date.now(); fetched = heard; }, 1000);
    return true;
  })()`);
  registry.hold = /^https:\/\/cdn\.jsdelivr\.net\/npm\/modern-tar@/;

  const next = await page.tab();
  const bios = await watch(next);
  await next.goto('/');
  await ready(next, undefined, { tools: false });
  assert.ok(
    registry.asked.some((url) => registry.hold.test(url)),
    'the new BIOS probed modern-tar'
  );
  const texts = bios.texts('installer').filter((text) => !/, nothing new for \d+ s$/.test(text));
  assert.equal(texts.length, 1, JSON.stringify(texts));
  assert.match(texts[0], /^connection #\d+$/);
  assert.equal(await installer('born'), born, 'the installer kept running');
  await installer('clearInterval(globalThis.flowing); running.delete(-1); true');
  registry.hold = null;
});
