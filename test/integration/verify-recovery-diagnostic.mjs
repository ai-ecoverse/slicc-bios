import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const log = await readFile('diagnostic/row.log', 'utf8');
const reports = log
  .split('\n')
  .filter((line) => line.startsWith('recovery diagnostic '))
  .map((line) => JSON.parse(line.slice('recovery diagnostic '.length)));
const records = log
  .split('\n')
  .filter((line) => line.startsWith('recovery record '))
  .map((line) => JSON.parse(line.slice('recovery record '.length)));
const expected = '7.9.16';
assert.equal(reports.length, 1, 'one forced row reported');
const report = reports[0];
assert.equal(report.scenario, expected);
assert.notEqual(report.unavailable, true);
assert.equal(report.installed, true);
assert.equal(report.channels, 6);
assert.equal(report.summary.branch, 'after accepted navigation reply');
assert.ok(
  report.targetsAfterFailure.some((target) => target.url.endsWith('/recovery-destination.html'))
);
const fourth = records.filter((row) => row.side === 'cli' && row.channel === 4);
const sent = fourth.find((row) => row.direction === 'send' && row.method === 'Page.navigate');
assert.ok(sent.url.endsWith('/recovery-destination.html'));
const reply = fourth.find(
  (row) => row.direction === 'receive' && row.method === 'Page.navigate' && row.id === sent.id
);
assert.ok(reply.frameId);
assert.ok(reply.loaderId);
assert.equal(reply.error, undefined);
assert.equal(reply.errorText, undefined);
assert.match(log, /forced recovery diagnostic/);
assert.match(log, /fail 1/);
assert.equal(
  records.some((row) => row.scenario !== expected),
  false
);
const result = {
  verdict: 'PASS',
  scenario: expected,
  livePage: true,
  channelFourIsRecovery: true,
  branch: report.summary.branch,
  channels: report.channels,
  records: records.length,
  targetsAfterFailure: report.targetsAfterFailure,
};
await writeFile('diagnostic/verdict.json', JSON.stringify(result, null, 2));
console.log('recovery diagnostic validation', JSON.stringify(result));
