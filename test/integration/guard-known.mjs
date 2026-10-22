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

const BLANK_LEGS = [
  { id: 'C8.protected-error-page.fragment', variants: ['prompt', 'lagging'] },
  { id: 'C8.protected-error-page-sticky', variants: ['prompt', 'lagging'] },
  { id: 'C8.protected-error-page-sticky.query', variants: ['lagging'] },
  { id: 'C8.protected-error-page-sticky.fragment', variants: ['lagging'] },
];

const closedCheck = (item) => /^[A-Za-z]+: got (?:false|undefined), want true$/.test(item);

const blankLeg = (row) =>
  row.transport === 'extension' &&
  row.target === 'seven' &&
  BLANK_LEGS.find((leg) => leg.id === row.id && leg.variants.includes(row.variant));

const closedBlank = (row) => {
  if (!blankLeg(row) || row.live !== 'fail' || row.errors?.length) return false;
  const items = (row.why ?? '').split('; ').filter(Boolean);
  const tail = items.at(-1) ?? '';
  return (
    tail.startsWith('not live:') &&
    tail.includes('frame about:blank unreachableUrl none, target about:blank#blocked') &&
    items.slice(0, -1).every(closedCheck)
  );
};

export function known(row, { listed = false } = {}) {
  const reason = issue(row.id);
  if (!reason || row.control !== 'pass' || row.guarded !== 'fail') return null;
  if (!listed && row.transport !== 'proxy' && closedBlank(row)) return reason;
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

const passed = (row) => row.control === 'pass' && row.guarded === 'pass' && row.live === 'pass';

export function stale(results) {
  const ids = Object.entries(KNOWN).flatMap(([reason, knownIds]) =>
    knownIds
      .filter((id) => {
        const rows = results.filter((row) => row.id === id);
        return rows.length > 0 && rows.every(passed);
      })
      .map((id) => `remove ${id} from the ${reason} known list`)
  );
  const legs = BLANK_LEGS.flatMap((leg) =>
    leg.variants
      .filter((variant) => {
        const rows = results.filter(
          (row) =>
            row.id === leg.id &&
            row.variant === variant &&
            row.transport === 'extension' &&
            row.target === 'seven'
        );
        return rows.length > 0 && rows.every(passed);
      })
      .map((variant) => `remove ${leg.id} ${variant} extension seven from the #748 known list`)
  );
  return [...ids, ...legs];
}
