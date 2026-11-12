import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { page as harnessPage } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/page.mjs';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const EXTENSION = 'chrome-extension://akjjllgokmbgpbdbmafpiefnhidlmbgf';
const chrome = await launch({
  tools: false,
  extensions: [fileURLToPath(new URL('./fixtures/panel-extension', import.meta.url))],
});
after(() => chrome.close());

async function openPanel(tab, os) {
  const url = `${EXTENSION}/panel.html?src=${encodeURIComponent(os)}`;
  await tab.send('Page.navigate', { url });
  await tab.until((href) => location.href === href, url);
  return tab;
}

async function frameOf(panel, os) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find((t) => t.type === 'iframe' && t.url.startsWith(os));
    if (found) {
      const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
        targetId: found.targetId,
        flatten: true,
      });
      const cdp = {
        send: (...args) => chrome.cdp.send(...args),
        on: (listener) => chrome.cdp.on(listener),
        target: () => undefined,
      };
      return harnessPage(cdp, { sessionId, targetId: found.targetId }, { url: os });
    }
    if (Date.now() > deadline)
      throw new Error(`no /os/ frame in ${await panel.evaluate(() => location.href)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const said = (panel) => panel.evaluate(() => globalThis.said);
const role = (frame) =>
  frame.evaluate(() => document.querySelector('slicc-app')?.model?.tabs?.state().role ?? null);

test('slicc-extension’s side panel frames /os/ as a follower that never takes the kernel, and only the extension may frame it', async (t) => {
  const owner = await chrome.page(t);
  await boot(owner);
  const policies = await owner.evaluate(async () => {
    const csp = async (path) =>
      (await fetch(path, { cache: 'no-store' })).headers.get('content-security-policy');
    return { page: await csp('/os/'), style: await csp('/os/os.css') };
  });
  assert.deepEqual(policies, {
    page: `frame-ancestors 'self' ${EXTENSION}`,
    style: "frame-ancestors 'self'",
  });

  const os = new URL('/os/', await owner.evaluate(() => location.origin)).href;
  const panel = await openPanel(await owner.tab(), os);
  await panel.within(120000, () => globalThis.said.some((m) => m.role === 'follower'));
  const frame = await frameOf(panel, os);
  t.after(() => frame.dispose());
  assert.deepEqual(
    await frame.evaluate(() => ({
      isolated: globalThis.crossOriginIsolated,
      ancestors: [...location.ancestorOrigins],
    })),
    { isolated: false, ancestors: [EXTENSION] }
  );
  assert.equal(await role(frame), 'follower');
  const first = (await said(panel)).find((m) => m.role === 'follower');
  assert.deepEqual(
    { origin: first.origin, stalled: first.stalled, skew: first.skew },
    { origin: new URL(os).origin, stalled: false, skew: false }
  );

  await frame.until(() =>
    document
      .querySelector('slicc-app')
      ?.dock?.api.panels.some((panel) => panel.id.startsWith('terminal:'))
  );
  await run(frame, 'echo from-the-panel-$((40+2)) > /tmp/panel; cat /tmp/panel');
  await shows(frame, 'from-the-panel-42', 60000);
  await run(owner, 'cat /tmp/panel');
  await shows(owner, 'from-the-panel-42', 30000);

  await owner.close();
  await panel.within(30000, () => globalThis.said.at(-1)?.role === 'connecting');
  await new Promise((resolve) => setTimeout(resolve, 8000));
  assert.equal(
    (await said(panel)).some((m) => m.role === 'owner'),
    false,
    'the panel never becomes the owner'
  );
  assert.notEqual(await role(frame), 'owner');
  const held = await frame.evaluate(async () =>
    (await navigator.locks.query()).held.map((lock) => lock.name)
  );
  assert.equal(held.includes('slicc-agent'), false, `the panel holds ${held}`);

  const next = await panel.tab();
  await boot(next);
  await next.until(() => document.querySelector('slicc-app').model.tabs?.state().role === 'owner');
  await panel.within(60000, () => globalThis.said.at(-1)?.role === 'follower');
  assert.deepEqual(frame.errors, []);
});
