import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const QUIET = 50;
const MISSED = 95;
const BOUND = 120;
const MARGIN = 30;
const HOST = 'quiet.example.test';

const open = new Set();
const server = createServer((request, response) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*',
  };
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors);
    response.end();
    return;
  }
  response.writeHead(200, { ...cors, 'content-type': 'text/plain', 'cache-control': 'no-store' });
  response.flushHeaders();
  open.add(response);
  response.on('close', () => open.delete(response));
  if (request.url === '/missed') response.write('keepalive\n');
  const delay = { '/quiet': QUIET, '/missed': MISSED }[request.url];
  if (delay === undefined) return;
  const timer = setTimeout(() => response.end(`spoke after ${delay} s\n`), delay * 1000);
  response.on('close', () => clearTimeout(timer));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://${HOST}:${server.address().port}`;

const chrome = await launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
after(async () => {
  for (const response of open) response.destroy();
  server.close();
  await chrome.close();
});

test(`under the page fetch, a response body quiet for ${QUIET} s, or for ${MISSED} s after a keepalive (one missed 45 s keepalive plus latency), still arrives, and one silent past ${BOUND} s still fails within the bound`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.transport), 'page');
  await run(
    page,
    `clear; for name in quiet missed silent; do ( start=$(date +%s); curl -sS --max-time ${BOUND + MARGIN + 20} ${url}/$name > /tmp/$name.out 2> /tmp/$name.err; echo "$name rc=$? after $(( $(date +%s) - start )) s" > /tmp/$name.done ) & done; wait; cat /tmp/quiet.done /tmp/missed.done /tmp/silent.done /tmp/quiet.out /tmp/missed.out /tmp/quiet.err /tmp/missed.err /tmp/silent.err; echo fetched-$((40 + 2))`
  );
  await shows(page, 'fetched-42', (BOUND + MARGIN + 40) * 1000);
  const text = await screen(page);
  const quiet = text.match(/quiet rc=(\d+) after (\d+) s/);
  const missed = text.match(/missed rc=(\d+) after (\d+) s/);
  const silent = text.match(/silent rc=(\d+) after (\d+) s/);
  assert.ok(quiet && missed && silent, text);
  assert.equal(quiet[1], '0', text);
  assert.ok(+quiet[2] >= QUIET - 1, text);
  assert.ok(text.includes(`spoke after ${QUIET} s`), text);
  assert.equal(missed[1], '0', text);
  assert.ok(+missed[2] >= MISSED - 1, text);
  assert.ok(text.includes(`spoke after ${MISSED} s`), text);
  assert.notEqual(silent[1], '0', text);
  assert.ok(+silent[2] >= BOUND - 5 && +silent[2] <= BOUND + MARGIN, text);
  assert.deepEqual(page.errors, []);
});
