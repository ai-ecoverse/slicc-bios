import { createHash } from 'node:crypto';

const BACKOFFS_MS = [1000, 3000];
const ASSET = 'slicc-extension.zip';
const API = 'https://api.github.com/repos/ai-ecoverse/slicc-extension/releases/tags';

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authHeaders() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function checkSha(extension, zip) {
  const sum = createHash('sha256').update(zip).digest('hex');
  if (sum !== extension.sha256)
    throw new Error(`${extension.url}: sha256 ${sum}, want ${extension.sha256}`);
  return zip;
}

async function fromRelease(extension, doFetch, sleep) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await doFetch(extension.url);
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      last = new Error(`${extension.url}: HTTP ${response.status}`);
      if (response.status < 500 || response.status > 599) throw last;
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
      if (/: HTTP [1-4]\d\d$/.test(last.message)) throw last;
    }
    if (attempt === 2) break;
    await sleep(BACKOFFS_MS[attempt]);
  }
  throw last;
}

async function fromApi(extension, doFetch) {
  const tagUrl = `${API}/v${extension.version}`;
  const release = await doFetch(tagUrl, {
    headers: { Accept: 'application/vnd.github+json', ...authHeaders() },
  });
  if (!release.ok) throw new Error(`${tagUrl}: HTTP ${release.status}`);
  const body = await release.json();
  const asset = (body.assets ?? []).find((item) => item.name === ASSET);
  if (!asset?.url) throw new Error(`${tagUrl}: no ${ASSET} asset`);
  const response = await doFetch(asset.url, {
    headers: { Accept: 'application/octet-stream', ...authHeaders() },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${asset.url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchExtension(extension, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? sleepDefault;
  let zip;
  let releaseError;
  try {
    zip = await fromRelease(extension, doFetch, sleep);
  } catch (error) {
    releaseError = error instanceof Error ? error : new Error(String(error));
  }
  if (zip) return checkSha(extension, zip);
  console.error(
    `harness: github.com release download failed (${releaseError.message}), using the API`
  );
  try {
    zip = await fromApi(extension, doFetch);
  } catch (error) {
    const apiError = error instanceof Error ? error : new Error(String(error));
    throw new Error(
      `github.com release and API downloads failed: ${releaseError.message}; ${apiError.message}`
    );
  }
  return checkSha(extension, zip);
}
