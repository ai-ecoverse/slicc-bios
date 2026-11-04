import assert from 'node:assert/strict';
import test from 'node:test';
import { domMemory } from './guard-private-dom-memory.mjs';

for (const route of ['extension', 'link']) {
  test(`bios ${route} private placement leaves an existing client frontend node usable`, async (t) => {
    const memory = domMemory(t, route);
    const client = memory.open();
    const attached = await client.attach();
    assert.equal(attached.error, undefined);
    const session = attached.result.sessionId;
    const document = await client.send('DOM.getDocument', { depth: 1, pierce: false }, session);
    assert.equal(document.error, undefined);
    const before = memory.calls.length;
    const other = memory.open();
    assert.equal((await other.attach()).error, undefined);
    const listed = await client.send(
      'DOM.querySelectorAll',
      { nodeId: document.result.root.nodeId, selector: 'iframe,frame' },
      session
    );
    assert.equal(listed.error, undefined);
    assert.deepEqual(listed.result.nodeIds, []);
    const privateCalls = memory.calls.slice(before).filter(({ id }) => id >= 2 ** 30);
    if (route === 'extension') {
      assert.ok(privateCalls.some(({ method }) => method === 'DOMSnapshot.captureSnapshot'));
      assert.equal(
        privateCalls.some(({ method }) => ['DOM.getDocument', 'DOM.disable'].includes(method)),
        false
      );
    } else {
      assert.ok(privateCalls.some(({ method }) => method === 'DOM.getDocument'));
      assert.ok(
        privateCalls
          .filter(({ method }) => method.startsWith('DOM.'))
          .every(({ sessionId }) => sessionId !== session)
      );
    }
  });
}

for (const failure of ["'DOMSnapshot.captureSnapshot' wasn't found", 'snapshot failed']) {
  test(`bios refuses missing or erroring independent backend evidence rather than admitting Debugger: ${failure}`, async (t) => {
    const memory = domMemory(t);
    memory.fail(failure);
    const client = memory.open();
    const attached = await client.attach();
    assert.equal(attached.error, undefined);
    const enabled = await client.send('Debugger.enable', {}, attached.result.sessionId);
    assert.ok(enabled.error);
    assert.match(enabled.error.message, /refused/);
    assert.equal(
      memory.calls.some(({ id, method }) => id < 2 ** 30 && method === 'Debugger.enable'),
      false
    );
    assert.equal(
      client.delivered.some(({ method }) => method?.startsWith('Debugger.')),
      false
    );
  });
}
