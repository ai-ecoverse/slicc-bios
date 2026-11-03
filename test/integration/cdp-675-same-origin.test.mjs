import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sameOriginChildCall,
  sameOriginChildMarkup,
  sameOriginTools,
} from './cdp-675-same-origin.mjs';

const tools = [{ name: 'add' }, { name: 'child_add' }];
const frames = [
  {
    id: 'ROOT',
    loaderId: 'ROOT-DOC',
    securityOrigin: 'http://localhost:1234',
    url: 'http://localhost:1234/page',
  },
  {
    id: 'CHILD',
    parentId: 'ROOT',
    loaderId: 'CHILD-DOC',
    securityOrigin: 'http://localhost:1234',
    url: 'http://localhost:1234/same-child',
  },
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

test('link same-origin list requires both tools and actual distinct same-origin native frames', () => {
  assert.deepEqual(sameOriginTools(tools, 'link', frames), { root: tools[0], child: tools[1] });
  assert.throws(() => sameOriginTools(tools.slice(0, 1), 'link', frames), /both list/);
  assert.throws(
    () => sameOriginTools(tools, 'link', [frames[0], { ...frames[1], id: 'ROOT' }]),
    /distinct native frames/
  );
  assert.throws(
    () =>
      sameOriginTools(tools, 'link', [
        frames[0],
        { ...frames[1], securityOrigin: 'http://foreign:1234' },
      ]),
    /same-origin/
  );
});

test('same-origin child frame tools do not work on the extension route yet (#694); root stays required', () => {
  assert.deepEqual(sameOriginTools(tools, 'extension', frames), {
    root: tools[0],
    child: tools[1],
  });
  assert.throws(() => sameOriginTools([], 'extension', frames), /root tools must list/);
  assert.deepEqual(sameOriginTools(tools.slice(0, 1), 'extension', frames), {
    root: tools[0],
    child: undefined,
  });
  assert.throws(
    () => sameOriginTools([{ ...tools[0], error: 'broken' }], 'extension', frames),
    /must not contain an error/
  );
});

test('an absent extension child reports the declared limit without making a child call', async () => {
  let calls = 0;
  const result = await sameOriginChildCall(
    sameOriginTools(tools.slice(0, 1), 'extension', frames),
    () => {
      calls += 1;
    }
  );
  assert.equal(calls, 0);
  assert.equal(
    result.limit,
    'same-origin child frame tools do not work on the extension route yet (#694)'
  );
});

test('every listed child on either route must call and return fifteen', async () => {
  for (const route of ['extension', 'link']) {
    const selection = sameOriginTools(tools, route, frames);
    const calls = [];
    const result = await sameOriginChildCall(selection, async (name) => {
      calls.push(name);
      return { stdout: '15\n' };
    });
    assert.deepEqual(calls, ['child_add']);
    assert.match(result.stdout, /^15$/m);
    await assert.rejects(
      sameOriginChildCall(selection, async () => ({ stdout: '5\n' })),
      /15/
    );
  }
});
