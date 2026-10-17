import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, ready, run, screen } from './bios.mjs';
import { launch } from './chrome.mjs';
import { leader, model, startHub } from './fake-hub.mjs';

const STEP = 3 * 60 * 1000;
const owners = await launch({ timeout: 120000 });
const followers = await launch({ timeout: 120000 });
const hub = await startHub();
after(async () => {
  hub.close();
  await Promise.all([owners.close(), followers.close()]);
});

async function typed(page, command, label, ms = STEP) {
  await run(page, `clear; ${command}; echo "${label}-$((40 + 2)) $?"`);
  const code = await page
    .within(
      ms,
      (pattern) => {
        const { dock } = document.querySelector('slicc-app');
        const id = dock.api.panels
          .map((panel) => panel.id)
          .findLast((id) => id.startsWith('terminal:'));
        return new RegExp(pattern).exec(dock.content(id).screen.textContent)?.[1];
      },
      `${label}-42 (\\d+)`
    )
    .catch(async (error) => {
      throw new Error(
        `${label}: ${error.message}\nscreen:\n${await screen(page)}\nconsole:\n${page.console.slice(-15).join('\n')}`
      );
    });
  return { code: Number(code), text: await screen(page) };
}

const devices = async (page) =>
  (await model(page, (network) => network.status().links.devices)).filter(
    (item) => item.kind === 'cli' && item.mode === 'remote'
  );

async function boot(page, hubUrl) {
  await page.goto('/');
  await ready(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hubUrl);
  await page.reload();
  await ready(page);
}

test('an unlink by one seven leaves this seven’s certificate, so another seven on the hub still knows it and keeps its Allow remote control; only the re-link the unlink asks for makes a new device', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  const owner = await owners.page(t);
  await boot(owner, hub.url);
  const page = await followers.page(t);
  await boot(page, hub.url);
  await page.within(5 * 60 * 1000, () =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'slicc' && item.state === 'available')
  );
  assert.equal(await actPackage(page, 'slicc'), 'ok');
  const { joinUrl } = await model(owner, (network) => network.status().links);
  const toOwner = `sudo -u cone slicc '${joinUrl}' abort`;

  const first = await typed(page, toOwner, 'asking');
  assert.equal(first.code, 3, first.text);
  assert.match(first.text, /doesn't allow remote control from this one/);
  let found = [];
  for (let i = 0; i < 240 && found.length !== 1; i += 1) {
    found = await devices(owner);
    if (found.length !== 1) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(found.length, 1, `the leader lists this seven once: ${JSON.stringify(found)}`);
  const [known] = found;
  await model(owner, (network, id) => network.setRemoteControl(id, true), known.id);
  const allowed = await typed(page, toOwner, 'allowed');
  assert.equal(allowed.code, 3, allowed.text);
  assert.match(allowed.text, /the agent is not running/);

  const fake = await owner.evaluate(leader, hub.url);
  const toFake = `sudo -u cone slicc '${fake}' abort`;
  const followedFake = await typed(page, toFake, 'fake');
  assert.equal(followedFake.code, 0, followedFake.text);
  assert.match(followedFake.text, /nothing was running/);
  const [before] = await owner.evaluate(() => globalThis.fakeLeader.fingerprints);
  assert.equal(before, known.id, 'every seven on the hub sees one certificate');
  await owner.evaluate(() => globalThis.fakeLeader.unlink());

  const refused = await typed(page, toFake, 'unlinked');
  assert.equal(refused.code, 3, refused.text);
  assert.match(refused.text, /unlinked this one; run slicc again to link as a new device/);
  assert.deepEqual(await owner.evaluate(() => globalThis.fakeLeader.fingerprints), [
    before,
    before,
  ]);

  await page.reload();
  await ready(page);
  const still = await typed(page, toOwner, 'still');
  assert.equal(still.code, 3, still.text);
  assert.match(
    still.text,
    /the agent is not running/,
    'the other seven still knows this one and keeps its Allow remote control'
  );
  const kept = await devices(owner);
  assert.deepEqual(
    kept.map((item) => [item.id, item.control.allowed]),
    [[known.id, true]]
  );

  await owner.evaluate(() => {
    globalThis.fakeLeader.away = true;
  });
  const fingerprints = () => owner.evaluate(() => globalThis.fakeLeader.fingerprints);
  for (const label of ['away', 'still-away']) {
    const from = (await fingerprints()).length;
    const unanswered = await typed(page, toFake, label);
    assert.notEqual(unanswered.code, 0, unanswered.text);
    assert.match(unanswered.text, /couldn't reach that seven through its tray/);
    assert.ok((await fingerprints()).length > from, `${label}: the re-link reached the leader`);
  }
  await owner.evaluate(() => {
    globalThis.fakeLeader.away = false;
  });
  const relinked = await typed(page, toFake, 'relinked');
  assert.equal(relinked.code, 0, relinked.text);
  const seen = await fingerprints();
  assert.notEqual(seen[2], before, 'the re-link is a new device');
  assert.deepEqual(
    [...new Set(seen.slice(2))],
    [seen[2]],
    're-links that fail mint one certificate, not one per retry'
  );

  await page.reload();
  await ready(page);
  const fresh = await typed(page, toOwner, 'fresh');
  assert.equal(fresh.code, 3, fresh.text);
  assert.match(fresh.text, /doesn't allow remote control from this one/);
  assert.ok((await devices(owner)).some((item) => item.id === seen[2] && !item.control.allowed));
  assert.deepEqual(page.errors, []);
  assert.deepEqual(owner.errors, []);
});
