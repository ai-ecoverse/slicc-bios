export const KNOWN = {
  '#748': [
    'C8.protected-error-page',
    'C8.protected-error-page.query',
    'C8.protected-error-page.fragment',
    'C8.protected-document-restore',
    'C8.protected-error-page-sticky',
    'C8.protected-error-page-sticky.query',
    'C8.protected-error-page-sticky.fragment',
  ],
};
const RECOVERY = new Set(['reload', 'blank', 'close', 'attachRedacted']);

const checks = (why = '') =>
  why
    .split('; ')
    .filter(Boolean)
    .map((item) => item.split(':')[0]);

const issue = (id) => Object.keys(KNOWN).find((key) => KNOWN[key].includes(id));

export function known(row) {
  const reason = issue(row.id);
  if (!reason || row.control !== 'pass' || row.guarded !== 'fail') return null;
  if (row.transport === 'proxy') {
    return row.live === 'fail' && /(?:^|; )not live$/.test(row.why ?? '') ? reason : null;
  }
  const failed = checks(row.why);
  return row.live === 'pass' && failed.length > 0 && failed.every((check) => RECOVERY.has(check))
    ? reason
    : null;
}

export function stale(results) {
  return Object.entries(KNOWN).flatMap(([reason, ids]) =>
    ids
      .filter((id) => {
        const rows = results.filter((row) => row.id === id);
        return (
          rows.length > 0 &&
          rows.every(
            (row) => row.control === 'pass' && row.guarded === 'pass' && row.live === 'pass'
          )
        );
      })
      .map((id) => `remove ${id} from the ${reason} known list`)
  );
}
