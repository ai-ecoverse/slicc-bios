import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXTENSION_FRAME, PROTECTED } from '../../src/seed/guard.js';
import { ready } from './bios.mjs';
import { CURRENT_EXTENSION, FRAME_EXTENSION, realExtension, SEVEN } from './real-extension.mjs';

const site = createHttp((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    '<!doctype html><title>login</title><form><input id="user" autocomplete="username"><input id="note"></form>'
  );
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
after(() => site.close());
const login = `http://localhost:${site.address().port}/login`;
const foreign = fileURLToPath(new URL('./fixtures/injected-frame', import.meta.url));

async function install(pageUrl) {
  globalThis.framedGuard?.close();
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const extension = globalThis.sliccExtension;
  const connection = guardProtected(
    extensionConnection(extension.cdp),
    location.origin,
    new Map(),
    { kind: 'extension', version: extension.version },
    (targetId) => extension.frames(Number(targetId))
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
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} got no answer within 60 s` } });
      }, 60000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const evaluate = async (expression, sessionId) => {
    const answer = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    return answer.error ? { error: answer.error.message } : { value: answer.result?.result?.value };
  };
  const attach = async (targetId) => {
    const answer = await send('Target.attachToTarget', { targetId, flatten: true });
    if (answer.error) return { refused: answer.error.message };
    const sessionId = answer.result.sessionId;
    const deadline = Date.now() + 30000;
    let state;
    while (Date.now() < deadline) {
      state = await evaluate('document.title + " " + document.readyState', sessionId);
      if (state.value === 'login complete') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { sessionId, state };
  };
  const created = pageUrl ? await send('Target.createTarget', { url: pageUrl }) : null;
  globalThis.framedGuard = {
    close: () => connection.close(),
    send,
    evaluate,
    attach,
    events,
  };
  return { targetId: created?.result?.targetId, created };
}

const guarded = (seven, call, ...args) =>
  seven.evaluate((name, rest) => globalThis.framedGuard[name](...rest), call, args);

async function raw(real, expression) {
  const { targetInfos } = await real.cdp.send('Target.getTargets');
  const target = targetInfos.find((info) => info.type === 'page' && info.url === login);
  assert.ok(target, `the login tab is listed over raw CDP: ${JSON.stringify(targetInfos)}`);
  const { sessionId } = await real.cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  try {
    await real.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    const { result } = await real.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    );
    return result.value;
  } finally {
    await real.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

const FRAMES = `[...document.querySelectorAll('iframe')].filter((frame) => frame.src.startsWith('chrome-extension://')).length`;

async function until(check, what) {
  const deadline = Date.now() + 30000;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last === true) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`${what} never happened; last saw ${JSON.stringify(last)}`);
}

async function opened(real) {
  await real.cdp.send('Target.createTarget', { url: login });
  await until(
    async () => (await raw(real, 'document.readyState')) === 'complete',
    'the login page loading'
  );
}

async function tabOf(seven) {
  const listed = await guarded(seven, 'send', 'Target.getTargets');
  const tab = listed.result?.targetInfos?.find((info) => info.url === login);
  assert.ok(tab, `the login tab is listed through the guard: ${JSON.stringify(listed)}`);
  return tab.targetId;
}

async function recovered(real, seven, targetId, fresh = false) {
  assert.equal(
    await raw(real, `document.getElementById("note").focus(), ${FRAMES}`),
    0,
    'focusing an ordinary field removes the foreign frame'
  );
  await until(async () => !(await framed(real)), 'the foreign frame target going away');
  if (fresh) await seven.evaluate(install);
  const back = await guarded(seven, 'attach', targetId);
  assert.equal(back.state?.value, 'login complete', JSON.stringify(back));
  const kept = await guarded(
    seven,
    'evaluate',
    'document.getElementById("user").value',
    back.sessionId
  );
  assert.equal(kept.value, 'ada', 'the form kept what was typed, so the tab was not reloaded');
}

async function framed(real) {
  const { targetInfos } = await real.cdp.send('Target.getTargets');
  return targetInfos.some(
    (info) =>
      info.type === 'iframe' &&
      info.url.endsWith('/frame.html') &&
      info.url.startsWith('chrome-extension://')
  );
}

async function autofill(real) {
  await until(async () => {
    await raw(
      real,
      'document.getElementById("note").focus(), document.getElementById("user").value = "ada", document.getElementById("user").focus()'
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    return framed(real);
  }, 'the foreign autofill frame');
}

async function booted(t, extension) {
  const real = await realExtension({ extension, extensions: [foreign] });
  t.after(() => real.close());
  const seven = await real.page(t);
  await seven.goto(SEVEN);
  await ready(seven);
  t.after(() => seven.evaluate(() => globalThis.framedGuard?.close()).catch(() => {}));
  return { real, seven };
}

for (const extension of [CURRENT_EXTENSION, FRAME_EXTENSION]) {
  test(`over the real extension ${extension.version}, a tab holding another extension's frame refuses with the extension-frame text, and comes back once the frame goes`, {
    timeout: 10 * 60 * 1000,
  }, async (t) => {
    const { real, seven } = await booted(t, extension);
    await opened(real);
    await autofill(real);
    await seven.evaluate(install);
    const targetId = await tabOf(seven);
    const refused = await guarded(seven, 'attach', targetId);
    assert.equal(refused.refused, EXTENSION_FRAME, JSON.stringify(refused));
    const again = await guarded(seven, 'attach', targetId);
    assert.equal(again.refused, EXTENSION_FRAME, JSON.stringify(again));
    await recovered(real, seven, targetId);
  });

  test(`over the real extension ${extension.version}, a frame another extension adds after the attach, on focus, refuses the tab while it is there and leaves it usable for the next connection once it goes`, {
    timeout: 10 * 60 * 1000,
  }, async (t) => {
    const { real, seven } = await booted(t, extension);
    await opened(real);
    await seven.evaluate(install);
    const targetId = await tabOf(seven);
    const first = await guarded(seven, 'attach', targetId);
    assert.equal(first.state?.value, 'login complete', JSON.stringify(first));
    await autofill(real);
    const old = await guarded(seven, 'evaluate', 'document.title', first.sessionId);
    assert.match(old.error ?? '', /^slicc: refused: /, JSON.stringify(old));
    const during = await guarded(seven, 'attach', targetId);
    assert.ok(
      [PROTECTED, EXTENSION_FRAME].includes(during.refused ?? during.state?.error),
      JSON.stringify(during)
    );
    await recovered(real, seven, targetId, true);
  });
}
