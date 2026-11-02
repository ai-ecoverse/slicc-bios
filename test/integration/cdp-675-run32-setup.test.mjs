import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEBUGGER_ROUTE_UPDATE } from '../../src/seed/debugger.js';

const packaged = await readFile(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');
const workflow = await readFile(
  new URL('../../.github/workflows/cdp-675-stage1.yml', import.meta.url),
  'utf8'
);
const artifacts = await readFile(
  new URL('./fixtures/cdp-675-artifacts.mjs', import.meta.url),
  'utf8'
);
const vectors = await readFile(new URL('./guard-vectors.test.mjs', import.meta.url), 'utf8');
const start = vectors.indexOf('      await t.test(`E4.${name} protected`, async () => {');
const end = vectors.indexOf('\n\n      await t.test(`E5.', start);
assert.ok(start >= 0 && end > start);
const protectedBody = vectors.slice(start, end);
const runProtected = new Function(
  't',
  'assert',
  'guard',
  'tab',
  'PLAIN',
  'DEBUGGER',
  'DEBUGGER_ROUTE_UPDATE',
  'chrome',
  'TRIGGERS',
  'at',
  'keptOut',
  'pause',
  'closeAll',
  'name',
  'lag',
  `return (async () => { ${protectedBody} })();`
);

test('diagnostic CDP stamp, artifact name, manifest and equality agree above the release', () => {
  assert.match(workflow, /npm pkg set version=1\.44\.99/);
  assert.match(artifacts, /const cdp = 'ai-ecoverse-slicc-cdp-1\.44\.99\.tgz'/);
  assert.match(artifacts, /diagnosticVersions:\s*\{\s*cdp: '1\.44\.99',\s*mcpcat: '0\.80\.1'/);
  assert.match(packaged, /packageProof\(trace\.install, '1\.44\.99', manifest\.wasmSha256\)/);
  assert.doesNotMatch(`${workflow}\n${artifacts}\n${packaged}`, /1\.43\.2/);
});

test('only the old link lane selects the installed historical CLI and retains its version assertion', () => {
  assert.match(
    workflow,
    /npm install --prefix "\$RUNNER_TEMP\/old-cli" --no-audit --no-fund @ai-ecoverse\/slicc@1\.49\.36/
  );
  assert.match(
    workflow,
    /export SLICC_675_OLD_CLI="\$RUNNER_TEMP\/old-cli\/node_modules\/\.bin\/slicc"/
  );
  assert.match(packaged, /oldRoute \? process\.env\.SLICC_675_OLD_CLI : undefined/);
  assert.match(packaged, /route\.version === \(oldRoute \? '1\.49\.36' : '1\.56\.99'\)/);
  assert.match(packaged, /if \(oldRoute\)\s*assert\.ok\(\s*process\.env\.SLICC_675_OLD_CLI/);
});

async function exercise({ floor = true, error = null, leak = false } = {}) {
  const seen = [];
  const guard = {
    attach: async () => 'session',
    send: async (method) => {
      seen.push(method);
      if (method === 'Debugger.enable' || method === 'Debugger.setInstrumentationBreakpoint')
        return error
          ? { error: { message: error } }
          : floor
            ? { error: { message: DEBUGGER_ROUTE_UPDATE } }
            : {};
      return {
        error: { message: 'slicc: refused: breakpoints could run in seven’s pages or the vault' },
      };
    },
    events: async () =>
      seen.includes('navigate') && leak ? [{ protected: 'protected.test' }] : [],
    go: async () => seen.push('navigate'),
  };
  await runProtected(
    { test: async (_, body) => body() },
    assert,
    guard,
    async () => 'target',
    'https://plain.test',
    /^slicc: refused: breakpoints could run in seven’s pages or the vault/,
    DEBUGGER_ROUTE_UPDATE,
    { requests: [] },
    { href: (url) => url },
    (path) => `https://protected.test${path}`,
    async (name, options) => {
      assert.equal(name, 'E4');
      assert.equal(options.targetId, 'target');
      seen.push('protected-check');
    },
    async () => {},
    async () => seen.push('closed'),
    'released',
    0
  );
  return seen;
}

for (const floor of [true, false])
  test(`E4 runs the protected hop and checks after ${floor ? 'the released floor refusal' : 'predecessor admission'}`, async () => {
    const seen = await exercise({ floor });
    assert.deepEqual(seen, [
      'Debugger.enable',
      'Debugger.setBreakpointByUrl',
      'Debugger.setInstrumentationBreakpoint',
      'DOMDebugger.setEventListenerBreakpoint',
      'navigate',
      'protected-check',
      'closed',
    ]);
  });

test('E4 does not accept any other predecessor error or a protected host leak', async () => {
  await assert.rejects(exercise({ error: 'Can only perform operation while paused.' }));
  await assert.rejects(exercise({ leak: true }), /nothing naming the protected host/);
});
