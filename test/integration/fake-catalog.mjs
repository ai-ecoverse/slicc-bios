import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { type } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/server.mjs';

export const REMOTES = [
  'https://cdn.jsdelivr.net/',
  'https://registry.npmjs.org/',
  'https://raw.githubusercontent.com/',
];
const REGISTRY = 'https://registry.npmjs.org/';
const TARBALL = /\/-\/[^/]+\.tgz$/;
const cors = { name: 'access-control-allow-origin', value: '*' };

function metadataOf(url, names) {
  const { hostname, pathname } = new URL(url);
  if (hostname === 'raw.githubusercontent.com') return true;
  if (hostname !== 'registry.npmjs.org' || TARBALL.test(pathname)) return false;
  const path = decodeURIComponent(pathname);
  if (path.startsWith('/-/npm/v1/attestations/')) return true;
  return [...names].some((name) => path === `/${name}` || path.startsWith(`/${name}/`));
}

export async function fakeCatalog(cdp) {
  const state = {
    latest: new Map(),
    docs: new Map(),
    down: false,
    status: 0,
    tarballs: 0,
    only: null,
    hold: null,
    asked: [],
    names: new Set(),
    reset() {
      state.latest.clear();
      state.docs.clear();
      state.names.clear();
      state.down = false;
      state.status = 0;
      state.tarballs = 0;
      state.only = null;
      state.hold = null;
      state.asked.length = 0;
    },
  };

  async function body(url) {
    if (state.docs.has(url)) return state.docs.get(url);
    const path = decodeURIComponent(new URL(url).pathname);
    for (const [name, version] of state.latest)
      if (path === `/${name}/latest`)
        return (await download(`${REGISTRY}${name}/${encodeURIComponent(version)}`)).toString();
    return download(url);
  }

  cdp.on(async ({ method, params }) => {
    if (method !== 'Fetch.requestPaused') return;
    const { requestId, request } = params;
    state.asked.push(request.url);
    if (state.hold?.test(request.url)) return;
    const names = new Set([...state.names, ...state.latest.keys()]);
    const { pathname } = new URL(request.url);
    const tarball =
      state.tarballs && TARBALL.test(pathname) && (!state.only || state.only.test(pathname));
    const failing = state.status || tarball || (state.down && metadataOf(request.url, names));
    if (failing) {
      const responseCode = state.status || (tarball ? state.tarballs : 503);
      return cdp
        .send('Fetch.fulfillRequest', { requestId, responseCode, responseHeaders: [cors] })
        .catch(() => {});
    }
    let refused = 0;
    const found = await body(request.url).catch((error) => {
      refused = Number(/^(4\d\d) /.exec(error.message)?.[1] ?? 0);
      return null;
    });
    if (refused)
      return cdp
        .send('Fetch.fulfillRequest', { requestId, responseCode: refused, responseHeaders: [cors] })
        .catch(() => {});
    if (found === null || found === undefined)
      return cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    const bytes = Buffer.from(found);
    const json = typeof found === 'string';
    await cdp
      .send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          cors,
          {
            name: 'content-type',
            value: json ? 'application/json' : type(new URL(request.url).pathname),
          },
        ],
        body: bytes.toString('base64'),
      })
      .catch(() => {});
  });
  await cdp.send('Fetch.enable', {
    patterns: REMOTES.map((remote) => ({ urlPattern: `${remote}*` })),
  });
  return state;
}
