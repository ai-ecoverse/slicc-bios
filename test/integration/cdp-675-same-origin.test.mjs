import assert from 'node:assert/strict';
import test from 'node:test';
import { sameOriginChildMarkup, sameOriginTools } from './cdp-675-same-origin.mjs';

const tools = [
  { name: 'add', frameId: 'ROOT', origin: 'http://localhost:1234' },
  { name: 'child_add', frameId: 'CHILD', origin: 'http://localhost:1234' },
];

test('initial same-origin child fixture awaits one fetch before registration, without retrying', () => {
  assert.match(sameOriginChildMarkup, /<script type="module">/);
  assert.match(sameOriginChildMarkup, /name: "child_add"/);
  assert.match(sameOriginChildMarkup, /a\+b\+10/);
  assert.match(
    sameOriginChildMarkup,
    /await fetch\("\/same-child-ready"\); if \(document\.modelContext\)/
  );
  assert.equal((sameOriginChildMarkup.match(/fetch\(/g) ?? []).length, 1);
  assert.equal((sameOriginChildMarkup.match(/registerTool\(/g) ?? []).length, 1);
  assert.doesNotMatch(sameOriginChildMarkup, /setTimeout|setInterval/);
});

test('same-origin list requires both tools with distinct native frames', () => {
  assert.deepEqual(sameOriginTools(tools), { root: tools[0], child: tools[1] });
  assert.throws(() => sameOriginTools(tools.slice(0, 1)), /both list/);
  assert.throws(
    () => sameOriginTools([tools[0], { ...tools[1], frameId: 'ROOT' }]),
    /distinct native frames/
  );
  assert.throws(
    () => sameOriginTools([tools[0], { ...tools[1], origin: 'http://foreign:1234' }]),
    /same-origin/
  );
});
