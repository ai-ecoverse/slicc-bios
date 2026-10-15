import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const INSTALL = 10 * 60 * 1000;

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id),
    id
  );

async function act(page, id, action) {
  await page.evaluate(
    ([id, action]) => {
      window.acted = undefined;
      document
        .querySelector('slicc-app')
        .model.updates.actPackage(id, action)
        .then(
          () => 'ok',
          (error) => error.message
        )
        .then((result) => {
          window.acted = result;
        });
    },
    [id, action]
  );
  await page.within(INSTALL, () => window.acted !== undefined);
  return page.evaluate(() => window.acted);
}

const terminal = (page) =>
  page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    return dock.content(
      dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'))
    ).screen.textContent;
  });

const b64 = (text) => Buffer.from(text).toString('base64');
const EXE = '#!/usr/bin/env ruby\nputs "hello #{6 * 7} from a gem"\n';
const SPEC = `Gem::Specification.new do |s|
  s.name = "hello42"
  s.version = "0.1.0"
  s.summary = "Says hello"
  s.authors = ["seven"]
  s.files = ["exe/hello42"]
  s.bindir = "exe"
  s.executables = ["hello42"]
end
`;

test('a cone’s gem install puts a command on PATH, and a fresh login shell runs it by name', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.until(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === id),
    'ruby'
  );
  assert.equal(await act(page, 'ruby', 'install'), 'ok');
  assert.equal((await row(page, 'ruby')).version, '3.4.11-12');
  await run(
    page,
    `clear; cd /; sudo -u cone bash -c 'cd && mkdir -p gem42/exe && echo ${b64(EXE)} | base64 -d > gem42/exe/hello42 && echo ${b64(SPEC)} | base64 -d > gem42/hello42.gemspec && cd gem42 && gem build hello42.gemspec > /dev/null 2>&1 && gem install --local ./hello42-0.1.0.gem 2>&1 | tail -1'; echo built-$((40 + 2))`
  );
  await shows(page, 'built-42', 5 * 60 * 1000);
  assert.match(await terminal(page), /1 gem installed/);
  await run(page, "clear; sudo -u cone bash -lc 'hello42; echo ran=$?'; echo done-$((40 + 2))");
  await shows(page, 'done-42', 5 * 60 * 1000);
  const text = await terminal(page);
  assert.match(text, /hello 42 from a gem/);
  assert.match(text, /ran=0/);
  assert.deepEqual(page.errors, []);
});
