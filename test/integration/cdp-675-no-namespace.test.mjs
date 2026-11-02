import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const rig = readFileSync(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');
const expression = (first, last) => {
  const start = rig.indexOf(first);
  const end = rig.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, first);
  return rig
    .slice(start + first.length, end)
    .trim()
    .replace(/[;,]$/, '');
};
const commandSource = expression('const command = ', '\n          row.command =');
const launchSource = `\`export PATH=$PNPM_HOME${expression('command: `export PATH=$PNPM_HOME', '\n              log: row.log,')}`;

for (const [name, scene] of [
  ['ordinary', { reload: true }],
  ['root-only standalone', { reload: true, standaloneControl: true }],
  ['same-origin child', { reload: true, sameOriginChild: true }],
]) {
  test(`packaged ${name} starts the identical untraced shipped command`, () => {
    const scope = {
      scene,
      row: { target: 'TAB', port: 8813, pid: '/tmp/holder.pid' },
      quote: (value) => `'${value}'`,
    };
    const command = runInNewContext(commandSource, scope);
    const launch = runInNewContext(launchSource, { ...scope, command });
    assert.equal(
      command,
      "mcpcat serve --webmcp --webmcp-reload --tab 'TAB' --http 8813 --no-auth"
    );
    assert.equal(launch.split(';').at(-1).trim(), `exec ${command}`);
    assert.doesNotMatch(
      launch,
      /SLICC_WEBMCP_TRACE|namespace|(?:export |\benv )(?:HOME|PWD|XDG_STATE_HOME|XDG_CONFIG_HOME)=/
    );
    assert.ok(launch.includes('echo $$ > /tmp/holder.pid;'));
  });
}

test('packaged route drops the diagnostic flag and files but retains both standalone and child positives', () => {
  assert.doesNotMatch(
    rig,
    /SLICC_WEBMCP_TRACE|namespaceCommand|namespaceEnabled|namespaceTrace|cdp-675-namespace\.ndjson/
  );
  for (const file of [
    'cdp-675-namespace.mjs',
    'cdp-675-namespace.test.mjs',
    'cdp-675-namespace-exec.test.mjs',
  ])
    assert.equal(existsSync(new URL(file, import.meta.url)), false);
  assert.ok(
    rig.includes(
      "{ name: 'ordinary-root-only-standalone-list-control', reload: true, standaloneControl: true }"
    )
  );
  assert.equal(
    rig.match(/`playwright-cli webmcp-list --tab \$\{quote\(row\.target\)\} --json`/g)?.length,
    2
  );
  assert.ok(rig.includes('standalone second-process root-only tools must list'));
  assert.ok(rig.includes('shipped MCP must list the initial same-origin child'));
  assert.ok(
    rig.includes('row.sameOriginTools = sameOriginTools(JSON.parse(row.secondProcessList.stdout))')
  );
  assert.match(rig, /assert\.match\(row\.sameOriginCall\.stdout, \/\^15\$\/m\)/);
});
