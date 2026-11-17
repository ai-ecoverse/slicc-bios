import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { after, test } from 'node:test';
import { EXTENSION_FRAME, PROTECTED } from '../../src/seed/guard.js';
import { ready } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const CHROME_REFUSAL = 'Cannot access a chrome-extension:// URL of different extension';

const site = createHttp((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    '<!doctype html><title>login</title><form><input id="user" autocomplete="username"><input id="note"></form>'
  );
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const port = site.address().port;
after(() => site.close());

const chrome = await launch({
  tools: false,
  args: ['--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1, MAP ordinary.test 127.0.0.1'],
});
const { port: debugging } = await devtools(chrome);
after(() => chrome.close());
const fakeExtension = extensionOver(await debuggerUrl(debugging));

async function install() {
  globalThis.framedGuard?.close();
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const connection = guardProtected(
    extensionConnection(globalThis.sliccExtension.cdp),
    self.origin,
    new Map(),
    { kind: 'extension', version: globalThis.sliccExtension.version }
  );
  const pending = new Map();
  const events = [];
  let next = 0;
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.id === undefined) return void events.push(message);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      next += 1;
      const id = next;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} got no answer within 30 s` } });
      }, 30000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const attach = async (targetId) => {
    const answer = await send('Target.attachToTarget', { targetId, flatten: true });
    if (answer.error) return { refused: answer.error.message };
    const read = await send(
      'Runtime.evaluate',
      { expression: 'document.title', returnByValue: true },
      answer.result.sessionId
    );
    return {
      sessionId: answer.result.sessionId,
      title: read.result?.result?.value ?? read.error?.message,
    };
  };
  globalThis.framedGuard = { close: () => connection.close(), send, attach, events };
}

const inPage = (page, targetId) =>
  page.evaluate((targetId) => globalThis.framedGuard.attach(targetId), targetId);

async function rawTarget(url) {
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url });
  const deadline = Date.now() + 15000;
  for (;;) {
    const { targetInfo } = await chrome.cdp.send('Target.getTargetInfo', { targetId });
    if (targetInfo.url.startsWith(url.split('#')[0])) return targetId;
    if (Date.now() > deadline) throw new Error(`${url} never committed: ${targetInfo.url}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function sevenTarget(page) {
  const href = await page.evaluate(() => location.href);
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const found = targetInfos.find((info) => info.type === 'page' && info.url === href);
  assert.ok(found, `seven's own page ${href} is listed`);
  return found.targetId;
}

async function setup(t) {
  const framed = new Set();
  const page = await chrome.page(t);
  const extension = await fakeExtension(page, {
    refuse: (command) =>
      command.method === 'Target.attachToTarget' && framed.has(command.params?.targetId)
        ? CHROME_REFUSAL
        : undefined,
  });
  t.after(() => extension.close());
  await page.goto('/');
  await ready(page);
  await page.evaluate(install);
  t.after(() => page.evaluate(() => globalThis.framedGuard?.close()).catch(() => {}));
  const login = await rawTarget(`http://ordinary.test:${port}/login`);
  const vault = await rawTarget(`http://vault.sliccy.ai:${port}/`);
  t.after(async () => {
    for (const targetId of [login, vault])
      await chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  });
  return { page, extension, framed, login, vault, seven: await sevenTarget(page) };
}

async function stillRefused({ page, seven, vault }, when) {
  for (const [name, targetId] of [
    ['seven', seven],
    ['vault', vault],
  ]) {
    const answer = await inPage(page, targetId);
    assert.equal(answer.refused, PROTECTED, `${name} ${when}: ${JSON.stringify(answer)}`);
  }
}

test('over the extension a foreign frame refuses the attach with its own text, and the tab comes back once it goes', {
  timeout: 3 * 60 * 1000,
}, async (t) => {
  const state = await setup(t);
  const { page, framed, login } = state;
  framed.add(login);
  framed.add(state.seven);
  framed.add(state.vault);
  const refused = await inPage(page, login);
  assert.equal(refused.refused, EXTENSION_FRAME, JSON.stringify(refused));
  await stillRefused(state, 'while the frame is there');
  const again = await inPage(page, login);
  assert.equal(again.refused, EXTENSION_FRAME, JSON.stringify(again));
  framed.clear();
  const back = await inPage(page, login);
  assert.equal(back.title, 'login', JSON.stringify(back));
  await stillRefused(state, 'after the frame went');
});

test('over the extension a session Chrome detached for a foreign frame surfaces the refusal, then the tab comes back', {
  timeout: 3 * 60 * 1000,
}, async (t) => {
  const state = await setup(t);
  const { page, framed, login, extension } = state;
  const first = await inPage(page, login);
  assert.equal(first.title, 'login', JSON.stringify(first));
  framed.add(login);
  extension.detach(login);
  const deadline = Date.now() + 15000;
  while (
    !(await page.evaluate(
      (sessionId) =>
        globalThis.framedGuard.events.some(
          (event) =>
            event.method === 'Target.detachedFromTarget' && event.params?.sessionId === sessionId
        ),
      first.sessionId
    ))
  ) {
    assert.ok(Date.now() < deadline, 'the client heard its session detach');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const refused = await inPage(page, login);
  assert.equal(refused.refused, EXTENSION_FRAME, JSON.stringify(refused));
  await stillRefused(state, 'while the frame is there');
  framed.clear();
  const back = await inPage(page, login);
  assert.equal(back.title, 'login', JSON.stringify(back));
  await stillRefused(state, 'after the frame went');
});
