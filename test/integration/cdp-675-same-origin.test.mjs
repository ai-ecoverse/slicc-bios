import assert from 'node:assert/strict';
import test from 'node:test';
import { sameOriginChildMarkup, sameOriginTools } from './cdp-675-same-origin.mjs';

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

test('extension same-origin child absence is a declared limit with a required unaffected root and no error', () => {
  assert.deepEqual(sameOriginTools([tools[0]], 'extension', frames), {
    root: tools[0],
    child: null,
    declaredLimit: '#694',
  });
  assert.throws(() => sameOriginTools([], 'extension', frames), /root tools must list/);
  assert.throws(() => sameOriginTools(tools, 'extension', frames), /declared Stage 1 limit/);
  assert.throws(
    () => sameOriginTools([{ ...tools[0], error: 'broken' }], 'extension', frames),
    /must not contain an error/
  );
});
