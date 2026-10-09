import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { serve, launch as start } from '@ai-ecoverse/slicc-shared-web/harness';

const options = {
  roots: [['/', 'src/']],
  aliases: [['/os/', 'src/seed/']],
  intercept: ['https://cdn.jsdelivr.net/', 'https://registry.npmjs.org/'],
  timeout: 60000,
  args: [],
};

export const emptyAgent = {
  '/packages/agent/package.json': '{ "name": "slicc-bios-agent", "private": true }\n',
  '/packages/agent/pnpm-lock.yaml':
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
};

export async function launch({ agent = false, ...overrides } = {}) {
  const chrome = await start({ ...options, ...overrides });
  if (agent) return chrome;
  const page = chrome.page;
  chrome.page = async (t) => {
    const opened = await page(t);
    for (const [path, body] of Object.entries(emptyAgent)) chrome.overrides.set(path, body);
    return opened;
  };
  return chrome;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve({ ...options, port: Number(env.PORT ?? 8080) });
  console.log(`slicc-bios on ${url}`);
}
