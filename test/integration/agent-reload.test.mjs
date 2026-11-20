import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { agentUp, ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ tools: false, agent: true, timeout: 60000 });
after(() => chrome.close());

const LINE = 'Seven is starting its agent.';

const column = () => {
  const { dock } = document.querySelector('slicc-app');
  const left = (group) => Math.round(group.element.getBoundingClientRect().left);
  const chat = dock.api.panels.find((item) => item.id.startsWith('chat:'));
  if (!chat) return null;
  const lefts = new Set(dock.api.groups.map(left));
  return [...lefts].filter((at) => at < left(chat.group)).length;
};

function watch() {
  window.watched = [];
  const look = () => {
    const app = document.querySelector('slicc-app');
    const agent = app?.model?.agent;
    if (agent && app.dock?.api && !agent.list().length)
      window.watched.push({
        starting: agent.starting?.() ?? null,
        note: !!app.dock.content('agents')?.shadowRoot?.querySelector('[data-empty=starting]'),
      });
    if (!agent?.list().length) setTimeout(look, 10);
  };
  look();
}

test('a reload says the agent is starting until it lists its cones, asks to keep Install / Update closed, and its chat comes back in the same column', {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.goto('/');
  await ready(page);
  const cold = await page.evaluate(() =>
    document.querySelector('slicc-app').model.updates.opensAtBoot()
  );
  await agentUp(page);
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    app.show('agents');
    app.show('chat');
  });
  await page.until(() => {
    const { dock } = document.querySelector('slicc-app');
    return dock.has('agents') && dock.api.panels.some((panel) => panel.id.startsWith('chat:'));
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = await page.evaluate(column);
  await page.init(watch);
  await page.reload();
  await ready(page, undefined, { tools: false });
  const warm = await page.evaluate(() =>
    document.querySelector('slicc-app').model.updates.opensAtBoot()
  );
  await agentUp(page, { label: 'agent after the reload' });
  await page.until(() => document.querySelector('slicc-app').model.agent.list().length > 0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const watched = await page.evaluate(() => window.watched);
  assert.ok(watched.length > 0, 'the page never showed an agent port without cones');
  assert.deepEqual(
    watched.filter((seen) => seen.starting !== LINE),
    [],
    'an agent port without cones had no starting line'
  );
  assert.ok(
    watched.some((seen) => seen.note),
    'Agents never said the agent shows up once it starts'
  );
  assert.equal(await page.evaluate(column), before);
  assert.deepEqual({ cold, warm }, { cold: true, warm: false });
  assert.deepEqual(page.errors, []);
});
