import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { attach, CLI } from './cli.mjs';
import { startFakeVault } from './fake-vault.mjs';
import { shoot } from './shots.mjs';

const fake = await startFakeVault({
  locked: true,
  secrets: ['HARBOR_API_KEY', 'TIDE_STATION_TOKEN'],
});
const chrome = await launch({ vault: false });
after(() => {
  chrome.close();
  fake.close();
});

const override = (origin) =>
  `() => { if (location.origin === ${JSON.stringify(new URL(chrome.url).origin)}) localStorage.setItem('slicc-os.vault-origin', ${JSON.stringify(origin)}); }`;

async function logged(check) {
  for (let tries = 0; tries < 100 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

const roles = (op) => fake.log.filter((entry) => entry.op === op).map((entry) => entry.role);

test('seven embeds the vault at its origin: the page hello, status and list, a locked vault still lists, and changed re-lists', async (t) => {
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  await page.until(() => {
    const vault = document.querySelector('slicc-app').model.vault;
    return vault?.availability() === 'locked' && vault.list()?.secrets.length === 2;
  });
  const frame = await page.evaluate(() => {
    const element = document.querySelector('iframe[data-vault=core]');
    return { src: element.src, hidden: element.hidden };
  });
  assert.deepEqual(frame, { src: `${fake.origin}/`, hidden: true });
  await logged(() => fake.log.some((entry) => entry.op === 'hello'));
  const hello = fake.log.find((entry) => entry.op === 'hello' && entry.role === 'page');
  assert.deepEqual(hello, {
    role: 'page',
    op: 'hello',
    origin: new URL(chrome.url).origin,
    sudoGid: null,
  });
  assert.equal(roles('hello').includes('agent'), false);
  assert.deepEqual(
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.vault.list()
        .secrets.map((secret) => secret.name)
    ),
    ['HARBOR_API_KEY', 'TIDE_STATION_TOKEN']
  );
  const refused = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.vault.put('DOCK_TOKEN', 'dock-value-12345678')
      .then(
        () => null,
        (error) => ({ code: error.code, message: error.message })
      )
  );
  assert.deepEqual(refused, {
    code: 'EACCES',
    message: 'vault is locked: unlock it in the vault window',
  });
  fake.set({ locked: false });
  const hellos = roles('hello').filter((role) => role === 'page').length;
  await page.evaluate(() => {
    const element = document.querySelector('iframe[data-vault=core]');
    element.setAttribute('src', element.getAttribute('src'));
  });
  await page.until(
    () => document.querySelector('slicc-app').model.vault.availability() === 'ready'
  );
  assert.ok(await logged(() => roles('hello').filter((role) => role === 'page').length > hellos));
  const lists = roles('list').length;
  const sealed = await page.evaluate(() =>
    document.querySelector('slicc-app').model.vault.put('DOCK_TOKEN', 'dock-value-12345678')
  );
  assert.equal(sealed.name, 'DOCK_TOKEN');
  await page.until(
    () => document.querySelector('slicc-app').model.vault.list()?.secrets.length === 3
  );
  assert.ok(await logged(() => roles('list').length > lists));
  assert.equal(JSON.stringify(fake.log).includes('dock-value-12345678'), false);
  assert.deepEqual(page.errors, []);
});

test('the agent port: the scrub pair reaches the worker before a put answer, and { vault, scrub } comes again after a frame reload', async (t) => {
  fake.set({ locked: false, secrets: [], version: 0 });
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  const before = fake.log.length;
  await page.evaluate(async (origin) => {
    const { createVault } = await import('/os/vault.js');
    const kept = new Map();
    const storage = {
      getItem: (key) => kept.get(key) ?? null,
      setItem: (key, value) => kept.set(key, value),
      removeItem: (key) => kept.delete(key),
    };
    const order = [];
    const ports = [];
    const worker = {
      postMessage(message) {
        if (message.vault) {
          ports.push(message.vault);
          order.push('vault');
        } else order.push(`scrub:${message.scrub?.version}`);
      },
    };
    const vault = createVault({ origin, storage });
    vault.attach(worker);
    window.agentVault = { vault, order, ports };
  }, fake.origin);
  await page.until(
    () =>
      window.agentVault.vault.port.availability() === 'ready' &&
      window.agentVault.order.includes('vault')
  );
  const order = await page.evaluate(async () => {
    const { vault, order } = window.agentVault;
    await vault.port.put('HARBOR_API_KEY', 'harbor-value-1234');
    order.push('put');
    return order;
  });
  assert.equal(order[0], 'vault');
  assert.deepEqual(order.slice(-2), ['scrub:1', 'put']);
  const since = fake.log.slice(before);
  assert.ok(
    since.some((entry) => entry.op === 'hello' && entry.role === 'agent') ||
      (await logged(() =>
        fake.log.slice(before).some((entry) => entry.op === 'hello' && entry.role === 'agent')
      ))
  );
  await page.evaluate(() => {
    const { frame } = window.agentVault.vault;
    frame.setAttribute('src', frame.getAttribute('src'));
  });
  await page.until(() => window.agentVault.order.filter((entry) => entry === 'vault').length === 2);
  const answer = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const port = window.agentVault.ports.at(-1);
        port.onmessage = ({ data }) => {
          if (data.op === 'welcome') {
            port.postMessage({ v: 1, id: 1, op: 'records' });
            return;
          }
          resolve(data);
        };
      })
  );
  assert.deepEqual(answer, { v: 1, id: 1, error: { code: 'ENOTSUP', message: 'later' } });
  assert.ok(
    await logged(() => fake.log.some((entry) => entry.role === 'agent' && entry.op === 'records'))
  );
  await page.evaluate(() => window.agentVault.vault.close());
  assert.deepEqual(page.errors, []);
});

test('the vault button is the vault’s own button.html, themed with seven’s colour scheme', async (t) => {
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  await page.evaluate(() => {
    const host = document.createElement('slicc-vault-button');
    host.id = 'probe';
    host.vault = document.querySelector('slicc-app').model.vault;
    host.config = { intent: { kind: 'unlock' } };
    document.body.append(host);
  });
  const themes = () =>
    fake.log
      .filter((entry) => entry.role === 'button' && entry.op === 'button')
      .map((entry) => entry.theme);
  await page.until(
    () =>
      document
        .querySelector('#probe')
        .shadowRoot.querySelector('iframe')
        ?.style.width.endsWith('px') &&
      document.querySelector('#probe').shadowRoot.querySelector('iframe').style.width !== '0px'
  );
  const frame = await page.evaluate(() => {
    const element = document.querySelector('#probe').shadowRoot.querySelector('iframe');
    return { src: element.src, sandboxed: element.hasAttribute('sandbox') };
  });
  assert.deepEqual(frame, { src: `${fake.origin}/button.html`, sandboxed: false });
  const scheme = () =>
    page.evaluate(() => {
      const element = document.querySelector('#probe').shadowRoot.querySelector('iframe');
      return {
        frame: getComputedStyle(element).colorScheme,
        app: document.querySelector('slicc-app').color,
      };
    });
  assert.ok(await logged(() => themes().length > 0));
  const first = themes().at(-1);
  assert.deepEqual(await scheme(), { frame: first, app: first });
  await page.evaluate(() => document.querySelector('slicc-app').toggleColor());
  assert.ok(await logged(() => themes().at(-1) !== first));
  const second = themes().at(-1);
  assert.deepEqual(await scheme(), { frame: second, app: second });
  await page.evaluate(() => {
    const element = document.querySelector('#probe').shadowRoot.querySelector('iframe');
    element.setAttribute('src', element.getAttribute('src'));
  });
  const count = themes().length;
  assert.ok(await logged(() => themes().length > count));
  assert.equal(themes().at(-1), second);
  assert.ok(['light', 'dark'].includes(first));
  assert.deepEqual(page.errors, []);
});

test('locked, every Secrets action either waits for the unlock with a reason or works, and none fails with an error', async (t) => {
  fake.set({ locked: true, secrets: ['HARBOR_API_KEY', 'TIDE_STATION_TOKEN'], version: 2 });
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  await page.evaluate(() => {
    const deep = (root, selector) => {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && deep(element.shadowRoot, selector);
        if (inner) return inner;
      }
      return null;
    };
    window.secrets = () => deep(document, 'slicc-secrets');
    window.confirmDialog = () => deep(document, 'slicc-confirm');
    window.within = (selector) => window.secrets()?.shadowRoot.querySelector(selector);
    window.state = (selector) => {
      const form = window.within('[data-form]');
      const submit = form?.querySelector(
        '[data-action=save], [data-action=read], [data-action=download]'
      );
      return {
        form: form?.dataset.form ?? null,
        submitDisabled: submit ? submit.hasAttribute('disabled') : null,
        reason: form?.querySelector('[data-locked]')?.textContent.trim() ?? null,
        error:
          window.secrets().shadowRoot.querySelector('[role=alert], .error')?.textContent.trim() ??
          null,
        enabled: selector ? !window.within(selector)?.hasAttribute('disabled') : null,
      };
    };
    document.querySelector('slicc-app').show('settings');
  });
  await page.until(
    () => window.secrets()?.shadowRoot.querySelector('section')?.dataset.vault === 'locked'
  );
  const table = {};
  const open = async (label, selector) => {
    await page.evaluate(() => window.within('[data-action=cancel]')?.click());
    const before = await page.evaluate((selector) => window.state(selector), selector);
    await page.evaluate((selector) => window.within(selector).click(), selector);
    await page.until(() => !!window.within('[data-form]'));
    await page.evaluate(() => {
      for (const input of window
        .within('[data-form]')
        .querySelectorAll('input[type=password], input[type=text]')) {
        input.value = input.dataset.field === 'name' ? 'DOCK_TOKEN' : 'dock-value-12345678';
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
      window
        .within('[data-form] input')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })
        );
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    table[label] = {
      button: before.enabled ? 'enabled' : 'disabled',
      ...(await page.evaluate(() => window.state())),
    };
    delete table[label].enabled;
  };
  await open('Add secret', '[data-action=add-secret]');
  await open('Import…', '[data-tools] [data-action=import]');
  await open('Export…', '[data-tools] [data-action=export]');
  await open('Export backup', '[data-backup] [data-action=export]');
  await open('Replace value', '[data-action=replace]');
  for (const [label, row] of Object.entries(table)) {
    assert.equal(row.submitDisabled, true, label);
    assert.equal(row.reason, 'Unlock the vault first', label);
    assert.equal(row.error, null, label);
  }
  await page.evaluate(() => window.within('[data-action=cancel]')?.click());
  await page.evaluate(() => window.within('[data-action=remove]').click());
  await page.until(() => !!window.confirmDialog()?.shadowRoot?.querySelector('[data-action]'));
  await page.evaluate(() =>
    window.confirmDialog().shadowRoot.querySelector('[data-action]').click()
  );
  await page.until(
    () => document.querySelector('slicc-app').model.vault.list()?.secrets.length === 1
  );
  table.Remove = {
    button: 'enabled',
    form: null,
    works: 'removed while locked',
    error: await page.evaluate(() => window.state().error),
  };
  assert.equal(table.Remove.error, null);
  t.diagnostic(JSON.stringify(table));
  await page.evaluate(() => window.within('[data-action=add-secret]').click());
  await page.evaluate(() => {
    const form = window.within('[data-form=add]');
    for (const input of form.querySelectorAll('input')) {
      input.value = input.dataset.field === 'name' ? 'DOCK_TOKEN' : 'dock-value-12345678';
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
  });
  fake.unlock();
  await page.until(
    () =>
      window.within('[data-form=add] [data-action=save]') &&
      !window.within('[data-form=add] [data-action=save]').hasAttribute('disabled')
  );
  await page.evaluate(() => window.within('[data-form=add] [data-action=save]').click());
  await page.until(() => !!window.within('[data-said=saved]'));
  assert.ok(fake.log.some((entry) => entry.op === 'put' && entry.name === 'DOCK_TOKEN'));
  assert.deepEqual(page.errors, []);
});

test('a token refresh the vault asks seven to send never follows a redirect, so the refresh token stays with the token endpoint', async (t) => {
  const stolen = [];
  const elsewhere = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      stolen.push({ method: req.method, body });
      res.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': 'application/json',
      });
      res.end('{"access_token":"stolen-token-12345678","token_type":"Bearer","expires_in":3600}');
    });
  });
  await new Promise((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
  const endpoint = createServer((req, res) => {
    res.writeHead(307, {
      location: `http://localhost:${elsewhere.address().port}/steal`,
      'access-control-allow-origin': '*',
    });
    res.end();
  });
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    elsewhere.close();
    endpoint.close();
    fake.set({ egress: null });
  });
  fake.set({ locked: false, secrets: ['HARBOR_API_KEY'] });
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  fake.set({
    egress: {
      id: 'refresh-1',
      request: {
        method: 'POST',
        url: `http://localhost:${endpoint.address().port}/token`,
        headers: [['content-type', 'application/x-www-form-urlencoded']],
        body: 'grant_type=refresh_token&refresh_token=dummy-refresh-token-1234&client_id=seven',
      },
    },
  });
  assert.ok(await logged(() => fake.log.some((entry) => entry.role === 'egress')));
  const answered = fake.log.find((entry) => entry.role === 'egress');
  assert.deepEqual(answered, {
    role: 'egress',
    id: 'refresh-1',
    status: null,
    error: 'EACCES: the token endpoint redirected',
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(stolen, []);
  assert.deepEqual(page.errors, []);
});

test('a /dev/sealed request made while the vault hasn’t answered yet fails with ENOTCONN once seven stops waiting, not at the kernel’s timeout', async (t) => {
  t.after(() => fake.set({ mute: false }));
  fake.set({ mute: false, locked: false });
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  fake.set({ mute: true });
  await new Promise((resolve) => setTimeout(resolve, 600));
  await page.evaluate(() => {
    const element = document.querySelector('iframe[data-vault=core]');
    element.setAttribute('src', element.getAttribute('src'));
  });
  await page.until(
    () => document.querySelector('slicc-app').model.vault.availability() === 'connecting'
  );
  const started = Date.now();
  await run(
    page,
    `clear; exec 3<>/dev/sealed; printf '{"v":1,"op":"list"}' >&3; cat <&3; echo; R=EARL; echo "$R"Y`
  );
  await shows(page, 'EARLY');
  const elapsed = Date.now() - started;
  const screen = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    return dock.content(id).screen.textContent;
  });
  assert.match(screen, /ENOTCONN/, screen);
  assert.ok(elapsed < 9000, String(elapsed));
  assert.deepEqual(page.errors, []);
});

test('a vault frame that reloads while a /dev/sealed request waits fails it with ENOTCONN at once, and seven never sends it again', async (t) => {
  t.after(() => fake.set({ mute: false, hold: [] }));
  fake.set({ mute: false, locked: false, hold: [] });
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  const reload = () =>
    page.evaluate(() => {
      const element = document.querySelector('iframe[data-vault=core]');
      element.setAttribute('src', element.getAttribute('src'));
    });
  const relayed = () =>
    fake.log.filter((entry) => entry.role === 'page' && entry.op === 'sealed').length;
  fake.set({ hold: ['sealed'] });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const before = relayed();
  await run(
    page,
    `clear; exec 3<>/dev/sealed; printf '{"v":1,"op":"list"}' >&3; cat <&3; echo; R=HEL; echo "$R"D`
  );
  assert.ok(await logged(() => relayed() === before + 1), 'the vault got the request');
  fake.set({ hold: [], mute: true });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const started = Date.now();
  await reload();
  await shows(page, 'HELD', 20000);
  const elapsed = Date.now() - started;
  const text = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    return dock.content(id).screen.textContent;
  });
  assert.match(text, /ENOTCONN/, text);
  assert.match(text, /reconnected before it answered/, text);
  assert.ok(elapsed < 9000, String(elapsed));
  fake.set({ mute: false });
  await new Promise((resolve) => setTimeout(resolve, 600));
  await reload();
  await page.until(
    () => document.querySelector('slicc-app').model.vault.availability() === 'ready'
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(relayed(), before + 1);
  assert.deepEqual(page.errors, []);
});

test('a token refresh whose endpoint stalls is given up at seven’s deadline, and its connection is closed', {
  timeout: 120000,
}, async (t) => {
  const seen = { opened: 0, closed: 0 };
  const endpoint = createServer((req, res) => {
    seen.opened += 1;
    res.on('close', () => {
      seen.closed += 1;
    });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
      });
      res.end();
    }
  });
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    endpoint.closeAllConnections?.();
    endpoint.close();
    fake.set({ egress: null });
  });
  fake.set({ locked: false, mute: false });
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  fake.set({
    egress: {
      id: 'stall-1',
      request: {
        method: 'POST',
        url: `http://localhost:${endpoint.address().port}/token`,
        headers: [['content-type', 'application/x-www-form-urlencoded']],
        body: 'grant_type=refresh_token&refresh_token=dummy-refresh-token-5678&client_id=seven',
      },
    },
  });
  for (
    let n = 0;
    n < 600 && !fake.log.some((entry) => entry.role === 'egress' && entry.id === 'stall-1');
    n += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    fake.log.find((entry) => entry.role === 'egress' && entry.id === 'stall-1'),
    {
      role: 'egress',
      id: 'stall-1',
      status: null,
      error: 'ETIMEDOUT: the token request took too long',
    }
  );
  assert.ok(seen.opened > 0);
  for (let n = 0; n < 50 && seen.closed < seen.opened; n += 1)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(seen.closed, seen.opened, JSON.stringify(seen));
  assert.deepEqual(page.errors, []);
});

test('/dev/sealed relays to the vault with the kernel stamp', async (t) => {
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  await run(page, 'S=SEALED; test -c /dev/sealed && echo "$S-YES" || echo "$S-NO"');
  await shows(page, 'SEALED-');
  const present = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    return dock.content(id).screen.textContent.includes('SEALED-YES');
  });
  if (!present) {
    t.skip('this kernel has no /dev/sealed yet (slicc-kernel ≥ 1.68.0)');
    return;
  }
  await run(
    page,
    `exec 3<>/dev/sealed; printf '{"v":1,"op":"list"}' >&3; cat <&3; echo; echo RELAYED`
  );
  await shows(page, 'RELAYED');
  await logged(() => fake.log.some((entry) => entry.op === 'sealed'));
  const relayed = fake.log.find((entry) => entry.op === 'sealed');
  assert.deepEqual(relayed, { role: 'page', op: 'sealed', sealed: 'list', stamp: true });
  assert.deepEqual(page.errors, []);
});

const KERNEL_HOOK = `() => {
  const Native = globalThis.Worker;
  const replies = new Map();
  globalThis.Worker = class extends Native {
    constructor(url, options) {
      super(url, options);
      if (options?.name !== 'slicc-kernel') return;
      globalThis.kernelWorker = this;
      const post = this.postMessage.bind(this);
      this.postMessage = (message, transfer) => {
        const answer = message?.sealedReply;
        if (answer && replies.has(answer.id)) {
          replies.get(answer.id)(answer);
          replies.delete(answer.id);
          return;
        }
        return post(message, transfer);
      };
    }
  };
  globalThis.askLikeTheKernel = (req) =>
    new Promise((resolve) => {
      const id = 'kernel-like-' + replies.size + '-' + performance.now();
      replies.set(id, resolve);
      globalThis.kernelWorker.dispatchEvent(new MessageEvent('message', { data: { sealedAsk: { id, req } } }));
    });
}`;

const leftovers = (page, needles) =>
  page.evaluate(async (needles) => {
    const found = [];
    const hit = (where, text) => {
      if (needles.some((needle) => text.includes(needle))) found.push(where);
    };
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      hit(`localStorage ${key}`, `${key}\n${localStorage.getItem(key)}`);
    }
    const ask = (request) =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    let stores = 0;
    for (const { name } of await indexedDB.databases()) {
      const db = await ask(indexedDB.open(name));
      for (const store of db.objectStoreNames) {
        const items = db.transaction(store).objectStore(store);
        const [keys, values] = [await ask(items.getAllKeys()), await ask(items.getAll())];
        hit(`indexedDB ${name}/${store}`, JSON.stringify([keys, values]));
        stores += 1;
      }
      db.close();
    }
    const latin = new TextDecoder('latin1');
    let files = 0;
    const walk = async (dir, path) => {
      try {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === 'directory') await walk(handle, `${path}${name}/`);
          else {
            hit(`opfs ${path}${name}`, latin.decode(await (await handle.getFile()).arrayBuffer()));
            files += 1;
          }
        }
      } catch (error) {
        if (error.name !== 'NotFoundError') throw error;
      }
    };
    await walk(await navigator.storage.getDirectory(), '/');
    return { found, stores, files };
  }, needles);

test('the kernel’s sessionMaterialize reaches the vault with exactly its fields and its values go back only to the kernel; a program’s is refused, and no value is left in a log or in storage', async (t) => {
  const own = await startFakeVault({ secrets: ['HARBOR_API_KEY'] });
  t.after(() => own.close());
  const page = await chrome.page(t);
  await page.init(override(own.origin));
  await page.init(KERNEL_HOOK);
  await boot(page);
  await page.until(() => {
    const vault = document.querySelector('slicc-app').model.vault;
    return vault?.availability() === 'ready' && vault.list()?.secrets.length === 1;
  });
  await page.until(() => !!globalThis.kernelWorker);
  const value = 'dummy-value-harbor_api_key';
  const placeholder = await page.evaluate(
    () => document.querySelector('slicc-app').model.vault.list().secrets[0].placeholder
  );
  const stamp = { pid: 77, ppid: 1, uid: 0, gid: 0, users: 'enforce', groups: [0], tag: 'curl' };
  const session = {
    stamp,
    session: 'sess_kernel_0123456789',
    host: 'api.harbor.test',
    port: 443,
    protocol: 'http1',
    position: 'header:authorization',
    verified: true,
    handshakeAt: Date.now(),
    exit: 'page',
    placeholders: [placeholder],
    head: { method: 'GET', path: '/v1/forecast' },
  };
  const reply = await page.evaluate((req) => globalThis.askLikeTheKernel(req), {
    v: 1,
    op: 'sessionMaterialize',
    caller: stamp,
    ...session,
  });
  assert.deepEqual(reply.reply, { values: { [placeholder]: value } });
  await logged(() => own.log.some((entry) => entry.op === 'session'));
  const relayed = own.log.filter((entry) => entry.op === 'session');
  assert.equal(relayed.length, 1);
  assert.deepEqual(relayed[0].fields, [...Object.keys(session), 'id', 'op', 'v'].sort());
  assert.deepEqual([relayed[0].stamp, relayed[0].head], [stamp, session.head]);
  const refused = await page.evaluate((req) => globalThis.askLikeTheKernel(req), {
    v: 1,
    op: 'sessionMaterialize',
    caller: stamp,
    ...session,
    placeholders: ['fnox_proxy_unknown'],
  });
  assert.deepEqual(refused.reply, { v: 1, error: { code: 'EACCES' } });
  await logged(() => own.log.filter((entry) => entry.op === 'session').length === 2);

  const request = JSON.stringify({ v: 1, op: 'sessionMaterialize', ...session });
  await run(
    page,
    `clear; exec 3<>/dev/sealed; printf '%s' '${request}' >&3 || echo "PROGRAM-REFUSED"; echo PROGRAM-DONE`
  );
  await shows(page, 'PROGRAM-DONE');
  const screen = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    return dock.content(id).screen.textContent;
  });
  assert.match(screen, /PROGRAM-REFUSED/);
  assert.equal(own.log.filter((entry) => entry.op === 'session').length, 2);

  const left = await leftovers(page, [value]);
  assert.deepEqual(left.found, [], JSON.stringify(left));
  assert.ok(left.files > 100 && left.stores > 0, JSON.stringify(left));
  assert.ok(!page.console.some((line) => line.includes(value)), page.console.join('\n'));
  assert.ok(!page.errors.some((line) => line.includes(value)));
  assert.ok(!JSON.stringify(own.log).includes(value));
});

test('the kernel’s sessionAnchors reaches the vault with exactly its fields and only the anchors and pins come back; a program’s is refused, and no anchor is left in a log or in storage', async (t) => {
  const anchor = 'TUlJQmtUQ0NBVHVnQXdJQkFnSVVhbmNob3ItZm9yLWJpb3MtdGVzdA==';
  const pin = '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';
  const own = await startFakeVault({
    secrets: ['HARBOR_DB_PASSWORD'],
    anchors: { 'db.harbor.test': { anchors: [anchor], pins: [pin] } },
  });
  t.after(() => own.close());
  const page = await chrome.page(t);
  await page.init(override(own.origin));
  await page.init(KERNEL_HOOK);
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  await page.until(() => !!globalThis.kernelWorker);
  const stamp = { pid: 81, ppid: 1, uid: 0, gid: 0, users: 'enforce', groups: [0], tag: 'psql' };
  const ask = {
    stamp,
    session: 'sess_kernel_anchor_0123456789',
    host: 'db.harbor.test',
    port: 5432,
    protocol: 'pg',
    exit: 'device:local:H-FuXm3ZyTMQF_kkC0Y_qQ',
  };
  const answered = await page.evaluate((req) => globalThis.askLikeTheKernel(req), {
    v: 1,
    op: 'sessionAnchors',
    caller: stamp,
    ...ask,
  });
  assert.deepEqual(answered.reply, { anchors: [anchor], pins: [pin] });
  assert.ok(
    await logged(() => own.log.some((entry) => entry.op === 'anchors')),
    JSON.stringify(own.log.map((entry) => entry.op))
  );
  const relayed = own.log.filter((entry) => entry.op === 'anchors');
  assert.equal(relayed.length, 1);
  assert.deepEqual(relayed[0].fields, [...Object.keys(ask), 'id', 'op', 'v'].sort());
  assert.deepEqual([relayed[0].stamp, relayed[0].exit], [stamp, ask.exit]);
  const refused = await page.evaluate((req) => globalThis.askLikeTheKernel(req), {
    v: 1,
    op: 'sessionAnchors',
    caller: stamp,
    ...ask,
    host: 'other.harbor.test',
  });
  assert.deepEqual(refused.reply, { v: 1, error: { code: 'EACCES' } });
  assert.ok(
    await logged(() => own.log.filter((entry) => entry.op === 'anchors').length === 2),
    JSON.stringify(own.log.map((entry) => entry.op))
  );

  const scram = {
    clientFirstBare: 'n=harbor,r=fyko+d2lbbFgONRv9qkxdawL',
    serverFirst: 'r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096',
    clientFinalBare: 'c=biws,r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j',
    proof: 'v0X8v3Bz2T0CJGbJQyF0X+HI4Ts=',
  };
  const login = {
    ...ask,
    position: 'scram-sha-256',
    verified: true,
    verifiedBy: 'anchored',
    anchor,
    handshakeAt: Date.now(),
    scram,
  };
  await page.evaluate((req) => globalThis.askLikeTheKernel(req), {
    v: 1,
    op: 'sessionMaterialize',
    caller: stamp,
    ...login,
  });
  assert.ok(
    await logged(() => own.log.some((entry) => entry.op === 'session')),
    JSON.stringify(own.log.map((entry) => entry.op))
  );
  const carried = own.log.find((entry) => entry.op === 'session');
  assert.deepEqual(carried.fields, [...Object.keys(login), 'id', 'op', 'v'].sort());
  assert.deepEqual(
    { verifiedBy: carried.verifiedBy, anchor: carried.anchor, scram: carried.scram },
    { verifiedBy: 'anchored', anchor, scram }
  );

  const request = JSON.stringify({ v: 1, op: 'sessionAnchors', ...ask });
  await run(
    page,
    `clear; exec 3<>/dev/sealed; printf '%s' '${request}' >&3 || echo "PROGRAM-REFUSED"; echo PROGRAM-DONE`
  );
  await shows(page, 'PROGRAM-DONE');
  const screen = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels
      .map((panel) => panel.id)
      .findLast((id) => id.startsWith('terminal:'));
    return dock.content(id).screen.textContent;
  });
  assert.match(screen, /PROGRAM-REFUSED/);
  assert.equal(own.log.filter((entry) => entry.op === 'anchors').length, 2);

  const left = await leftovers(page, [anchor, pin, scram.proof]);
  assert.deepEqual(left.found, [], JSON.stringify(left));
  assert.ok(left.files > 100 && left.stores > 0, JSON.stringify(left));
  assert.ok(
    !page.console.some((line) => line.includes(anchor) || line.includes(pin)),
    page.console.join('\n')
  );
  assert.ok(!page.errors.some((line) => line.includes(anchor) || line.includes(pin)));
});

test('under users enforce, a cone’s /dev/sealed request reaches the vault with the cone’s stamp, and seven names the sudo group in its hello', async (t) => {
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  assert.ok(
    await logged(() =>
      fake.log.some((entry) => entry.op === 'hello' && Number.isInteger(entry.sudoGid))
    ),
    JSON.stringify(fake.log.filter((entry) => entry.op === 'hello'))
  );
  const { sudoGid } = fake.log.findLast(
    (entry) => entry.op === 'hello' && Number.isInteger(entry.sudoGid)
  );
  await run(
    page,
    `clear; sudo -u cone bash -c 'exec 3<>/dev/sealed; printf "{\\"v\\":1,\\"op\\":\\"list\\"}" >&3; cat <&3'; echo; echo "CO""NE=$(id -u cone)"`
  );
  const uid = Number(
    await page.until(() => {
      const { dock } = document.querySelector('slicc-app');
      const id = dock.api.panels
        .map((panel) => panel.id)
        .findLast((id) => id.startsWith('terminal:'));
      return /CONE=(\d+)/.exec(dock.content(id).screen.textContent)?.[1];
    })
  );
  assert.ok(uid >= 1000, String(uid));
  assert.ok(
    await logged(() => fake.log.some((entry) => entry.role === 'stamp' && entry.uid === uid))
  );
  const stamp = fake.log.find((entry) => entry.role === 'stamp' && entry.uid === uid);
  assert.equal(stamp.users, 'enforce');
  assert.ok(stamp.groups?.includes(sudoGid), JSON.stringify(stamp));
  assert.deepEqual(page.errors, []);
});

test('a tab that takes over from the owner says hello again with the sudo group its own first hello lacked', async (t) => {
  const first = await chrome.page(t);
  await first.init(override(fake.origin));
  await boot(first);
  assert.ok(
    await logged(() =>
      fake.log.some((entry) => entry.op === 'hello' && Number.isInteger(entry.sudoGid))
    )
  );
  const kept = await first.evaluate(() => localStorage.getItem('slicc-os.vault-sudo-gid'));
  assert.ok(kept);
  await first.evaluate(() => localStorage.removeItem('slicc-os.vault-sudo-gid'));
  const before = fake.log.length;
  const second = await first.tab();
  await second.goto('/');
  await second.until(
    () => document.querySelector('slicc-app')?.model?.tabs?.state().role === 'follower'
  );
  assert.ok(
    await logged(() =>
      fake.log
        .slice(before)
        .some((entry) => entry.op === 'hello' && entry.role === 'page' && entry.sudoGid === null)
    )
  );
  await second.evaluate((gid) => localStorage.setItem('slicc-os.vault-sudo-gid', gid), kept);
  const promoted = fake.log.length;
  await first.close();
  await second.within(
    120000,
    () => document.querySelector('slicc-app')?.model?.tabs?.state().role === 'owner'
  );
  assert.ok(
    await logged(() =>
      fake.log
        .slice(promoted)
        .some(
          (entry) => entry.op === 'hello' && entry.role === 'page' && entry.sudoGid === Number(kept)
        )
    ),
    JSON.stringify(fake.log.slice(promoted).filter((entry) => entry.op === 'hello'))
  );
  assert.deepEqual(second.errors, []);
});

const cli = CLI;
const native = (() => {
  const target = {
    'darwin arm64': 'darwin-arm64',
    'darwin x64': 'darwin-amd64',
    'linux arm64': 'linux-arm64',
    'linux x64': 'linux-amd64',
  }[`${process.platform} ${process.arch}`];
  try {
    return createRequire(import.meta.url).resolve(`@ai-ecoverse/slicc-${target}/bin/slicc`);
  } catch {
    return cli;
  }
})();

test('a jerk sign-in cancelled while the linked computer doesn’t answer leaves no jerk running there', {
  skip: !cli,
}, async (t) => {
  const { chmod, mkdtemp, writeFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createInterface } = await import('node:readline');
  const dir = await mkdtemp(join(tmpdir(), 'vault-jerk-'));
  await writeFile(
    join(dir, 'jerk'),
    `#!/bin/sh\ncase "$1" in --version) echo "jerk 99.0.0"; exit 0;; esac\nif [ "$2" = create ]; then touch "${dir}/started"; sleep 6; touch "${dir}/finished"; echo '{"exit":0,"message":"signed in"}'; exit 0; fi\necho '{"exit":0,"items":[]}'\n`
  );
  await chmod(join(dir, 'jerk'), 0o755);
  fake.set({ locked: false, secrets: [] });
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  const said = [];
  const node = attach(native, ['--signal', 'stdio', '--name', 'jerk-node', '--no-kernel'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  t.after(() => {
    node.kill('SIGCONT');
    node.kill();
  });
  createInterface({ input: node.stderr }).on('line', (line) => said.push(line));
  await page.expose('sliccLinkSend', (message) => node.stdin.write(`${JSON.stringify(message)}\n`));
  createInterface({ input: node.stdout }).on('line', (line) =>
    page.evaluate((line) => globalThis.sliccLinkReceive(line), line).catch(() => {})
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links?.devices.some((device) => device.state === 'connected')
  );
  assert.ok(
    await logged(() => said.some((line) => /jerk: offering slicc-jerk 99\.0\.0/.test(line))),
    said.join('\n')
  );
  node.kill('SIGSTOP');
  await run(
    page,
    `exec 3<>/dev/sealed; printf '{"v":1,"op":"request","kind":"jerk","jop":"create","provider":"github"}' >&3; R=$(cat <&3); exec 3>&-; echo "ASKED $R"`
  );
  await shows(page, 'ASKED {');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await run(
    page,
    `exec 3<>/dev/sealed; printf '{"v":1,"op":"cancel","id":"req-1"}' >&3; R=$(cat <&3); exec 3>&-; echo "CANCELLED $R"`
  );
  await shows(page, 'CANCELLED {');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  node.kill('SIGCONT');
  await new Promise((resolve) => setTimeout(resolve, 10000));
  assert.equal(
    existsSync(join(dir, 'finished')),
    false,
    'jerk kept running on the linked computer after the cancel'
  );
  assert.equal(
    fake.log.some((entry) => entry.op === 'answered' && entry.request === 'req-1'),
    false
  );
  assert.deepEqual(page.errors, []);
});

test('jerk status counts a usable MCP record only for mcp:<its exact server>; every other provider answers no token, and a kernel program reads that back', async (t) => {
  t.after(() => fake.set({ secrets: [] }));
  fake.set({
    locked: false,
    records: [
      {
        kind: 'mcp',
        name: 'HARBOR_MCP_TOKEN',
        value: 'harbor-token-value',
        source: 'settings',
        placeholder: 'fnox_proxy_000000000000000000000b01',
        server: 'harbor',
      },
    ],
    version: 1,
  });
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  const sealed = async (mark, body) => {
    await run(
      page,
      `exec 3<>/dev/sealed; printf '${JSON.stringify(body)}' >&3; R=$(cat <&3); exec 3>&-; echo "${mark} $R"`
    );
    await shows(page, `${mark} {`);
  };
  const ask = async (provider) => {
    const before = fake.log.length;
    await sealed(`ASKED ${provider}`, {
      v: 1,
      op: 'request',
      kind: 'jerk',
      jop: 'status',
      provider,
    });
    const answer = await logged(() =>
      fake.log.slice(before).find((entry) => entry.op === 'answered')
    );
    assert.ok(answer, `no answer for ${provider}: ${JSON.stringify(fake.log.slice(before))}`);
    assert.equal(answer.state, 'done');
    await sealed(`READ ${answer.request}`, { v: 1, op: 'status', id: answer.request });
    await shows(
      page,
      `READ ${answer.request} {"v":1,"kind":"jerk","state":"done","exit":${answer.fields.exit}`
    );
    return answer.fields;
  };
  const none = (provider) => ({
    exit: 3,
    message: `no token for ${provider} in seven's vault: run jerk ${provider} create`,
  });
  assert.deepEqual(await ask('mcp:harbor'), { exit: 0 });
  for (const provider of ['mcp:tide', 'mcp:harbor-north', 'mcp:harbo', 'harbor'])
    assert.deepEqual(await ask(provider), none(provider));
  assert.deepEqual(page.errors, []);
});

test('the live vault answers on vault.sliccy.ai (smoke)', async (t) => {
  const response = await fetch('https://vault.sliccy.ai/', {
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (!response) {
    t.skip('vault.sliccy.ai is unreachable from here');
    return;
  }
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-security-policy') ?? '',
    /frame-ancestors[^;]*https:\/\/seven\.sliccy\.ai/
  );
  t.diagnostic('the hello itself is answered only for seven’s origins, which the harness can’t be');
});

test('the vault’s endpoints entries show in Activity as named hosts, never "undefined", and Unpin shows on a live pin and sends the vault one unpin for its name', async (t) => {
  const now = Date.now();
  const entry = (seq, minutes, fields) => ({
    type: 'endpoints',
    seq,
    id: `endpoints-${seq}`,
    at: now - minutes * 60000,
    uid: null,
    tag: null,
    ...fields,
  });
  t.after(() => fake.set({ audit: [] }));
  fake.set({
    locked: false,
    secrets: ['HARBOR_MCP_TOKEN', 'TIDE_STATION_TOKEN'],
    audit: [
      entry(14, 2, {
        unpinned: { name: 'TIDE_STATION_TOKEN', server: 'tide-mcp', host: 'mcp.tide.example' },
      }),
      entry(13, 9, {
        pinned: { name: 'HARBOR_MCP_TOKEN', server: 'harbor-mcp', host: 'mcp.harbor.example' },
      }),
      entry(12, 30, { adopted: [{ server: 'harbor-mcp', host: 'mcp.harbor.example' }] }),
      entry(11, 95, {
        purged: [
          {
            provider: 'tide-models',
            host: 'models.tide.example',
            url: 'https://models.tide.example/v1',
          },
        ],
      }),
    ],
  });
  const page = await chrome.page(t);
  await page.init(override(fake.origin));
  await boot(page);
  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  const rows = await page.within(60000, () => {
    const deep = (root) => {
      const found = root.querySelector('slicc-secrets');
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && deep(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const items = [
      ...(deep(document)?.shadowRoot?.querySelectorAll('ol.audit li[data-type=endpoints]') ?? []),
    ];
    return items.length === 4
      ? items.map((item) => ({
          seq: Number(item.dataset.seq),
          text: item.querySelector('.what').textContent.replace(/\s+/g, ' ').trim(),
          unpin: !!item.querySelector('[data-action=unpin]'),
        }))
      : null;
  });
  assert.deepEqual(
    rows.map(({ seq }) => seq),
    [14, 13, 12, 11]
  );
  for (const row of rows) assert.doesNotMatch(row.text, /undefined/, row.text);
  assert.deepEqual(
    rows.map(({ unpin }) => unpin),
    [false, true, false, false]
  );
  assert.match(rows[0].text, /mcp\.tide\.example/);
  assert.match(rows[1].text, /mcp\.harbor\.example/);
  assert.match(rows[2].text, /mcp\.harbor\.example/);
  assert.match(rows[3].text, /models\.tide\.example/);
  t.diagnostic(JSON.stringify(rows));
  await shoot(page, 'vault-endpoints-activity', { show: 'settings', target: '#secrets-audit' });
  const before = fake.log.length;
  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.within(30000, () => {
    const deep = (root) => {
      const found = root.querySelector('slicc-secrets');
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && deep(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const unpin = deep(document)?.shadowRoot?.querySelector(
      'li[data-seq="13"] [data-action=unpin]'
    );
    if (!unpin) return false;
    unpin.click();
    return true;
  });
  await logged(() => fake.log.slice(before).some((entry) => entry.op === 'endpoints-fields'));
  const sent = fake.log
    .slice(before)
    .filter((entry) => entry.op === 'endpoints-fields')
    .map((entry) => entry.fields);
  assert.deepEqual(sent, [{ unpin: ['HARBOR_MCP_TOKEN'] }]);
  await page.within(30000, () => {
    const deep = (root) => {
      const found = root.querySelector('slicc-secrets');
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && deep(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return !deep(document)?.shadowRoot?.querySelector('li[data-seq="13"] [data-action=unpin]');
  });
  assert.deepEqual(page.errors, []);
});
