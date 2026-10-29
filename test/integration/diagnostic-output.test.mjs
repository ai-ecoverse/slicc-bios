import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { diagnosticAboutProof, prepareDiagnostic, splitDiagnosticCli } from './diagnostic-rig.mjs';

const upstream = (url) => ({
  layer: 'bios',
  stage: 'upstream',
  method: 'Page.navigate',
  params: { url },
});
const begin = { layer: 'rig', stage: 'legacy-inherit:start' };
const finish = { layer: 'rig', stage: 'legacy-inherit:finished' };

test('about-navigation proof reads backend forwarding inside the complete phase', () => {
  assert.deepEqual(
    diagnosticAboutProof(
      [upstream('about://'), begin, upstream('https://ordinary.invalid'), finish],
      'legacy-inherit'
    ),
    { valid: true, observed: true, forwarded: 0 }
  );
  assert.deepEqual(diagnosticAboutProof([begin, upstream('about://'), finish], 'legacy-inherit'), {
    valid: true,
    observed: true,
    forwarded: 1,
  });
});

test('about-navigation proof rejects missing or reversed phase markers', () => {
  for (const records of [[begin], [finish], [finish, begin]])
    assert.deepEqual(diagnosticAboutProof(records, 'legacy-inherit'), {
      valid: false,
      observed: false,
      forwarded: null,
    });
});

test('about-navigation proof cannot claim backend observation from CLI text or client intents', () => {
  const records = [
    begin,
    { layer: 'cli', stage: 'refused' },
    { ...upstream('about://'), stage: 'client' },
    finish,
  ];
  assert.deepEqual(diagnosticAboutProof(records, 'legacy-inherit'), {
    valid: true,
    observed: false,
    forwarded: 0,
  });
});

test('the selection trace is registered before navigation without evaluating the old document', async () => {
  let init;
  const page = {
    async init(script) {
      init = script;
    },
    async evaluate() {
      assert.fail('diagnostic setup must not evaluate the previous document');
    },
  };
  await prepareDiagnostic(undefined, page, { version: '7.9.13' }, 'legacy');
  assert.match(init, /extension-selected/);
  assert.match(init, /"scenarioVersion":"7.9.13"/);
});

for (const released of [false, true]) {
  test(`the CLI fixture selects ${released ? 'published bytes before trace bytes' : 'trace bytes with empty release path'}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'thr_vsmsb8icpu-cli-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const published = join(dir, 'published.wasm');
    const traced = join(dir, 'traced.wasm');
    await writeFile(published, 'published-fixture');
    await writeFile(traced, 'traced-fixture');
    for (const [name, value] of Object.entries({
      SLICC_DIAGNOSTIC_RELEASE_CLI: released ? published : '',
      SLICC_DIAGNOSTIC_CLI: traced,
      SLICC_DIAGNOSTIC_ROLL_FORWARD: '1',
    })) {
      const prior = process.env[name];
      process.env[name] = value;
      t.after(() => {
        if (prior === undefined) delete process.env[name];
        else process.env[name] = prior;
      });
    }
    const records = [];
    const writes = [];
    let closed = false;
    for (const [name, value] of Object.entries({
      sliccDiagnostic: { emit: (record) => records.push(record) },
      sliccKernelClient: async () => ({
        fs: {
          async mkdir() {},
          async writeFile(path, contents) {
            writes.push({ path, contents });
          },
        },
        run: async () => ({ status: 0 }),
        close: async () => {
          closed = true;
        },
      }),
    })) {
      const prior = globalThis[name];
      globalThis[name] = value;
      t.after(() => {
        if (prior === undefined) delete globalThis[name];
        else globalThis[name] = prior;
      });
    }
    const page = { async init() {}, evaluate: async (fn, argument) => fn(argument) };
    const rig = await prepareDiagnostic(undefined, page, { version: '7.9.13' }, 'legacy');
    assert.equal(await rig.installCli(), true);
    const wasm = writes.find(({ path }) => path.endsWith('/bin/playwright-cli'));
    assert.equal(
      Buffer.from(wasm.contents).toString(),
      released ? 'published-fixture' : 'traced-fixture'
    );
    assert.equal(
      records.find(({ stage }) => stage === 'cli-installed').cliVariant,
      released ? 'published-1.42.10' : 'traced-source-1.42.10'
    );
    assert.equal(closed, true);
  });
}

test('only known diagnostic CLI records are separated from unchanged assertion text', () => {
  const record = {
    stage: 'away:tree',
    detail: {
      error:
        'slicc: refused: seven’s own pages and the vault are out of reach of browser automation',
    },
  };
  const output = `recovery-goto-0\nSLICC_DIAGNOSTIC ${JSON.stringify(record)}\nheading "Recovered ordinary tab"\nrecovery-read-0\nrecovery-snapshot-0\n`;
  assert.deepEqual(splitDiagnosticCli(output), {
    parsed: [record],
    clean:
      'recovery-goto-0\nheading "Recovered ordinary tab"\nrecovery-read-0\nrecovery-snapshot-0\n',
  });
});

for (const text of [
  'slicc: refused: genuine unprefixed error',
  'SLICC_DIAGNOSTIC not-json',
  'SLICC_DIAGNOSTIC null',
  'SLICC_DIAGNOSTIC {"stage":"unknown","detail":{}}',
  'SLICC_DIAGNOSTIC {"stage":"away:tree","detail":{},"extra":"unexpected"}',
  'SLICC_DIAGNOSTIC {"stage":"away:tree"}',
  'prefix SLICC_DIAGNOSTIC {"stage":"away:tree","detail":{}}',
]) {
  test(`non-rig output is retained: ${text}`, () => {
    assert.deepEqual(splitDiagnosticCli(text), { parsed: [], clean: text });
  });
}
