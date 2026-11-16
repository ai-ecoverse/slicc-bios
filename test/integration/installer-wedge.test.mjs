import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ tools: false });
after(() => chrome.close());

const PAKO = 'node_modules/pako';

async function holdPage(page) {
  chrome.overrides.set('/hold.html', '<!doctype html><title>hold</title>');
  const other = await page.tab();
  await other.goto('/hold.html');
  await page.send('Page.bringToFront');
  return other;
}

async function installerWorker(t) {
  const href = new URL('/installer.js', chrome.url).href;
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const found = targetInfos.filter(({ type, url }) => type === 'shared_worker' && url === href);
  assert.equal(found.length, 1, `installer workers: ${JSON.stringify(targetInfos)}`);
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: found[0].targetId,
    flatten: true,
  });
  const detach = () => chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  t.after(detach);
  const evaluate = (expression) =>
    chrome.cdp
      .send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      .then(({ result, exceptionDetails }) => {
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description);
        return result.value;
      });
  evaluate.detach = detach;
  return evaluate;
}

test('a BIOS whose packages wait for another tab says who holds them, says how long nothing has happened, lists the locks in its diagnostics, and boots once they are free', async (t) => {
  const page = await chrome.page(t);
  const holder = await holdPage(page);
  await holder.evaluate(
    () =>
      new Promise((resolve) => {
        navigator.locks.request('slicc-packages', () => {
          resolve(true);
          return new Promise((release) => {
            window.release = release;
          });
        });
      })
  );
  const bios = await watch(page);
  await page.goto('/');
  const waiting = /^waiting 0 s for another install of the packages \(held by another seven tab\)$/;
  await page.within(
    30000,
    (source) =>
      new RegExp(source).test(document.querySelector('[data-step="packages"] output')?.value ?? ''),
    waiting.source
  );
  const quiet = await page.within(40000, () => {
    const text = document.querySelector('[data-step="packages"] output').value;
    return /, nothing new for \d+ s$/.test(text) && text;
  });
  assert.match(
    quiet,
    /^waiting 0 s for another install of the packages \(held by another seven tab\), nothing new for 1\d s$/
  );
  const locks = await page.within(15000, () => {
    const text = document.querySelector('.diagnostics [data-key="locks"]')?.textContent ?? '';
    return text.includes('waiting') && text;
  });
  assert.equal(locks, 'held slicc-packages; waiting slicc-packages');
  assert.equal(
    await page.evaluate(() => document.querySelector('.diagnostics [data-key="six"]').textContent),
    'none'
  );
  assert.match(
    await page.evaluate(
      () => document.querySelector('.diagnostics [data-key="workers"]').textContent
    ),
    /, controller none$/
  );
  await holder.evaluate(() => window.release());
  await ready(page, undefined, { tools: false });
  assert.ok(bios.texts('packages').some((text) => waiting.test(text)));
  assert.match(bios.texts('packages').at(-1), /^\d+\/\d+ downloaded from npm/);
});

test('a BIOS that finds the installer stuck in a packages run for two minutes starts a new installer, which finishes the run, and the stuck run and the tab waiting behind it are told why they stopped', async (t) => {
  const page = await chrome.page(t);
  await boot(page, undefined, { tools: false });
  const holder = await holdPage(page);
  await holder.evaluate(() => {
    const { port } = new SharedWorker('/installer.js', 'slicc-installer');
    window.installer = { port, note: '', result: null };
    port.onmessage = ({ data }) => {
      if ('progress' in data) window.installer.note = data.progress.note ?? window.installer.note;
      else if (data.id === 2) window.installer.result = data;
    };
    port.postMessage({ id: 1, op: 'hello' });
  });
  const installer = await installerWorker(t);
  assert.equal(
    await installer(`(() => {
      const create = FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const path = (await (await navigator.storage.getDirectory()).resolve(this))?.join('/');
        if (path?.startsWith(${JSON.stringify(`${PAKO}/`)})) return new Promise(() => {});
        return create.apply(this, args);
      };
      return true;
    })()`),
    true
  );
  await holder.evaluate(async (dir) => {
    let at = await navigator.storage.getDirectory();
    for (const part of dir.split('/')) at = await at.getDirectoryHandle(part);
    await at.removeEntry('package.json');
  }, PAKO);
  await holder.evaluate(() =>
    window.installer.port.postMessage({
      id: 2,
      op: 'packages',
      args: {
        from: new URL('/packages/package-lock.json', location.href).href,
        base: 'opt/slicc/base',
      },
    })
  );
  assert.equal(
    await holder.within(
      60000,
      () =>
        window.installer.result ??
        (window.installer.note === 'downloading node_modules/pako' && 'stuck')
    ),
    'stuck'
  );

  const behind = await page.tab();
  await behind.goto('/');
  await behind.within(30000, async () => {
    const text = document.querySelector('[data-step="packages"] output')?.value ?? '';
    return /^waiting \d+ s for another install of the packages \(held by this installer's other run, \d+ s in, at node_modules\/pako\)/.test(
      text
    );
  });

  const deadline = Date.now() + 4 * 60 * 1000;
  let busy = [];
  for (;;) {
    busy = await installer('busy(0)');
    if (
      busy.some(
        (work) => work.op === 'packages' && work.phase === 'running' && work.quiet >= 120000
      )
    )
      break;
    assert.ok(Date.now() < deadline, `the run never went quiet for 120 s: ${JSON.stringify(busy)}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  await installer.detach();
  const next = await page.tab();
  const bios = await watch(next);
  await next.goto('/');
  await ready(next, undefined, { tools: false });
  const why = /its packages run made no progress for 1\d\d s at node_modules\/pako/;
  const texts = bios.texts('installer').filter((text) => !/, nothing new for \d+ s$/.test(text));
  assert.equal(texts.length, 2, JSON.stringify(texts));
  assert.match(texts[0], new RegExp(`^connection #\\d+: ${why.source}, starting a new installer$`));
  assert.match(texts[1], new RegExp(`^connection #1, replaced the installer \\(${why.source}\\)$`));

  const stopped = new RegExp(`^the installer stopped: seven's BIOS replaced it: ${why.source}$`);
  const { id, error } = await holder.until(() => window.installer.result);
  assert.equal(id, 2);
  assert.match(error, stopped);
  const left = await behind.within(30000, async () => {
    const item = document.querySelector('[data-step="packages"]');
    return item?.dataset.state === 'failed' && item.querySelector('output').value;
  });
  assert.match(left, stopped);
});
