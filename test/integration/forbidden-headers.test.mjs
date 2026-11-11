import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import {
  curlArgs,
  DUMMY_COOKIE,
  echoed,
  headerFetch,
  ORDINARY,
  startEcho,
} from './header-echo.mjs';

const echo = await startEcho();
const chrome = await launch();
after(async () => {
  await echo.close();
  await chrome.close();
});

async function seven(t) {
  const page = await chrome.page(t);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await page.goto('/');
  await ready(page);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.transport), 'page');
  return { page, ...(await headerFetch(page)) };
}

test("on the page route, a JS program's fetch with Cookie gets the kernel's forbidden-header refusal and is never sent, and ordinary headers still arrive (#1485)", async (t) => {
  const { page, fetchWith } = await seven(t);
  const refused = await fetchWith(`${echo.url}/page-cookie`, { ...ORDINARY, Cookie: DUMMY_COOKIE });
  assert.equal(refused.name, 'TypeError', JSON.stringify(refused));
  assert.equal(refused.message, 'fetch failed');
  assert.equal(refused.cause.code, 'ENOTSUP');
  assert.equal(refused.cause.detail, 'forbidden-header');
  assert.match(
    refused.cause.message,
    /refused: the page's fetch can't send the request header cookie, so it was not sent/
  );
  assert.ok(!refused.cause.message.includes(DUMMY_COOKIE), 'the refusal names the cookie value');
  assert.deepEqual(echo.reached('/page-cookie'), [], 'the refused request reached the server');

  const seen = echoed(await fetchWith(`${echo.url}/page-ordinary`, ORDINARY));
  assert.equal(seen['x-probe'], 'visible');
  assert.equal(seen.cookie, undefined);
  assert.equal(echo.reached('/page-ordinary').length, 1);
  assert.deepEqual(page.errors, []);
});

test('on the page route, curl with Cookie gets a 502 naming it and nothing is sent, while curl --compressed with ordinary headers and a User-Agent still goes, without the User-Agent (#1485, #1203)', async (t) => {
  const { sh } = await seven(t);
  const refused = await sh(
    `curl -sS -w ' %{http_code}' ${curlArgs({ ...ORDINARY, Cookie: DUMMY_COOKIE })} ${echo.url}/curl-cookie`
  );
  assert.match(refused.stdout, /can't send the request header cookie, so it was not sent/);
  assert.match(refused.stdout, / 502$/);
  assert.ok(!refused.stdout.includes(DUMMY_COOKIE));
  assert.deepEqual(echo.reached('/curl-cookie'), []);

  const plain = await sh(
    `curl -sS --compressed -A probe-agent ${curlArgs(ORDINARY)} ${echo.url}/curl-ordinary`
  );
  assert.equal(plain.status, 0, plain.stderr);
  const seen = JSON.parse(plain.stdout);
  assert.equal(seen['x-probe'], 'visible');
  assert.notEqual(seen['user-agent'], 'probe-agent');
  assert.equal(echo.reached('/curl-ordinary').length, 1);
});
