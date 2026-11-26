import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { control, device } from '../lease-owner.mjs';
import { localLeader } from './job.mjs';

function required(name) {
  const path = process.env[name];
  if (!path?.startsWith('/')) throw new Error(`Missing verified fixture input: ${name}`);
  return path;
}

async function ownerBrowser(t, app, home, chrome) {
  const profile = join(home, 'owner');
  const owner = await chromium.launchPersistentContext(profile, {
    executablePath: chrome,
    headless: true,
    args: [
      '--remote-debugging-port=0',
      '--no-proxy-server',
      `--ignore-certificate-errors-spki-list=${app.spki}`,
      '--host-resolver-rules=MAP *.example.test 127.0.0.1, MAP cross.test 127.0.0.1',
    ],
  });
  t.after(() => owner.close());
  owner.setDefaultTimeout(10000);
  const original = owner.pages()[0],
    billing = app.sites.billing;
  await original.goto(`${billing}/owner-session`);
  await original.waitForFunction(() => window.invoiceReady);
  await original.evaluate(() => window.invoiceReady);
  const strict = (await owner.cookies(billing)).filter((c) => c.name === '__Host-fixture');
  assert.ok(
    strict.length === 1 &&
      strict[0].secure &&
      strict[0].httpOnly &&
      strict[0].sameSite === 'Strict',
    'synthetic owner session'
  );
  const port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  assert.ok(port > 1023 && port <= 65535, 'ephemeral owner endpoint');
  return { owner, original, endpoint: `http://127.0.0.1:${port}` };
}

function follow(t, go, home, endpoint, pair) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: home,
    SLICC_NO_UPDATE_CHECK: '1',
    SLICC_DISCOVERY: 'isolated',
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_RUNTIME_DIR: home,
  };
  execFileSync(go, ['lease', 'pair', '--link', 'fixture', '--peer', pair.leader], {
    env,
    stdio: 'ignore',
    timeout: 5000,
  });
  return () => {
    const child = spawn(
      go,
      ['-', 'follow', '--json', '--lease-browser', endpoint, '--name', 'fixture'],
      { env, stdio: ['pipe', 'ignore', 'ignore'] }
    );
    const done = once(child, 'exit');
    child.stdin.on('error', () => {});
    child.stdin.end(`${pair.url}\n`);
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await done;
    };
    t.after(stop);
    const call = (op, params) =>
      control(join(home, 'slicc', `${child.pid}.sock`), `cdp-lease-${op}`, params);
    return {
      stop,
      call,
      live: (p) =>
        Promise.race([
          p,
          done.then(() => {
            throw new Error('isolated follower exited before handshake');
          }),
        ]),
    };
  };
}

function milestone(t, counts) {
  return async (label, fn, delta = {}) => {
    const at = performance.now(),
      before = await counts();
    try {
      await fn();
      const after = await counts();
      const observed = Object.fromEntries(
        [...new Set([...Object.keys(after), ...Object.keys(before)])]
          .map((k) => [k, (after[k] ?? 0) - (before[k] ?? 0)])
          .filter(([, n]) => n !== 0)
      );
      assert.deepEqual(observed, delta);
      t.diagnostic(
        `${label}: ${Math.round(performance.now() - at)} ms; counts=${JSON.stringify(observed)}`
      );
    } catch (e) {
      if (
        e.code === 'ERR_ASSERTION' &&
        e.operator === 'deepStrictEqual' &&
        e.actual &&
        Object.keys(e.actual).every((k) => /^[\w.]+$/.test(k) && Number.isInteger(e.actual[k]))
      )
        t.diagnostic(
          `${label}: expected counters=${JSON.stringify(delta)} actual counters=${JSON.stringify(e.actual)}`
        );
      throw new Error(
        `Broker interop failed at ${label} after ${Math.round(performance.now() - at)} ms`
      );
    }
  };
}

const askProof = {
  'open.request': 1,
  'challenge.request': 1,
  'out.request.proof': 1,
  'in.request.pending': 1,
};
const dataOpen = {
  'open.data': 1,
  dataWithJws: 1,
  'challenge.data': 1,
  'out.data.proof': 1,
  'in.data.ready': 1,
};
const readPage = { 'out.data.goto': 1, 'out.data.snapshot': 1, 'in.data.result': 2 };

async function scenario(t, { app, job, owner, original, start }) {
  const step = milestone(t, job.counts),
    { billing, receipt } = app.sites;
  const origin = [{ kind: 'origin', url: billing }],
    exact = (url) => [{ kind: 'exact', url }];
  const pad = (url) => url.padEnd(2048, 'x');
  const longBilling = pad(`${billing}/invoices/`),
    longReceipt = pad(`${receipt}/r/1042#`);
  const n = { approve: 0, deny: 0, revoke: 0, created: 0, closed: 0, refused: 0 };
  let broker, tab;
  async function pending(label, rules, from) {
    await job.request(label, rules, from);
    await job.wait('pending');
    const list = await broker.call('list');
    assert.equal(list.pending.length, 1);
    const [p] = list.pending;
    assert.ok(await job.matches({ label, request: p.request, jkt: p.jkt }));
    assert.ok(JSON.stringify(p.allow) === JSON.stringify(rules), 'owner scope');
    assert.equal(list.active.length, from ? 1 : 0);
    assert.equal(Boolean(p.parent), Boolean(from));
    return p.request;
  }
  async function issue(label, rules, from) {
    let request;
    await step(
      `request ${label}`,
      async () => {
        request = await pending(label, rules, from);
        await job.action(label, 'snapshot', {}, 'E_PENDING');
      },
      askProof
    );
    await step(
      `approve ${label}`,
      async () => {
        await broker.call('approve', { request });
        n.approve++;
        await job.wait('active', label);
        assert.equal((await broker.call('list')).active.length, 1);
      },
      { 'in.request.grant': 1 }
    );
  }
  async function drive(label, url, bill = true) {
    const created = bill ? owner.waitForEvent('page', { timeout: 10000 }) : null;
    await Promise.all([
      job.action(label, 'goto', { url }),
      created?.then((p) => {
        tab = p;
        n.created++;
      }),
    ]);
    if (bill) {
      await tab.waitForFunction(() => window.invoiceReady);
      await tab.evaluate(() => window.invoiceReady);
    } else await tab.waitForLoadState();
    await job.action(label, 'snapshot', {}, 'ok', bill ? 'Invoice 1042' : 'Receipt 1042');
  }
  async function revoke(label) {
    const active = (await broker.call('list')).active;
    assert.equal(active.length, 1);
    await Promise.all([
      tab.waitForEvent('close', { timeout: 10000 }),
      broker.call('revoke', { lease: active[0].lease }),
    ]);
    n.revoke++;
    n.closed++;
    await job.wait('inactive');
    await job.action(label, 'snapshot', {}, 'E_REVOKED');
    assert.equal(owner.pages().length, 1);
    assert.ok(owner.pages()[0] === original);
  }
  await step(
    'pair follower',
    async () => {
      broker = start();
      await broker.live(job.wait('attach', null, 1));
    },
    { attach: 1 }
  );
  await step('unsupported initial scopes: exact, multi-rule, prefix', async () => {
    for (const r of [
      exact(`${billing}/invoices/1`),
      [...origin, ...exact(`${receipt}/r/1042`)],
      [{ kind: 'path-prefix', url: `${billing}/invoices` }],
    ]) {
      await job.request('invalid', r, null, 'E_UNSUPPORTED');
      n.refused++;
    }
    assert.equal((await broker.call('list')).pending.length, 0);
  });
  await issue('first', origin);
  assert.equal(owner.pages().length, 1);
  await step('2048-byte goto and scoped snapshot', () => drive('first', longBilling), {
    ...dataOpen,
    ...readPage,
  });
  await step('reject writes, outside site and too-long serialized goto', async () => {
    for (const [op, args, reason] of [
      ['click', { ref: 'e1' }, 'E_UNSUPPORTED'],
      ['fill', { ref: 'e1', value: 'fixture' }, 'E_UNSUPPORTED'],
      ['goto', { url: longBilling + 'a' }, 'E_UNSUPPORTED'],
      ['goto', { url: longBilling.slice(0, -2) + 'é' }, 'E_UNSUPPORTED'],
      ['goto', { url: receipt }, 'E_SCOPE'],
    ]) {
      await job.action('first', op, args, reason);
      n.refused++;
    }
    await job.request('invalid', exact(longReceipt + 'a'), 'first', 'E_UNSUPPORTED');
    n.refused++;
    assert.equal((await broker.call('list')).pending.length, 0);
  });
  let reject;
  await step(
    'request exact delta for denial',
    async () => {
      reject = await pending('denied', exact(longReceipt), 'first');
    },
    askProof
  );
  await step(
    'deny delta; original still reads',
    async () => {
      await broker.call('deny', { request: reject });
      n.deny++;
      await job.wait('denied', 'denied');
      await job.action('first', 'snapshot');
    },
    { 'in.request.error': 1, 'out.data.snapshot': 1, 'in.data.result': 1 }
  );
  const deadline = (await broker.call('list')).active[0].exp;
  await issue('expanded', exact(longReceipt), 'first');
  await step(
    'exact 2048-byte receipt, same tab and deadline',
    async () => {
      assert.equal((await broker.call('list')).active[0].exp, deadline);
      await job.action('first', 'snapshot', {}, 'E_REVOKED');
      await drive('expanded', longReceipt, false);
      assert.equal(owner.pages().length, 2);
      await job.action('expanded', 'goto', { url: `${receipt}/r/1043` }, 'E_SCOPE');
    },
    { ...dataOpen, ...readPage }
  );
  await step('revoke and close only the task tab', () => revoke('expanded'));
  await issue('interrupt', origin);
  await step('use a distinct live grant', () => drive('interrupt', billing), {
    ...dataOpen,
    ...readPage,
  });
  await step(
    'stop follower while grant is live',
    async () => {
      assert.ok((await job.status()).active);
      await Promise.all([tab.waitForEvent('close', { timeout: 10000 }), broker.stop()]);
      n.closed++;
      await job.wait('detach', null, 1);
      assert.ok(!(await job.status()).active);
      await job.action('interrupt', 'snapshot', {}, 'E_REVOKED');
    },
    { detach: 1 }
  );
  await step(
    'reconnect same pinned device; no data OPEN with old handle',
    async () => {
      broker = start();
      await broker.live(job.wait('attach', null, 2));
      await job.action('interrupt', 'snapshot', {}, 'E_REVOKED');
    },
    { attach: 1 }
  );
  await issue('fresh', origin);
  await step('use freshly approved handle', () => drive('fresh', billing), {
    ...dataOpen,
    ...readPage,
  });
  await step('revoke fresh grant', () => revoke('fresh'));
  assert.deepEqual(n, { approve: 4, deny: 1, revoke: 2, created: 3, closed: 3, refused: 9 });
  assert.equal(app.submitted(), 0);
  t.diagnostic(
    `owner observations=${JSON.stringify(n)}; wire totals=${JSON.stringify(await job.counts())}`
  );
}

test('pinned main broker and BIOS adapter on the dedicated lease link', {
  timeout: 120000,
}, async (t) => {
  const at = performance.now();
  const go = required('SLICC_LEASE_BROKER'),
    chrome = required('CHROME_PATH');
  const fixture = await import(pathToFileURL(required('SLICC_LEASE_PAGE_FIXTURE')).href);
  const app = await fixture.leasePageFixture({ sameSite: 'Strict' });
  t.after(() => app.close());
  const home = await mkdtemp('/tmp/sl-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const job = await localLeader(t, chrome);
  t.diagnostic(`Chromium ${job.version}`);
  const pair = await job.start(await device(home, job.hub));
  const { owner, original, endpoint } = await ownerBrowser(t, app, home, chrome);
  await scenario(t, { job, app, owner, original, start: follow(t, go, home, endpoint, pair) });
  await job.close();
  t.diagnostic(`total ${Math.round(performance.now() - at)} ms`);
});
