import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareDiagnostic, splitDiagnosticCli } from './diagnostic-rig.mjs';

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
