import { readFile, writeFile } from 'node:fs/promises';

const pass = process.argv[2];
const log = await readFile(`diagnostic/${pass}.log`, 'utf8').catch(() => '');
const rows = [];
for (const line of log.split('\n')) {
  const match = line.match(
    /\b(RECOVERY_(?:DIAGNOSTIC|EXTENSION|CLI|EXIT|RELAY|GUARD))\s+(\{.*\})\s*$/
  );
  if (!match) continue;
  try {
    rows.push({ kind: match[1], ...JSON.parse(match[2]) });
  } catch {}
}
const xml = await readFile(`diagnostic/${pass}.xml`, 'utf8').catch(() => '');
const tests = [];
for (const match of xml.matchAll(/<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
  const name = match[1].match(/\bname="([^"]*)"/)?.[1] ?? '';
  if (!name.includes('recovery scenario')) continue;
  const body = match[2] ?? '';
  tests.push({
    name,
    status: /<failure\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed',
    duration: Number(match[1].match(/\btime="([^"]*)"/)?.[1] ?? 0),
  });
}
await writeFile(
  `diagnostic/${pass}.jsonl`,
  rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
);
await writeFile(
  `diagnostic/${pass}.summary.json`,
  JSON.stringify(
    {
      pass,
      at: Date.now(),
      tests,
      traces: rows.length,
      workers: new Set(
        rows.filter((row) => row.kind === 'RECOVERY_EXTENSION').map((row) => row.boot)
      ).size,
      exits: rows.filter((row) => row.kind === 'RECOVERY_EXIT'),
    },
    null,
    2
  )
);
