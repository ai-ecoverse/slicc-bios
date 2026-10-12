import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
const framers = new Map();
const other = createServer((request, response) => {
  const body = framers.get(new URL(request.url, 'http://x').pathname);
  if (!body) return response.writeHead(404).end();
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
});
await new Promise((done) => other.listen(0, '127.0.0.1', done));
const elsewhere = `http://127.0.0.1:${other.address().port}`;
after(async () => {
  await new Promise((done) => other.close(done));
  await chrome.close();
});

const files = {
  'os/probe.html':
    '<!doctype html><title>probe</title><p id="ok">os</p><script>parent.postMessage("os", "*")</script>\n',
  'tmp/x.html':
    '<!doctype html><title>user</title><p id="ok">user</p><script>parent.postMessage("user", "*")</script>\n',
};

async function write(page) {
  await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split('/');
      const name = parts.pop();
      let dir = root;
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    }
  }, files);
}

function framer(base) {
  return `<!doctype html><title>framer</title>
<iframe id="os" src="${base}/os/probe.html"></iframe>
<iframe id="user" src="${base}/tmp/x.html"></iframe>
<script>
  self.loaded = new Set();
  self.said = new Set();
  addEventListener('message', ({ data }) => self.said.add(data));
  for (const frame of document.querySelectorAll('iframe')) {
    frame.addEventListener('load', () => self.loaded.add(frame.id));
  }
</script>
`;
}

async function frames(tab) {
  await tab.until(() => self.loaded?.size === 2);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return tab.evaluate(() => [...self.said].sort());
}

test("a cross-origin page can't frame seven's documents or its user content", async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await write(page);
  const seven = new URL(chrome.url).origin;
  framers.set('/framer.html', framer(seven));
  const tab = await page.tab();
  await tab.goto(`${elsewhere}/framer.html`);
  assert.deepEqual(await frames(tab), []);
  assert.deepEqual(page.errors, []);
});

test("seven's own pages still frame its documents and sprinkles", async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await write(page);
  chrome.overrides.set('/frames.html', framer(''));
  const tab = await page.tab();
  await tab.goto('/frames.html');
  assert.deepEqual(await frames(tab), ['os', 'user']);
  const inside = await tab.evaluate(
    () => document.getElementById('os').contentDocument.getElementById('ok').textContent
  );
  assert.equal(inside, 'os');

  const own = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    frame.src = '/os/probe.html';
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve));
    const posted = new Promise((resolve) =>
      addEventListener('message', ({ data }) => resolve(data), { once: true })
    );
    document.body.append(frame);
    await loaded;
    const from = await posted;
    const text = frame.contentDocument.getElementById('ok').textContent;
    frame.remove();
    const sprinkle = document.createElement('iframe');
    sprinkle.sandbox = 'allow-scripts';
    sprinkle.srcdoc = '<script>parent.postMessage("sprinkle", "*")</script>';
    const message = new Promise((resolve) =>
      addEventListener('message', ({ data }) => resolve(data), { once: true })
    );
    document.body.append(sprinkle);
    const said = await message;
    sprinkle.remove();
    return { text, from, said };
  });
  assert.deepEqual(own, { text: 'os', from: 'os', said: 'sprinkle' });
  assert.deepEqual(page.errors, []);
});
