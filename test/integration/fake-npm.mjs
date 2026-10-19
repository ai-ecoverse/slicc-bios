import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { packTar, unpackTar } from 'modern-tar';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { type } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/server.mjs';

export const REMOTES = ['https://cdn.jsdelivr.net/', 'https://registry.npmjs.org/'];
const REGISTRY = 'https://registry.npmjs.org/';
const SLSA = 'https://slsa.dev/provenance/v1';

async function repack(tarball, version) {
  const entries = await unpackTar(gunzipSync(tarball));
  const encoder = new TextEncoder();
  const out = entries.map(({ header, data }) => {
    if (header.name !== 'package/package.json') return { header, data };
    const manifest = JSON.parse(new TextDecoder().decode(data));
    const body = encoder.encode(`${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
    return { header: { ...header, size: body.byteLength }, data: body };
  });
  return gzipSync(await packTar(out));
}

const short = (name) => name.split('/').pop();

export async function fakeRelease({ name, from, version, repository }) {
  const base = `${REGISTRY}${name}`;
  const tarball = await repack(await download(`${base}/-/${short(name)}-${from}.tgz`), version);
  const sha512 = createHash('sha512').update(tarball).digest();
  const integrity = `sha512-${sha512.toString('base64')}`;
  const url = `${REGISTRY}-/npm/v1/attestations/${name.replace('/', '%2f')}@${version}`;
  const release = {
    name,
    version,
    integrity,
    provenance: true,
    repository,
  };
  const packument = async () => {
    const real = JSON.parse((await download(base)).toString());
    const doc = structuredClone(real.versions[from]);
    doc.version = version;
    doc._id = `${name}@${version}`;
    doc.dist = {
      ...doc.dist,
      tarball: `${base}/-/${short(name)}-${version}.tgz`,
      integrity,
      shasum: createHash('sha1').update(tarball).digest('hex'),
      attestations: release.provenance ? { url, provenance: { predicateType: SLSA } } : undefined,
    };
    delete doc.dist.signatures;
    return { real, doc };
  };
  const statement = () => ({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: `pkg:npm/${name.replace('@', '%40')}@${version}`,
        digest: { sha512: sha512.toString('hex') },
      },
    ],
    predicateType: SLSA,
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { ref: 'refs/heads/main', repository: release.repository, path: 'release.yml' },
        },
      },
    },
  });
  release.serve = async (address) => {
    const { pathname } = new URL(address);
    const path = decodeURIComponent(pathname);
    if (path === `/${name}`) {
      const { real, doc } = await packument();
      return JSON.stringify({
        ...real,
        'dist-tags': { ...real['dist-tags'], latest: version },
        versions: { ...real.versions, [version]: doc },
        time: { ...real.time, [version]: real.time?.[from] ?? new Date(0).toISOString() },
      });
    }
    if (path === `/${name}/latest`) return JSON.stringify((await packument()).doc);
    if (path === `/${name}/-/${short(name)}-${version}.tgz`) return tarball;
    if (release.provenance && path === `/-/npm/v1/attestations/${name}@${version}`) {
      const payload = Buffer.from(JSON.stringify(statement())).toString('base64');
      return JSON.stringify({
        attestations: [
          {
            predicateType: SLSA,
            bundle: { dsseEnvelope: { payload, payloadType: 'application/vnd.in-toto+json' } },
          },
        ],
      });
    }
    return null;
  };
  return release;
}

export async function fakeRegistry(cdp, releases) {
  const asked = [];
  cdp.on(async ({ method, params }) => {
    if (method !== 'Fetch.requestPaused') return;
    const { requestId, request } = params;
    let body = null;
    for (const release of releases) body ??= await release.serve(request.url).catch(() => null);
    if (body !== null) asked.push(request.url);
    body ??= await download(request.url).catch(() => null);
    if (body === null)
      return cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    const bytes = Buffer.from(body);
    const json = typeof body === 'string';
    await cdp
      .send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'access-control-allow-origin', value: '*' },
          {
            name: 'content-type',
            value: json ? 'application/json' : type(new URL(request.url).pathname),
          },
          { name: 'content-length', value: String(bytes.length) },
        ],
        body: bytes.toString('base64'),
      })
      .catch(() => {});
  });
  await cdp.send('Fetch.enable', {
    patterns: REMOTES.map((remote) => ({ urlPattern: `${remote}*` })),
  });
  return { asked };
}
