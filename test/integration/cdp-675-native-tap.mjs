import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tapNativeSource(source) {
  assert.equal(source.split('class Connection {').length, 2);
  return `${source}
const cdp675NativeRecord = (record) => {
  const records = globalThis.cdp675NativeTrace ??= [];
  records.push({ at: Date.now(), ...record });
  if (records.length > 20000) records.shift();
};
const cdp675NativeEvent = Connection.prototype.onEvent;
Connection.prototype.onEvent = async function (source, method, params) {
  if (method.startsWith('Debugger.')) cdp675NativeRecord({ tabId: source.tabId, phase: 'native-event', method, params });
  return cdp675NativeEvent.call(this, source, method, params);
};
for (const name of ['sessionCommand', 'admit', 'seal', 'bind', 'send']) {
  const original = Connection.prototype[name];
  Connection.prototype[name] = async function (...args) {
    const command = name === 'sessionCommand';
    const tabId = command ? this.state.sessions.get(args[0].sessionId)?.tabId : args[0];
    const method = command ? args[0].method : name === 'send' ? args[1] : args[2];
    const params = command ? args[1] : name === 'send' ? args[2] : args[3];
    const probe = method === 'Runtime.evaluate' && params?.expression === 'location.href';
    const read = name === 'send' && ['Page.getFrameTree', 'DOMSnapshot.captureSnapshot'].includes(method);
    if (!probe && !read) return original.apply(this, args);
    const state = () => {
      const tab = name === 'send' || command ? this.state.tabs.get(tabId) : args[1];
      return { visible: [...(tab?.seal?.visible ?? [])], sealed: [...(tab?.seal?.sealed ?? [])], nodes: [...(tab?.seal?.nodes ?? [])] };
    };
    cdp675NativeRecord({ tabId, phase: name, outcome: 'start', method, params, ...state() });
    try {
      const result = await original.apply(this, args);
      const witness = read ? method === 'Page.getFrameTree' ? result : { frames: result.documents?.map(doc => result.strings?.[doc.frameId]) } : undefined;
      cdp675NativeRecord({ tabId, phase: name, outcome: 'success', method, witness, ...state() });
      return result;
    } catch (error) {
      cdp675NativeRecord({ tabId, phase: name, outcome: 'error', method, error: String(error?.message ?? error), stack: error?.stack ?? null, ...state() });
      throw error;
    }
  };
}
`;
}

export function tapDebuggerSource(source) {
  const lift = '          state.suspension = null;';
  assert.equal(source.split(lift).length, 2);
  const tapped = source.replace(
    lift,
    `          globalThis.cdp675GateRecord({ tabId, phase: 'lift', outcome: 'success', reason: 'fresh whole-page proof, same generation and revision, within suspension deadline' });
${lift}`
  );
  return `${tapped}
const cdp675GateState = (gate, tabId, supplied) => {
  const state = supplied ?? gate.states.get(tabId);
  const tab = gate.connection.tabState(tabId);
  return {
    owner: state?.owner, generation: state?.generation, revision: state?.revision,
    enabled: state?.enabled, currentState: Boolean(state) && gate.states.get(tabId) === state,
    suspended: Boolean(state?.suspension), suspensionDeadline: state?.suspension?.deadline,
    pause: state?.pause && { converted: state.pause.converted, published: state.pause.published, verifying: state.pause.verifying, deadline: state.pause.deadline },
    scripts: [...(state?.scripts.keys() ?? [])], scriptInfo: [...(state?.scriptInfo.entries() ?? [])],
    root: tab?.mainFrameId, loader: tab?.documents.frames.get(tab.mainFrameId)?.loaderId,
    tabRevision: tab?.debuggerRevision, frameEvents: tab?.frameEvents,
    frames: [...(tab?.frames.entries() ?? [])], blocks: [...(tab?.debuggerFrameBlocks ?? [])],
    foreign: tab?.worlds.foreign, hidden: [...(tab?.worlds.ids.values() ?? [])].filter(entry => entry.hidden).map(entry => entry.context?.id)
  };
};
globalThis.cdp675GateRecord = (record) => {
  const records = globalThis.cdp675NativeTrace ??= [];
  records.push({ at: Date.now(), gate: true, ...record });
  if (records.length > 20000) records.shift();
};
for (const name of ['event', 'proof', 'pauseReady', 'paused', 'convert', 'resume', 'drop']) {
  const original = DebuggerGate.prototype[name];
  DebuggerGate.prototype[name] = async function (...args) {
    const tabId = args[0];
    const supplied = ['pauseReady', 'paused', 'convert', 'resume', 'proof'].includes(name) ? args[1] : undefined;
    const params = name === 'event' ? args[2] : ['pauseReady', 'paused'].includes(name) ? args[2] : undefined;
    const reason = name === 'convert' ? 'guard-owned instrumentation pause conversion' : name === 'resume' ? args[2] ? 'published pause rescue' : 'private resume; see caller and preceding gate decision' : params?.reason ?? name;
    globalThis.cdp675GateRecord({ tabId, phase: name, outcome: 'start', reason, caller: new Error().stack, method: name === 'event' ? args[1] : undefined, params, ...cdp675GateState(this, tabId, supplied) });
    try {
      const result = await original.apply(this, args);
      globalThis.cdp675GateRecord({ tabId, phase: name, outcome: 'success', reason: result === false ? 'predicate refused; see preceding proof or predicate decision' : name, verdict: result, ...cdp675GateState(this, tabId, supplied) });
      return result;
    } catch (error) {
      globalThis.cdp675GateRecord({ tabId, phase: name, outcome: 'error', reason: String(error?.message ?? error), stack: error?.stack, ...cdp675GateState(this, tabId, supplied) });
      throw error;
    }
  };
}
for (const name of ['script', 'suspend', 'revoke', 'convertible', 'childrenPlaced', 'knownChildren', 'context', 'ids', 'privateInstrumentation', 'rememberPublished']) {
  const original = DebuggerGate.prototype[name];
  DebuggerGate.prototype[name] = function (...args) {
    const tabId = name === 'rememberPublished' ? [...this.states].find(([, state]) => state === args[0])?.[0] : name === 'knownChildren' ? [...this.connection.state.tabs].find(([, tab]) => tab === args[0])?.[0] : args[0];
    const before = cdp675GateState(this, tabId);
    try {
      const result = original.apply(this, args);
      const reason = name === 'rememberPublished' ? 'all live publication checks passed' : name === 'suspend' ? 'reachable frame or child witness unsettled; fresh whole-page proof required' : name;
      globalThis.cdp675GateRecord({ tabId, phase: name === 'rememberPublished' ? 'publish' : name, outcome: 'success', reason, caller: new Error().stack, verdict: result, before, ...cdp675GateState(this, tabId) });
      return result;
    } catch (error) {
      globalThis.cdp675GateRecord({ tabId, phase: name, outcome: 'error', reason: String(error?.message ?? error), before });
      throw error;
    }
  };
}
`;
}

export async function nativeTapFixture(directory) {
  const root = await mkdtemp(join(tmpdir(), 'cdp-675-native-tap-'));
  await cp(directory, root, { recursive: true });
  const file = join(root, 'cdp.js');
  const original = await readFile(file, 'utf8');
  const tapped = tapNativeSource(original);
  await writeFile(file, tapped);
  const debuggerFile = join(root, 'debugger.js');
  const debuggerOriginal = await readFile(debuggerFile, 'utf8');
  const debuggerTapped = tapDebuggerSource(debuggerOriginal);
  await writeFile(debuggerFile, debuggerTapped);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  assert.equal(typeof manifest.key, 'string');
  const extensionId = createHash('sha256')
    .update(Buffer.from(manifest.key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + Number.parseInt(character, 16)));
  return {
    directory: root,
    extensionId,
    sourceSha256: createHash('sha256').update(original).digest('hex'),
    tappedSha256: createHash('sha256').update(tapped).digest('hex'),
    debuggerSourceSha256: createHash('sha256').update(debuggerOriginal).digest('hex'),
    debuggerTappedSha256: createHash('sha256').update(debuggerTapped).digest('hex'),
    scope:
      'test-only native refusal and DebuggerGate decisions, raw observer only, never guard output',
  };
}

export async function nativeTapRead(chrome, fixture, targetId, bounded) {
  const workers = (await chrome.cdp.send('Target.getTargets', {})).targetInfos.filter(
    (target) =>
      target.type === 'service_worker' &&
      target.url === `chrome-extension://${fixture.extensionId}/background.js`
  );
  assert.equal(workers.length, 1, 'native tap must use the owned candidate worker');
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: workers[0].targetId,
    flatten: true,
  });
  try {
    const result = await bounded(chrome, sessionId, 'Runtime.evaluate', {
      expression: `({installed: Array.isArray(globalThis.cdp675NativeTrace), gateInstalled: typeof globalThis.cdp675GateRecord === 'function', records: (globalThis.cdp675NativeTrace ?? []).filter(record => String(record.tabId) === ${JSON.stringify(String(targetId))})})`,
      returnByValue: true,
    });
    assert.equal(
      result.result?.value?.installed,
      true,
      'native refusal observer was not installed'
    );
    assert.equal(
      result.result?.value?.gateInstalled,
      true,
      'native gate observer was not installed'
    );
    return result.result.value;
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId });
  }
}
