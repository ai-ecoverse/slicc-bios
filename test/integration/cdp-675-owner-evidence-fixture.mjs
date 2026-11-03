import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { captureRowPageEvidence } from './cdp-675-row-evidence.mjs';

export function ownerEvidenceFixture(
  values,
  sourceFile = new URL('./cdp-675-packaged.test.mjs', import.meta.url)
) {
  const source = readFileSync(sourceFile, 'utf8');
  const context = vm.createContext({ assert, captureRowPageEvidence, ...values });
  const extract = (first, last, prefix, suffix) => {
    const start = source.indexOf(first);
    const end = source.indexOf(last, start);
    assert.ok(start >= 0 && end > start);
    const padding = '\n'.repeat(source.slice(0, start).split('\n').length - 2);
    return vm.runInContext(padding + prefix + '\n' + source.slice(start, end) + suffix, context, {
      filename: fileURLToPath(sourceFile),
    });
  };
  const rescue = extract(
    'async function lifecycleRescue(',
    'async function lifecycleChanged(',
    '',
    '\n;lifecycleRescue'
  );
  const finish = extract(
    '          bfcacheOff?.();',
    '        }\n      }\n      try {',
    '(async () => {',
    '\n})'
  );
  return {
    rescue,
    finish,
    evaluate(fn, argument) {
      context.argument = argument;
      return vm.runInContext(`(${fn.toString()})(argument)`, context);
    },
  };
}
