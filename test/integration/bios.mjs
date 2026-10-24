import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

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

export async function boot(page, prompts = [prompt], options = {}) {
  await page.goto('/');
  await ready(page, prompts, options);
}

export const prompt = 'slicc:/home# ';

export async function ready(page, prompts = [prompt], { tools = true } = {}) {
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
  if (!tools) return;
  await toolsSettled(page);
  const left = await page.evaluate(() =>
    (document.querySelector('slicc-app')?.model?.updates?.packages?.() ?? [])
      .filter((row) => row.id.startsWith('tools:') && row.state !== 'installed')
      .map((row) => `${row.id} ${row.state}${row.error ? ` (${row.error})` : ''}`)
  );
  if (left.length) console.log(`seven's tools settled with ${left.join(', ')}`);
}

export async function toolsSettled(page, ms = 10 * 60 * 1000) {
  try {
    await page.within(ms, () => {
      const at = document.documentElement.dataset.tools;
      return !!at && at !== 'installing';
    });
  } catch (error) {
    const seen = await page
      .evaluate(async () => ({
        tools: document.documentElement.dataset.tools ?? 'unset',
        rows: (document.querySelector('slicc-app')?.model?.updates?.packages?.() ?? [])
          .filter((row) => row.id.startsWith('tools:'))
          .map((row) => `${row.id} ${row.state}${row.error ? ` (${row.error})` : ''}`),
        locks: ((await navigator.locks.query()).held ?? []).map((lock) => lock.name),
      }))
      .catch((failed) => ({ tools: `unreadable (${failed.message})`, rows: [], locks: [] }));
    throw new Error(
      `seven's tools didn't settle in ${ms} ms: data-tools is ${seen.tools}; held locks ${seen.locks.join(', ') || 'none'}; ${seen.rows.join(', ') || 'no tool rows'}`,
      { cause: error }
    );
  }
}

export async function rowSettled(page, id, ms = 10 * 60 * 1000) {
  await page
    .within(
      ms,
      (id) => {
        const row = document
          .querySelector('slicc-app')
          ?.model?.updates?.list?.()
          .find((item) => item.id === id);
        window.sliccRowSeen = row?.state ?? 'absent';
        return row && !/queued|starting|checking|downloading|linking/.test(row.state);
      },
      id
    )
    .catch(async (error) => {
      const seen = await page.evaluate(() => window.sliccRowSeen).catch(() => 'unknown');
      throw new Error(`the ${id} row didn't settle, last ${seen}: ${error.message}`);
    });
}

export async function settled(page, ms = 120000) {
  await page.within(ms, () => {
    const app = document.querySelector('slicc-app');
    return app?.model?.updates?.ready?.() && !app.dock.api.getPanel('updates')?.params?.boot;
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function showing(needle) {
  const { dock } = document.querySelector('slicc-app');
  return dock
    .content(dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:')))
    .screen.textContent.includes(needle);
}

async function front(page) {
  if (await page.evaluate(() => document.visibilityState === 'hidden')) {
    await page.send('Page.bringToFront');
  }
}

export async function screen(page) {
  await front(page);
  return page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    return dock.content(
      dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'))
    ).screen.textContent;
  });
}

const SLICE = 2000;
const SHOWS = 120000;

export async function shows(page, text, ms = SHOWS) {
  const deadline = Date.now() + ms;
  for (;;) {
    await front(page);
    const left = deadline - Date.now();
    try {
      await page.within(Math.max(1, Math.min(SLICE, left)), showing, text);
      return;
    } catch (error) {
      if (error.fatal || Date.now() >= deadline) {
        throw new Error(`${text} never showed in ${ms} ms: ${error.message}`);
      }
    }
  }
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
    notes: (row?.log ?? '')
      .split('\n')
      .filter((line) =>
        /WARN|ERR_|retr(y|ies)|timed? ?out|ECONN|ETIMEDOUT|EAI_AGAIN|socket/i.test(line)
      ),
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

function agentLog() {
  const model = document.querySelector('slicc-app')?.model ?? {};
  return model.updates?.list?.().find((item) => item.id === 'agent')?.log ?? '';
}

async function keepFailedInstall(page, label, message) {
  if (!page.dir) return;
  const log = await page.evaluate(agentLog).catch((error) => `no install log: ${error.message}`);
  await writeFile(
    new URL(`${label.replace(/[^\w-]+/g, '-')}-failed.log`, page.dir),
    `${message}\ninstall log:\n${log}\n`
  ).catch(() => {});
}

export async function agentState(page) {
  return describe(await probeAgent(page), page);
}

const GAP = 30 * 1000;

function resourceTimes() {
  return {
    timeOrigin: performance.timeOrigin,
    entries: performance
      .getEntriesByType('resource')
      .filter((entry) => !entry.name.startsWith(location.origin))
      .map((entry) => ({
        name: entry.name,
        initiator: entry.initiatorType,
        protocol: entry.nextHopProtocol,
        startTime: Math.round(entry.startTime),
        requestStart: Math.round(entry.requestStart),
        responseStart: Math.round(entry.responseStart),
        responseEnd: Math.round(entry.responseEnd),
        size: entry.transferSize,
      })),
  };
}

function networkSetting() {
  const model = document.querySelector('slicc-app')?.model ?? {};
  const status = model.network?.status?.() ?? {};
  return {
    transport: document.documentElement.dataset.transport ?? null,
    route: status.route ?? null,
    health: status.health ?? null,
    exit: status.exit ?? null,
    versions: Object.fromEntries(
      (model.updates?.list?.() ?? []).map((item) => [item.id, item.to ?? item.from ?? null])
    ),
    userAgent: navigator.userAgent,
  };
}

function installTrace(page, label, log) {
  if (!page.trace) return null;
  const started = Date.now();
  const steps = [];
  const notes = new Set();
  const gaps = [];
  let dumped = false;
  const since = (at) => (at ? Math.round((at - started) / 100) / 10 : null);
  const row = (request) => ({
    url: request.url,
    method: request.method,
    type: request.type,
    cached: request.cached,
    protocol: request.protocol ?? null,
    status: request.status ?? null,
    bytes: request.bytes ?? null,
    error: request.error ?? null,
    sent: since(request.sent),
    paused: since(request.paused),
    headers: since(request.headers),
    finished: since(request.finished),
    failed: since(request.failed),
  });
  const open = () =>
    page.trace.requests().filter((request) => !request.finished && !request.failed);
  return {
    step: (line) => steps.push({ at: since(Date.now()), line }),
    note: (lines) => {
      for (const line of lines ?? []) notes.add(line.trim());
    },
    moved: () => {
      dumped = false;
    },
    async gap(quiet) {
      if (dumped) return;
      dumped = true;
      const timing = await page
        .evaluate(resourceTimes)
        .catch((error) => ({ error: error.message }));
      const flying = open().sort((a, b) => a.sent - b.sent);
      gaps.push({ at: since(Date.now()), quiet, inFlight: flying.map(row), timing });
      const oldest = flying[0];
      log(
        `${label} trace: no progress for ${quiet} s, ${flying.length} requests in flight${oldest ? `, the oldest ${oldest.url} for ${Math.round((Date.now() - oldest.sent) / 1000)} s${oldest.paused ? '' : ', not yet handed to the harness'}` : ''}`
      );
    },
    async save(outcome) {
      const requests = page.trace.requests();
      const [browser, setting, timing] = await Promise.all([
        page.trace.browser().catch((error) => ({ error: error.message })),
        page.evaluate(networkSetting).catch((error) => ({ error: error.message })),
        page.evaluate(resourceTimes).catch((error) => ({ error: error.message })),
      ]);
      const name = `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-install-trace.json`;
      const file = new URL(name, page.dir);
      await writeFile(
        file,
        `${JSON.stringify(
          {
            label,
            outcome,
            started: new Date(started).toISOString(),
            browser,
            setting,
            steps,
            notes: [...notes],
            gaps,
            requests: requests.map(row),
            timing,
          },
          null,
          2
        )}\n`
      );
      const done = requests.filter((request) => request.finished);
      const slowest = done.sort((a, b) => b.finished - b.sent - (a.finished - a.sent))[0];
      log(
        `${label} trace: ${requests.length} requests, ${open().length} never finished, ${gaps.length} quiet spells over ${GAP / 1000} s${slowest ? `, slowest ${slowest.url} ${slowest.finished - slowest.sent} ms` : ''}, transport ${setting?.transport ?? '?'}, in ${file.pathname}`
      );
    },
  };
}

export async function agentUp(
  page,
  { budget = AGENT_BUDGET, stall = AGENT_STALL, label = 'agent', log = console.log } = {}
) {
  const start = Date.now();
  const trace = installTrace(page, label, log);
  let seen = null;
  let moved = start;
  let said = 0;
  let outcome = 'up';
  try {
    for (;;) {
      const probe = await probeAgent(page);
      const now = Date.now();
      const at = `${label} after ${Math.round((now - start) / 1000)} s`;
      const key = JSON.stringify([probe.state, probe.progress, probe.ready, probe.attached]);
      trace?.note(probe.notes);
      if (key !== seen || now - said >= HEARTBEAT) {
        if (key !== seen) {
          moved = now;
          trace?.moved();
        }
        seen = key;
        said = now;
        const line = `${at}: ${probe.unreachable ? 'no answer' : `${probe.state ?? 'no row'}${probe.progress ? ` ${probe.progress}` : ''}${probe.ready ? ', ready' : ''}${probe.attached ? ', attached' : ''}`}`;
        log(line);
        trace?.step(line);
      }
      if (probe.ready && probe.attached) return probe;
      if (trace && now - moved >= GAP) await trace.gap(Math.round((now - moved) / 1000));
      const why =
        probe.state === 'failed'
          ? 'the agent install failed'
          : now - moved >= stall
            ? `the agent made no progress for ${Math.round(stall / 1000)} s`
            : now - start >= budget
              ? `the agent was not up within ${Math.round(budget / 1000)} s`
              : null;
      if (why) {
        outcome = why;
        const message = `${at}: ${why}\n${describe(probe, page)}`;
        await keepFailedInstall(page, label, message);
        throw new Error(message);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    await trace?.save(outcome).catch((error) => log(`${label} trace: not saved: ${error.message}`));
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

function packageEvidence([id, lockDir]) {
  const listing = async (dir, prefix) => {
    const lines = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        lines.push(`${prefix}${name}/`, ...(await listing(handle, `${prefix}${name}/`)));
      } else {
        const file = await handle.getFile();
        lines.push(`${prefix}${name} ${file.size} ${new Date(file.lastModified).toISOString()}`);
      }
    }
    return lines;
  };
  return (async () => {
    const model = document.querySelector('slicc-app')?.model ?? {};
    const rows = model.updates?.packages?.() ?? [];
    const row = rows.find((item) => item.id === id) ?? null;
    let tmp = await navigator.storage.getDirectory();
    let lock = [];
    try {
      for (const part of lockDir.split('/')) tmp = await tmp.getDirectoryHandle(part);
      lock = await listing(tmp, '');
    } catch (error) {
      lock = [`${lockDir}: ${error.name}`];
    }
    return [
      `row: ${JSON.stringify({ state: row?.state, error: row?.error, version: row?.version })}`,
      `ls -la /${lockDir} (OPFS):`,
      ...lock.map((line) => `  ${line}`),
      'log:',
      row?.log ?? '',
    ].join('\n');
  })();
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
      if (probe.done !== 'ok' && page.dir) {
        const evidence = await page
          .evaluate(packageEvidence, [id, 'tmp/pnpm-store-operation-locks-0'])
          .catch((error) => `no evidence: ${error.message}`);
        const agent = await agentState(page).catch((error) => `agent: ${error.message}`);
        await writeFile(
          new URL(`${action}-${id}-failed.log`, page.dir),
          `${at}: ${probe.done}\n${evidence}\nagent:\n${agent}\n`
        ).catch(() => {});
      }
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
