import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { ready, run, screen, shows } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const CANDIDATE = (
  await readFile(new URL('./fixtures/sliccy-browser-candidate.tgz', import.meta.url))
).toString('base64');
const PUBLISHED = '0.1.34';
const OWN = '/home/cone/.local/share/pnpm/bin';
const BASE = '/usr/bin';
const WORK = `const browser = require('sliccy:browser');
const url = process.argv[2];
browser
  .ensureTab(url)
  .then(async (tab) => {
    const found = await browser.findTab({ urlMatch: '/driven[.]html$' });
    const fetched = await browser.fetch(tab, url);
    const facts = {
      same: found?.targetId === tab.targetId,
      title: await browser.eval(tab, 'document.title'),
      sum: await browser.evalAsync(tab, 'Promise.resolve(2 + 2)'),
      stored: await browser.eval(tab, () => {
        localStorage.setItem('n', '123');
        return localStorage.getItem('n');
      }),
      status: fetched.status,
    };
    console.log('work ' + JSON.stringify(facts));
    process.exit(0);
  })
  .catch((error) => {
    console.log('work-error ' + error.stack);
    process.exit(1);
  });
`;
const SCRIPT = `export PATH=$PNPM_HOME/bin:$PATH
export SLICC_CDP_URL=\${SLICC_CDP_URL:-http://127.0.0.1:9222}
add() {
  pnpm add -g --config.minimum-release-age=0 "$@" >> /tmp/add.log 2>&1
  echo "added-$?"
}
look() {
  hash -r
  echo "which $(which playwright-cli) $(which curlwright)"
  playwright-cli --version
  jsh /tmp/work.jsh "$URL"
  pnpm ls -g --depth 0
}
`;

const chrome = await launch({ timeout: 120000, intercept: [] });
after(() => chrome.close());
const { port } = await devtools(chrome);
const fakeExtension = extensionOver(await debuggerUrl(port));

chrome.overrides.set('/driven.html', '<!doctype html><title>driven</title><h1>Driven</h1>');
const driven = () => {
  const at = new URL('/driven.html', chrome.url);
  at.hostname = 'localhost';
  return at.href;
};

async function sh(page, command) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  return page.evaluate(async (command) => {
    globalThis.diagnosticClient = await globalThis.sliccKernelClient();
    return globalThis.diagnosticClient.run(['bash', '-c', command], { cwd: '/' }).then(
      ({ status, stdout, stderr }) => ({
        code: String(status),
        out: `${stdout ?? ''}${stderr ?? ''}`.trim(),
      }),
      (error) => ({ code: 'error', out: error.message })
    );
  }, command);
}

async function write(page, file, text) {
  const written = await sh(
    page,
    `printf %s '${Buffer.from(text).toString('base64')}' | base64 -d > ${file}; chmod 644 ${file}; echo wrote-$?`
  );
  assert.equal(written.out, 'wrote-0');
}

async function start(t) {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page);
  await write(page, '/tmp/work.jsh', WORK);
  await write(page, '/tmp/676.sh', `URL=${driven()}\n${SCRIPT}`);
  const tarball = await sh(
    page,
    `printf %s '${CANDIDATE}' | base64 -d > /tmp/sliccy-browser.tgz; chmod 644 /tmp/sliccy-browser.tgz; echo wrote-$?`
  );
  assert.equal(tarball.out, 'wrote-0');
  return page;
}

async function asCone(page, steps, name) {
  const body = `. /tmp/676.sh; ${steps}`;
  await run(
    page,
    `clear; sudo -u cone bash -c '${body.replaceAll("'", "'\\''")}' > /tmp/${name}.log 2>&1; echo ${name}-$((40 + 2))`
  );
  await shows(page, `${name}-42`, 10 * 60 * 1000).catch(async (error) => {
    throw new Error(`${error.message}\n${await screen(page)}`);
  });
  const log = (await sh(page, `cat /tmp/${name}.log; echo ---; cat /tmp/add.log`)).out;
  console.log(`--- ${name}\n${log}`);
  return log;
}

const worked = /^work \{"same":true,"title":"driven","sum":4,"stored":"123","status":200\}$/m;

function checkBase(log) {
  assert.match(log, new RegExp(`^which ${BASE}/playwright-cli ${BASE}/curlwright$`, 'm'), log);
  assert.match(log, /^playwright-cli \d+\.\d+\.\d+$/m, log);
  assert.doesNotMatch(log, /^playwright-cli 1\.30\.18$/m, log);
  assert.match(log, worked, log);
  assert.doesNotMatch(log, /@ai-ecoverse\/slicc-cdp@/, log);
}

test('#676: in a real seven, a fresh pnpm add -g of the packed sliccy-browser leaves cone the base set’s playwright-cli and curlwright, and sliccy:browser works', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await start(t);
  const log = await asCone(
    page,
    'add @ai-ecoverse/slicc-jsh file:/tmp/sliccy-browser.tgz; look',
    'fresh'
  );
  assert.match(log, /^added-0$/m, log);
  checkBase(log);
});

test(`#676: in a real seven, updating from the published ${PUBLISHED} gives cone the base set’s playwright-cli and curlwright back, sliccy:browser works, and it holds across a reload`, {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await start(t);
  const before = await asCone(
    page,
    `add @ai-ecoverse/slicc-jsh @ai-ecoverse/sliccy-browser@${PUBLISHED}; look`,
    'published'
  );
  assert.match(before, /^added-0$/m, before);
  assert.match(before, new RegExp(`^which ${OWN}/playwright-cli ${OWN}/curlwright$`, 'm'), before);
  assert.match(before, /^playwright-cli 1\.30\.18$/m, before);

  const updated = await asCone(page, 'add file:/tmp/sliccy-browser.tgz; look', 'updated');
  assert.doesNotMatch(updated.split('---')[0], /^added-[1-9]/m, updated);
  checkBase(updated.split('---')[0]);

  await page.reload();
  await ready(page);
  const reloaded = await asCone(page, 'look', 'reloaded');
  checkBase(reloaded.split('---')[0]);
  assert.deepEqual(page.errors, []);
});
