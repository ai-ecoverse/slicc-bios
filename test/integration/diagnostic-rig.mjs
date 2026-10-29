import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function diagnosticShape(value = {}) {
  const origin = (url) => {
    if (typeof url !== 'string') return undefined;
    try {
      const parsed = new URL(url);
      return parsed.origin === 'null' ? `${parsed.protocol}//${parsed.hostname}` : parsed.origin;
    } catch {
      return url === '://' ? '://' : 'invalid';
    }
  };
  const error = (text) => {
    if (typeof text !== 'string') return undefined;
    const known = [
      'slicc: refused: seven’s own pages and the vault are out of reach of browser automation',
      "slicc: refused: target is on seven's origin",
      "slicc: refused: slicc can't keep seven's origin out of this target",
    ];
    const found = known.find((message) => text.includes(message));
    return found ?? (text.includes('slicc: refused:') ? 'other-slicc-refusal' : 'other-error');
  };
  const frame = (item = {}) => ({
    fields: Object.keys(item).sort(),
    url: origin(item.url),
    unreachableUrl: origin(item.unreachableUrl),
    securityOrigin: origin(item.securityOrigin),
    parent: item.parentId !== undefined,
  });
  const tree = (item) =>
    item && {
      frame: frame(item.frame),
      children: (item.childFrames ?? []).map(tree),
    };
  const result = value.result ?? value;
  const out = {
    fields: Object.keys(result ?? {}).sort(),
    error: error(typeof value.error === 'string' ? value.error : value.error?.message),
  };
  if (result?.frameTree) out.frameTree = tree(result.frameTree);
  if (Array.isArray(result?.entries))
    out.history = {
      currentIndex: result.currentIndex,
      entries: result.entries.map((item) => ({
        fields: Object.keys(item).sort(),
        url: origin(item.url),
        userTypedURL: origin(item.userTypedURL),
      })),
    };
  if (result?.targetInfo)
    out.targetInfo = {
      fields: Object.keys(result.targetInfo).sort(),
      type: result.targetInfo.type,
      url: origin(result.targetInfo.url),
    };
  if (Array.isArray(result?.targetInfos))
    out.targetInfos = result.targetInfos.map((item) => ({
      type: item.type,
      url: origin(item.url),
    }));
  if (value.frame) out.frame = frame(value.frame);
  for (const key of ['url', 'pendingUrl', 'unreachableUrl', 'securityOrigin'])
    if (typeof value[key] === 'string') out[key] = origin(value[key]);
  if (value.errorReason !== undefined) out.errorReason = value.errorReason === 'BlockedByClient';
  return out;
}

function initDiagnostic(shape) {
  const records = [];
  const labels = new Map();
  let guards = 0;
  const label = (value) => {
    if (value === undefined || value === null) return null;
    if (!labels.has(value)) labels.set(value, labels.size + 1);
    return labels.get(value);
  };
  const emit = (record) => records.push({ time: Date.now(), seq: records.length, ...record });
  const tracked = new WeakSet();
  const instrument = (guard) => {
    const id = ++guards;
    const requests = new Map();
    const log = (stage, detail = {}) => emit({ layer: 'bios', guard: id, stage, ...detail });
    const state = (target) => {
      const nav = guard.navs.get(target);
      return {
        target: label(target),
        recalled: guard.recalled.has(target),
        nav: Boolean(nav),
        navSession: label(nav?.session),
        navDone: nav?.done,
        navFailed: nav?.failed,
        guarded: guard.targets.get(target)?.guarded,
        reported: shape({ url: guard.targets.get(target)?.reported }).url,
      };
    };
    log('new');
    if (!tracked.has(guard.tabs)) {
      tracked.add(guard.tabs);
      for (const name of ['get', 'set', 'delete']) {
        const original = guard.tabs[name];
        guard.tabs[name] = function (...args) {
          const result = original.apply(this, args);
          const record = name === 'get' ? result : args[1];
          emit({
            layer: 'bios',
            stage: `tabs:${name}`,
            target: label(args[0]),
            admitted: record?.admitted === true,
            error: Boolean(record?.error),
            errorOrigin: shape({ url: record?.error?.url }).url,
          });
          return result;
        };
      }
    }
    for (const name of [
      'touch',
      'stranded',
      'strandable',
      'fresh',
      'placed',
      'recover',
      'pageCheck',
      'precheck',
      'check',
      'recheck',
      'observing',
      'proveContent',
      'confirmed',
      'guarding',
      'unsafeContent',
      'reachTarget',
      'rememberTab',
      'rememberError',
      'rememberTreeError',
      'learn',
      'standIn',
      'refuse',
      'pass',
      'received',
      'call',
      'answer',
    ]) {
      const original = guard[name];
      guard[name] = function (...args) {
        const message = args[0];
        const target =
          typeof message === 'string' &&
          ['touch', 'stranded', 'strandable', 'rememberTab'].includes(name)
            ? message
            : name === 'learn'
              ? message?.targetId
              : name === 'rememberError'
                ? args[2]
                : name === 'rememberTreeError'
                  ? args[2]?.targetId
                  : guard.sessions.get(message?.sessionId)?.targetId;
        const method =
          typeof message === 'object' ? message?.method : name === 'call' ? message : undefined;
        const detail = {
          method,
          request: typeof message === 'object' ? message?.id : undefined,
          session: label(
            typeof message === 'object' ? message?.sessionId : name === 'call' ? args[2] : undefined
          ),
          ...state(target),
        };
        if (['rememberError', 'learn'].includes(name)) detail.shape = shape(message);
        if (name === 'rememberTreeError') detail.shape = shape({ frameTree: message });
        if (name === 'refuse') {
          detail.error = shape({
            error:
              args[1] ??
              'slicc: refused: seven’s own pages and the vault are out of reach of browser automation',
          }).error;
          detail.site = new Error().stack
            .split('\n')
            .slice(2, 5)
            .map((line) => line.trim());
        }
        if (name === 'received') {
          const incoming = JSON.parse(message);
          const request = requests.get(incoming.id);
          log('backend-reply', {
            method: request?.method ?? incoming.method,
            request: incoming.id,
            session: label(incoming.sessionId),
            shape: shape(incoming),
          });
        } else log(`${name}:enter`, detail);
        const result = original.apply(this, args);
        const done = (value) => {
          const verdict =
            typeof value === 'string'
              ? shape({ error: value }).error
              : typeof value === 'boolean'
                ? value
                : value === null
                  ? null
                  : Boolean(value);
          log(`${name}:return`, {
            ...detail,
            ...state(target),
            verdict,
            proof: this.recoveries.has(message ?? {}),
            ...(name === 'call' ? { shape: shape(value) } : {}),
          });
        };
        if (result?.then) result.then(done, () => log(`${name}:throw`, detail));
        else done(result);
        return result;
      };
    }
    const send = guard.connection.send;
    guard.connection.send = function (text) {
      const message = JSON.parse(text);
      requests.set(message.id, message);
      log('upstream', {
        method: message.method,
        request: message.id,
        session: label(message.sessionId),
        sessionKind: message.id >= 2 ** 30 ? 'guard-own' : 'client',
        params: shape(message.params),
      });
      return send.call(this, text);
    };
    const start = guard.start;
    guard.start = function () {
      const result = start.call(this);
      const outgoing = result.send;
      result.send = function (text) {
        const message = JSON.parse(text);
        requests.set(message.id, message);
        log('client', {
          method: message.method,
          request: message.id,
          session: label(message.sessionId),
          params: shape(message.params),
        });
        return outgoing.call(this, text);
      };
      let handler;
      Object.defineProperty(result, 'onmessage', {
        get: () =>
          handler &&
          ((text) => {
            const message = JSON.parse(text);
            const command = requests.get(message.id);
            log('client-reply', {
              method: command?.method ?? message.method,
              request: message.id,
              session: label(message.sessionId),
              shape: shape(message),
            });
            return handler(text);
          }),
        set: (value) => {
          handler = value;
        },
        configurable: true,
      });
      return result;
    };
  };
  globalThis.sliccDiagnostic = { records, emit, instrument };
}

export async function prepareDiagnostic(_real, page, extension, kind) {
  await page.init(`() => (${initDiagnostic.toString()})(${diagnosticShape.toString()})`);
  const mark = async (phase) =>
    page.evaluate(
      (phase) => globalThis.sliccDiagnostic.emit({ layer: 'rig', stage: phase }),
      phase
    );
  const collect = async () => {
    const records = await page.evaluate(() => globalThis.sliccDiagnostic?.records ?? []);
    const dir = process.env.SLICC_DIAGNOSTIC_DIR ?? 'diagnostic-artifacts';
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${extension.version}-${kind}.jsonl`),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n'
    );
  };
  const installCli = async () => {
    if (extension.version !== '7.9.16' || !process.env.SLICC_DIAGNOSTIC_CLI) return;
    const bytes = (await readFile(process.env.SLICC_DIAGNOSTIC_CLI)).toString('base64');
    const installed = await page.evaluate(async (bytes) => {
      const client = await globalThis.sliccKernelClient();
      try {
        const pkg = '/tmp/diagnostic-cli';
        await client.fs.mkdir(`${pkg}/bin`, { recursive: true });
        await client.fs.writeFile(
          `${pkg}/package.json`,
          JSON.stringify({
            name: 'diagnostic-cli',
            slicc: { abi: 'wasi', commands: { 'playwright-cli': { wasm: 'bin/playwright-cli' } } },
          })
        );
        await client.fs.writeFile(
          `${pkg}/bin/playwright-cli`,
          Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0))
        );
        const result = await client.run(['chmod', '755', `${pkg}/bin/playwright-cli`]);
        globalThis.sliccDiagnostic.emit({
          layer: 'rig',
          stage: 'cli-installed',
          code: result.status,
        });
        return result.status;
      } finally {
        await client.close();
      }
    }, bytes);
    assert.equal(installed, 0, 'traced playwright-cli was installed');
    return true;
  };
  const cli = async (text, phase) => {
    const parsed = text
      .split('\n')
      .filter((line) => line.startsWith('SLICC_DIAGNOSTIC '))
      .map((line) => JSON.parse(line.slice(17)));
    const exits = [...text.matchAll(/recovery-(goto|read|snapshot)-(\d+)/g)].map((match) => ({
      step: match[1],
      code: Number(match[2]),
    }));
    await page.evaluate(
      ({ parsed, exits, phase }) => {
        for (const record of parsed)
          globalThis.sliccDiagnostic.emit({ layer: 'cli', phase, ...record });
        globalThis.sliccDiagnostic.emit({ layer: 'rig', stage: 'cli-exits', phase, exits });
      },
      { parsed, exits, phase }
    );
  };
  return { mark, collect, installCli, cli };
}
