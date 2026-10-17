import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AGENT_BUDGET, actPackage, agentUp, boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000, agent: true });
after(() => chrome.close());

function watchKernels() {
  const sample = () => {
    const model = document.querySelector('slicc-app')?.model;
    const agent = model?.updates?.list?.().find((item) => item.id === 'agent');
    const rsync = model?.updates?.packages?.().find((item) => item.id === 'rsync');
    window.sliccSamples.push({
      agent: agent?.state ?? null,
      agentProgress: agent?.progress
        ? `${agent.progress.phase} ${agent.progress.done} of ${agent.progress.total}`
        : null,
      rsync: rsync?.state ?? null,
    });
  };
  window.sliccSamples = [];
  setInterval(sample, 100);
  const Native = window.Worker;
  const seen = { made: 0, live: 0, peak: 0 };
  window.sliccKernelWorkers = seen;
  window.Worker = class extends Native {
    constructor(url, options) {
      super(url, options);
      if (options?.name !== 'slicc-kernel') return;
      seen.made += 1;
      seen.live += 1;
      seen.peak = Math.max(seen.peak, seen.live);
      const end = this.terminate.bind(this);
      let ended = false;
      this.terminate = () => {
        if (!ended) {
          ended = true;
          seen.live -= 1;
        }
        end();
      };
    }
  };
}

test('a cold agent install runs in the page’s one kernel with no package scripts, and an optional install started during it waits its turn on the pnpm store', async (t) => {
  const page = await chrome.page(t);
  await page.init(watchKernels);
  await boot(page);
  await page.within(
    300000,
    () =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === 'rsync') &&
      document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === 'agent')?.progress
  );
  await run(
    page,
    "clear; ps -e -o args | grep '^pnpm install' | sed 's/^/seen: /'; echo listed-$((40 + 2))"
  );
  await shows(page, 'listed-42', 120000);
  const screen = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    return dock.content(
      dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'))
    ).screen.textContent;
  });
  const seen = screen.match(/seen: (pnpm install[^\n]*?)(?=\s{2,}|seen:|listed-42)/)?.[1] ?? '';
  assert.match(seen, /--frozen-lockfile/, screen);
  assert.match(seen, /--ignore-scripts/, screen);
  assert.match(seen, /--ignore-pnpmfile/, screen);
  const optional = actPackage(page, 'rsync', 'install', {
    budget: AGENT_BUDGET,
    stall: AGENT_BUDGET,
  });
  await agentUp(page);
  assert.equal(await optional, 'ok');
  const kernels = await page.evaluate(() => window.sliccKernelWorkers);
  const samples = await page.evaluate(() => window.sliccSamples);
  assert.equal(kernels.peak, 1, `kernels on the root at once: ${JSON.stringify(kernels)}`);
  assert.equal(kernels.made, 1, `kernels made: ${JSON.stringify(kernels)}`);
  const done = samples.findIndex((s) => s.rsync === 'installed');
  const busy = samples.findLastIndex(
    (s, i) => s.agentProgress && i > 0 && s.agentProgress !== samples[i - 1].agentProgress
  );
  assert.ok(
    busy >= 0 && done > busy,
    `rsync installed at sample ${done}, the agent's pnpm last moved at ${busy}: ${JSON.stringify(samples.slice(Math.max(0, Math.min(done, busy) - 3), Math.max(done, busy) + 2))}`
  );
  assert.deepEqual(page.errors, []);
});
