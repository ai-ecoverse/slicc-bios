import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { after } from 'node:test';
import { debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';
import { fakeRegistry, fakeRelease } from './fake-npm.mjs';

export const AGENT = '@ai-ecoverse/slicc-agent';
export const PINNED = JSON.parse(
  await readFile(new URL('../../src/packages/agent/package.json', import.meta.url), 'utf8')
).dependencies[AGENT];
export const BETA = '6.99.0';
export const ELSEWHERE = 'Only the tab running SLICC can install a beta or leave one.';

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
export const release = await fakeRelease({
  name: AGENT,
  from: PINNED,
  version: BETA,
  repository: 'https://github.com/ai-ecoverse/slicc-agent',
});
export const chrome = await launch({
  agent: true,
  timeout: 120000,
  intercept: [],
  args: [`--remote-debugging-port=${port}`],
});
after(() => chrome.close());
export const clipboard = await fakeRelease({
  name: '@ai-ecoverse/slicc-clipboard',
  from: '1.0.2',
  version: '1.0.99',
  repository: 'https://github.com/ai-ecoverse/slicc-clipboard',
});
export const tainted = await fakeRelease({
  name: AGENT,
  from: PINNED,
  version: '6.98.0',
  repository: 'https://github.com/ai-ecoverse/slicc-agent',
  dependencies: { '@ai-ecoverse/slicc-clipboard': '1.0.99' },
});
export const mcpcat = await fakeRelease({
  name: '@ai-ecoverse/mcpcat',
  from: '0.17.2',
  version: '0.99.0',
  repository: 'https://github.com/ai-ecoverse/mcpcat',
});
export const pinned = await fakeRelease({
  name: AGENT,
  from: PINNED,
  version: '6.97.0',
  repository: 'https://github.com/ai-ecoverse/slicc-agent',
  dependencies: { '@ai-ecoverse/mcpcat': '0.99.0' },
});
export const major = await fakeRelease({
  name: AGENT,
  from: PINNED,
  version: '7.0.0',
  repository: 'https://github.com/ai-ecoverse/slicc-agent',
});
export const releases = [release, clipboard, mcpcat];
export const registry = await fakeRegistry(chrome.cdp, releases);
export const fakeExtension = extensionOver(await debuggerUrl(port));

export const agentRow = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'agent')
  );

export const installedAgent = (page) =>
  page.evaluate(async (name) => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ['opt', 'agent', 'node_modules', ...name.split('/')])
      dir = await dir.getDirectoryHandle(part);
    const file = await (await dir.getFileHandle('package.json')).getFile();
    return JSON.parse(await file.text()).version;
  }, AGENT);

export const notice = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.notices.list()
        .find((item) => item.id === id || item.id.startsWith(`${id}:`)) ?? null,
    id
  );

export async function runsAgent(page, version, ms = 5 * 60 * 1000) {
  await page
    .within(
      ms,
      (version) => {
        const row = document
          .querySelector('slicc-app')
          .model.updates.list()
          .find((item) => item.id === 'agent');
        window.sliccRuns = JSON.stringify([row?.state, row?.from, row?.to]);
        return row?.state !== 'ready' && row?.from === version && row?.to === version;
      },
      version
    )
    .catch(async (error) => {
      const seen = await page.evaluate(() => window.sliccRuns).catch(() => 'unknown');
      throw new Error(`the agent never ran ${version}, last ${seen}: ${error.message}`);
    });
}

export async function developer(page, on, ms = 10 * 60 * 1000) {
  await page.evaluate((on) => {
    window.sliccDeveloper = document
      .querySelector('slicc-app')
      .model.updates.setDeveloper(on)
      .then(
        () => 'done',
        (error) => error.message
      );
  }, on);
  await page
    .within(
      ms,
      (on) => {
        const { updates } = document.querySelector('slicc-app').model;
        const npm = updates.list().find((item) => item.id === 'agent')?.npm ?? null;
        window.sliccNpm = JSON.stringify(npm);
        if (updates.developer() !== on) return false;
        return on ? npm !== null && npm.state !== 'checking' : npm === null;
      },
      on
    )
    .catch(async (error) => {
      const seen = await page.evaluate(() => window.sliccNpm).catch(() => 'unknown');
      throw new Error(
        `developer mode never settled ${on ? 'on' : 'off'}, last ${seen}: ${error.message}`
      );
    });
}

export async function npmSays(page, state, ms = 10 * 60 * 1000) {
  await page
    .within(
      ms,
      (state) => {
        const row = document
          .querySelector('slicc-app')
          .model.updates.list()
          .find((item) => item.id === 'agent');
        window.sliccNpm = JSON.stringify(row?.npm ?? null);
        return row?.npm?.state === state;
      },
      state
    )
    .catch(async (error) => {
      const seen = await page.evaluate(() => window.sliccNpm).catch(() => 'unknown');
      throw new Error(`npm never said ${state}, last ${seen}: ${error.message}`);
    });
}

export async function confirmWith(page, label) {
  await page.until(() => {
    const app = document.querySelector('slicc-app');
    return !!app.shadowRoot
      .querySelector('slicc-confirm')
      ?.shadowRoot?.querySelector('dialog[open]');
  });
  const body = await page.evaluate(
    () =>
      document.querySelector('slicc-app').shadowRoot.querySelector('slicc-confirm').shadowRoot
        .textContent
  );
  await page.evaluate((label) => {
    const dialog = document.querySelector('slicc-app').shadowRoot.querySelector('slicc-confirm');
    [...dialog.shadowRoot.querySelectorAll('swc-button')]
      .find((button) => button.textContent.trim() === label)
      .click();
  }, label);
  return body;
}

export async function act(page, action, ms = 10 * 60 * 1000) {
  const id = await page.evaluate((action) => {
    window.sliccActs ??= [];
    const n = window.sliccActs.length;
    window.sliccActs.push({ done: false });
    document
      .querySelector('slicc-app')
      .model.updates.act('agent', action)
      .then(
        () => {
          window.sliccActs[n] = { done: true };
        },
        (error) => {
          window.sliccActs[n] = { done: true, error: error.message };
        }
      );
    return n;
  }, action);
  await page.within(ms, (n) => window.sliccActs?.[n]?.done === true, id);
  const { error } = await page.evaluate((n) => window.sliccActs[n], id);
  if (error) throw new Error(error);
}
