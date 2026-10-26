import { writeFileSync } from 'node:fs';

export default async function* reporter(source) {
  const summary = { selected: 0, passed: 0, failed: 0, skipped: 0 };
  for await (const event of source) {
    if (!['test:pass', 'test:fail'].includes(event.type) || event.data.details?.type === 'suite')
      continue;
    if (event.data.skip) {
      if (!String(event.data.skip).includes('test name does not match')) summary.skipped += 1;
      continue;
    }
    summary.selected += 1;
    summary[event.type === 'test:pass' ? 'passed' : 'failed'] += 1;
  }
  writeFileSync(process.env.SLICC_GUARD_DIAGNOSTIC_SUMMARY, `${JSON.stringify(summary)}\n`);
  yield `${JSON.stringify(summary)}\n`;
}
