import { readFile, writeFile } from 'node:fs/promises';

const pass = process.argv[2];
const log = await readFile(`diagnostic/${pass}.log`, 'utf8').catch(() => '');
const rows = [];
for (const line of log.split('\n')) {
  const match = line.match(/\bPAIRED_(RESULT|EXTENSION|PROTOCOL|GUARD|STOP)\s+(\{.*\})\s*$/);
  if (!match) continue;
  rows.push({ kind: match[1], ...JSON.parse(match[2]) });
}
const results = rows.filter((row) => row.kind === 'RESULT');
const counts = {};
for (const side of ['baseline', 'candidate']) {
  const selected = results.filter((row) => row.side === side && row.usable !== false);
  counts[side] = {
    passed: selected.filter((row) => row.passed).length,
    failed: selected.filter((row) => !row.passed).length,
    unusable: results.filter((row) => row.side === side && row.usable === false).length,
    retryCalls: selected.reduce((sum, row) => sum + row.retry.calls, 0),
    admitted: selected.reduce((sum, row) => sum + row.retry.admitted, 0),
    refused: selected.reduce((sum, row) => sum + row.retry.refused, 0),
    bound: selected.reduce((sum, row) => sum + row.retry.bound, 0),
    interrupted: selected.reduce((sum, row) => sum + row.retry.interrupted, 0),
  };
}
const summary = {
  pass,
  counts,
  results,
  failures: results.filter((row) => !row.passed),
  retryRefusals: results.filter((row) => row.retry?.refused > 0),
  stop: rows.some((row) => row.kind === 'STOP'),
};
await writeFile(
  `diagnostic/${pass}.jsonl`,
  rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
);
await writeFile(`diagnostic/${pass}.summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ pass, counts, stop: summary.stop, results: results.length }));
