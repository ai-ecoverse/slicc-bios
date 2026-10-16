import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { serve, launch as start } from '@ai-ecoverse/slicc-shared-web/harness';
import { startFakeVault } from './fake-vault.mjs';

const options = {
  roots: [['/', 'src/']],
  aliases: [['/os/', 'src/seed/']],
  intercept: ['https://cdn.jsdelivr.net/', 'https://registry.npmjs.org/'],
  timeout: 60000,
};

export const emptyAgent = {
  '/packages/agent/package.json': '{ "name": "slicc-bios-agent", "private": true }\n',
  '/packages/agent/pnpm-lock.yaml':
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
  '/packages/agent/pnpm-workspace.yaml': "minimumReleaseAgeExclude:\n  - '@ai-ecoverse/*'\n",
};

export const VAULT_KEY = 'slicc-os.vault-origin';

const NOISE = /Spectrum Web Components is in dev mode|The legal slot is empty/;
const KEEP = 40;

function consoleTail(cdp) {
  const lines = [];
  const keep = (line) => {
    if (NOISE.test(line)) return;
    lines.push(line.slice(0, 400));
    if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
  };
  cdp.on(({ method, params }) => {
    if (
      method === 'Runtime.consoleAPICalled' &&
      ['error', 'warning', 'assert'].includes(params.type)
    )
      keep(`${params.type} ${params.args.map((arg) => arg.value ?? arg.description).join(' ')}`);
    if (method === 'Runtime.exceptionThrown') {
      const { exception, text } = params.exceptionDetails;
      keep(`exception ${exception?.description ?? text}`);
    }
  });
  return lines;
}

export async function launch({ agent = false, vault = true, ...overrides } = {}) {
  const chrome = await start({ ...options, ...overrides });
  const fake = vault ? await startFakeVault({ agentReal: true }) : null;
  const page = chrome.page;
  const close = chrome.close;
  chrome.vault = fake;
  const messages = consoleTail(chrome.cdp);
  chrome.close = (...args) => {
    fake?.close();
    return close.apply(chrome, args);
  };
  chrome.page = async (t) => {
    const opened = await page(t);
    messages.length = 0;
    opened.console = messages;
    if (fake)
      await opened.init(
        `() => { if (location.origin === ${JSON.stringify(new URL(chrome.url).origin)} && !localStorage.getItem(${JSON.stringify(VAULT_KEY)})) localStorage.setItem(${JSON.stringify(VAULT_KEY)}, ${JSON.stringify(fake.origin)}); }`
      );
    if (!agent)
      for (const [path, body] of Object.entries(emptyAgent)) chrome.overrides.set(path, body);
    return opened;
  };
  return chrome;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve({ ...options, port: Number(env.PORT ?? 8080) });
  console.log(`slicc-bios on ${url}`);
}
