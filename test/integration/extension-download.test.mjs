import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fetchExtension } from './extension-download.mjs';

const BYTES = Buffer.from('slicc-extension-zip-body');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const EXTENSION = {
  version: '7.12.2',
  url: 'https://github.com/ai-ecoverse/slicc-extension/releases/download/v7.12.2/slicc-extension.zip',
  sha256: SHA,
};
const TAG = 'https://api.github.com/repos/ai-ecoverse/slicc-extension/releases/tags/v7.12.2';
const ASSET_API =
  'https://api.github.com/repos/ai-ecoverse/slicc-extension/releases/assets/711554509';

const ok = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async arrayBuffer() {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  },
  async json() {
    return JSON.parse(body.toString());
  },
});

const json = (value, status = 200) => ok(Buffer.from(JSON.stringify(value)), status);

test('release 504 thrice then API zip with matching sha returns bytes and logs fallback', async () => {
  const calls = [];
  const sleeps = [];
  const lines = [];
  const error = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const zip = await fetchExtension(EXTENSION, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (url === EXTENSION.url) return ok(Buffer.from('no'), 504);
        if (url === TAG) return json({ assets: [{ name: 'slicc-extension.zip', url: ASSET_API }] });
        if (url === ASSET_API) {
          assert.equal(init?.headers?.Accept, 'application/octet-stream');
          return ok(BYTES);
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    assert.deepEqual(zip, BYTES);
  } finally {
    console.error = error;
  }
  assert.deepEqual(
    calls.map((call) => call.url),
    [EXTENSION.url, EXTENSION.url, EXTENSION.url, TAG, ASSET_API]
  );
  assert.deepEqual(sleeps, [1000, 3000]);
  assert.match(
    lines.join('\n'),
    /harness: github\.com release download failed \(.*HTTP 504.*\), using the API/
  );
});

test('release 200 returns the zip and never calls the API', async () => {
  const calls = [];
  const zip = await fetchExtension(EXTENSION, {
    fetch: async (url) => {
      calls.push(String(url));
      assert.equal(url, EXTENSION.url);
      return ok(BYTES);
    },
  });
  assert.deepEqual(zip, BYTES);
  assert.deepEqual(calls, [EXTENSION.url]);
});

test('API zip whose sha does not match fails with the sha message', async () => {
  await assert.rejects(
    () =>
      fetchExtension(EXTENSION, {
        sleep: async () => {},
        fetch: async (url) => {
          if (url === EXTENSION.url) return ok(Buffer.from('no'), 504);
          if (url === TAG)
            return json({ assets: [{ name: 'slicc-extension.zip', url: ASSET_API }] });
          if (url === ASSET_API) return ok(Buffer.from('wrong-bytes'));
          throw new Error(`unexpected ${url}`);
        },
      }),
    (error) => {
      assert.match(error.message, new RegExp(`${EXTENSION.url}: sha256 [a-f0-9]{64}, want ${SHA}`));
      return true;
    }
  );
});

test('release 404 is not retried before the API path', async () => {
  const calls = [];
  const sleeps = [];
  await fetchExtension(EXTENSION, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: async (url) => {
      calls.push(String(url));
      if (url === EXTENSION.url) return ok(Buffer.from('missing'), 404);
      if (url === TAG) return json({ assets: [{ name: 'slicc-extension.zip', url: ASSET_API }] });
      if (url === ASSET_API) return ok(BYTES);
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.deepEqual(calls, [EXTENSION.url, TAG, ASSET_API]);
  assert.deepEqual(sleeps, []);
});

test('release and API both 504 names both failures', async () => {
  await assert.rejects(
    () =>
      fetchExtension(EXTENSION, {
        sleep: async () => {},
        fetch: async (url) => {
          if (url === EXTENSION.url) return ok(Buffer.from('no'), 504);
          if (url === TAG) return ok(Buffer.from('no'), 504);
          throw new Error(`unexpected ${url}`);
        },
      }),
    (error) => {
      assert.match(
        error.message,
        /github\.com release and API downloads failed: .*HTTP 504.*; .*HTTP 504/
      );
      return true;
    }
  );
});
