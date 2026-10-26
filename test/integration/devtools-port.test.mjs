import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { devtools, launch } from './chrome.mjs';

const launched = [];
after(() => {
  for (const chrome of launched) chrome.close();
});

const version = async (port) => {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  return response.ok ? (await response.json()).webSocketDebuggerUrl : `HTTP ${response.status}`;
};

test('a second Chrome finds the DevTools port it bound itself, so a port another server took in between is never mistaken for it (#1076)', async () => {
  const taken = createServer((req, res) => res.writeHead(404).end());
  await new Promise((resolve) => taken.listen(0, '127.0.0.1', resolve));
  after(() => taken.close());
  const busy = taken.address().port;
  assert.equal(await version(busy), 'HTTP 404', 'the stand-in for the harness server answers 404');
  const first = await launch();
  launched.push(first);
  const second = await launch();
  launched.push(second);
  const one = await devtools(first);
  const two = await devtools(second);
  assert.notEqual(one.port, two.port);
  for (const { port, browser } of [one, two]) {
    assert.notEqual(port, busy);
    assert.equal(await version(port), browser, `port ${port} is this Chrome's DevTools`);
  }
});

test('when Chrome writes no DevTools port, devtools fails saying which file it waited for', async () => {
  await assert.rejects(devtools({ profile: '/nonexistent-profile' }, 300), {
    message:
      'Chrome wrote no DevTools port to /nonexistent-profile/DevToolsActivePort in 300 ms; it holds: null',
  });
});
