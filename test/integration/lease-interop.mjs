import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { findBrowser } from '@ai-ecoverse/slicc-cdp';
import { chromium } from 'playwright-core';
import { localJob } from './lease-candidate.mjs';
import { control, device } from './lease-owner.mjs';

function required(name) {
  if (!process.env[name]) throw new Error(`Set ${name} to the local candidate artifact`);
  return resolve(process.env[name]);
}

const args = (lease, ...ops) => ['--lease', lease, ...ops];
const refused = (r, reason) => {
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stderr).reason, reason);
};
const success = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

if (process.env.SLICC_TEST_LEASE_FORM !== undefined)
  throw new Error('This adapter only supports goto and snapshot');

test('review gate: read-only local broker, isolated kernel, WASI client and signed-in HTTPS fixture', {
  timeout: 120000,
}, async (t) => {
  const go = required('SLICC_LEASE_BROKER');
  const fixture = await import(pathToFileURL(required('SLICC_LEASE_PAGE_FIXTURE')).href);
  const job = await localJob(t, {
    dist: required('SLICC_LEASE_KERNEL_DIST'),
    wasm: required('SLICC_LEASE_CDP_WASM'),
  });
  const app = await fixture.leasePageFixture({ sameSite: 'Strict' });
  t.after(() => app.close());
  const home = await mkdtemp('/tmp/sl-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const pin = await device(home, job.hub.url);
  const profile = join(home, 'owner-profile');
  const owner = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH ?? (await findBrowser())?.executable,
    headless: true,
    args: [
      '--remote-debugging-port=0',
      '--use-mock-keychain',
      '--no-proxy-server',
      `--ignore-certificate-errors-spki-list=${app.spki}`,
      '--host-resolver-rules=MAP *.example.test 127.0.0.1, MAP cross.test 127.0.0.1',
    ],
  });
  t.after(() => owner.close());
  const page = owner.pages()[0];
  const port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  assert.ok(port > 1023);
  const endpoint = `http://127.0.0.1:${port}`;
  const { billing, receipt } = app.sites;
  await page.goto(`${billing}/owner-session`);
  await page.evaluate(() => window.invoiceReady);
  const attributes = (await owner.cookies(billing))
    .filter((c) => c.name === '__Host-fixture')
    .map(({ httpOnly, secure, sameSite }) => ({ httpOnly, secure, sameSite }));
  assert.deepEqual(attributes, [{ httpOnly: true, secure: true, sameSite: 'Strict' }]);
  const baseline = await owner.newPage();
  await baseline.goto(billing);
  await baseline.evaluate(() => window.invoiceReady);
  assert.match(await baseline.locator('#invoice').textContent(), /Invoice 1042/);
  await baseline.close();
  const receiptUrl = `${receipt}/r/1042`;
  const url = await job.start(pin);
  const { lease, jkt } = await job.request(billing);
  refused(await job.run(...args(lease, 'snapshot')), 'E_PENDING');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: home,
    SLICC_NO_UPDATE_CHECK: '1',
    SLICC_DISCOVERY: 'isolated',
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_RUNTIME_DIR: home,
  };
  execFileSync(go, ['lease', 'pair', '--link', 'fixture', '--peer', job.leaderPin], {
    env,
    stdio: 'pipe',
  });
  const follower = spawn(
    go,
    ['-', 'follow', '--json', '--lease-browser', endpoint, '--name', 'fixture'],
    { env, stdio: ['pipe', 'ignore', 'pipe'] }
  );
  const done = once(follower, 'exit');
  t.after(async () => {
    if (follower.exitCode === null && follower.signalCode === null) follower.kill('SIGTERM');
    await done;
  });
  let error = '';
  follower.stderr.on('data', (chunk) => {
    error = (error + chunk).slice(-500);
  });
  follower.stdin.end(`${url}\n`);
  const pid = follower.pid;
  const dir =
    process.platform === 'linux' ? join(home, 'slicc') : join(home, `slicc-${process.getuid()}`);
  const call = (op, params) => control(join(dir, `${pid}.sock`), `cdp-lease-${op}`, params);
  const pending = await Promise.race([
    job.wait('pending'),
    done.then(() => {
      throw new Error(`fixture follower exited: ${error.replaceAll(url, '[fixture link]')}`);
    }),
  ]);
  const first = await call('list');
  assert.equal(first.active.length, 0);
  assert.equal(first.pending.length, 1);
  assert.equal(first.pending[0].jkt, jkt);
  assert.equal(first.pending[0].request, pending);
  assert.throws(
    () =>
      execFileSync(
        go,
        ['lease', 'review', '--to', `jkt:${jkt}`, '--allow', billing, '--for', '1h'],
        { input: '\n', stdio: 'pipe', env }
      ),
    /terminal/
  );
  assert.equal((await call('list')).active.length, 0);
  await call('approve', { request: pending });
  await job.wait('active', lease);
  const next = owner.waitForEvent('page');
  success(await job.run(...args(lease, 'goto', billing)));
  const task = await next;
  await task.waitForLoadState();
  assert.notEqual(
    success(await job.run(...args(lease, 'snapshot'))),
    'Synthetic session required',
    'first navigation must use the synthetic owner session'
  );
  await task.waitForFunction(() => window.invoiceReady);
  await task.evaluate(() => window.invoiceReady);
  const evidence = await task.evaluate(async () => ({
    invoice: document.querySelector('#invoice')?.textContent,
    font: document.fonts.check('16px Fixture', '$'),
    worker: Boolean((await navigator.serviceWorker.ready).active),
    resources: performance.getEntriesByType('resource').map((r) => r.name),
  }));
  assert.match(evidence.invoice, /Invoice 1042.*paid/);
  assert.equal(evidence.font && evidence.worker, true);
  for (const resource of [
    `${app.sites.cdn}/app.js`,
    `${app.sites.cdn}/app.css`,
    `${app.sites.api}/data`,
  ])
    assert.ok(evidence.resources.includes(resource), `leased tab did not load ${resource}`);
  const snapshot = success(await job.run(...args(lease, 'snapshot')));
  assert.match(snapshot, /Invoice 1042/);
  assert.doesNotMatch(snapshot, /Support frame fixture only/);
  await task.goto(`${app.sites.support}/sso`);
  const handoff = await job.run(...args(lease, 'snapshot'));
  refused(handoff, 'E_SCOPE');
  assert.doesNotMatch(handoff.stdout + handoff.stderr, /Human handoff|Resume billing|cross\.test/);
  await task.goto(`${billing}/invoices/1042`);
  await task.evaluate(() => window.invoiceReady);
  assert.match(success(await job.run(...args(lease, 'snapshot'))), /Invoice 1042/);
  refused(await job.run(...args(lease, 'goto', receiptUrl)), 'E_SCOPE');
  const active = (await call('list')).active[0];
  assert.equal(active.jkt, jkt);
  async function expansion() {
    const text = success(await job.run('lease', 'request', '--from', lease, '--add', receiptUrl));
    const newHandle = /^Lease: ([\w-]+)$/m.exec(text)?.[1];
    assert.ok(newHandle && newHandle !== lease);
    const request = await job.wait('pending');
    const item = (await call('list')).pending.find((p) => p.request === request);
    assert.equal(item.parent, active.lease);
    assert.deepEqual(item.allow, [{ kind: 'exact', url: receiptUrl }]);
    return { request, newHandle };
  }
  const deny = await expansion();
  await call('deny', { request: deny.request });
  await job.wait('denied', deny.newHandle);
  refused(await job.run(...args(deny.newHandle, 'snapshot')), 'E_DENIED');
  assert.match(success(await job.run(...args(lease, 'snapshot'))), /Invoice 1042/);
  const add = await expansion();
  await call('approve', { request: add.request });
  await job.wait('active', add.newHandle);
  const replacement = (await call('list')).active;
  assert.equal(replacement.length, 1);
  assert.notEqual(replacement[0].lease, active.lease);
  assert.equal(replacement[0].exp, active.exp);
  refused(await job.run(...args(lease, 'snapshot')), 'E_REVOKED');
  success(await job.run(...args(add.newHandle, 'goto', receiptUrl)));
  assert.match(success(await job.run(...args(add.newHandle, 'snapshot'))), /Receipt 1042/);
  refused(await job.run(...args(add.newHandle, 'goto', `${receipt}/r/1043`)), 'E_SCOPE');
  refused(await job.run(...args(add.newHandle, 'click', 'e1')), 'E_UNSUPPORTED');
  refused(await job.run(...args(add.newHandle, 'fill', 'e1', 'test')), 'E_UNSUPPORTED');
  assert.equal(owner.pages().length, 2, 'one original and one task tab before revocation');
  const closed = task.waitForEvent('close', { timeout: 5000 });
  await Promise.all([closed, call('revoke', { lease: replacement[0].lease })]);
  refused(await job.run(...args(add.newHandle, 'snapshot')), 'E_REVOKED');
  assert.equal(owner.pages().length, 1, 'revocation closes only the task tab');
  assert.equal(owner.pages()[0], page);
  assert.match(page.url(), /\/invoices\/1042/);
  assert.equal(app.submitted(), 0);
  for (const resource of ['api', 'embed', 'font', 'script', 'stylesheet', 'websocket', 'worker'])
    assert.ok(app.assets.has(resource), `fixture did not serve ${resource}`);
  await job.page.evaluate(() => stopJob());
});
