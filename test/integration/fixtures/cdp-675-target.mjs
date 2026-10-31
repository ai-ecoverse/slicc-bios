export function fixtureTarget(infos, url) {
  const expected = new URL(url);
  return (infos ?? []).find((info) => {
    if (info.type !== 'page') return false;
    try {
      const actual = new URL(info.url);
      return actual.origin === expected.origin && actual.pathname === expected.pathname;
    } catch {
      return false;
    }
  });
}
