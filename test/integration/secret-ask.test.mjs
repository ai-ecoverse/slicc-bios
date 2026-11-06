import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startFakeVault } from './fake-vault.mjs';

const chrome = await launch({ vault: false });
after(() => chrome.close());

const override = (origin) =>
  `() => { if (location.origin === ${JSON.stringify(new URL(chrome.url).origin)}) { localStorage.setItem('slicc-os.vault-origin', ${JSON.stringify(origin)}); globalThis.sliccSecretApprovals = true; } }`;

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
  globalThis.asks = new Map();
  globalThis.askLikeTheKernel = (req) => {
    serial += 1;
    const id = 900000 + serial;
    globalThis.asks.set(id, new Promise((resolve) => replies.set(id, resolve)));
    globalThis.kernelWorker.dispatchEvent(new MessageEvent('message', { data: { sealedAsk: { id, req } } }));
    return id;
  };
  globalThis.abortLikeTheKernel = (id, reason) =>
    globalThis.kernelWorker.dispatchEvent(new MessageEvent('message', { data: { sealedAbort: { id, reason } } }));
  globalThis.answerOf = (id) => globalThis.asks.get(id);
}`;

async function logged(fake, check) {
  for (let tries = 0; tries < 200 && !check(fake.log); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return check(fake.log);
}

const agent = {
  pid: 41,
  ppid: 1,
  uid: 1000,
  gid: 1000,
  user: 'cone',
  users: 'enforce',
  groups: [27],
  tag: '{"kind":"agent","agentId":"cone:cone"}',
};
const terminal = {
  pid: 52,
  ppid: 1,
  uid: 0,
  gid: 0,
  user: 'root',
  users: 'enforce',
  groups: [0],
  tag: '{"kind":"user","where":"terminal:tab-1"}',
};
const facts = (argv) => ({
  exe: '/usr/bin/sealed',
  argv,
  cwd: '/home/cone',
  tty: null,
  stdin: 'none',
});
const ask = (caller, name, fields = {}) => ({
  v: 1,
  op: 'ask',
  name,
  reveal: false,
  caller,
  requester: facts(['sealed', 'ask', name]),
  ...fields,
});

async function booted(t, fake) {
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await page.init(KERNEL_HOOK);
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  await page.until(() => !!globalThis.kernelWorker);
  await page.evaluate(() => {
    globalThis.ended = [];
    document
      .querySelector('slicc-app')
      .model.approvals.on('ended', (event) => globalThis.ended.push(event));
  });
  return page;
}

const secrets = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.approvals.list()
      .filter((item) => item.kind === 'secret')
  );

async function listed(page, count = 1) {
  await page.until(
    (count) =>
      document
        .querySelector('slicc-app')
        .model.approvals.list()
        .filter((item) => item.kind === 'secret').length === count,
    count
  );
  return secrets(page);
}

test('an agent’s ask reaches the vault with who asks and where, lists as a secret approval, and the value typed in the vault’s frame goes back only to the kernel', async (t) => {
  const fake = await startFakeVault({ secrets: [] });
  t.after(() => fake.close());
  const page = await booted(t, fake);
  const req = ask(agent, 'TIDE_TOKEN', {
    reveal: true,
    prompt: 'the tide station needs its token',
    value: 'smuggled-top-level',
    requester: {
      ...facts(['sealed', 'ask', 'TIDE_TOKEN', '--reveal']),
      kind: 'user',
      planted: 'smuggled-requester',
    },
  });
  const id = await page.evaluate((req) => globalThis.askLikeTheKernel(req), req);
  const [item] = await listed(page);
  assert.deepEqual(
    { ...item, createdAt: 0, expiresAt: 0 },
    {
      id: 'ask-1',
      kind: 'secret',
      mode: 'enter',
      name: 'TIDE_TOKEN',
      prompt: 'the tide station needs its token',
      reveal: true,
      requester: { kind: 'agent', name: 'cone', where: 'cone' },
      process: {
        exe: '/usr/bin/sealed',
        argv: ['sealed', 'ask', 'TIDE_TOKEN', '--reveal'],
        cwd: '/home/cone',
      },
      createdAt: 0,
      expiresAt: 0,
    }
  );
  assert.ok(
    await logged(fake, (log) => log.some((entry) => entry.role === 'page' && entry.op === 'ask'))
  );
  const relayed = fake.log.find((entry) => entry.role === 'page' && entry.op === 'ask');
  assert.deepEqual(relayed.requester, {
    ...facts(['sealed', 'ask', 'TIDE_TOKEN', '--reveal']),
    kind: 'agent',
    name: 'cone',
    where: 'cone',
  });
  assert.deepEqual(relayed.stamp, { uid: 1000, tag: agent.tag });
  assert.deepEqual(relayed.fields, ['name', 'op', 'prompt', 'requester', 'reveal', 'v']);

  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(
    await page.evaluate(() => document.querySelector('slicc-app').model.vault.availability()),
    'ready'
  );

  await page.evaluate((request) => {
    const frame = document.querySelector('slicc-app').model.vault.valueFrame(request);
    globalThis.heard = [];
    frame.listen((event) => globalThis.heard.push(event));
    frame.element.id = 'value-frame';
    document.body.append(frame.element);
    frame.post({ op: 'value', config: { lang: 'en' } });
  }, item.id);
  assert.ok(
    await logged(fake, (log) =>
      log.some((entry) => entry.role === 'value' && entry.op === 'value' && entry.theme)
    )
  );
  const shown = fake.log.find((entry) => entry.role === 'value' && entry.op === 'value');
  assert.equal(shown.request, item.id);
  assert.equal(shown.origin, new URL(chrome.url).origin);
  assert.deepEqual(
    await page.evaluate(() => {
      const element = document.getElementById('value-frame');
      return [element.dataset.vault, element.getAttribute('src').endsWith('/value.html')];
    }),
    ['value', true]
  );

  const value = 'tide-typed-value-6f1c2';
  fake.set({ typed: { request: item.id, value } });
  const answer = await page.evaluate((id) => globalThis.answerOf(id), id);
  assert.equal(answer.reply.v, 1);
  assert.equal(answer.reply.state, 'done');
  assert.equal(answer.reply.record, 'inert');
  assert.match(answer.reply.placeholder, /^fnox_proxy_/);
  assert.equal(answer.reply.value, value);
  await listed(page, 0);
  await page.until(() => globalThis.heard.some((event) => event.event === 'done'));
  assert.deepEqual(
    await page.evaluate(() => globalThis.heard.find((event) => event.event === 'done')),
    { type: 'slicc-vault', v: 1, event: 'done', request: item.id, state: 'sealed' }
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(await page.evaluate(() => globalThis.ended), []);

  const stored = await page.evaluate(() =>
    Object.keys(localStorage)
      .map((key) => `${key}=${localStorage.getItem(key)}`)
      .join('\n')
  );
  assert.ok(!stored.includes(value));
  assert.ok(!page.console.some((line) => line.includes(value)), page.console.join('\n'));
  assert.ok(!page.errors.some((line) => line.includes(value)));
  assert.deepEqual(page.errors, []);
});

test('Deny on a secret approval cancels it in the vault, and the same session’s next ask within 10 s is refused without reaching the vault', async (t) => {
  const fake = await startFakeVault({ secrets: ['HARBOR_API_KEY'] });
  t.after(() => fake.close());
  const page = await booted(t, fake);
  const id = await page.evaluate(
    (req) => globalThis.askLikeTheKernel(req),
    ask(terminal, 'HARBOR_API_KEY', { reveal: true })
  );
  const [item] = await listed(page);
  assert.equal(item.mode, 'reveal');
  assert.deepEqual(item.requester, { kind: 'user', name: 'root', where: 'a terminal' });
  await assert.rejects(
    page.evaluate(
      (id) => document.querySelector('slicc-app').model.approvals.decide(id, 'once'),
      item.id
    ),
    /Save or Allow in the vault's frame/
  );
  await page.evaluate(
    (id) => document.querySelector('slicc-app').model.approvals.decide(id, 'deny'),
    item.id
  );
  const answer = await page.evaluate((id) => globalThis.answerOf(id), id);
  assert.deepEqual(answer.reply, { v: 1, state: 'cancelled' });
  assert.ok(
    await logged(fake, (log) =>
      log.some((entry) => entry.op === 'cancelled' && entry.request === item.id)
    )
  );
  assert.equal(fake.log.find((entry) => entry.op === 'cancelled').reason, null);
  await listed(page, 0);
  assert.deepEqual(await page.evaluate(() => globalThis.ended), []);

  const asked = fake.log.filter((entry) => entry.role === 'page' && entry.op === 'ask').length;
  const again = await page.evaluate(
    (req) => globalThis.answerOf(globalThis.askLikeTheKernel(req)),
    ask(terminal, 'HARBOR_API_KEY', { reveal: true })
  );
  assert.deepEqual(again.reply, {
    v: 1,
    error: { code: 'EACCES', message: 'another request was just dismissed' },
  });
  assert.equal(
    fake.log.filter((entry) => entry.role === 'page' && entry.op === 'ask').length,
    asked
  );

  const known = await page.evaluate(
    (req) => globalThis.answerOf(globalThis.askLikeTheKernel(req)),
    ask({ ...terminal, tag: '{"kind":"user","where":"terminal:tab-2"}' }, 'HARBOR_API_KEY')
  );
  assert.equal(known.reply.state, 'done');
  assert.equal(known.reply.record, 'inert');
  assert.equal(known.reply.value, undefined);
  assert.deepEqual(page.errors, []);
});

test('an ask whose program goes away is withdrawn in the vault, and the approval ends as withdrawn', async (t) => {
  const fake = await startFakeVault({ secrets: [] });
  t.after(() => fake.close());
  const page = await booted(t, fake);
  const id = await page.evaluate(
    (req) => globalThis.askLikeTheKernel(req),
    ask(agent, 'REEF_TOKEN')
  );
  const [item] = await listed(page);
  await page.evaluate((request) => {
    const frame = document.querySelector('slicc-app').model.vault.valueFrame(request);
    globalThis.heard = [];
    frame.listen((event) => globalThis.heard.push(event));
    document.body.append(frame.element);
  }, item.id);
  assert.ok(
    await logged(fake, (log) => log.some((entry) => entry.role === 'value' && entry.op === 'value'))
  );
  await page.evaluate((id) => globalThis.abortLikeTheKernel(id, 'withdrawn'), id);
  assert.ok(
    await logged(fake, (log) =>
      log.some((entry) => entry.op === 'cancelled' && entry.reason === 'withdrawn')
    )
  );
  await listed(page, 0);
  await page.until(() => globalThis.ended.length === 1);
  assert.deepEqual(await page.evaluate(() => globalThis.ended), [
    { id: item.id, reason: 'withdrawn' },
  ]);
  await page.until(() => globalThis.heard.some((event) => event.event === 'gone'));

  const next = await page.evaluate(
    (req) => globalThis.askLikeTheKernel(req),
    ask(agent, 'REEF_TOKEN')
  );
  const [again] = await listed(page);
  assert.notEqual(again.id, item.id);
  await page.evaluate((id) => globalThis.abortLikeTheKernel(id, 'withdrawn'), next);
  await listed(page, 0);
  assert.deepEqual(page.errors, []);
});
