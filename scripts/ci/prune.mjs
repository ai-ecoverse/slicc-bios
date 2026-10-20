import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MEDIA = /\.(png|jpe?g|webp|gif|webm|mp4)$|trace[^/]*\.(zip|json)$/i;

export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []
  );
}

export function failedSuites(root) {
  const dir = join(root, 'experiment');
  const reports = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  if (!reports.length) return null;
  const suites = new Set();
  for (const f of reports) {
    const report = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const g of report.groups ?? [])
      for (const attempt of [g.first, g.retry])
        for (const file of attempt?.failed ?? []) suites.add(slug(basename(file, '.test.mjs')));
    for (const { file } of report.flips ?? []) suites.add(slug(basename(file, '.test.mjs')));
  }
  return suites;
}

export function prune(root) {
  const failed = failedSuites(root);
  const record = { kept: 'everything else, and every file of a suite that failed', dropped: [] };
  if (!failed) {
    record.kept = 'everything: no shard report, so no file is known to have passed';
  } else {
    for (const file of walk(root)) {
      const rel = relative(root, file);
      const suite = rel.split('/')[0];
      if (rel.split('/').length < 3 || failed.has(suite) || !MEDIA.test(rel)) continue;
      record.dropped.push({ path: rel, bytes: statSync(file).size });
      rmSync(file, { force: true });
    }
  }
  record.bytes = record.dropped.reduce((n, d) => n + d.bytes, 0);
  writeFileSync(join(root, 'pruned.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = prune(process.argv[2] ?? 'artifacts');
  console.log(
    `prune: dropped ${r.dropped.length} media files (${(r.bytes / 1048576).toFixed(1)} MB) of suites that passed; listed in artifacts/pruned.json`
  );
}
