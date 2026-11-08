import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { packTar, unpackTar } from 'modern-tar';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { fakeRegistry } from './fake-npm.mjs';

const NAME = '@ai-ecoverse/slicc-capture';
const INDEX = 'package/page/index.mjs';
const LOCKS = ['/packages/package-lock.json', '/packages/pnpm-lock.yaml'];
const source = (path) => readFile(new URL(`../../src${path}`, import.meta.url), 'utf8');

export async function standIn(chrome) {
  const lock = JSON.parse(await source(LOCKS[0]));
  const entry = lock.packages[`node_modules/${NAME}`];
  const entries = await unpackTar(gunzipSync(Buffer.from(await download(entry.resolved))));
  const index = entries.find(({ header }) => header.name === INDEX);
  const page = await readFile(new URL('fixtures/camera-page.mjs', import.meta.url));
  const tarball = gzipSync(
    await packTar([
      ...entries.map((one) =>
        one === index ? { ...one, header: { ...one.header, name: 'package/page/real.mjs' } } : one
      ),
      { header: { ...index.header, size: page.byteLength }, data: new Uint8Array(page) },
    ])
  );
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const bodies = await Promise.all(
    LOCKS.map(async (path) => [path, (await source(path)).replaceAll(entry.integrity, integrity)])
  );
  await fakeRegistry(chrome.cdp, [
    { serve: async (url) => (url === entry.resolved ? tarball : null) },
  ]);
  return () => {
    for (const [path, body] of bodies) chrome.overrides.set(path, body);
  };
}
