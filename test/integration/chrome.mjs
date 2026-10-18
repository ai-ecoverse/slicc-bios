import { existsSync } from 'node:fs';
import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { serve, launch as start } from '@ai-ecoverse/slicc-shared-web/harness';
import { startFakeVault } from './fake-vault.mjs';

const options = {
  roots: [['/', 'src/']],
  aliases: [['/os/', 'src/seed/']],
  intercept: ['https://cdn.jsdelivr.net/', 'https://registry.npmjs.org/'],
  timeout: 60000,
  ...(env.SLICC_COVERAGE === '1' ? {} : { coverage: [] }),
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

export const TRACE = env.SLICC_INSTALL_TRACE ? env.SLICC_INSTALL_TRACE !== '0' : Boolean(env.CI);
const CDN = new URL('../../node_modules/.cache/slicc-harness/cdn/', import.meta.url);

function cached(url) {
  const { host, pathname, search } = new URL(url);
  const query = search ? encodeURIComponent(search) : '';
  return existsSync(new URL(`./${host}${pathname}${query}`.replaceAll('%', '%25'), CDN));
}

const FETCHES = new Set(['Fetch', 'XHR']);

function networkTrace(cdp, origin) {
  const requests = new Map();
  const paused = new Map();
  const entry = (id) => requests.get(id);
  cdp.on(({ method, params }) => {
    const at = Date.now();
    if (method === 'Fetch.requestPaused') {
      const id = params.networkId ?? params.requestId;
      const pause = { paused: at, cached: cached(params.request.url) };
      if (entry(id)) Object.assign(entry(id), pause);
      else paused.set(id, pause);
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const { url, method: verb } = params.request;
      if (!FETCHES.has(params.type) || !/^https?:/.test(url) || url.startsWith(origin)) return;
      requests.set(params.requestId, {
        url,
        method: verb,
        type: params.type ?? null,
        sent: at,
        paused: null,
        cached: null,
        ...paused.get(params.requestId),
        headers: null,
        finished: null,
        failed: null,
      });
      paused.delete(params.requestId);
      return;
    }
    const found = params?.requestId && entry(params.requestId);
    if (!found) return;
    if (method === 'Network.responseReceived')
      Object.assign(found, {
        headers: at,
        status: params.response.status,
        protocol: params.response.protocol ?? null,
        fromServiceWorker: params.response.fromServiceWorker ?? false,
        remote: params.response.remoteIPAddress ?? null,
      });
    if (method === 'Network.loadingFinished')
      Object.assign(found, { finished: at, bytes: params.encodedDataLength });
    if (method === 'Network.loadingFailed')
      Object.assign(found, { failed: at, error: params.errorText, canceled: params.canceled });
  });
  return {
    list: () => [...requests.values()],
    reset() {
      requests.clear();
      paused.clear();
    },
  };
}

export async function launch({ agent = false, vault = true, ...overrides } = {}) {
  const chrome = await start({ ...options, ...overrides });
  const fake = vault ? await startFakeVault({ agentReal: true }) : null;
  const page = chrome.page;
  const close = chrome.close;
  chrome.vault = fake;
  const messages = consoleTail(chrome.cdp);
  const traced = TRACE ? networkTrace(chrome.cdp, new URL(chrome.url).origin) : null;
  chrome.close = (...args) => {
    fake?.close();
    return close.apply(chrome, args);
  };
  chrome.page = async (t) => {
    const opened = await page(t);
    messages.length = 0;
    opened.console = messages;
    if (traced) {
      traced.reset();
      opened.trace = {
        requests: traced.list,
        browser: () => chrome.cdp.send('Browser.getVersion'),
      };
      await opened.init(() => performance.setResourceTimingBufferSize(20000));
    }
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
