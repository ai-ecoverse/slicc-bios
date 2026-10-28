import { UNGUARDED } from '../../src/seed/guard.js';

export const KNOWN = {};
const ERROR_RECOVERY = [
  'C8.protected-error-page',
  'C8.protected-error-page.query',
  'C8.protected-error-page.fragment',
  'C8.protected-document-restore',
  'C8.protected-error-page-sticky',
  'C8.protected-error-page-sticky.query',
  'C8.protected-error-page-sticky.fragment',
];
const RECOVERY = new Set(['reload', 'blank', 'close', 'attachRedacted']);
const unmet = (items) =>
  items.every((item) => /^[A-Za-z]+: got (?:false|undefined), want true$/.test(item));
const ABSENT = new Set(['listRedacted', 'infoRedacted']);
export const LINK = {
  '#749 (discovery metadata)': {
    ids: ERROR_RECOVERY,
    allowed: new Set(['eventsRedacted']),
  },
  'slicc-cli#366 (fail-closed)': {
    ids: ERROR_RECOVERY,
    allowed: new Set([...RECOVERY, ...ABSENT]),
    notLive: `not live: client attach refused: ${UNGUARDED}`,
  },
  'slicc-cli ends the session (fail-closed)': {
    ids: ['C2.redirect-secret', 'C2.redirect-secret-mix'],
    allowed: new Set(['extraLocation']),
  },
};

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

function linked(row, listed) {
  if (listed || row.control !== 'pass' || row.guarded !== 'fail') return null;
  const found = Object.entries(LINK).find(([, { ids, allowed, notLive }]) => {
    if (!ids.includes(row.id)) return false;
    if (row.live === 'fail') {
      const items = (row.why ?? '').split('; ');
      return Boolean(notLive && items.at(-1) === notLive && unmet(items.slice(0, -1)));
    }
    if (row.live !== 'pass') return false;
    const failed = checks(row.why);
    return failed.length > 0 && failed.every((check) => allowed.has(check));
  });
  return found?.[0] ?? null;
}

const RELOAD_WAIT = '#748 (lagging reload, awaiting slicc-browsers)';
const laggingExtension = (row) =>
  row.transport === 'extension' && row.variant === 'lagging' && row.target === 'seven';

function laggingReload(row, listed) {
  if (
    listed ||
    row.errors?.length ||
    row.incomplete?.length ||
    !laggingExtension(row) ||
    !ERROR_RECOVERY.includes(row.id) ||
    row.control !== 'pass' ||
    row.guarded !== 'fail' ||
    row.live !== 'pass'
  )
    return null;
  return row.why === 'reload: got false, want true' ? RELOAD_WAIT : null;
}

export function known(row, { listed = false } = {}) {
  if (row.transport === 'link') return linked(row, listed);
  const reload = laggingReload(row, listed);
  if (reload) return reload;
  const reason = issue(row.id);
  if (!reason || row.control !== 'pass' || row.guarded !== 'fail') return null;
  const items = (row.why ?? '').split('; ');
  if (row.live === 'fail') {
    return !listed && /^not live(?::|$)/.test(items.at(-1)) && unmet(items.slice(0, -1))
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
  const lists = [
    [RELOAD_WAIT, ERROR_RECOVERY, laggingExtension],
    ...Object.entries(KNOWN).map(([reason, ids]) => [reason, ids, () => true]),
    ...Object.entries(LINK).map(([reason, { ids }]) => [
      reason,
      ids,
      (row) => row.transport === 'link',
    ]),
  ];
  return lists.flatMap(([reason, ids, route]) =>
    ids
      .filter((id) => {
        const rows = results.filter((row) => row.id === id && route(row));
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
