import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
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

const WARM_PROMPT = 11000;
const FIRST_UI = 2000;

function promptStamp() {
  const tick = () => {
    const app = document.querySelector('slicc-app');
    if (app?.dock && location.pathname === '/os/') window.sliccUiAt ??= Date.now();
    const id = app?.dock?.api.panels
      .map((panel) => panel.id)
      .findLast((name) => name.startsWith('terminal:'));
    const text = id ? (app.dock.content(id)?.screen?.textContent ?? '') : '';
    if (/slicc:(~\$|\/home#) /.test(text)) {
      window.sliccPromptAt = Date.now();
      return;
    }
    if (id && !window.sliccTerminalShown) {
      window.sliccTerminalShown = true;
      app.dock.api.getPanel(id)?.api.setActive();
    }
    setTimeout(tick, 50);
  };
  tick();
}

const transforms = (page) =>
  page.evaluate(() => {
    const out = { cached: 0, redone: [] };
    for (const entry of performance.getEntriesByType('resource')) {
      const timing = entry.serverTiming.find(({ name }) => name === 'transform');
      if (!timing) continue;
      if (timing.description === 'cached') out.cached += 1;
      else out.redone.push(new URL(entry.name).pathname);
    }
    return out;
  });

async function idle(page) {
  await page.within(AGENT_BUDGET, () => {
    const rows = document.querySelector('slicc-app')?.model?.updates?.list?.() ?? [];
    return (
      rows.length > 0 &&
      rows.every((row) => !/queued|starting|checking|downloading|linking/.test(row.state))
    );
  });
}

describe('a cold agent install runs in the page’s one kernel with no package scripts, an optional install waits on the pnpm store, the next reload re-transforms none of seven’s own modules, and a steady reload shows the prompt within 11 s', () => {
  let page;
  let finish;
  let ui;
  let kept;
  after(() => finish?.());
  before(async () => {
    page = await chrome.page({
      name: 'one kernel',
      filePath: import.meta.filename,
      after: (fn) => {
        finish = fn;
      },
    });
  });

  test('a cold agent install runs in the page’s one kernel with no package scripts, and an optional install waits on the pnpm store', async () => {
    await page.init(watchKernels);
    await page.init(promptStamp);
    await page.init(() => performance.setResourceTimingBufferSize(20000));
    await boot(page, undefined, { tools: false });
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
  });

  test('the first reload after the agent install re-transforms none of seven’s own modules', async () => {
    await idle(page);
    const first = Date.now();
    await page.reload();
    ui = (await page.within(120000, () => window.sliccUiAt)) - first;
    await page.within(120000, () => window.sliccPromptAt);
    assert.ok(ui < FIRST_UI, `the first reload after the agent install took ${ui} ms to the UI`);
    kept = await transforms(page);
    assert.ok(
      kept.cached > 0,
      'the first reload after the agent install served no cached transform'
    );
    assert.deepEqual(
      kept.redone.filter((path) => !path.startsWith('/opt/agent/')),
      [],
      'the agent install dropped transforms of modules outside /opt/agent/'
    );
    assert.deepEqual(page.errors, []);
  });

  test('a steady reload shows the prompt within 11 s', async (t) => {
    await idle(page);
    const start = Date.now();
    await page.reload();
    const steady = (await page.within(120000, () => window.sliccUiAt)) - start;
    const took = (await page.within(120000, () => window.sliccPromptAt)) - start;
    t.diagnostic(
      `first reload after the agent install to the UI: ${ui} ms (bound ${FIRST_UI} ms; a steady reload ${steady} ms), ${kept.cached} transforms cached`
    );
    t.diagnostic(`warm reload to the terminal prompt: ${took} ms (bound ${WARM_PROMPT} ms)`);
    assert.ok(
      took < WARM_PROMPT,
      `a steady-state warm reload took ${took} ms to the terminal prompt`
    );
    assert.deepEqual(page.errors, []);
  });
});
