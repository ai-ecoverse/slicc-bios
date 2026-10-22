import { KNOWN, profileSchema, schemaOf } from './durable.js';
import { GATED } from './layer.js';
import { compare, locked } from './packages.js';
import { BIOS } from './site.js';
import { fetchText, pnpm, remove, text, versions, write } from './update.js';

export const DEVELOPER = 'slicc-os.developer';
export const BETAS = 'slicc-os.beta';
export const REGISTRY = 'https://registry.npmjs.org/';
export const SLSA = 'https://slsa.dev/provenance/v1';
export const NOTICE = 'beta:agent';
export const AGENT = {
  id: 'agent',
  name: '@ai-ecoverse/slicc-agent',
  repository: 'https://github.com/ai-ecoverse/slicc-agent',
  workflow: ['.github/workflows/release.yml', '.github/workflows/ci.yml'],
  folder: 'opt/agent',
  scratch: 'opt/slicc/beta/agent',
};
const KERNEL = '@ai-ecoverse/slicc-kernel';
const SPECTRUM = '@ai-ecoverse/slicc-spectrum';
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CERTS = new URL('packages/certs.json', BIOS);
const LOCK_ONLY = ['pnpm', 'install', '--lockfile-only'];

export async function digest(value) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function triple(version) {
  const [main] = version.split('-');
  return main.split('.').map(Number);
}

function filled(partial) {
  const parts = partial.split('-')[0].split('.');
  const pre = partial.includes('-') ? partial.slice(partial.indexOf('-')) : '';
  return { parts: parts.length, version: `${[0, 1, 2].map((i) => parts[i] ?? 0).join('.')}${pre}` };
}

function bump(version, at) {
  const next = triple(version).map((part, i) => (i < at ? part : i === at ? part + 1 : 0));
  return `${next.join('.')}-0`;
}

function comparators(token) {
  if (token === '*' || token === 'x' || token === '') return [];
  const match = token.match(/^(\^|~|>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/);
  if (!match) return null;
  const [, op = '=', raw] = match;
  const { parts, version } = filled(raw);
  if (op === '^') {
    const [major, minor] = triple(version);
    const at = major > 0 || parts === 1 ? 0 : minor > 0 || parts === 2 ? 1 : 2;
    return [
      ['>=', version],
      ['<', bump(version, at)],
    ];
  }
  if (op === '~') {
    return [
      ['>=', version],
      ['<', bump(version, parts === 1 ? 0 : 1)],
    ];
  }
  if (op === '=' && parts < 3) {
    return [
      ['>=', version],
      ['<', bump(version, parts - 1)],
    ];
  }
  if (op === '<=' && parts < 3) return [['<', bump(version, parts - 1)]];
  if (op === '>' && parts < 3) return [['>=', bump(version, parts - 1)]];
  return [[op, version]];
}

const CHECKS = {
  '=': (d) => d === 0,
  '>=': (d) => d >= 0,
  '<=': (d) => d <= 0,
  '>': (d) => d > 0,
  '<': (d) => d < 0,
};

export function satisfies(version, range) {
  if (typeof range !== 'string' || !EXACT.test(version)) return false;
  return range.split('||').some((set) => {
    const tokens = set.trim().split(/\s+/).filter(Boolean);
    const all = [];
    for (const token of tokens.length ? tokens : ['*']) {
      const found = comparators(token);
      if (!found) return false;
      all.push(...found);
    }
    return all.every(([op, at]) => CHECKS[op](compare(version, at)));
  });
}

function decode(base64) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function sha512hex(integrity) {
  const bytes = Uint8Array.from(atob(integrity.slice('sha512-'.length)), (char) =>
    char.charCodeAt(0)
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function provenance(doc, { name, repository, workflow, refs }, fetcher = fetch) {
  const { integrity, attestations } = doc.dist ?? {};
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) return 'no integrity';
  if (attestations?.provenance?.predicateType !== SLSA || typeof attestations.url !== 'string')
    return 'no provenance';
  const url = new URL(attestations.url);
  if (url.origin !== new URL(REGISTRY).origin) return 'no provenance';
  const response = await fetcher(url.href, { cache: 'no-cache' });
  if (!response.ok) return 'no provenance';
  const found = ((await response.json())?.attestations ?? []).find(
    (one) => one?.predicateType === SLSA
  );
  const payload = found?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== 'string') return 'no provenance';
  let statement;
  try {
    statement = JSON.parse(decode(payload));
  } catch {
    return 'no provenance';
  }
  const subject = `pkg:npm/${name.replace(/^@/, '%40')}@${doc.version}`;
  const hex = sha512hex(integrity);
  const matches = (statement?.subject ?? []).some(
    (one) => one?.name === subject && one?.digest?.sha512 === hex
  );
  const built = statement?.predicate?.buildDefinition?.externalParameters?.workflow;
  if (!matches || built?.repository !== repository)
    return 'its provenance doesn’t match this release';
  const from = refs ?? ['refs/heads/main', `refs/tags/v${doc.version}`];
  if (![workflow].flat().includes(built.path) || !from.includes(built.ref))
    return 'built outside the release workflow';
  return null;
}

export function compatible(doc, have) {
  const wants = { ...doc.peerDependencies };
  if (doc.engines?.['slicc-kernel']) wants[KERNEL] = doc.engines['slicc-kernel'];
  for (const [name, range] of Object.entries(wants)) {
    if (!Object.hasOwn(have, name)) continue;
    const at = have[name];
    if (at && !satisfies(at, range)) {
      const short = name.replace(/^@ai-ecoverse\//, '');
      return `needs ${short} ${range}; seven has ${at}`;
    }
  }
  return null;
}

export function changes(before, after) {
  const old = locked(before);
  const next = locked(after);
  const added = [...next].filter(([key, integrity]) => old.get(key) !== integrity);
  const removed = [...old.keys()].filter((key) => !next.has(key));
  const nameOf = (key) => key.slice(0, key.lastIndexOf('@'));
  const gated = added.filter(([key]) => GATED.test(nameOf(key)));
  const names = new Set([...added.map(([key]) => nameOf(key)), ...removed.map(nameOf)]);
  return {
    count: names.size,
    added: added.map(([key]) => key),
    removed,
    gated: gated.map(([key, integrity]) => ({ key, integrity })),
  };
}

function exactPin(manifest, name, version) {
  const out = structuredClone(manifest);
  out.dependencies = { ...out.dependencies, [name]: version };
  return `${JSON.stringify(out, null, 2)}\n`;
}

function parse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function developerOn(storage) {
  return storage.getItem(DEVELOPER) === 'on';
}

export function readBeta(storage, { name } = AGENT) {
  const found = parse(storage.getItem(BETAS) ?? 'null')?.agent;
  if (!found || typeof found !== 'object') return null;
  const { version, integrity, lock, manifest, deployment, certified } = found;
  const strings = [version, integrity, lock, manifest, deployment, certified];
  if (found.name !== name || strings.some((value) => typeof value !== 'string')) return null;
  if (!EXACT.test(version) || locked(lock).get(`${name}@${version}`) !== integrity) return null;
  if (parse(manifest)?.dependencies?.[name] !== version) return null;
  return found;
}

async function deployment(from) {
  const [manifest, lock] = await Promise.all(
    ['package.json', 'pnpm-lock.yaml'].map((file) => fetchText(file, from))
  );
  const parsed = JSON.parse(manifest);
  return {
    manifest: parsed,
    lock,
    hash: await digest(lock),
    pin: parsed.dependencies?.[AGENT.name],
  };
}

async function mismatch(root, record) {
  const receipt = await text(root, 'var/lib/slicc/agent/pnpm-lock.yaml');
  if (receipt !== record.lock) return 'its lockfile isn’t the one you approved';
  const at = (await versions(root, [AGENT.name], `${AGENT.folder}/`))[AGENT.name];
  if (at !== record.version) return `/opt/agent has ${at ?? 'no agent'} instead`;
  return null;
}

async function resolve(ctx, deployed, doc) {
  const { root, from, scratch } = ctx;
  const manifest = exactPin(deployed.manifest, AGENT.name, doc.version);
  const workspace = await fetchText('pnpm-workspace.yaml', from).catch(() => '{}\n');
  await write(root, `${scratch}/package.json`, manifest);
  await write(root, `${scratch}/pnpm-lock.yaml`, deployed.lock);
  await write(root, `${scratch}/pnpm-workspace.yaml`, workspace);
  await remove(root, `${scratch}/.cache`);
  const argv = [...LOCK_ONLY, `--config.cache-dir=/${scratch}/.cache`];
  await pnpm(await ctx.kernel(), `/${scratch}`, () => {}, doc.version, argv);
  const lock = await text(root, `${scratch}/pnpm-lock.yaml`);
  if (!lock || locked(lock).get(`${AGENT.name}@${doc.version}`) !== doc.dist.integrity)
    throw new Error('npm’s integrity doesn’t match the resolved lockfile');
  const diff = changes(deployed.lock, lock);
  const certified = await ctx.certs();
  const uncertified = diff.gated
    .filter(({ key, integrity }) => certified[key]?.integrity !== integrity)
    .map(({ key }) => key);
  return { manifest, lock, diff, uncertified };
}

async function have(root, deployed) {
  const base = await versions(root, [SPECTRUM]);
  return {
    [KERNEL]: deployed.manifest.dependencies?.[KERNEL] ?? null,
    [SPECTRUM]: base[SPECTRUM],
  };
}

async function latestOf(ctx) {
  const response = await ctx.fetcher(`${REGISTRY}${AGENT.name}/latest`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} from npm`);
  const doc = await response.json();
  if (doc?.name !== AGENT.name || !EXACT.test(doc?.version ?? ''))
    throw new Error('npm gave no version');
  return doc;
}

async function look(ctx) {
  const deployed = await deployment(ctx.from);
  const record = readBeta(ctx.storage);
  const doc = await latestOf(ctx);
  const latest = doc.version;
  const running = record?.version ?? (await ctx.installed()) ?? deployed.pin;
  if (compare(latest, deployed.pin) <= 0 || compare(latest, running) <= 0)
    return { npm: { state: 'current', latest }, offer: null };
  const [from, to] = [deployed.pin, latest].map((version) => Number(version.split('.')[0]));
  const needed = await profileSchema(await navigator.storage.getDirectory(), ctx.storage);
  if (to > from && needed < schemaOf(latest) && needed <= KNOWN) {
    const reason = `a new major version; seven ships ${from}.x`;
    return { npm: { state: 'not-offered', latest, reason }, offer: null };
  }
  const refused =
    (await provenance(doc, AGENT, ctx.fetcher)) ?? compatible(doc, await have(ctx.root, deployed));
  if (refused) return { npm: { state: 'not-offered', latest, reason: refused }, offer: null };
  const key = `${latest}\n${doc.dist.integrity}\n${deployed.hash}`;
  if (ctx.previewed?.key !== key) ctx.previewed = { key, ...(await resolve(ctx, deployed, doc)) };
  const seen = ctx.previewed;
  if (seen.uncertified.length) {
    const reason = `needs ${seen.uncertified.join(', ')}, which isn’t certified`;
    return { npm: { state: 'not-offered', latest, reason }, offer: null };
  }
  const offer = {
    version: latest,
    integrity: doc.dist.integrity,
    manifest: seen.manifest,
    lock: seen.lock,
    deployment: deployed.hash,
    certified: deployed.pin,
    diff: seen.diff,
  };
  const gated = seen.diff.gated.map(({ key: one }) => one);
  return {
    npm: { state: 'offered', latest, changes: { count: seen.diff.count, gated } },
    offer,
  };
}

function described(diff) {
  const gated = diff.gated.map(({ key }) => key);
  const count = `${diff.count} ${diff.count === 1 ? 'package changes' : 'packages change'}`;
  return gated.length
    ? `${count} in /opt/agent’s lockfile, including the certified ${gated.join(', ')}, at certified versions.`
    : `${count} in /opt/agent’s lockfile. No certified packages change.`;
}

function recordOf(chosen, now) {
  return {
    agent: {
      name: AGENT.name,
      version: chosen.version,
      integrity: chosen.integrity,
      manifest: chosen.manifest,
      lock: chosen.lock,
      deployment: chosen.deployment,
      certified: chosen.certified,
      at: now(),
    },
  };
}

function betaNotice(record) {
  return {
    id: `${NOTICE}:${record.version}`,
    tone: 'warning',
    title: 'The agent runs a beta',
    body: `slicc-agent ${record.version} isn’t certified. You installed it in developer mode; seven’s certified version is ${record.certified}.`,
    actions: [{ id: 'back-to-certified', label: 'Back to certified' }],
    session: true,
  };
}

async function settled(ctx, tell) {
  const record = readBeta(ctx.storage);
  if (!record) {
    if (ctx.storage.getItem(BETAS) !== null) ctx.forget();
    return null;
  }
  const deployed = await deployment(ctx.from);
  if (deployed.hash === record.deployment) return record;
  ctx.forget();
  if (EXACT.test(deployed.pin ?? '') && compare(deployed.pin, record.version) >= 0) {
    tell(
      'caught-up',
      'The agent is certified again',
      `Seven now ships certified slicc-agent ${deployed.pin}, so the beta ${record.version} is no longer needed.`
    );
  } else {
    tell(
      'replaced',
      'The agent went back to certified',
      `Seven updated its certified agent to ${deployed.pin}, so it removed the beta ${record.version}. Install the beta again from Install / Update.`
    );
  }
  return null;
}

async function applied(ctx, record, run) {
  const read = async (file) => {
    if (file === 'package.json') return record.manifest;
    if (file === 'pnpm-lock.yaml') return record.lock;
    return fetchText(file, ctx.from);
  };
  try {
    const result = await run({ read });
    return { result, problem: await mismatch(ctx.root, record) };
  } catch (error) {
    return { result: null, problem: error.message.split('\n')[0] };
  }
}

export function createBetas({
  storage = localStorage,
  root,
  kernel,
  updates,
  notices,
  ask,
  reinstall,
  installed,
  from,
  fetcher = (url, init) => fetch(url, init),
  certs = () => fetchText('', CERTS).then(JSON.parse),
  now = Date.now,
}) {
  let offer = null;
  let npm = null;
  let checking = null;
  let shownNotice = null;
  const ctx = {
    storage,
    root,
    kernel,
    installed,
    from,
    fetcher,
    certs,
    scratch: AGENT.scratch,
    previewed: null,
    forget() {
      storage.removeItem(BETAS);
      offer = null;
      ctx.previewed = null;
    },
  };

  const show = () => {
    const record = readBeta(storage);
    updates.setBeta(AGENT.id, {
      beta: record ? { version: record.version, certified: record.certified } : null,
      npm: developerOn(storage) ? npm : null,
    });
    const notice = record && betaNotice(record);
    if (shownNotice && shownNotice !== notice?.id) notices.remove(shownNotice);
    shownNotice = notice?.id ?? null;
    if (notice) notices.show(notice, () => leave());
  };

  const tell = (key, title, body) =>
    notices.show({ id: `beta:${key}:${now()}`, tone: 'info', title, body, actions: [] }, () => {});

  async function apply(run) {
    const record = await settled(ctx, tell);
    if (!record) {
      const result = await run({});
      show();
      return result;
    }
    const { result, problem } = await applied(ctx, record, run);
    show();
    if (!problem) return result;
    ctx.forget();
    show();
    await run({});
    throw Object.assign(new Error(problem), {
      plain: `Couldn’t install the agent’s beta ${record.version} (${problem}). Seven went back to certified ${record.certified}.`,
    });
  }

  async function looked() {
    npm = { ...npm, state: 'checking' };
    show();
    try {
      ({ npm, offer } = await look(ctx));
    } catch (error) {
      offer = null;
      npm = {
        state: 'failed',
        latest: npm?.latest ?? null,
        reason: `Couldn’t check npm (${error.message.split('\n')[0]})`,
      };
    }
    show();
  }

  async function check() {
    if (!developerOn(storage) || !(await kernel())) {
      offer = null;
      npm = null;
      show();
      return;
    }
    checking ??= looked().finally(() => {
      checking = null;
    });
    await checking;
  }

  async function install() {
    if (!developerOn(storage)) throw new Error('Turn on developer mode in Settings first.');
    await checking;
    const chosen = offer;
    if (!chosen) throw new Error('There is no beta to install.');
    const yes = await ask({
      title: `Install the agent’s beta ${chosen.version}?`,
      body: `slicc-agent ${chosen.version} isn’t certified; seven’s certified version is ${chosen.certified}. ${described(chosen.diff)} You can go back to certified at any time.`,
      action: 'Install beta',
      variant: 'confirmation',
    });
    if (!yes) return;
    if (offer?.version !== chosen.version || offer.lock !== chosen.lock)
      throw new Error('The beta on npm changed meanwhile. Check again.');
    if ((await deployment(from)).hash !== chosen.deployment)
      throw new Error('Seven’s certified agent changed meanwhile. Check again.');
    storage.setItem(BETAS, JSON.stringify(recordOf(chosen, now)));
    offer = null;
    npm = { state: 'current', latest: chosen.version };
    show();
    await reinstall();
    await check();
  }

  async function leave() {
    const had = readBeta(storage);
    ctx.forget();
    show();
    if (!had) return;
    await reinstall();
    if (updates.get(AGENT.id)?.actions.includes('restart-agent'))
      void updates.act(AGENT.id, 'restart-agent').catch(() => undefined);
    await check();
  }

  async function off() {
    const record = readBeta(storage);
    const back =
      record &&
      (await ask({
        title: 'Return the agent to certified?',
        body: `The agent runs the beta ${record.version}. With developer mode off, seven offers no more betas; a beta you keep stays marked.`,
        action: 'Back to certified',
        cancel: 'Keep beta',
        variant: 'confirmation',
      }));
    storage.removeItem(DEVELOPER);
    offer = null;
    npm = null;
    if (back) await leave();
    else show();
  }

  async function set(on) {
    if (!on) return off();
    storage.setItem(DEVELOPER, 'on');
    await check();
  }

  updates.handleDeveloper({ on: () => developerOn(storage), set });
  updates.handle('install-beta', () => install());
  updates.handle('back-to-certified', () => leave());

  return { apply, check, install, leave, set, show };
}
