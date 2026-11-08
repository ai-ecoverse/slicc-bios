import { createHash } from 'node:crypto';

export const BACKOFFS_MS = [1000, 3000];
const GITHUB_RELEASE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/;

export const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authHeaders() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function checkSha(url, zip, sha256, want = 'want') {
  const sum = createHash('sha256').update(zip).digest('hex');
  if (sum !== sha256) throw new Error(`${url}: sha256 ${sum}, ${want} ${sha256}`);
  return zip;
}

export async function retried(once, sleep = sleepDefault) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await once();
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
      if (/: HTTP [1-4]\d\d$/.test(last.message)) throw last;
    }
    if (attempt === 2) break;
    await sleep(BACKOFFS_MS[attempt]);
  }
  throw last;
}

export async function githubAsset(owner, repo, tag, name, doFetch, init = {}) {
  const tagUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;
  const release = await doFetch(tagUrl, {
    ...init,
    headers: { Accept: 'application/vnd.github+json', ...authHeaders(), ...init.headers },
  });
  if (!release.ok) throw new Error(`${tagUrl}: HTTP ${release.status}`);
  const body = await release.json();
  const asset = (body.assets ?? []).find((item) => item.name === name);
  if (!asset?.url) throw new Error(`${tagUrl}: no ${name} asset`);
  const response = await doFetch(asset.url, {
    ...init,
    headers: { Accept: 'application/octet-stream', ...authHeaders(), ...init.headers },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${asset.url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export function parseGithubRelease(url) {
  const match = GITHUB_RELEASE.exec(url);
  if (!match) return null;
  return { owner: match[1], repo: match[2], tag: match[3], name: match[4] };
}

export async function fetchReleaseBytes(url, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? sleepDefault;
  const init = deps.init ?? {};
  try {
    return await retried(async () => {
      const response = await doFetch(url, init);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    }, sleep);
  } catch (error) {
    const releaseError = error instanceof Error ? error : new Error(String(error));
    const parsed = parseGithubRelease(url);
    if (!parsed) throw releaseError;
    console.error(
      `harness: github.com release download failed (${releaseError.message}), using the API`
    );
    try {
      return await githubAsset(parsed.owner, parsed.repo, parsed.tag, parsed.name, doFetch, init);
    } catch (api) {
      const apiError = api instanceof Error ? api : new Error(String(api));
      throw new Error(
        `github.com release and API downloads failed: ${releaseError.message}; ${apiError.message}`
      );
    }
  }
}

export async function fetchExtension(extension, deps = {}) {
  const zip = await fetchReleaseBytes(extension.url, deps);
  return checkSha(extension.url, zip, extension.sha256, 'want');
}
