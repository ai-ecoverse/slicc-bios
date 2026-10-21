import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, ready, run, screen } from './bios.mjs';
import { launch } from './chrome.mjs';
import { follower, model, startHub } from './fake-hub.mjs';
import { shoot } from './shots.mjs';

const STEP = 3 * 60 * 1000;
const chrome = await launch({ timeout: 120000 });
const hub = await startHub();
after(async () => {
  hub.close();
  await chrome.close();
});

const sh = (page, command) =>
  page.evaluate(
    (command) =>
      globalThis.trayClient
        .run(['bash', '-c', command], { cwd: '/' })
        .then(({ status, stdout, stderr }) => ({ status, out: `${stdout ?? ''}${stderr ?? ''}` })),
    command
  );

const start = (page, command, label) =>
  run(
    page,
    `clear; ${command} > /tmp/${label}.out 2> /tmp/${label}.err; echo "${label}-$((40 + 2)) $?"`
  );

const asked = (page, op) =>
  page.within(
    STEP,
    (op) => {
      const item = document
        .querySelector('slicc-app')
        .model.approvals.list()
        .find((entry) => entry.kind === 'tray' && entry.op === op);
      return item && JSON.parse(JSON.stringify(item));
    },
    op
  );

const decide = (page, id, decision) =>
  page.until(
    ([id, decision]) => {
      const deep = (root) => {
        const found = root.querySelector(`dialog[data-approval="${id}"]`);
        if (found) return found;
        for (const element of root.querySelectorAll('*')) {
          const inner = element.shadowRoot && deep(element.shadowRoot);
          if (inner) return inner;
        }
        return null;
      };
      const listed = document
        .querySelector('slicc-app')
        .model.approvals.list()
        .some((entry) => entry.id === id);
      if (!listed) return true;
      deep(document)?.querySelector(`[data-action="${decision}"]`)?.click();
      return false;
    },
    [id, decision]
  );

const trays = (page) =>
  page.evaluate(
    () =>
      document
        .querySelector('slicc-app')
        .model.approvals.list()
        .filter((entry) => entry.kind === 'tray').length
  );

const dialog = (page, open) =>
  page.until((open) => {
    const deep = (root) => {
      const found = root.querySelector('dialog[data-approval][data-kind="tray"]');
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && deep(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return Boolean(deep(document)?.open) === open;
  }, open);

async function approved(page, command, label, op, decision = 'once', shot = null) {
  await start(page, command, label);
  const item = await asked(page, op);
  await dialog(page, true);
  if (shot) await shoot(page, shot);
  await decide(page, item.id, decision);
  await dialog(page, false);
  return { item, ...(await finished(page, label)) };
}

async function typed(page, command, label) {
  await start(page, command, label);
  return finished(page, label);
}

async function finished(page, label) {
  const code = await page
    .within(
      STEP,
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
      throw new Error(`${label}: ${error.message}\nscreen:\n${await screen(page)}`);
    });
  const out = (await sh(page, `cat /tmp/${label}.out`)).out;
  const err = (await sh(page, `cat /tmp/${label}.err`)).out;
  return { code: Number(code), out, err };
}

async function link(page, t, n) {
  hub.send({
    type: 'follower.join_requested',
    trayId: `t${n}`,
    controllerId: `dev${n}`,
    bootstrapId: `b${n}`,
    attempt: 1,
    runtime: 'slicc-link/1',
    iceServers: [],
  });
  const offer = await hub.next('bootstrap.offer');
  const answer = await page.evaluate((sdp) => globalThis.followerAccept(sdp), offer.offer.sdp);
  hub.send({
    type: 'bootstrap.answer',
    trayId: `t${n}`,
    controllerId: `dev${n}`,
    bootstrapId: `b${n}`,
    answer: { type: 'answer', sdp: answer },
  });
  const relay = setInterval(() => {
    const found = hub.fromLeader.filter((m) => m.type === 'bootstrap.ice_candidate');
    hub.fromLeader = hub.fromLeader.filter((m) => m.type !== 'bootstrap.ice_candidate');
    for (const m of found)
      page.evaluate((c) => globalThis.followerCandidate(c), m.candidate).catch(() => {});
  }, 50);
  t.after(() => clearInterval(relay));
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((d) => d.state === 'connected')
  );
  const [device] = await model(page, (network) => network.status().links.devices);
  return device;
}

const raw = (op) => {
  const hello = JSON.stringify({ v: 1, open: { kind: 'tray', op } });
  const length = Buffer.byteLength(hello);
  const head = [1, length >>> 24, (length >>> 16) & 255, (length >>> 8) & 255, length & 255]
    .map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`)
    .join('');
  return `exec 3<>/dev/tcp/127.0.0.1/7400; printf '${head}%s' '${hello}' >&3; timeout 10 cat <&3 | tr -c '[:print:]' '.'`;
};

test('a cone’s slicc tray in seven’s terminal lists and retries this seven’s tray, and hands out, rotates and unlinks only once the owner approves; root isn’t asked, a scoop is refused, and status never carries a join or webhook URL', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto('/');
  await ready(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  t.after(() => page.evaluate(() => localStorage.removeItem('slicc-os.tray-hub')).catch(() => {}));
  await page.reload();
  await ready(page);
  await page.until(() => document.querySelector('slicc-app').model.network.status().links?.joinUrl);
  await page.within(5 * 60 * 1000, () =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'slicc' && item.state === 'available')
  );
  assert.equal(await actPackage(page, 'slicc'), 'ok');
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  await page.evaluate(async () => {
    globalThis.trayClient ??= await globalThis.sliccKernelClient();
  });
  await page.evaluate(follower);
  const device = await link(page, t, 1);
  assert.match(device.id, /^[0-9a-f]{64}$/);
  const { joinUrl, webhookUrl } = await model(page, (network) => network.status().links);
  assert.equal(joinUrl, `${hub.url}/join/j1`);
  assert.equal(webhookUrl, `${hub.url}/webhook/w1`);

  const listed = await typed(page, 'sudo -u cone slicc tray', 'listed');
  assert.equal(listed.code, 0, `${listed.out}\n${listed.err}`);
  assert.match(listed.out, /ready/);
  assert.match(listed.out, new RegExp(hub.url.replace(/[.]/g, '\\.')));
  assert.match(listed.out, /slicc on far/);
  assert.match(listed.out, /far\.slicc\.internal/);
  assert.match(listed.out, new RegExp(`${device.id.slice(0, 4)}…${device.id.slice(-4)}`));
  assert.doesNotMatch(`${listed.out}${listed.err}`, /\/join\/|\/webhook\//);

  const json = await typed(page, 'sudo -u cone slicc tray --json', 'json');
  assert.equal(json.code, 0, `${json.out}\n${json.err}`);
  const status = JSON.parse(json.out);
  assert.equal(status.tray, 'ready');
  assert.equal(status.hub, hub.url);
  assert.deepEqual(
    status.devices.map(({ id, name, host, mode, state }) => ({ id, name, host, mode, state })),
    [
      {
        id: device.id,
        name: 'slicc on far',
        host: 'far.slicc.internal',
        mode: 'remote',
        state: 'connected',
      },
    ]
  );

  const answered = await typed(page, raw('status'), 'raw');
  assert.match(answered.out, /\{"opened":\{"tray":"ready"/, answered.out);
  assert.ok(answered.out.includes(device.id), answered.out);
  for (const secret of [
    joinUrl,
    webhookUrl,
    '/join/',
    '/webhook/',
    'joinUrl',
    'joinCommand',
    'followUrl',
    'webhookUrl',
  ])
    assert.ok(
      !answered.out.includes(secret),
      `the status answer carries ${secret}: ${answered.out}`
    );

  const own = await typed(page, 'slicc tray url', 'own');
  assert.deepEqual([own.code, own.out], [0, `${joinUrl}\n`]);
  assert.equal(await trays(page), 0);
  const url = await approved(
    page,
    'sudo -u cone slicc tray url',
    'url',
    'url',
    'once',
    'tray-approval-url'
  );
  assert.deepEqual([url.code, url.out], [0, `${joinUrl}\n`]);
  assert.deepEqual(
    [url.item.requester.name, url.item.expiresAt - url.item.createdAt, 'always' in url.item],
    ['cone', 5 * 60 * 1000, false]
  );
  const denied = await approved(page, 'sudo -u cone slicc tray url', 'denied', 'url', 'deny');
  assert.equal(denied.code, 3, `${denied.out}\n${denied.err}`);
  assert.match(denied.err, /the owner didn't approve this/);
  assert.equal(denied.out, '');
  assert.doesNotMatch(denied.err, /\/join\//);

  const sockets = hub.sockets.length;
  const rotated = await approved(
    page,
    'sudo -u cone slicc tray rotate',
    'rotated',
    'rotate',
    'once',
    'tray-approval-rotate'
  );
  assert.equal(rotated.code, 0, rotated.err);
  assert.equal(rotated.out, '');
  assert.match(rotated.err, /made a new join URL/);
  assert.equal(hub.trays, 2);
  assert.deepEqual(
    (await page.evaluate(() => globalThis.followerLog)).filter((m) => m.kind === 'join'),
    [{ kind: 'join', url: `${hub.url}/join/j2` }]
  );
  await page.until(() =>
    document.querySelector('slicc-app').model.network.status().links?.joinUrl?.endsWith('/j2')
  );
  const moved = await typed(page, 'slicc tray url', 'moved');
  assert.deepEqual([moved.code, moved.out], [0, `${hub.url}/join/j2\n`]);

  const retried = await typed(page, 'sudo -u cone slicc tray retry', 'retried');
  assert.equal(retried.code, 0, retried.err);
  const deadline = Date.now() + 60000;
  while (hub.sockets.length <= sockets + 1 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    hub.sockets.length > sockets + 1,
    `no new controller socket after retry: ${hub.sockets.map((s) => s.path)}`
  );
  await page.until(
    () => document.querySelector('slicc-app').model.network.status().links?.sync === 'ready'
  );

  const made = await sh(
    page,
    "echo 'scoop-probe:x:1100:1100:scoop-probe:/home/cone:/bin/bash' >> /etc/passwd && echo 'scoop-probe:x:1100:' >> /etc/group && sed -i 's/^cone:x:1000:$/cone:x:1000:scoop-probe/' /etc/group && sudo -u scoop-probe id"
  );
  assert.match(made.out, /uid=1100\(scoop-probe\).*1000\(cone\)/, made.out);
  for (const op of ['url', '']) {
    const scoop = await typed(page, `sudo -u scoop-probe slicc tray ${op}`, `scoop${op}`);
    assert.equal(await trays(page), 0);
    assert.equal(scoop.code, 3, `${scoop.out}\n${scoop.err}`);
    assert.match(scoop.err, /only root and members of sudo may reach another seven/);
    assert.doesNotMatch(`${scoop.out}${scoop.err}`, /\/join\//);
  }

  const unlinked = await approved(
    page,
    `sudo -u cone slicc tray unlink ${device.id.slice(0, 8)}`,
    'unlinked',
    'unlink',
    'once',
    'tray-approval-unlink'
  );
  assert.deepEqual(unlinked.item.device, { id: device.id, name: 'slicc on far' });
  assert.equal(unlinked.code, 0, unlinked.err);
  assert.deepEqual((await page.evaluate(() => globalThis.followerLog)).at(-1), { kind: 'unlink' });
  assert.deepEqual(await model(page, (network) => network.status().links.devices), []);
  const gone = await typed(page, `sudo -u cone slicc tray unlink ${device.id.slice(0, 8)}`, 'gone');
  assert.equal(gone.code, 1, `${gone.out}\n${gone.err}`);
  assert.deepEqual(page.errors, []);
});
