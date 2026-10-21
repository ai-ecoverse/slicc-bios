import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { packTar } from 'modern-tar';
import { eventually, ready, run, shows, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const WAIT_S = 10;

const helpers = () => {
  globalThis.sliccKernelDebug = true;
  window.exists = async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    try {
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  };
  window.watcher = async (script) => {
    window.kernelClient ??= await globalThis.sliccKernelClient();
    window.watched = window.kernelClient
      .run(['bash', '-c', script], { cwd: '/' })
      .then(({ status, stdout, stderr }) => ({ status, stdout, stderr }));
  };
  window.sh = async (script) => {
    window.kernelClient ??= await globalThis.sliccKernelClient();
    const { status, stdout, stderr } = await window.kernelClient.run(['bash', '-c', script], {
      cwd: '/',
    });
    return { status, stdout, stderr };
  };
};

const watching = (setup, seen) =>
  [
    'start=$SECONDS',
    setup,
    ': > /home/nt/polled',
    'while :; do',
    `  if ${seen}; then echo seen; break; fi`,
    `  if [ $((SECONDS - start)) -ge ${WAIT_S} ]; then echo stale; break; fi`,
    'done',
  ].join('\n');

async function polled(page) {
  await page.within(30000, () => window.exists('home/nt/polled'));
}

const installer = ([op, args]) =>
  new Promise((resolve, reject) => {
    const bios = new URL('./', navigator.serviceWorker.controller.scriptURL);
    const { port } = new SharedWorker(new URL('installer.js', bios), 'slicc-installer');
    port.onmessage = ({ data }) => {
      if ('progress' in data) return;
      port.close();
      if ('error' in data) reject(new Error(data.error));
      else resolve(data.result);
    };
    port.postMessage({ id: 1, op, args });
  });

async function tarball(files) {
  const tar = await packTar(
    Object.entries(files).map(([name, body]) => ({
      header: { name: `package/${name}`, size: Buffer.byteLength(body) },
      body,
    }))
  );
  const gz = gzipSync(Buffer.from(tar));
  return { gz, integrity: `sha512-${createHash('sha512').update(gz).digest('base64')}` };
}

const FIXTURE = 'node_modules/fs-notice-fixture';

async function serveSteps(t, steps) {
  const deployed = new URL('/packages/', chrome.url);
  const text = async (name) => (await fetch(new URL(name, deployed))).text();
  const lock = JSON.parse(await text('package-lock.json'));
  const manifest = await text('package.json');
  const pnpmLock = await text('pnpm-lock.yaml');
  const served = [];
  const serve = (path, body) => {
    chrome.overrides.set(path, body);
    served.push(path);
  };
  for (const [step, files] of Object.entries(steps)) {
    const { gz, integrity } = await tarball(files);
    const resolved = new URL(`/fs-notice/${step}/fixture.tgz`, chrome.url).href;
    serve(`/fs-notice/${step}/fixture.tgz`, gz);
    serve(
      `/fs-notice/${step}/package-lock.json`,
      JSON.stringify({
        ...lock,
        packages: { ...lock.packages, [FIXTURE]: { version: '1.0.0', resolved, integrity } },
      })
    );
    serve(`/fs-notice/${step}/package.json`, manifest);
    serve(`/fs-notice/${step}/pnpm-lock.yaml`, pnpmLock);
  }
  t.after(() => {
    for (const path of served) chrome.overrides.delete(path);
  });
  return (step) => new URL(`/fs-notice/${step}/package-lock.json`, chrome.url).href;
}

test('a running kernel program sees an installer update at once: a file the new version dropped is gone', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/#users=off');
  await ready(page);
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  const from = await serveSteps(t, {
    a: { 'package.json': '{"name":"fs-notice-fixture","version":"1.0.0"}', 'old.js': 'old' },
    b: { 'package.json': '{"name":"fs-notice-fixture","version":"1.0.0","b":1}' },
  });
  const first = await page.evaluate(installer, ['packages', { from: from('a') }]);
  assert.equal(first.removed, 0);
  const old = `/${FIXTURE}/old.js`;
  assert.deepEqual(
    await page.evaluate((old) => window.sh(`mkdir -p /home/nt && cat ${old}`), old),
    { status: 0, stdout: 'old', stderr: '' }
  );
  await page.evaluate(
    (script) => window.watcher(script),
    watching(`[ -e ${old} ]`, `[ ! -e ${old} ]`)
  );
  await polled(page);
  const second = await page.evaluate(installer, ['packages', { from: from('b') }]);
  assert.equal(second.downloaded, 1);
  assert.deepEqual(await page.evaluate(() => window.watched), {
    status: 0,
    stdout: 'seen\n',
    stderr: '',
  });
  assert.deepEqual(page.errors, []);
});

test('a running kernel program reads the service worker’s integrity.log append at once, and sees it newer', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/#users=off');
  await ready(page);
  const bios = await watch(page);
  await run(page, `echo 'globalThis.__changed = 1;' >> /os/callback.js && echo first-$((40 + 2))`);
  await shows(page, 'first-42');
  await page.evaluate(() => {
    window.stale = true;
    void fetch('/os/callback.js');
  });
  await page.until(() => !window.stale && location.pathname === '/os/');
  await ready(page);
  await eventually(() => assert.ok(bios.states().includes('navigate:done')));
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  assert.deepEqual(await page.evaluate(() => window.sh('rm -rf /home/nt && mkdir -p /home/nt')), {
    status: 0,
    stdout: '',
    stderr: '',
  });
  const log = '/var/log/slicc/integrity.log';
  await page.evaluate(
    (script) => window.watcher(script),
    watching(
      `lines() { n=0; while IFS= read -r l; do n=$((n + 1)); last=$l; done < ${log}; }; lines; before=$n; : > /home/nt/ref; [ ${log} -nt /home/nt/ref ]`,
      `lines && [ "$n" -gt "$before" ] && [ -z "\${last##*'"event":"stopped"'*}" ] && [ ${log} -nt /home/nt/ref ]`
    )
  );
  await polled(page);
  assert.deepEqual(
    await page.evaluate(() => window.sh("echo 'globalThis.__changed = 2;' >> /os/callback.js")),
    { status: 0, stdout: '', stderr: '' }
  );
  const refused = await page.evaluate(async () => {
    const response = await fetch('/os/callback.js');
    return [response.status, await response.text()];
  });
  assert.deepEqual(refused, [
    500,
    'sw: /os/callback.js keeps changing, so seven stopped restoring it\n',
  ]);
  assert.deepEqual(await page.evaluate(() => window.watched), {
    status: 0,
    stdout: 'seen\n',
    stderr: '',
  });
  assert.deepEqual(page.errors, []);
});
