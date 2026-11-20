import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { guardHost, targets } from './guard-set.mjs';

const REFUSED = /^slicc: refused:/;
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const outcome = async (promise) => {
  try {
    return { ok: true, result: await promise };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
};
const verdict = (answer) =>
  answer.ok ? 'answered' : REFUSED.test(answer.error) ? 'refused' : `error: ${answer.error}`;

async function until(check, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value || Date.now() >= end) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function measure(client, session) {
  return {
    dom: verdict(await outcome(client.send('DOM.getDocument', { depth: 1 }, session))),
    shot: verdict(await outcome(client.send('Page.captureScreenshot', { format: 'png' }, session))),
    input: verdict(
      await outcome(
        client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 }, session)
      )
    ),
    runtime: verdict(
      await outcome(
        client.send(
          'Runtime.evaluate',
          { expression: 'document.title', returnByValue: true },
          session
        )
      )
    ),
  };
}

test('the documented limit: on the extension route an ordinary page with an error iframe stays locked for DOM, paint and input while the error frame exists, Runtime reads still work, and it is drivable once the frame is gone', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const clientFactory = await guardHost(t, 'extension');
  const { client, unguarded, close } = await clientFactory('extension')({});
  t.after(() => close());
  const tag = `error-frame-${Date.now()}`;
  const FAILED = `${new URL(targets.ordinary).protocol}//${new URL(targets.ordinary).hostname}:${await closedPort()}/`;
  const url = `${targets.ordinary}/framed?tag=${tag}&url=${encodeURIComponent(FAILED)}&log=${encodeURIComponent(targets.log)}`;
  const { targetId } = await unguarded.send('Target.createTarget', { url });
  t.after(() => outcome(unguarded.send('Target.closeTarget', { targetId })));
  const { sessionId: raw } = await unguarded.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const walk = (node) => [node.frame, ...(node.childFrames ?? []).flatMap(walk)];
  const errorFrame = async () => {
    const { frameTree } = await unguarded.send('Page.getFrameTree', {}, raw);
    const local = walk(frameTree)
      .slice(1)
      .some((frame) => frame.unreachableUrl || frame.url.startsWith('chrome-error:'));
    const { targetInfos } = await unguarded.send('Target.getTargets');
    const remote = targetInfos.some(
      (info) =>
        info.type === 'iframe' &&
        info.parentId === targetId &&
        (info.url.startsWith('chrome-error:') || info.url === FAILED)
    );
    return local || remote;
  };
  assert.ok(await until(errorFrame, 15000), 'the iframe failed to load without the guard');
  const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
  const session = attached.sessionId;
  await outcome(client.send('Page.enable', {}, session));
  const present = await measure(client, session);
  await unguarded.send(
    'Runtime.evaluate',
    { expression: "document.querySelectorAll('iframe').forEach((frame) => frame.remove())" },
    raw
  );
  await until(async () => !(await errorFrame()), 10000);
  const gone = await until(async () => {
    const row = await measure(client, session);
    return row.dom === 'answered' ? row : null;
  }, 10000);
  process.stdout.write(
    `GUARD-ERROR-FRAME extension ${JSON.stringify({ present, gone: gone ?? (await measure(client, session)) })}\n`
  );
  assert.equal(present.dom, 'refused', 'DOM reads are refused while the error frame exists');
  assert.equal(present.shot, 'refused', 'screenshots are refused while the error frame exists');
  assert.equal(present.input, 'refused', 'input is refused while the error frame exists');
  assert.equal(present.runtime, 'answered', 'Runtime reads still work');
  assert.ok(gone, 'the page answers DOM reads once the error frame is gone');
  assert.equal(gone.shot, 'answered', 'screenshots work once the error frame is gone');
  assert.equal(gone.input, 'answered', 'input works once the error frame is gone');
});
