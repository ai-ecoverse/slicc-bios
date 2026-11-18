import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { agentUp, ready, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startHub } from './fake-hub.mjs';

const OWN = 'own kernel approvals node';
const OTHER = 'another device approvals node';
const OWN_KERNEL = "a link from this seven's own kernel can't decide approvals";
const COMMAND = /\/id -un$/;

const chrome = await launch({ tools: false, intercept: [], agent: true, timeout: 120000 });
const hub = await startHub();
after(async () => {
  hub.close();
  await chrome.close();
});

test("approvals and decide against the real agent: EACCES without Control, a pending sudo listed and denied from another device, and decide refused from this seven's own kernel", {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/manifest.json');
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page, ['slicc:/home# ']);
  await agentUp(page);
  const joinUrl = await page.within(
    60000,
    () => document.querySelector('slicc-app').model.network.status().links?.joinUrl
  );
  const raw = await page.tab();
  await raw.goto('/manifest.json');
  const open = (who, meta, lines = 0) =>
    raw.evaluate(
      async (join, name, meta, lines) => {
        globalThis.nodes ??= {};
        if (!globalThis.nodes[name]) {
          const { createLeaders, certificateKey } = await import('/seed/leaders.js');
          const { certificate, hubClient } = await import('/seed/follow.js');
          const own = name.startsWith('own');
          globalThis.nodes[name] = createLeaders({
            post: hubClient({ origin: null, fetch: (...args) => fetch(...args) }),
            name,
            cert: (hub) => certificate(own ? certificateKey(hub) : `elsewhere:${hub}`),
          });
        }
        try {
          const { stream } = await globalThis.nodes[name].open(join, meta);
          const info = stream.info;
          const read = [];
          let text = '';
          while (read.length < lines) {
            const chunk = await Promise.race([
              stream.read(),
              new Promise((resolve) => setTimeout(() => resolve('late'), 30000)),
            ]);
            if (!chunk || chunk === 'late') break;
            text += new TextDecoder().decode(chunk);
            const parts = text.split('\n');
            text = parts.pop();
            read.push(...parts.map((part) => JSON.parse(part)));
          }
          stream.close();
          return { opened: info, lines: read };
        } catch (error) {
          return { code: error.code, message: error.message };
        }
      },
      joinUrl,
      who,
      meta,
      lines
    );
  const list = { kind: 'agent', op: 'approvals' };
  const decide = (id, answer) => ({ kind: 'agent', op: 'decide', id, answer });
  const grant = async (name, before = null) => {
    const device = await page.within(
      60000,
      (name, before) =>
        document
          .querySelector('slicc-app')
          .model.network.status()
          .links?.devices.find(
            (d) => d.name === name && d.state === 'connected' && d.id !== before
          ),
      name,
      before
    );
    await page.evaluate(
      (id) => document.querySelector('slicc-app').model.network.setAccess(id, 'control', true),
      device.id
    );
    return device.id;
  };

  for (const who of [OWN, OTHER])
    for (const meta of [list, decide('nothing', 'once')]) {
      const answer = await open(who, meta);
      assert.equal(answer.code, 'EACCES', JSON.stringify(answer));
      assert.match(answer.message, /doesn't allow remote control/);
    }
  const own = await grant(OWN);
  const other = await grant(OTHER);
  const kept = await raw.evaluate(async () => {
    const { keptFingerprints } = await import('/seed/follow.js');
    return keptFingerprints('link:');
  });
  assert.ok(kept.includes(own), `${own} is not in ${JSON.stringify(kept)}`);
  assert.equal(kept.includes(other), false);

  assert.deepEqual(await open(OTHER, list), { opened: { approvals: [] }, lines: [] });
  await run(page, 'clear; sudo -u cone sudo id -un; echo id=$?');
  let listed = [];
  for (let i = 0; i < 240 && !listed.some((entry) => entry.kind === 'sudo'); i += 1) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 500));
    listed = (await open(OTHER, list)).opened?.approvals ?? [];
  }
  const item = listed.find((entry) => entry.kind === 'sudo');
  assert.ok(item, JSON.stringify(listed));
  assert.equal(item.tier, 'user');
  assert.equal(typeof item.expiresAt, 'number');
  assert.match(JSON.stringify(item.detail), /id -un/);
  for (const hidden of ['replay', 'device', 'seat']) assert.equal(hidden in item, false);

  assert.deepEqual(await open(OWN, decide(item.id, 'once')), {
    code: 'EACCES',
    message: OWN_KERNEL,
  });
  const rotated = await raw.evaluate(async (join) => {
    const { certificateKey } = await import('/seed/leaders.js');
    const { certificate, hubOrigin, keptFingerprints } = await import('/seed/follow.js');
    const year = 366 * 24 * 60 * 60 * 1000;
    await certificate(certificateKey(hubOrigin(join)), { now: () => Date.now() + year });
    return keptFingerprints('link:');
  }, joinUrl);
  assert.deepEqual(
    await open(OWN, decide(item.id, 'once')),
    { code: 'EACCES', message: OWN_KERNEL },
    'the own-kernel link that stayed up while its certificate was replaced'
  );
  assert.ok(rotated.includes(own), `the replaced certificate is gone from ${rotated}`);
  assert.ok(
    rotated.some((print) => print !== own),
    `no new certificate in ${rotated}`
  );
  assert.equal(rotated.includes(other), false);
  await raw.evaluate(
    async (join, name) => {
      const { joinKey } = await import('/seed/leaders.js');
      const id = await joinKey(join);
      await globalThis.nodes[name].disconnect(id);
      await globalThis.nodes[name].reconnect(id);
    },
    joinUrl,
    OWN
  );
  const redialled = await grant(OWN, own);
  assert.notEqual(redialled, own, 'the reconnect dials with the new certificate');
  assert.ok(rotated.includes(redialled), `${redialled} is not in ${rotated}`);
  assert.deepEqual(
    await open(OWN, decide(item.id, 'once')),
    { code: 'EACCES', message: OWN_KERNEL },
    'the own-kernel link dialled again after the rotation'
  );
  const seen = await open(OWN, list);
  assert.deepEqual(
    seen.opened?.approvals.map((entry) => entry.id),
    listed.map((entry) => entry.id)
  );
  const unknown = await open(OTHER, decide('no-such-approval', 'once'));
  assert.equal(unknown.code, 'ENOENT', JSON.stringify(unknown));
  const bad = await open(OTHER, decide(item.id, 'maybe'));
  assert.deepEqual(bad, { code: 'EINVAL', message: 'the answer is once, always, deny or stop' });

  const watched = await raw.evaluate(
    async (join, name) => {
      const { stream } = await globalThis.nodes[name].open(join, {
        kind: 'agent',
        op: 'approvals',
        watch: true,
      });
      globalThis.watching = stream;
      return stream.info.approvals.map((entry) => entry.id);
    },
    joinUrl,
    OTHER
  );
  assert.ok(watched.includes(item.id), JSON.stringify(watched));
  assert.deepEqual(await open(OTHER, decide(item.id, 'deny')), {
    opened: { ok: true },
    lines: [],
  });
  await shows(page, 'id=1');
  const update = await raw.evaluate(async (id) => {
    const stream = globalThis.watching;
    let text = '';
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        stream.read(),
        new Promise((resolve) => setTimeout(() => resolve('late'), deadline - Date.now())),
      ]);
      if (!chunk || chunk === 'late') break;
      text += new TextDecoder().decode(chunk);
      const lines = text.split('\n');
      text = lines.pop();
      for (const line of lines.map((each) => JSON.parse(each)))
        if (!line.approvals.some((entry) => entry.id === id)) {
          stream.close();
          return line;
        }
    }
    stream.close();
    return `no snapshot without ${id}; left over: ${text}`;
  }, item.id);
  assert.equal(update?.t, 'approvals', JSON.stringify(update));
  assert.ok(Array.isArray(update.approvals), JSON.stringify(update));
  const again = await open(OTHER, decide(item.id, 'once'));
  assert.equal(again.code, 'EINVAL', JSON.stringify(again));
  assert.notEqual(again.message, 'EINVAL');
  const settled = await open(OTHER, list);
  assert.equal(
    settled.opened?.approvals.some((entry) => entry.id === item.id),
    false,
    JSON.stringify(settled)
  );
  await page.evaluate(() => localStorage.removeItem('slicc-os.tray-hub'));
});
