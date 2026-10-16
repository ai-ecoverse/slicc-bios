import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { agentUp, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const KERNEL = 'node_modules/@ai-ecoverse/slicc-kernel';
const OLD = {
  version: '1.67.1',
  resolved: 'https://registry.npmjs.org/@ai-ecoverse/slicc-kernel/-/slicc-kernel-1.67.1.tgz',
  integrity:
    'sha512-Z7ylHfrgkjf1pR7GSMLeg00QuohB8RBASTQYX9c5mhIprFuKRn473l+1epiwO+rLUMI7ON/gq2kQiSDaTPrrgQ==',
};

const chrome = await launch({ timeout: 120000, agent: true });
after(() => chrome.close());

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    try {
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return '';
    }
  }, path);
}

function olderLock(shipped) {
  const lock = structuredClone(shipped);
  lock.packages[KERNEL] = { ...lock.packages[KERNEL], ...OLD };
  return lock;
}

test('a profile whose /opt/agent was installed on kernel 1.67.1 keeps its bin scripts runnable under enforce on a /meta kernel', {
  timeout: 45 * 60 * 1000,
}, async (t) => {
  const { readFileSync } = await import('node:fs');
  const shipped = JSON.parse(
    readFileSync(new URL('../../src/packages/package-lock.json', import.meta.url), 'utf8')
  );
  const page = await chrome.page(t);
  const current = chrome.overrides.get('/packages/package-lock.json');
  chrome.overrides.set('/packages/package-lock.json', JSON.stringify(olderLock(shipped)));
  await page.goto('/#users=off');
  await ready(page, ['slicc:/home# ']);
  await agentUp(page, { label: 'agent on kernel 1.67.1' });
  if (current) chrome.overrides.set('/packages/package-lock.json', current);
  else chrome.overrides.delete('/packages/package-lock.json');
  chrome.cdn.requests.length = 0;
  await page.goto('/#users=enforce');
  await ready(page, ['slicc:/home# ']);
  const kernel = JSON.parse(await read(page, `${KERNEL}/package.json`));
  if (!kernel.exports?.['./meta']) {
    t.skip(`slicc-kernel ${kernel.version} has no /meta`);
    return;
  }
  const fetched = chrome.cdn.requests.filter((url) => url.endsWith('.tgz'));
  t.diagnostic(`the repair fetched ${fetched.length} tarballs: ${fetched.join(' ')}`);
  await agentUp(page, { label: 'agent after the repair' });
  await run(
    page,
    'clear; ls /opt/agent/node_modules/.bin | head -3; for b in /opt/agent/node_modules/.bin/*; do [ -x "$b" ] || echo "noexec $b"; done; b=$(ls /opt/agent/node_modules/.bin | head -1); stat -L -c \'%a %n\' "/opt/agent/node_modules/.bin/$b"; sudo -u cone "/opt/agent/node_modules/.bin/$b" --version > /dev/null 2>&1; echo ran=$?; i --help > /dev/null 2>&1; echo i=$?; echo bins-$((40 + 2))'
  );
  await shows(page, 'bins-42', 5 * 60 * 1000);
  const text = await screen(page);
  t.diagnostic(text.replace(/\s+/g, ' ').slice(0, 600));
  assert.doesNotMatch(text, /noexec/);
  assert.doesNotMatch(text, /ran=126/);
  assert.match(text, /i=0/);
  assert.deepEqual(page.errors, []);
});
