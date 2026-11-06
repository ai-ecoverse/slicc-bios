import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { CURRENT_EXTENSION, realExtension, SEVEN } from './real-extension.mjs';

const site = createHttp((req, res) => {
  const url = new URL(req.url, 'http://ordinary.test');
  res.writeHead(200, { 'content-type': 'text/html' });
  if (url.pathname === '/stage1.html') {
    return res.end(
      '<!doctype html><title>stage1</title><h1>Stage 1 ordinary</h1><script>document.documentElement.setAttribute("data-stage1","armed")</script>'
    );
  }
  res.end('<!doctype html><title>missing</title>');
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const port = site.address().port;
after(() => site.close());
const ordinary = (path) => `http://ordinary.test:${port}${path}`;

const printFact = (line) => {
  if (typeof line === 'string' && line.includes('FACT ')) process.stdout.write(`${line}\n`);
};

const answerFact = (label, answer) => {
  const payload = {
    error: answer?.error?.message ?? null,
    resultKeys: answer?.result ? Object.keys(answer.result) : null,
    id: answer?.id ?? null,
  };
  process.stdout.write(`FACT ${label} ${JSON.stringify(payload)}\n`);
  return payload;
};

async function openGuarded(seven, privateFrames) {
  await seven.evaluate(async (useFrames) => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const extension = globalThis.sliccExtension;
    const connection = guardProtected(
      extensionConnection(extension.cdp),
      location.origin,
      new Map(),
      { kind: 'extension', version: extension.version },
      useFrames ? (targetId) => extension.frames(Number(targetId)) : undefined
    );
    const pending = new Map();
    let next = 0;
    connection.onmessage = (text) => {
      const message = JSON.parse(text);
      if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    };
    globalThis.stage1Facts = {
      close: () => connection.close(),
      send: (method, params = {}, sessionId) =>
        new Promise((resolve) => {
          const id = ++next;
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ error: { message: `${method} got no answer` } });
          }, 60000);
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          connection.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
          );
        }),
    };
  }, privateFrames);
}

test(`FACT real-extension ${CURRENT_EXTENSION.version} ordinary page with privateFrames`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const real = await realExtension({
    extension: CURRENT_EXTENSION,
    rules: ['MAP ordinary.test 127.0.0.1'],
  });
  t.after(() => real.close());
  const seven = await real.page(t);
  await seven.goto(SEVEN);
  await ready(seven);
  assert.equal(
    await seven.evaluate(() => globalThis.sliccExtension.version),
    CURRENT_EXTENSION.version
  );
  assert.equal(await seven.evaluate(() => typeof globalThis.sliccExtension.frames), 'function');
  await openGuarded(seven, true);
  t.after(() => seven.evaluate(() => globalThis.stage1Facts?.close()));
  const target = ordinary('/stage1.html');
  const row = await seven.evaluate(async (url) => {
    const client = globalThis.stage1Facts;
    const created = await client.send('Target.createTarget', { url });
    if (created.error || !created.result?.targetId) return { step: 'create', created };
    const targetId = created.result.targetId;
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
    if (attached.error || !attached.result?.sessionId) return { step: 'attach', attached };
    const session = attached.result.sessionId;
    const page = await client.send('Page.enable', {}, session);
    const runtime = await client.send('Runtime.enable', {}, session);
    const want = new URL(url).pathname;
    const deadline = Date.now() + 60000;
    let ready;
    while (Date.now() < deadline) {
      const tree = await client.send('Page.getFrameTree', {}, session);
      const frame = tree.result?.frameTree?.frame;
      if (!tree.error && typeof frame?.url === 'string' && frame.url.includes(want)) {
        const state = await client.send(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          session
        );
        if (!state.error && state.result?.result?.value === 'complete') {
          ready = { tree, state, url: frame.url, frameId: frame.id };
          break;
        }
        ready = { tree, state, url: frame.url, frameId: frame.id };
      } else {
        ready = { tree };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready?.state || ready.state.error || ready.state.result?.result?.value !== 'complete')
      return { step: 'commit', ready, targetId, session };
    const document = await client.send('DOM.getDocument', { depth: -1, pierce: true }, session);
    const targets = await client.send('Target.getTargets');
    const info = await client.send('Target.getTargetInfo', { targetId });
    const enable = await client.send('Debugger.enable', {}, session);
    return {
      step: 'probed',
      targetId,
      session,
      url: ready.url,
      frameId: ready.frameId,
      page,
      runtime,
      tree: ready.tree,
      state: ready.state,
      document,
      targets,
      info,
      enable,
    };
  }, target);
  for (const line of seven.console ?? []) printFact(line);
  process.stdout.write(
    `FACT row ${JSON.stringify({ step: row.step, url: row.url, frameId: row.frameId, targetId: row.targetId, session: row.session })}\n`
  );
  answerFact('Page.enable', row.page);
  answerFact('Runtime.enable', row.runtime);
  answerFact('Page.getFrameTree', row.tree);
  answerFact('Runtime.evaluate', row.state);
  answerFact('DOM.getDocument', row.document);
  answerFact('Target.getTargets', row.targets);
  answerFact('Target.getTargetInfo', row.info);
  answerFact('Debugger.enable', row.enable);
  const facts = (seven.console ?? []).filter((line) => line.includes('FACT refuseBranch'));
  process.stdout.write(
    `FACT refuseBranchCount ${JSON.stringify({ count: facts.length, lines: facts })}\n`
  );
  assert.equal(row.step, 'probed', JSON.stringify(row));
  assert.match(row.url ?? '', /^http:\/\/ordinary\.test:/, JSON.stringify(row));
});

test(`FACT real-extension ${CURRENT_EXTENSION.version} ordinary page without privateFrames`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const real = await realExtension({
    extension: CURRENT_EXTENSION,
    rules: ['MAP ordinary.test 127.0.0.1'],
  });
  t.after(() => real.close());
  const seven = await real.page(t);
  await seven.goto(SEVEN);
  await ready(seven);
  await openGuarded(seven, false);
  t.after(() => seven.evaluate(() => globalThis.stage1Facts?.close()));
  const target = ordinary('/stage1.html');
  const row = await seven.evaluate(async (url) => {
    const client = globalThis.stage1Facts;
    const created = await client.send('Target.createTarget', { url });
    if (created.error || !created.result?.targetId) return { step: 'create', created };
    const targetId = created.result.targetId;
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
    if (attached.error || !attached.result?.sessionId) return { step: 'attach', attached };
    const session = attached.result.sessionId;
    const page = await client.send('Page.enable', {}, session);
    const runtime = await client.send('Runtime.enable', {}, session);
    const want = new URL(url).pathname;
    const deadline = Date.now() + 60000;
    let ready;
    while (Date.now() < deadline) {
      const tree = await client.send('Page.getFrameTree', {}, session);
      const frame = tree.result?.frameTree?.frame;
      if (!tree.error && typeof frame?.url === 'string' && frame.url.includes(want)) {
        ready = { tree, url: frame.url, frameId: frame.id };
        break;
      }
      ready = { tree };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready?.url?.includes(want)) return { step: 'commit', ready, targetId, session };
    const document = await client.send('DOM.getDocument', { depth: -1, pierce: true }, session);
    const targets = await client.send('Target.getTargets');
    const info = await client.send('Target.getTargetInfo', { targetId });
    const enable = await client.send('Debugger.enable', {}, session);
    return {
      step: 'probed',
      targetId,
      session,
      url: ready.url,
      frameId: ready.frameId,
      page,
      runtime,
      tree: ready.tree,
      document,
      targets,
      info,
      enable,
    };
  }, target);
  for (const line of seven.console ?? []) printFact(line);
  process.stdout.write(
    `FACT row-no-frames ${JSON.stringify({ step: row.step, url: row.url, targetId: row.targetId, session: row.session })}\n`
  );
  answerFact('noFrames.Page.enable', row.page);
  answerFact('noFrames.Runtime.enable', row.runtime);
  answerFact('noFrames.Page.getFrameTree', row.tree);
  answerFact('noFrames.DOM.getDocument', row.document);
  answerFact('noFrames.Target.getTargets', row.targets);
  answerFact('noFrames.Target.getTargetInfo', row.info);
  answerFact('noFrames.Debugger.enable', row.enable);
  const facts = (seven.console ?? []).filter((line) => line.includes('FACT refuseBranch'));
  process.stdout.write(
    `FACT noFrames.refuseBranchCount ${JSON.stringify({ count: facts.length, lines: facts })}\n`
  );
  assert.equal(row.step, 'probed', JSON.stringify(row));
  assert.match(row.url ?? '', /^http:\/\/ordinary\.test:/, JSON.stringify(row));
});
