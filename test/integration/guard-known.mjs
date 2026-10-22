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
const NOT_LIVE_ON_EXTENSION = new Set([
  'C8.protected-error-page-sticky.query',
  'C8.protected-error-page-sticky.fragment',
]);
const unmet = (items) =>
  items.every((item) => /^[A-Za-z]+: got (?:false|undefined), want true$/.test(item));
const ABSENT = new Set(['listRedacted', 'infoRedacted']);

export function listedWrong(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return false;
  }
  const infos = [
    ...(message?.result?.targetInfos ?? []),
    message?.result?.targetInfo,
    message?.params?.targetInfo,
  ].filter((info) => info && typeof info === 'object');
  return infos.some((info) => {
    const parsed = URL.canParse(info.url) ? new URL(info.url) : null;
    const protectedHost = parsed
      ? /(?:^|\.)sliccy\.ai\.?$/i.test(parsed.hostname)
      : /sliccy\.ai/i.test(`${info.url ?? ''}`);
    if (!protectedHost) return false;
    const origin = parsed?.origin ?? null;
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
  const items = (row.why ?? '').split('; ');
  if (row.live === 'fail') {
    const tolerated = row.transport === 'proxy' || NOT_LIVE_ON_EXTENSION.has(row.id);
    return tolerated && !listed && items.at(-1) === 'not live' && unmet(items.slice(0, -1))
      ? reason
      : null;
  }
  const failed = checks(row.why);
  const allowed = (check) => RECOVERY.has(check) || ABSENT.has(check);
  return !listed && row.live === 'pass' && failed.length > 0 && failed.every(allowed)
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
