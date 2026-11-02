import assert from 'node:assert/strict';
import test from 'node:test';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const origin = 'https://ordinary.invalid';

test('concrete protected owner evidence still stops root placement retry immediately', async (t) => {
  const p = protocol(t, guardProtected);
  const root = p.target('root', 'page', plainFrame('root'));
  const session = await p.attach('root');
  await p.send('Runtime.enable', {}, session);
  root.dom = {
    nodeId: 1,
    nodeName: '#document',
    documentURL: root.tree.frame.url,
    children: [
      {
        nodeId: 2,
        nodeName: 'IFRAME',
        frameId: 'PROTECTED',
        attributes: ['src', 'https://protected.invalid/frame'],
        contentDocument: { nodeId: 3, nodeName: '#document', documentURL: 'about:blank' },
      },
    ],
  };
  root.tree.frame.loaderId = 'NEXT';
  p.emit({ method: 'Page.frameNavigated', sessionId: session, params: { frame: root.tree.frame } });
  p.emit({
    method: 'Page.frameAttached',
    sessionId: session,
    params: { frameId: 'PROTECTED', parentFrameId: 'root' },
  });
  await flush();
  let attempts = 0;
  p.hold((message) => {
    if (
      message.id < 2 ** 30 ||
      message.method !== 'Runtime.evaluate' ||
      message.params.uniqueContextId !== 'PROTECTED-ROOT-PROBE'
    )
      return false;
    attempts += 1;
    queueMicrotask(() =>
      p.release(message, {
        error: { code: -32000, message: "slicc: refused: target is on seven's origin" },
      })
    );
    return true;
  });
  p.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id: 9,
        uniqueId: 'PROTECTED-ROOT-PROBE',
        name: '',
        origin,
        auxData: { frameId: 'root', isDefault: true, type: 'default' },
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(attempts, 1);
  assert.match(
    (
      await p.send(
        'Runtime.evaluate',
        { expression: '1', uniqueContextId: 'PROTECTED-ROOT-PROBE' },
        session
      )
    ).error?.message ?? '',
    /slicc: refused:/
  );
  assert.equal(p.clients().filter(({ method }) => method === 'Runtime.evaluate').length, 0);
});

test('the same root unique selector is re-proved after a provisional same-process child becomes ordinary', async (t) => {
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), { kind: 'extension', version: '7.11.99' }, async () => null)
  );
  const root = p.target('17', 'page', { ...plainFrame('ROOT'), loaderId: 'OLD' });
  const session = await p.attach('17');
  await p.send('Runtime.enable', {}, session);
  root.tree.frame.loaderId = 'NEW';
  root.tree.childFrames = [
    { frame: { id: 'CHILD', parentId: 'ROOT', loaderId: '', url: '', securityOrigin: 'null' } },
  ];
  root.dom = {
    nodeId: 1,
    nodeName: '#document',
    documentURL: root.tree.frame.url,
    children: [
      {
        nodeId: 2,
        nodeName: 'IFRAME',
        frameId: 'CHILD',
        attributes: ['src', '/same-child'],
        contentDocument: {
          nodeId: 3,
          nodeName: '#document',
          documentURL: 'about:blank',
          children: [],
        },
      },
    ],
  };
  p.emit({ method: 'Page.frameNavigated', sessionId: session, params: { frame: root.tree.frame } });
  p.emit({
    method: 'Page.frameAttached',
    sessionId: session,
    params: { frameId: 'CHILD', parentFrameId: 'ROOT' },
  });
  await flush();
  let placed = false;
  const attempts = [];
  let refused;
  const refusal = new Promise((resolve) => {
    refused = resolve;
  });
  p.hold((message) => {
    if (
      message.id < 2 ** 30 ||
      message.method !== 'Runtime.evaluate' ||
      message.params.uniqueContextId !== 'SAME-ROOT-UNIQUE'
    )
      return false;
    attempts.push({ at: Date.now(), selector: message.params.uniqueContextId, placed });
    if (placed) return false;
    queueMicrotask(() => {
      p.release(message, {
        error: { code: -32000, message: "slicc: refused: target is on seven's origin" },
      });
      refused();
    });
    return true;
  });
  p.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id: 4,
        uniqueId: 'SAME-ROOT-UNIQUE',
        name: '',
        origin,
        auxData: { frameId: 'ROOT', isDefault: true, type: 'default' },
      },
    },
  });
  await refusal;
  root.tree.childFrames[0].frame = {
    ...plainFrame('CHILD', 'ROOT'),
    loaderId: 'CHILD-NEW',
    url: `${origin}/same-child`,
  };
  root.dom.children[0].contentDocument.documentURL = `${origin}/same-child`;
  placed = true;
  p.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame: root.tree.childFrames[0].frame },
  });
  p.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id: 5,
        uniqueId: 'CHILD-UNIQUE',
        name: '',
        origin,
        auxData: { frameId: 'CHILD', isDefault: true, type: 'default' },
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const runtime = await p.send('Runtime.enable', {}, session);
  assert.equal(runtime.error, undefined);
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1].placed);
  assert.ok(attempts[1].at - attempts[0].at >= 90 && attempts[1].at - attempts[0].at < 1000);
  assert.deepEqual(
    attempts.map(({ selector }) => selector),
    ['SAME-ROOT-UNIQUE', 'SAME-ROOT-UNIQUE']
  );
});
