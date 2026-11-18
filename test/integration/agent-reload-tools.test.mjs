import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { agentUp, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeCatalog } from './fake-catalog.mjs';

const chrome = await launch({ agent: true, intercept: [], timeout: 120000 });
const registry = await fakeCatalog(chrome.cdp);
after(() => chrome.close());

const METADATA = /^https:\/\/registry\.npmjs\.org\/(?!.*\/-\/[^/]+\.tgz$)/;

test('a reload with every tool installed starts the agent at once: npm doesn’t answer the tools round, and the agent attaches while the round still waits', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  await agentUp(page);
  registry.hold = METADATA;
  const asked = registry.asked.length;
  await page.reload();
  await ready(page, undefined, { tools: false });
  await agentUp(page, { budget: 60 * 1000, label: 'agent after the reload' });
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.tools),
    'installing',
    'the tools round is still waiting for npm'
  );
  assert.ok(
    registry.asked.slice(asked).some((url) => METADATA.test(url)),
    'the tools round asked npm after the reload'
  );
  assert.deepEqual(page.errors, []);
});
