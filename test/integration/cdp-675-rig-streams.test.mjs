import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(
  process.env.CDP_675_RIG_SOURCE ?? new URL('./cdp-675-packaged.test.mjs', import.meta.url),
  'utf8'
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('675 rig awaits the worker message before asserting initial and reloaded readiness', async () => {
  const startup = source.match(/const workerStartup =[\s\S]*?\? `([^`]+)`/)[1];
  const expressions = [
    ...source.matchAll(
      /row\.worker(?:Premise|AfterHolder) = await rawBounded[\s\S]*?expression:\s*'([^']+)'/g
    ),
  ];
  assert.equal(expressions.length, 2);
  for (const [, expression] of expressions) {
    const context = vm.createContext({ window: {} });
    context.Worker = class {};
    vm.runInContext(
      `(async () => { ${startup.replaceAll("${at.searchParams.get('row')}", '1')} })()`,
      context
    );
    let settled = false;
    const result = Promise.resolve(vm.runInContext(expression, context)).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    assert.equal(settled, false, 'premise must wait for the actual worker reply');
    context.window.cdp675Worker.onmessage({ data: '675-worker-ready' });
    const value = await result;
    assert.equal(value.ready, true);
    assert.equal(value.owned, true);
  }
});

test('675 rig separates command stdout, stderr and exit status without changing the merged default', async () => {
  const start = source.indexOf('async function cone(');
  const end = source.indexOf('\nfunction installCommand', start);
  const make = new AsyncFunction(
    'run',
    'shows',
    'sh',
    'quote',
    `${source.slice(start, end)}\nreturn cone;`
  );
  const commands = [];
  const cone = await make(
    async (_page, command) => {
      commands.push(command);
    },
    async (_page, marker) => {
      assert.equal(marker, '675-fake-42');
    },
    async (_page, command) => {
      if (command.includes('.stdout')) return { status: 7, stdout: '[]\n', stderr: 'warning\n' };
      return { status: 0, stdout: '[]\nwarning\n', stderr: '' };
    },
    (value) => `'${value.replaceAll("'", "'\\''")}'`
  );
  const separated = await cone({}, 'printf test', '675-fake', true);
  assert.deepEqual(JSON.parse(separated.stdout), []);
  assert.equal(separated.stderr, 'warning\n');
  assert.equal(separated.status, 7);
  assert.match(
    commands[0],
    /> \/tmp\/675-fake\.stdout 2> \/tmp\/675-fake\.stderr; echo \$\? > \/tmp\/675-fake\.status/
  );
  const merged = await cone({}, 'printf test', '675-fake');
  assert.equal(merged.stdout, '[]\nwarning\n');
  assert.match(commands[1], /> \/tmp\/675-fake\.log 2>&1/);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `printf '[]\\n'; printf 'warning\\n' >&2; exit 7`;
  const actual = spawnSync('bash', ['-c', `bash -c ${quote(command)}`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(actual.stdout), []);
  assert.equal(actual.stderr, 'warning\n');
  assert.equal(actual.status, 7);
});

test('675 requested-child row keeps clean standalone JSON plus warning and the shipped holder root list and call', () => {
  const start = source.indexOf('            if (scene.fromOrigin) {');
  const end = source.indexOf('            for (const { tree }', start);
  const row = source.slice(start, end);
  assert.match(row, /row\.fromOriginList\.stderr,/);
  assert.match(row, /JSON\.parse\(row\.fromOriginList\.stdout\)/);
  assert.match(row, /assert\.deepEqual\(requested, \[\]\)/);
  assert.match(row, /row\.tools\.some/);
  assert.match(row, /assert\.match\(row\.call\.stdout/);
});
