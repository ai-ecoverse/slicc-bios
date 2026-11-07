import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startFakeVault } from './fake-vault.mjs';

const chrome = await launch({ vault: false });
after(() => chrome.close());

const override = (origin, framed) =>
  `() => { if (location.origin === ${JSON.stringify(new URL(chrome.url).origin)}) { localStorage.setItem('slicc-os.vault-origin', ${JSON.stringify(origin)}); globalThis.sliccValueEntry = ${framed}; } }`;

const KERNEL_HOOK = `() => {
  const Native = globalThis.Worker;
  const replies = new Map();
  let serial = 0;
  globalThis.Worker = class extends Native {
    constructor(url, options) {
      super(url, options);
      if (options?.name !== 'slicc-kernel') return;
      globalThis.kernelWorker = this;
      const post = this.postMessage.bind(this);
      this.postMessage = (message, transfer) => {
        const answer = message?.sealedReply;
        if (answer && replies.has(answer.id)) {
          replies.get(answer.id)(answer);
          replies.delete(answer.id);
          return;
        }
        return post(message, transfer);
      };
    }
  };
  globalThis.sealedLikeTheKernel = (req) => {
    serial += 1;
    const id = 800000 + serial;
    const answer = new Promise((resolve) => replies.set(id, resolve));
    globalThis.kernelWorker.dispatchEvent(new MessageEvent('message', { data: { sealedAsk: { id, req } } }));
    return answer;
  };
}`;

const caller = {
  pid: 52,
  ppid: 1,
  uid: 0,
  gid: 0,
  user: 'root',
  users: 'enforce',
  groups: [0],
  tag: '{"kind":"user","where":"terminal:tab-1"}',
};

async function logged(fake, check) {
  for (let tries = 0; tries < 200 && !check(fake.log); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return check(fake.log);
}

async function booted(t, fake, framed) {
  const page = await chrome.page(t);
  await page.init(override(fake.origin, framed));
  await page.init(KERNEL_HOOK);
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  await page.until(() => !!globalThis.kernelWorker);
  return page;
}

test('vault.enter opens a page-started request, its value frame seals the value, and put and value requests no longer carry a value', async (t) => {
  const fake = await startFakeVault({ secrets: ['TIDE_OLD'] });
  t.after(() => fake.close());
  const page = await booted(t, fake, true);

  const { request } = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.vault.enter({ name: 'TIDE_NEW', kind: 'secret', value: 'not-sent-value-77' })
  );
  assert.match(request, /^enter-/);
  assert.ok(await logged(fake, (log) => log.some((entry) => entry.op === 'enter-fields')));
  const fields = fake.log.find((entry) => entry.op === 'enter-fields');
  assert.deepEqual(fields.fields, ['kind', 'name']);
  const refused = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.vault.enter({ name: 'TIDE_OLD' })
      .then(
        () => null,
        (error) => error.code
      )
  );
  assert.equal(refused, 'EEXIST');

  await page.evaluate((request) => {
    const frame = document.querySelector('slicc-app').model.vault.valueFrame(request);
    globalThis.heard = [];
    frame.listen((event) => globalThis.heard.push(event));
    frame.element.id = 'value-frame';
    document.body.append(frame.element);
  }, request);
  assert.ok(
    await logged(fake, (log) =>
      log.some(
        (entry) => entry.role === 'value' && entry.op === 'value' && entry.request === request
      )
    )
  );
  const value = 'tide-entered-value-3c9d';
  fake.set({ typed: { request, value } });
  await page.until(() => globalThis.heard.some((event) => event.event === 'done'));
  const done = await page.evaluate(() => globalThis.heard.find((event) => event.event === 'done'));
  assert.deepEqual(Object.keys(done).sort(), [
    'event',
    'name',
    'placeholder',
    'record',
    'request',
    'state',
    'type',
    'v',
  ]);
  assert.deepEqual(
    [done.request, done.state, done.name, done.record],
    [request, 'sealed', 'TIDE_NEW', 'inert']
  );
  assert.match(done.placeholder, /^fnox_proxy_/);
  await page.until(
    (placeholder) =>
      document
        .querySelector('slicc-app')
        .model.vault.list()
        ?.secrets.some((secret) => secret.placeholder === placeholder),
    done.placeholder
  );

  const second = await page.evaluate(() =>
    document.querySelector('slicc-app').model.vault.enter({ name: 'TIDE_OLD', replace: true })
  );
  assert.equal(
    await page.evaluate(
      (id) => document.querySelector('slicc-app').model.vault.cancel(id),
      second.request
    ),
    'cancelled'
  );

  const put = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.vault.put('TIDE_PUT', 'put-value-not-sent-41')
      .then(
        () => null,
        (error) => [error.code, error.message]
      )
  );
  assert.deepEqual(put, ['EACCES', "values are typed in the vault's frame"]);
  assert.ok(!fake.log.some((entry) => entry.op === 'put'));

  const old = await page.evaluate(
    (caller) =>
      globalThis.sealedLikeTheKernel({
        v: 1,
        op: 'request',
        kind: 'value',
        name: 'TIDE_ASK',
        caller,
      }),
    caller
  );
  assert.deepEqual(old.reply, {
    v: 1,
    error: { code: 'EINVAL', message: 'ask with op ask instead' },
  });
  assert.ok(!fake.log.some((entry) => entry.sealed === 'request'));
  const text = JSON.stringify([page.console, fake.log]);
  for (const secret of [value, 'not-sent-value-77', 'put-value-not-sent-41'])
    assert.ok(!text.includes(secret), secret);
  assert.deepEqual(page.errors, []);
});

test('with a UI that still types values itself, put keeps its value and value requests reach the vault', async (t) => {
  const fake = await startFakeVault({ secrets: [] });
  t.after(() => fake.close());
  const page = await booted(t, fake, false);
  const put = await page.evaluate(() =>
    document.querySelector('slicc-app').model.vault.put('TIDE_PUT', 'put-value-kept-52')
  );
  assert.match(put.placeholder, /^fnox_proxy_/);
  const old = await page.evaluate(
    (caller) =>
      globalThis.sealedLikeTheKernel({
        v: 1,
        op: 'request',
        kind: 'value',
        name: 'TIDE_ASK',
        caller,
      }),
    caller
  );
  assert.equal(old.reply.state, 'pending');
  assert.deepEqual(page.errors, []);
});
