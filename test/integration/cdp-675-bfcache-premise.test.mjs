import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');

test('BFCache raw observer records the actual failed protected navigation, not an invented guard cause', () => {
  const observer = source.match(
    /unobserve = chrome.cdp.on\(([\s\S]*?)\);\s*await chrome.cdp.send\('Network.enable'/
  )[1];
  const row = { rawRedirects: [], rawFrames: [], rawLoads: [], rawWorlds: [], rawNetwork: [] };
  const receive = vm.runInNewContext(`(${observer})`, { row, rawSession: 'owned', Date });
  receive({
    method: 'Network.requestWillBeSent',
    sessionId: 'owned',
    params: {
      type: 'Document',
      requestId: 'seed',
      request: { url: 'https://vault.sliccy.ai/bfcache?n=own' },
    },
  });
  receive({
    method: 'Network.loadingFailed',
    sessionId: 'owned',
    params: {
      type: 'Document',
      requestId: 'seed',
      errorText: 'net::ERR_CONNECTION_RESET',
      canceled: false,
    },
  });
  receive({
    method: 'Network.loadingFailed',
    sessionId: 'other',
    params: { requestId: 'foreign', errorText: 'not owned' },
  });
  assert.equal(row.rawDocumentRequests[0].requestId, 'seed');
  assert.equal(row.rawNetworkFailures.length, 1);
  assert.equal(row.rawNetworkFailures[0].errorText, 'net::ERR_CONNECTION_RESET');
});

test('BFCache seed premise is explicit, success only follows prepare, and failure stays setup-failure', async () => {
  const start = source.indexOf(
    '            try {\n              row.bfcache = await deadline.wait'
  );
  const end = source.indexOf('            row.bfcache.ordinaryHistoryOnly', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  for (const fails of [false, true]) {
    const row = { setupChecks: [], step: 'create-ordinary-target' };
    const answer = { protectedEntry: 2, ordinaryEntry: 3 };
    const error = new Error('bfcache-restore: protected seed did not commit');
    const context = vm.createContext({
      row,
      deadline: { wait: (run) => run() },
      bfcacheDriver: {
        async prepare() {
          if (fails) throw error;
          return answer;
        },
      },
    });
    const run = vm.runInContext(`(async () => { ${block} })`, context);
    if (fails) await assert.rejects(run(), (thrown) => thrown === error);
    else {
      await run();
      assert.equal(row.bfcache, answer);
    }
    assert.equal(row.setupChecks[0].pass, !fails);
    assert.equal(row.step, 'create-ordinary-target');
  }
});
