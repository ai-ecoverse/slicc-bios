import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { namespaceCommand } from './cdp-675-namespace.mjs';

const rig = readFileSync(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');
const between = (first, last) => {
  const start = rig.indexOf(first);
  assert.ok(start >= 0, first);
  const end = rig.indexOf(last, start + first.length);
  assert.ok(end > start, last);
  return rig
    .slice(start + first.length, end)
    .trim()
    .replace(/[;,]$/, '');
};
const executable = between('const command = ', '\n          row.command =');
const launch = between('command: `export PATH=$PNPM_HOME', '\n              log: row.log,');
const launchExpression = `\`export PATH=$PNPM_HOME${launch}`;

for (const [name, scene, expected] of [
  [
    'same-origin child',
    { sameOriginChild: true, reload: true },
    'SLICC_WEBMCP_TRACE=1 exec mcpcat serve',
  ],
  [
    'root-only standalone',
    { standaloneControl: true, reload: true },
    'SLICC_WEBMCP_TRACE=1 exec mcpcat serve',
  ],
  ['ordinary', { reload: true }, 'exec mcpcat serve'],
]) {
  test(`packaged ${name} trace assignment precedes exec and never becomes its executable`, () => {
    const context = {
      scene,
      row: { target: 'TAB', port: 8813, pid: '/tmp/holder.pid' },
      quote: (value) => `'${value}'`,
      namespaceCommand,
    };
    const command = runInNewContext(executable, context);
    const actual = runInNewContext(launchExpression, { ...context, command });
    const finalCommand = actual.split(';').at(-1).trim();
    assert.ok(finalCommand.startsWith(expected), finalCommand);
    assert.doesNotMatch(actual, /\bexec SLICC_WEBMCP_TRACE=/);
    assert.equal(
      finalCommand.includes('SLICC_WEBMCP_TRACE=1'),
      Boolean(scene.sameOriginChild || scene.standaloneControl)
    );
    assert.match(finalCommand, /--webmcp-reload --tab 'TAB' --http 8813 --no-auth$/);
    assert.doesNotMatch(actual, /(?:export |\benv )(?:HOME|PWD|XDG_STATE_HOME|XDG_CONFIG_HOME)=/);
    assert.ok(actual.includes('echo $$ > /tmp/holder.pid;'));
  });
}

test('standalone namespace commands retain their valid leading assignment without an exec wrapper', () => {
  const actual = namespaceCommand(
    { sameOriginChild: true },
    "playwright-cli webmcp-list --tab 'TAB' --json"
  );
  assert.equal(actual, "SLICC_WEBMCP_TRACE=1 playwright-cli webmcp-list --tab 'TAB' --json");
});
