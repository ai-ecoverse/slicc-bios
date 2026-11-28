export const SITE = 'sliccy.ai';

const named = (hostname) =>
  String(hostname ?? '')
    .toLowerCase()
    .replace(/\.+$/, '');

const under = (host) => host.endsWith(`.${SITE}`);

const labels = (list) =>
  Array.isArray(list) &&
  list.length > 0 &&
  list.every((label) => typeof label === 'string' && label.length > 0);

export function validPolicy(seven) {
  return (
    typeof seven === 'object' &&
    seven !== null &&
    labels(seven.excludedLabels) &&
    (seven.excludedLabelPrefixes === undefined || labels(seven.excludedLabelPrefixes))
  );
}

export function sevenHost(seven, { protocol, hostname } = {}) {
  const host = named(hostname);
  if (!validPolicy(seven) || protocol !== 'https:' || !under(host)) return false;
  const label = host.split('.').at(-3);
  if (!label || seven.excludedLabels.includes(label)) return false;
  return !(seven.excludedLabelPrefixes ?? []).some((prefix) => label.startsWith(prefix));
}

export function onSite({ hostname } = {}) {
  const host = named(hostname);
  return host === SITE || under(host);
}

export const refusesBoot = (seven, at = {}) => onSite(at) && !sevenHost(seven, at);
