import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { agentUp, ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ agent: true, timeout: 60000 });
after(() => chrome.close());

const AGENT = '/opt/agent/node_modules/@ai-ecoverse/slicc-agent';

const helpers = () => {
  const folder = async (parts, create) => {
    let dir = await navigator.storage.getDirectory();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir;
  };
  const handle = async (path, create) => {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    return (await folder(parts, create)).getFileHandle(name, { create });
  };
  window.readOpfs = async (path) => {
    try {
      return await (await (await handle(path, false)).getFile()).text();
    } catch {
      return null;
    }
  };
  window.writeOpfs = async (path, text) => {
    const writable = await (await handle(path, true)).createWritable();
    await writable.write(text);
    await writable.close();
  };
  window.agentBuild = () => ({
    adapter: document.querySelector('slicc-app')?.model?.agent?.sevenBuild ?? null,
    chord: globalThis.sevenChord ?? null,
  });
};

async function upgrade(page) {
  return page.evaluate(async (agent) => {
    const candidates = [
      `${agent}/node_modules/@earendil-works/chord`,
      '/opt/agent/node_modules/@earendil-works/chord',
    ];
    let chord = null;
    for (const dir of candidates) {
      if ((await window.readOpfs(`${dir}/package.json`)) !== null) {
        chord = dir;
        break;
      }
    }
    if (!chord) throw new Error(`no @earendil-works/chord in ${candidates.join(' or ')}`);
    const port = await window.readOpfs(`${agent}/dist/spectrum/agent-port.js`);
    if (!/from "@earendil-works\/chord\/context"/.test(port))
      throw new Error('agent-port.js no longer imports @earendil-works/chord/context');
    if (!/\bclass AgentAdapter\b/.test(port)) throw new Error('agent-port.js has no AgentAdapter');
    const manifest = JSON.parse(await window.readOpfs(`${chord}/package.json`));
    const entry = manifest.exports['./context'].import;
    await window.writeOpfs(
      `${chord}/dist/context/next.js`,
      `export * from "./${entry.split('/').pop()}";\nglobalThis.sevenChord = "next";\n`
    );
    manifest.exports['./context'] = {
      ...manifest.exports['./context'],
      import: './dist/context/next.js',
    };
    await window.writeOpfs(`${chord}/package.json`, JSON.stringify(manifest));
    await window.writeOpfs(
      `${agent}/dist/spectrum/agent-port.js`,
      `${port}\nAgentAdapter.prototype.sevenBuild = 'next';\n`
    );
    const modules = '/opt/agent/node_modules/.modules.yaml';
    await window.writeOpfs(modules, (await window.readOpfs(modules)) ?? '');
    return entry;
  }, AGENT);
}

test("after an agent update that changes a module and a dependency's entry, Restart agent and the next load both run the new agent code", {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await ready(page);
  await agentUp(page);
  assert.deepEqual(await page.evaluate(() => window.agentBuild()), { adapter: null, chord: null });

  const entry = await upgrade(page);
  assert.match(entry, /^\.\/dist\/context\/.+\.js$/);
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.updates.act('agent', 'restart-agent')
  );
  await page.until(() => {
    const build = window.agentBuild();
    return build.adapter === 'next' && build.chord === 'next';
  });

  await page.reload();
  await ready(page);
  await agentUp(page, { label: 'agent on the next load' });
  await page.until(() => {
    const build = window.agentBuild();
    return build.adapter === 'next' && build.chord === 'next';
  });
  assert.deepEqual(page.errors, []);
});
