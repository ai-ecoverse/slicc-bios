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
const ABSENT = 'listRedacted';

export function listedWrong(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return false;
  }
  const infos = message?.result?.targetInfos;
  if (!Array.isArray(infos)) return false;
  return infos.some((info) => {
    const shown = `${info.url ?? ''} ${info.title ?? ''}`;
    if (!/sliccy\.ai/i.test(shown)) return false;
    const origin = URL.canParse(info.url) ? new URL(info.url).origin : null;
    return info.url !== origin || info.title !== origin;
  });
}

const checks = (why = '') =>
  why
    .split('; ')
    .filter(Boolean)
    .map((item) => item.split(':')[0]);

const issue = (id) => Object.keys(KNOWN).find((key) => KNOWN[key].includes(id));

export function known(row, { listed = false } = {}) {
  const reason = issue(row.id);
  if (!reason || row.control !== 'pass' || row.guarded !== 'fail') return null;
  if (row.transport === 'proxy') {
    const items = (row.why ?? '').split('; ');
    const absent = items
      .slice(0, -1)
      .every((item) => /^[A-Za-z]+: got (?:false|undefined), want true$/.test(item));
    return row.live === 'fail' && items.at(-1) === 'not live' && absent ? reason : null;
  }
  const failed = checks(row.why);
  const allowed = (check) => RECOVERY.has(check) || (check === ABSENT && !listed);
  return row.live === 'pass' && failed.length > 0 && failed.every(allowed) ? reason : null;
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
