import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const DOC = 'https://registry.npmjs.org/@ai-ecoverse/wasm-xxd/latest';

async function failing(page, times) {
  const hits = [];
  const stop = chrome.cdp.on(async ({ method, params, sessionId }) => {
    if (method !== 'Fetch.requestPaused' || params.request.url !== DOC) return;
    hits.push(Date.now());
    if (hits.length <= times)
      return chrome.cdp
        .send(
          'Fetch.fulfillRequest',
          {
            requestId: params.requestId,
            responseCode: 502,
            responseHeaders: [{ name: 'access-control-allow-origin', value: '*' }],
            body: Buffer.from('bad gateway').toString('base64'),
          },
          sessionId
        )
        .catch(() => undefined);
    return chrome.cdp
      .send('Fetch.continueRequest', { requestId: params.requestId }, sessionId)
      .catch(() => undefined);
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: DOC, requestStage: 'Request' }] });
  return {
    hits,
    async done() {
      stop?.();
      await page.send('Fetch.disable');
    },
  };
}

const xxd = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .find((item) => item.id === 'xxd')
  );

test('a catalog install whose npm version doc answers 502 once is retried and installs', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'xxd' && item.offered)
  );
  const blip = await failing(page, 1);
  try {
    assert.equal(await actPackage(page, 'xxd', 'install'), 'ok', (await xxd(page))?.log);
  } finally {
    await blip.done();
  }
  assert.equal((await xxd(page)).state, 'installed');
  assert.ok(blip.hits.length >= 2, 'one 502, then another try');
  assert.ok(blip.hits[1] - blip.hits[0] >= 400, 'the retry waited before it asked again');
  assert.deepEqual(page.errors, []);
});

test('when npm keeps answering 502, the install stops after three tries in a few seconds and says it couldn’t reach npm', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'xxd' && item.offered)
  );
  const outage = await failing(page, Number.POSITIVE_INFINITY);
  let result;
  try {
    result = await actPackage(page, 'xxd', 'install');
  } finally {
    await outage.done();
  }
  assert.equal(result, "Couldn't reach npm for xxd's version. Retry.");
  assert.equal(outage.hits.length, 3);
  assert.ok(outage.hits[2] - outage.hits[0] < 10000, `${outage.hits.at(-1) - outage.hits[0]} ms`);
  assert.notEqual((await xxd(page)).state, 'installed');
  assert.deepEqual(page.errors, []);
});
