import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startFakeVault } from './fake-vault.mjs';

const fake = await startFakeVault({
  locked: true,
  secrets: ['HARBOR_API_KEY', 'TIDE_STATION_TOKEN'],
});
const chrome = await launch();
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
  assert.deepEqual(refused, { code: 'EACCES', message: 'vault is locked' });
  fake.set({ locked: false });
  await page.evaluate(() => {
    const element = document.querySelector('iframe[data-vault=core]');
    element.setAttribute('src', element.getAttribute('src'));
  });
  await page.until(
    () => document.querySelector('slicc-app').model.vault.availability() === 'ready'
  );
  assert.ok(await logged(() => roles('hello').filter((role) => role === 'page').length === 2));
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
