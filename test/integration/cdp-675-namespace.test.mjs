import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { namespaceCommand, namespaceEnabled, namespaceTrace } from './cdp-675-namespace.mjs';

test('namespace witness is enabled only for the same-origin row and root-only standalone control', () => {
  for (const scene of [{ sameOriginChild: true }, { standaloneControl: true }]) {
    assert.equal(namespaceEnabled(scene), true);
    assert.equal(
      namespaceCommand(scene, 'playwright-cli webmcp-list'),
      'SLICC_WEBMCP_TRACE=1 playwright-cli webmcp-list'
    );
  }
  for (const scene of [{}, { reload: true }, { protectedSubframe: true }]) {
    assert.equal(namespaceEnabled(scene), false);
    assert.equal(namespaceCommand(scene, 'mcpcat serve'), 'mcpcat serve');
  }
});

test('namespace witness preserves selected process records and does not invent missing evidence', () => {
  const root = {
    phase: 'holder-save',
    HOME: '/home/cone',
    PWD: '/',
    fileHash: 'root',
    metadataPresent: true,
    selected: {},
  };
  const standalone = {
    phase: 'scope-selected',
    HOME: null,
    PWD: '/other',
    fileHash: 'other',
    metadataPresent: false,
    selected: { documentPolicySelected: false },
  };
  assert.deepEqual(namespaceTrace(`${JSON.stringify(root)}\n\n${JSON.stringify(standalone)}\n`), [
    root,
    standalone,
  ]);
  assert.deepEqual(namespaceTrace(' \n'), []);
  assert.throws(() => namespaceTrace('invalid'), SyntaxError);
});

test('packaged witness captures before holder shutdown without changing standalone namespace or positive assertions', () => {
  const rig = readFileSync(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');
  assert.ok(
    rig.includes(
      "{ name: 'ordinary-root-only-standalone-list-control', reload: true, standaloneControl: true }"
    )
  );
  assert.equal(rig.match(/namespaceCommand\(\s*scene,\s*`playwright-cli webmcp-list/g)?.length, 2);
  assert.match(rig, /namespaceCommand\(\s*scene,\s*`mcpcat serve/);
  assert.ok(
    rig.indexOf('row.namespaceTrace = namespaceTrace(capture.stdout)') <
      rig.indexOf('await sh(page, `kill "$(cat ${row.pid})"`)')
  );
  assert.ok(rig.includes('standalone second-process root-only tools must list'));
  assert.ok(
    rig.includes('row.sameOriginTools = sameOriginTools(JSON.parse(row.secondProcessList.stdout))')
  );
  assert.doesNotMatch(rig, /export (?:HOME|PWD|XDG_STATE_HOME|XDG_CONFIG_HOME)=/);
});
