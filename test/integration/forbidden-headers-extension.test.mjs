import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import {
  curlArgs,
  DUMMY_COOKIE,
  echoed,
  headerFetch,
  ORDINARY,
  startEcho,
} from './header-echo.mjs';
import { CURRENT_EXTENSION, realExtension, SEVEN } from './real-extension.mjs';

const REFERER = 'https://referer.test/page';
const CARRIED = { Cookie: DUMMY_COOKIE, Referer: REFERER };
const echo = await startEcho();
const real = await realExtension({ extension: CURRENT_EXTENSION });
after(async () => {
  await echo.close();
  await real.close();
});

async function seven(t) {
  const page = await real.page(t);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await page.goto(SEVEN);
  await ready(page);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.transport), 'extension');
  assert.equal(
    await page.evaluate(() => globalThis.sliccExtension.version),
    CURRENT_EXTENSION.version
  );
  return { page, ...(await headerFetch(page)) };
}

const health = (page) =>
  page.evaluate(() => document.querySelector('slicc-app').model.network.status().health);

test(`slicc-extension ${CURRENT_EXTENSION.version} delivers Cookie and Referer from a JS program's fetch and from curl, and ordinary headers as before (#1485)`, async (t) => {
  const { fetchWith, sh } = await seven(t);
  const seen = echoed(await fetchWith(`${echo.url}/extension-cookie`, { ...ORDINARY, ...CARRIED }));
  assert.equal(seen['x-probe'], 'visible');
  assert.equal(seen.cookie, DUMMY_COOKIE);
  assert.equal(seen.referer, REFERER);

  const plain = echoed(await fetchWith(`${echo.url}/extension-ordinary`, ORDINARY));
  assert.equal(plain['x-probe'], 'visible');
  assert.equal(plain.cookie, undefined);

  const curl = await sh(
    `curl -sS ${curlArgs({ ...ORDINARY, ...CARRIED })} ${echo.url}/extension-curl`
  );
  assert.equal(curl.status, 0, curl.stderr);
  const viaCurl = JSON.parse(curl.stdout);
  assert.equal(viaCurl['x-probe'], 'visible');
  assert.equal(viaCurl.cookie, DUMMY_COOKIE);
  assert.equal(viaCurl.referer, REFERER);
});

test(`a forbidden header slicc-extension ${CURRENT_EXTENSION.version} can't send gets the kernel's forbidden-header refusal, is never sent, and leaves the extension route green (#1485)`, async (t) => {
  const { page, fetchWith, sh } = await seven(t);
  const refused = await fetchWith(`${echo.url}/extension-dnt`, {
    ...ORDINARY,
    Cookie: DUMMY_COOKIE,
    DNT: '1',
  });
  assert.equal(refused.name, 'TypeError', JSON.stringify(refused));
  assert.equal(refused.message, 'fetch failed');
  assert.equal(refused.cause.code, 'ENOTSUP');
  assert.equal(refused.cause.detail, 'forbidden-header');
  assert.match(
    refused.cause.message,
    /refused: slicc-extension can't send the request header dnt, so it was not sent/
  );
  assert.ok(!refused.cause.message.includes(DUMMY_COOKIE));
  assert.deepEqual(echo.reached('/extension-dnt'), []);

  const curl = await sh(
    `curl -sS -w ' %{http_code}' ${curlArgs({ ...ORDINARY, DNT: '1' })} ${echo.url}/extension-dnt-curl`
  );
  assert.match(curl.stdout, /slicc-extension can't send the request header dnt/);
  assert.match(curl.stdout, / 502$/);
  assert.deepEqual(echo.reached('/extension-dnt-curl'), []);
  assert.equal(await health(page), 'ok');
  assert.deepEqual(page.errors, []);
});
