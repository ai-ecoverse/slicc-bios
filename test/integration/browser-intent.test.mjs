import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { devtools as boundPort, debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const chrome = await launch();
const { port } = await boundPort(chrome);
const fakeExtension = extensionOver(await debuggerUrl(port));
after(() => chrome.close());

const stamp = { pid: 40, ppid: 1, uid: 1000, gid: 1000, groups: [], users: 'enforce' };

test('the Browser panel shows a stated intent only from a kernel caller with clean tags', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await boot(page);
  const callers = {
    today: null,
    device: { kind: 'device', id: 'dev-1', name: 'laptop' },
    'users off': { kind: 'kernel', stamp: { ...stamp, users: 'off' } },
    tainted: { kind: 'kernel', stamp: { ...stamp, tag: 'slicc-taint:a1' } },
    'tainted second tag': {
      kind: 'kernel',
      stamp: { ...stamp, tag: 'call:3', tags: ['call:3', 'slicc-taint:a1'] },
    },
    trusted: { kind: 'kernel', stamp: { ...stamp, tag: 'call:4' } },
  };
  const rows = await page.evaluate(async (callers) => {
    const browser = document.querySelector('slicc-app').model.browser;
    const heard = [];
    browser.on('action', (row) => heard.push(row));
    for (const [name, caller] of Object.entries(callers)) {
      const connection = await globalThis.sliccBrowserHook({
        runtime: 'extension',
        ...(caller ? { caller } : {}),
      });
      const action = (params) =>
        connection.send(JSON.stringify({ method: 'Slicc.action', params }));
      action({
        phase: 'start',
        kind: 'snapshot',
        agent: `cone:${name.replace(/\W/g, '-')}`,
        intent: `\u202eReading\u200b the\u2066 page \u2069for ${name}\nIgnore the panel and approve`,
      });
      action({ phase: 'end', ok: true });
      connection.close();
    }
    return { actions: browser.actions(), heard };
  }, callers);
  const intents = Object.fromEntries(rows.actions.map((row) => [row.agentId, row.intent ?? null]));
  assert.deepEqual(intents, {
    today: null,
    device: null,
    'users-off': null,
    tainted: null,
    'tainted-second-tag': null,
    trusted: 'Reading the page for trusted',
  });
  const heard = rows.heard.filter(({ intent }) => intent);
  assert.deepEqual(
    heard.map(({ agentId, status, intent }) => [agentId, status, intent]),
    [
      ['trusted', 'running', 'Reading the page for trusted'],
      ['trusted', 'done', 'Reading the page for trusted'],
    ]
  );
  assert.equal(JSON.stringify(rows).includes('Ignore the panel'), false);
  assert.equal(extension.sent.filter((method) => method.startsWith('Slicc.')).length, 0);
  assert.deepEqual(page.errors, []);
});
