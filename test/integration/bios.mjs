import { readFileSync } from 'node:fs';

export const installable = Object.entries(
  JSON.parse(readFileSync(new URL('../../src/packages/package-lock.json', import.meta.url), 'utf8'))
    .packages
).filter(([path, entry]) => path && entry.resolved && !entry.os && !entry.cpu).length;

export const steps = ['opfs', 'installer', 'packages', 'seed', 'intercept', 'navigate'];
export const booted = steps.flatMap((step) => [`${step}:active`, `${step}:done`]);

export async function watch(page) {
  const events = [];
  await page.expose('bios', (event) => events.push(event));
  await page.init(() => {
    const observer = new MutationObserver((records) => {
      for (const { type, target } of records) {
        if (type === 'attributes' || target.localName === 'output') {
          const item = target.closest('[data-step]');
          if (!item) continue;
          const { step, state } = item.dataset;
          const text = item.querySelector('output').value;
          window.bios(JSON.stringify({ type, step, state, text }));
        }
      }
    });
    observer.observe(document, { subtree: true, childList: true, attributeFilter: ['data-state'] });
    addEventListener('pagereveal', ({ viewTransition }) => {
      const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
      const optIn = rules.some((rule) => rule.navigation === 'auto');
      const transition = Boolean(viewTransition);
      window.bios(JSON.stringify({ type: 'reveal', path: location.pathname, optIn, transition }));
    });
  });
  return {
    states: () => events.filter((e) => e.type === 'attributes').map((e) => `${e.step}:${e.state}`),
    texts: (step) =>
      events.filter((e) => e.type === 'childList' && e.step === step).map((e) => e.text),
    reveals: () =>
      events.filter((e) => e.type === 'reveal').map((e) => `${e.path}:${e.optIn}:${e.transition}`),
  };
}

export async function boot(page, prompts = [prompt]) {
  await page.goto('/');
  await ready(page, prompts);
}

export const prompt = 'slicc:/home# ';

export async function ready(page, prompts = [prompt]) {
  await page.until(
    () =>
      location.pathname === '/os/' &&
      !!document
        .querySelector('slicc-app')
        ?.dock?.api.panels.some((panel) => panel.id.startsWith('terminal:'))
  );
  await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    dock.api.getPanel(id)?.api.setActive();
  });
  await page.until((prompts) => {
    const text = document.querySelector('slicc-app')?.dock?.content(
      document
        .querySelector('slicc-app')
        .dock.api.panels.map((panel) => panel.id)
        .findLast((id) => id.startsWith('terminal:'))
    )?.screen?.textContent;
    return !!text && prompts.some((wanted) => text.includes(wanted));
  }, prompts);
}

function showing(needle) {
  const { dock } = document.querySelector('slicc-app');
  return dock
    .content(dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:')))
    .screen.textContent.includes(needle);
}

export async function screen(page) {
  return page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    return dock.content(
      dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'))
    ).screen.textContent;
  });
}

export async function shows(page, text, ms) {
  if (ms) await page.within(ms, showing, text);
  else await page.until(showing, text);
}

export async function run(page, command) {
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    const { dock } = app;
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    dock.api.getPanel(id)?.api.setActive();
    dock
      .content(
        dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'))
      )
      .screen.focus();
  });
  await page.insert(command);
  await page.enter();
}

export async function opfs(page) {
  return page.evaluate(async () => {
    const paths = [];
    const walk = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') await walk(handle, `${prefix}${name}/`);
        else paths.push(`${prefix}${name}`);
      }
    };
    await walk(await navigator.storage.getDirectory(), '');
    return paths.sort();
  });
}

export async function eventually(check) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function ui(page) {
  await page.init(() => {
    const app = () => document.querySelector('slicc-app');
    const view = (path) => app().dock.content(`file:${path}`);
    window.ui = {
      app,
      view,
      tree: () => app().dock.content('files').shadowRoot.querySelector('slicc-file-tree'),
      code: (path) =>
        view(path)
          ?.shadowRoot.querySelector('slicc-code-view')
          ?.shadowRoot.querySelector('diffs-container')?.shadowRoot.textContent ?? '',
      button: (path, text) =>
        [...view(path).shadowRoot.querySelectorAll('*')].findLast(
          (element) => element.textContent.trim() === text
        ),
    };
  });
}

export async function trust(page, files) {
  await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    const records = [];
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split('/');
      const name = parts.pop();
      let dir = root;
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
      const bytes = new TextEncoder().encode(text);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      records.push({ path: `/${path}`, size: bytes.byteLength, sha256, source: `test:/${path}` });
    }
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('slicc-bios-integrity');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('files', 'readwrite');
    for (const record of records) transaction.objectStore('files').put(record);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, files);
}

export const AGENT_BUDGET = 25 * 60 * 1000;
export const AGENT_STALL = 5 * 60 * 1000;
export const AGENT_RESTART = 5 * 60 * 1000;
const HEARTBEAT = 60 * 1000;

function agentProbe() {
  const app = document.querySelector('slicc-app');
  const model = app?.model ?? {};
  const row = model.updates?.list?.().find((item) => item.id === 'agent') ?? null;
  const progress = row?.progress;
  const accounts = model.settings?.accounts?.();
  return {
    page: location.pathname,
    ready: Boolean(model.updates?.ready?.()),
    attached: Array.isArray(accounts) && accounts.length > 0,
    state: row?.state ?? null,
    progress: progress ? `${progress.phase} ${progress.done} of ${progress.total}` : null,
    version: row?.to ?? row?.from ?? null,
    error: row?.error ?? null,
    log: (row?.log ?? '').trim().split('\n').slice(-6),
    accounts: accounts?.map((account) => `${account.id} ${account.status}`) ?? null,
    notices: (model.notices?.list?.() ?? []).map((notice) => `${notice.title}: ${notice.body}`),
    vault: model.vault?.availability?.() ?? null,
    tab: model.tabs?.state?.() ?? null,
    rows: (model.updates?.list?.() ?? []).map((item) => `${item.id} ${item.state}`),
  };
}

const probeAgent = (page) =>
  page.evaluate(agentProbe).catch((error) => ({ unreachable: error.message }));

function describe(probe, page) {
  if (probe.unreachable) return `the page did not answer: ${probe.unreachable}`;
  return [
    `page ${probe.page}, agent ${probe.state ?? 'no row'}${probe.progress ? ` (${probe.progress})` : ''}${probe.version ? ` ${probe.version}` : ''}, updates ready ${probe.ready}, agent model ${probe.attached ? 'attached' : 'not attached'}`,
    `updates: ${probe.rows.join(', ')}`,
    `vault ${probe.vault}, tab ${JSON.stringify(probe.tab)}`,
    `accounts: ${probe.accounts ? probe.accounts.join(', ') || 'none' : 'not listed'}`,
    ...(probe.error ? [`error: ${probe.error}`] : []),
    ...(probe.log.length ? ['install log:', ...probe.log.map((line) => `  ${line}`)] : []),
    ...(probe.notices.length ? ['notices:', ...probe.notices.map((line) => `  ${line}`)] : []),
    ...(page.errors.length ? ['page errors:', ...page.errors.map((line) => `  ${line}`)] : []),
    ...(page.console?.length
      ? ['console:', ...page.console.slice(-15).map((line) => `  ${line}`)]
      : []),
  ].join('\n');
}

export async function agentState(page) {
  return describe(await probeAgent(page), page);
}

export async function agentUp(
  page,
  { budget = AGENT_BUDGET, stall = AGENT_STALL, label = 'agent', log = console.log } = {}
) {
  const start = Date.now();
  let seen = null;
  let moved = start;
  let said = 0;
  for (;;) {
    const probe = await probeAgent(page);
    const now = Date.now();
    const at = `${label} after ${Math.round((now - start) / 1000)} s`;
    const key = JSON.stringify([probe.state, probe.progress, probe.ready, probe.attached]);
    if (key !== seen || now - said >= HEARTBEAT) {
      if (key !== seen) moved = now;
      seen = key;
      said = now;
      log(
        `${at}: ${probe.unreachable ? 'no answer' : `${probe.state ?? 'no row'}${probe.progress ? ` ${probe.progress}` : ''}${probe.ready ? ', ready' : ''}${probe.attached ? ', attached' : ''}`}`
      );
    }
    if (probe.ready && probe.attached) return probe;
    const why =
      probe.state === 'failed'
        ? 'the agent install failed'
        : now - moved >= stall
          ? `the agent made no progress for ${Math.round(stall / 1000)} s`
          : now - start >= budget
            ? `the agent was not up within ${Math.round(budget / 1000)} s`
            : null;
    if (why) throw new Error(`${at}: ${why}\n${describe(probe, page)}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export const PACKAGE_BUDGET = 10 * 60 * 1000;
export const PACKAGE_STALL = 4 * 60 * 1000;

function packageProbe(id) {
  const model = document.querySelector('slicc-app')?.model ?? {};
  const row = model.updates?.packages?.().find((item) => item.id === id) ?? null;
  const progress = row?.progress;
  return {
    done: window.sliccActed?.[id],
    state: row?.state ?? null,
    progress: progress ? `${progress.phase} ${progress.done} of ${progress.total}` : null,
    error: row?.error ?? null,
    log: (row?.log ?? '').trim().split('\n').slice(-6),
  };
}

export async function actPackage(
  page,
  id,
  action = 'install',
  { budget = PACKAGE_BUDGET, stall = PACKAGE_STALL, log = console.log } = {}
) {
  await page.evaluate(
    ([id, action]) => {
      window.sliccActed ??= {};
      window.sliccActed[id] = undefined;
      document
        .querySelector('slicc-app')
        .model.updates.actPackage(id, action)
        .then(
          () => 'ok',
          (error) => error.message
        )
        .then((result) => {
          window.sliccActed[id] = result;
        });
    },
    [id, action]
  );
  const start = Date.now();
  let seen = null;
  let moved = start;
  let said = 0;
  for (;;) {
    const probe = await page
      .evaluate(packageProbe, id)
      .catch((error) => ({ unreachable: error.message, log: [] }));
    const now = Date.now();
    const at = `${action} ${id} after ${Math.round((now - start) / 1000)} s`;
    if (probe.done !== undefined) {
      log(`${at}: ${probe.done}`);
      return probe.done;
    }
    const key = JSON.stringify([probe.state, probe.progress, probe.unreachable]);
    if (key !== seen || now - said >= HEARTBEAT) {
      if (key !== seen) moved = now;
      seen = key;
      said = now;
      log(
        `${at}: ${probe.unreachable ? 'no answer' : `${probe.state}${probe.progress ? ` ${probe.progress}` : ''}`}`
      );
    }
    const why =
      now - moved >= stall
        ? `no progress for ${Math.round(stall / 1000)} s`
        : now - start >= budget
          ? `not done within ${Math.round(budget / 1000)} s`
          : null;
    if (why)
      throw new Error(
        [
          `${at}: ${why}`,
          probe.unreachable
            ? `the page did not answer: ${probe.unreachable}`
            : `${id} ${probe.state}${probe.progress ? ` (${probe.progress})` : ''}`,
          ...(probe.error ? [`error: ${probe.error}`] : []),
          ...(probe.log.length ? ['log:', ...probe.log.map((line) => `  ${line}`)] : []),
          ...(page.console?.length
            ? ['console:', ...page.console.slice(-15).map((line) => `  ${line}`)]
            : []),
        ].join('\n')
      );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function listsAccount(page, id, ms = 30000) {
  await page
    .within(
      ms,
      (id) =>
        !!document
          .querySelector('slicc-app')
          .model.settings?.accounts?.()
          .some((account) => account.id === id),
      id
    )
    .catch(async (error) => {
      throw new Error(
        `${id} is not among the accounts: ${error.message}\n${await agentState(page)}`
      );
    });
}

export async function connected(page, id, ms = 60000) {
  await page
    .within(
      ms,
      (id) =>
        document
          .querySelector('slicc-app')
          .model.settings.accounts()
          .find((account) => account.id === id)?.status === 'connected',
      id
    )
    .catch(async (error) => {
      throw new Error(`${id} did not connect: ${error.message}\n${await agentState(page)}`);
    });
}

export const VAULT_NAMES = {
  'amazon-bedrock': 'AWS_BEARER_TOKEN_BEDROCK',
  adobe: 'ADOBE_IMS_TOKEN',
};

export async function connectAccount(page, id, key) {
  return page.evaluate(
    async ({ id, key, name }) => {
      const { vault, settings } = document.querySelector('slicc-app').model;
      await vault.put(name, key, undefined, { kind: 'model', provider: id });
      if (id !== 'adobe') return settings.connect(id);
    },
    { id, key, name: VAULT_NAMES[id] }
  );
}
