import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { agentUp, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startHub } from './fake-hub.mjs';

const NAME = 'own kernel approvals node';
const OWN_KERNEL = "a link from this seven's own kernel can't decide approvals";

const chrome = await launch({ tools: false, intercept: [], agent: true, timeout: 60000 });
const hub = await startHub();
after(async () => {
  hub.close();
  await chrome.close();
});

test("approvals and decide from this seven's own leader link: EACCES without Control, and decide refused with it", {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page);
  await agentUp(page);
  const joinUrl = await page.within(
    60000,
    () => document.querySelector('slicc-app').model.network.status().links?.joinUrl
  );
  const raw = await page.tab();
  await raw.goto('/manifest.json');
  const open = (meta) =>
    raw.evaluate(
      async (join, tray, name, meta) => {
        localStorage.setItem('slicc-os.tray-hub', tray);
        if (!globalThis.ownLeaders) {
          const { createLeaders } = await import('/seed/leaders.js');
          const { hubClient } = await import('/seed/follow.js');
          globalThis.ownLeaders = createLeaders({
            post: hubClient({ origin: null, fetch: (...args) => fetch(...args) }),
            name,
          });
        }
        try {
          const { stream } = await globalThis.ownLeaders.open(join, meta);
          const info = stream.info;
          stream.close();
          return { opened: info };
        } catch (error) {
          return { code: error.code, message: error.message };
        }
      },
      joinUrl,
      hub.url,
      NAME,
      meta
    );
  const decide = { kind: 'agent', op: 'decide', id: 'nothing-pending', answer: 'once' };

  for (const meta of [{ kind: 'agent', op: 'approvals' }, decide]) {
    const answer = await open(meta);
    assert.equal(answer.code, 'EACCES', JSON.stringify(answer));
    assert.match(answer.message, /doesn't allow remote control/);
  }

  const device = await page.within(
    60000,
    (name) =>
      document
        .querySelector('slicc-app')
        .model.network.status()
        .links?.devices.find((d) => d.name === name && d.state === 'connected'),
    NAME
  );
  const kept = await raw.evaluate(async () => {
    const { keptFingerprints } = await import('/seed/follow.js');
    return keptFingerprints('link:');
  });
  assert.ok(kept.includes(device.id), `${device.id} is not in ${JSON.stringify(kept)}`);
  await page.evaluate(
    (id) => document.querySelector('slicc-app').model.network.setAccess(id, 'control', true),
    device.id
  );

  assert.deepEqual(await open(decide), { code: 'EACCES', message: OWN_KERNEL });
  const listed = await open({ kind: 'agent', op: 'approvals' });
  if (listed.opened) assert.deepEqual(listed.opened, { approvals: [] });
  else assert.deepEqual(listed, { code: 'EOPNOTSUPP', message: 'this agent has no approvals' });
  await page.evaluate(() => localStorage.removeItem('slicc-os.tray-hub'));
});
